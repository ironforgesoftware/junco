/**
 * The daemon's chat registry (spec 2026-09-01 §2.4, §4): key → ChatSession,
 * the pre-turn gate check (the same two steps daemon.ts's gatedReady runs),
 * in-process spend recording (the ledger keeps its single writer), symmetric
 * provider-failure reporting (a chat 429 pauses claiming exactly as a ticket
 * 429 would), /health.chats, and the graceful drain. Draft parking attaches
 * through `onTurnComplete` (chatDrafts.ts) — the manager knows nothing about
 * fences.
 *
 * No per-key serialization lives here: ChatSession.prompt() owns that (it
 * steers a second concurrent prompt into the running turn) and its
 * reset()/drain() invalidate a session build that is still in flight, so the
 * manager stays a thin router over it.
 */
import { join } from "node:path";
import type { Config } from "../types.js";
import type { ProviderGate } from "../providerGate.js";
import type { SpendLedger } from "../spendLedger.js";
import { classifyProviderFailure, GATE_CLASSES } from "../providerFailure.js";
import { dataTreePaths } from "../dataTree.js";
import type { ChatDraftRecord } from "../agent/transcriptSchema.js";
import { log } from "../logging.js";
import { chatSlug } from "./chatKey.js";
import { resolveChatCwd, type ChatCwdError } from "./chatCwd.js";
import { ChatSession, type ChatSessionDeps, type ChatSubscriber } from "./chatSession.js";
import type { ChatTurnResult } from "./chatTurn.js";

export interface ChatStatus {
  key: string;
  slug: string;
  streaming: boolean;
  turns: number;
  lastActivityAt: string | null;
  draftsParked: number;
}
export interface ChatHealth {
  enabled: boolean;
  sessions: ChatStatus[];
  turns: number;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
}
export type ChatError = ChatCwdError | "chat_disabled";
export type ChatResult<T> = { ok: true; value: T } | { ok: false; error: ChatError };

export interface ChatManagerDeps {
  /** LIVE config: re-read on every call so hot-reloaded levers (chat.enabled,
   *  dailyBudgetUsd, chat.turnTimeoutMinutes) take effect without a restart. */
  cfg: () => Config;
  gate: Pick<
    ProviderGate,
    "claimBlockReason" | "status" | "reportFailure" | "reportBudgetExhausted"
  >;
  spend: Pick<SpendLedger, "recordUsd" | "todayUsd" | "nextMidnightMs">;
  resolveCwd?: typeof resolveChatCwd;
  session?: ChatSessionDeps;
  /** Task 11 (draft parking) attaches here; best-effort — a throw never fails
   *  the turn the operator just ran. */
  onTurnComplete?: (
    session: ChatSession,
    result: ChatTurnResult,
    source: "operator" | "auto_lint",
  ) => Promise<void>;
  draftsParkedFor?: (slug: string) => number;
  abortGraceMs?: number;
  now?: () => number;
}

export class ChatManager {
  private readonly sessions = new Map<string, ChatSession>();
  private turns = 0;
  private costUsd = 0;
  private tokensIn = 0;
  private tokensOut = 0;

  constructor(private readonly deps: ChatManagerDeps) {}

  enabled(): boolean {
    return this.deps.cfg().chat.enabled;
  }

  async get(key: string): Promise<ChatResult<ChatSession>> {
    if (!this.enabled()) return { ok: false, error: "chat_disabled" };
    const slug = chatSlug(key);
    const existing = this.sessions.get(slug);
    if (existing) return { ok: true, value: existing };
    const cfg = this.deps.cfg();
    const cwd = await (this.deps.resolveCwd ?? resolveChatCwd)(cfg, key);
    if (!cwd.ok) return { ok: false, error: cwd.error };
    const session = new ChatSession(
      {
        cfg,
        key,
        kind: cwd.kind,
        cwd: cwd.cwd,
        nwo: cwd.nwo,
        dir: join(dataTreePaths(cfg).chats, slug),
      },
      { ...this.deps.session, now: this.deps.now ?? this.deps.session?.now },
    );
    this.sessions.set(slug, session);
    return { ok: true, value: session };
  }

  /** daemon.ts gatedReady's two checks, verbatim in order: budget (live
   * lever) reported INTO the gate, then the gate itself — so a budget block
   * gets the same claimBlockReason()/status()//health surfacing as every
   * other gate state. A block is a record on the stream, not an error. */
  private blockReason(): { reason: string; until: string | null } | null {
    const cfg = this.deps.cfg();
    if (cfg.dailyBudgetUsd > 0) {
      const today = this.deps.spend.todayUsd();
      if (today >= cfg.dailyBudgetUsd) {
        this.deps.gate.reportBudgetExhausted(
          this.deps.spend.nextMidnightMs(),
          `daily budget $${cfg.dailyBudgetUsd.toFixed(2)} reached ($${today.toFixed(2)} spent)`,
        );
      }
    }
    const reason = this.deps.gate.claimBlockReason();
    if (!reason) return null;
    return { reason, until: this.deps.gate.status().until };
  }

  async prompt(
    key: string,
    text: string,
    opts: { source?: "operator" | "auto_lint" } = {},
  ): Promise<ChatResult<{ mode: "prompt" | "steer" | "rejected" }>> {
    const got = await this.get(key);
    if (!got.ok) return got;
    const session = got.value;
    const source = opts.source ?? "operator";
    // Before the gate check: a rejection is a transcript record, and the
    // transcript does not exist until meta does.
    await session.ensureMeta();
    const block = this.blockReason();
    if (block) {
      session.writeRecord({
        type: "junco_chat_turn_rejected",
        reason: block.reason,
        until: block.until,
      });
      return { ok: true, value: { mode: "rejected" } };
    }
    const cfg = this.deps.cfg();
    const timeoutMs = (cfg.chat.turnTimeoutMinutes ?? cfg.defaultTimeoutMinutes) * 60_000;
    const result = await session.prompt(text, {
      source,
      timeoutMs,
      abortGraceMs: this.deps.abortGraceMs,
      classify: (m) => classifyProviderFailure(m),
    });
    // A steer opened no turn of its own: it neither counts nor spends — the
    // running turn's end record carries the usage it contributed to.
    if (result.mode === "steer") return { ok: true, value: { mode: "steer" } };
    this.turns++;
    this.costUsd += result.usage.costUsd;
    this.tokensIn += result.usage.input;
    this.tokensOut += result.usage.output;
    if (result.usage.costUsd > 0) this.deps.spend.recordUsd(result.usage.costUsd);
    // Symmetric with runOnce.ts's GATE_CLASSES routing: a chat 429/auth/quota
    // pauses ticket claiming exactly as a ticket's would.
    if (result.status === "error" && result.errorMessage !== null) {
      const cls = classifyProviderFailure(result.errorMessage);
      if (GATE_CLASSES.has(cls)) this.deps.gate.reportFailure(cls, result.errorMessage);
    }
    if (this.deps.onTurnComplete) {
      try {
        await this.deps.onTurnComplete(session, result, source);
      } catch (e) {
        log.warn("chat onTurnComplete threw; ignoring", {
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    return { ok: true, value: { mode: "prompt" } };
  }

  async abort(key: string): Promise<ChatResult<{ aborted: boolean }>> {
    const got = await this.get(key);
    if (!got.ok) return got;
    return { ok: true, value: { aborted: await got.value.abort() } };
  }

  /**
   * /new (spec §2.4). The session object STAYS in the registry: reset() is
   * built to leave it reusable (transcript archived, turns/degraded/meta state
   * cleared, SDK disposed), and the dashboard's rail row must keep answering
   * status() across a reset — evicting it would make status() null until the
   * next prompt re-created it.
   */
  async fresh(key: string): Promise<ChatResult<null>> {
    const got = await this.get(key);
    if (!got.ok) return got;
    await got.value.reset("operator_new");
    return { ok: true, value: null };
  }

  async note(key: string, record: Omit<ChatDraftRecord, "ts">): Promise<ChatResult<null>> {
    const got = await this.get(key);
    if (!got.ok) return got;
    await got.value.ensureMeta();
    got.value.writeRecord(record);
    return { ok: true, value: null };
  }

  async subscribe(
    key: string,
    since: number,
    sub: ChatSubscriber,
  ): Promise<
    ChatResult<{ replay: Array<{ offset: number; line: string }>; unsubscribe: () => void }>
  > {
    const got = await this.get(key);
    if (!got.ok) return got;
    await got.value.ensureMeta();
    // Replay THEN attach: the sink is synchronous (chatSession.ts), so no line
    // can land between the read and the subscribe without being in the file.
    const replay = got.value.readLines(since);
    const unsubscribe = got.value.subscribe(sub);
    return { ok: true, value: { replay, unsubscribe } };
  }

  status(key: string): ChatStatus | null {
    const s = this.sessions.get(chatSlug(key));
    return s ? this.statusOf(s) : null;
  }

  private statusOf(s: ChatSession): ChatStatus {
    return {
      key: s.key,
      slug: s.slug,
      streaming: s.streaming,
      turns: s.turns,
      lastActivityAt: s.lastActivityAt,
      draftsParked: this.deps.draftsParkedFor?.(s.slug) ?? 0,
    };
  }

  health(): ChatHealth {
    return {
      enabled: this.enabled(),
      sessions: [...this.sessions.values()].map((s) => this.statusOf(s)),
      turns: this.turns,
      costUsd: this.costUsd,
      tokensIn: this.tokensIn,
      tokensOut: this.tokensOut,
    };
  }

  /** Graceful stop (spec §2.4): every session drains before the health server
   * closes. Concurrently — one wedged session must not hold the others' SSE
   * clients open past the shutdown deadline. */
  async drain(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((s) => s.drain()));
  }
}
