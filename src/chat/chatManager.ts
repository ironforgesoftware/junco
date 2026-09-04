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
import { chatSlug, isWatchedKey } from "./chatKey.js";
import { resolveChatCwd, type ChatCwd, type ChatCwdError } from "./chatCwd.js";
import { ChatSession, type ChatSessionDeps, type ChatSubscriber } from "./chatSession.js";
import type { ChatTurnResult } from "./chatTurn.js";
import type { SubmitExecDeps } from "./submitExec.js";

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
/** Ruling R33: what `prompt()` answers with the moment the turn is admitted.
 *  `done` settles when the turn (and its one auto-lint follow-up) is over and
 *  never rejects — the HTTP route ignores it, `drain()` awaits it. */
export interface AdmittedPrompt {
  mode: "prompt" | "steer" | "rejected";
  done: Promise<void>;
}
export type ChatError = ChatCwdError | "chat_disabled" | "draining";
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
  /** How a confirmed `junco_submit` reaches the CLI (spec 2026-09-03 §3.4).
   *  The daemon passes nothing — the real spawner and the real draft store;
   *  tests inject `spawnFn`/`cliPath`. */
  submit?: SubmitExecDeps;
  /** Draft parking (chatDrafts.ts) attaches here; best-effort — a throw never
   *  fails the turn the operator just ran. A returned `followUp` is the ONE
   *  automatic lint retry (spec §6.3): prompt() sends it back with
   *  `source: "auto_lint"`, and only ever off an `operator` turn. */
  onTurnComplete?: (
    session: ChatSession,
    result: ChatTurnResult,
    source: "operator" | "auto_lint",
  ) => Promise<{ followUp?: string } | void>;
  draftsParkedFor?: (slug: string) => number;
  abortGraceMs?: number;
  /** How long `drain()` waits for the sessions and their detached tails
   *  before giving up and letting shutdown proceed (default
   *  DRAIN_GRACE_MS). */
  drainGraceMs?: number;
  now?: () => number;
}

/** Shutdown's whole chat budget (#446). The per-turn abort grace
 * (chatTurn.ts's ABORT_GRACE_MS) already bounds a wedged MODEL, so what this
 * bounds is everything after it: a draft hook that hangs, or a turn admitted
 * in the window before `draining` latched. Deliberately far below
 * `chat.turnTimeoutMinutes` — a shutdown must not sit out a 30-minute turn. */
const DRAIN_GRACE_MS = 10_000;

export class ChatManager {
  private readonly sessions = new Map<string, ChatSession>();
  /** Slug → the in-flight build, so a concurrent first-touch of the same key
   *  joins it instead of racing a second ChatSession onto the same dir. */
  private readonly pending = new Map<string, Promise<ChatResult<ChatSession>>>();
  /** Slug → the turn tails that outlived their HTTP response (Ruling R33). */
  private readonly inFlightTurns = new Map<string, Set<Promise<void>>>();
  /** Slugs whose checkout path must be re-resolved the next time the session
   *  is opened (#453): set by `/new` (the session object survives a reset —
   *  Ruling R10) and by `reconcile()` when the watchlist entry moved. */
  private readonly recheckCwd = new Set<string>();
  private draining = false;
  private turns = 0;
  private costUsd = 0;
  private tokensIn = 0;
  private tokensOut = 0;

  constructor(private readonly deps: ChatManagerDeps) {}

  enabled(): boolean {
    return this.deps.cfg().chat.enabled;
  }

  /**
   * Atomic per slug ACROSS the cwd resolution. Every verb funnels through
   * here, so two concurrent first-touches of the same key are ordinary (a
   * dashboard SSE `subscribe` racing the first `prompt`): without the
   * in-flight cache both would clear the `sessions` miss, both would build a
   * ChatSession on the same dir, both would write a junco_meta header, and
   * status()/health() would track only the map winner while the orphan kept
   * writing to the same transcript. `enabled()` stays first and outside the
   * cache so a disabled config is never memoized.
   *
   * A cached session is handed back untouched unless `reconcile()` or a
   * reset flagged it: re-resolving on EVERY call would cost a watchlist read
   * per HTTP request, and a `git rev-parse` per request for a local key.
   */
  async get(key: string): Promise<ChatResult<ChatSession>> {
    if (!this.enabled()) return { ok: false, error: "chat_disabled" };
    const slug = chatSlug(key);
    const existing = this.sessions.get(slug);
    if (existing && !this.recheckCwd.has(slug)) return { ok: true, value: existing };
    const inFlight = this.pending.get(slug);
    if (inFlight) return inFlight;
    // Cleared on settle (failure included) so a transient resolution error —
    // a checkout that is not mounted yet — is retried on the next call rather
    // than replayed forever.
    const p = (existing ? this.reopen(key, slug, existing) : this.create(key, slug)).finally(() =>
      this.pending.delete(slug),
    );
    this.pending.set(slug, p);
    return p;
  }

  private async create(key: string, slug: string): Promise<ChatResult<ChatSession>> {
    const cfg = this.deps.cfg();
    const cwd = await (this.deps.resolveCwd ?? resolveChatCwd)(cfg, key);
    if (!cwd.ok) return { ok: false, error: cwd.error };
    const session = this.build(key, slug, cwd, cfg);
    this.sessions.set(slug, session);
    return { ok: true, value: session };
  }

  private build(
    key: string,
    slug: string,
    cwd: Extract<ChatCwd, { ok: true }>,
    cfg: Config,
  ): ChatSession {
    return new ChatSession(
      {
        cfg,
        key,
        kind: cwd.kind,
        cwd: cwd.cwd,
        nwo: cwd.nwo,
        dir: join(dataTreePaths(cfg).chats, slug),
      },
      {
        ...this.deps.session,
        now: this.deps.now ?? this.deps.session?.now,
        ...(this.deps.submit ? { submit: this.deps.submit } : {}),
      },
    );
  }

  /**
   * Spec §2.2: the checkout path is re-resolved when a session is (RE)OPENED,
   * not once per ChatSession lifetime (#453). A clone that moved — `clonesDir`
   * changed, a user-owned checkout relocated — used to keep its stale cwd
   * until the daemon restarted, because Ruling R10 keeps the reset session in
   * the registry and nothing else ever re-resolved.
   *
   * The old session is drained (SDK disposed — it is bound to the old path —
   * and subscribers ended, which is what makes the dashboard resubscribe) and
   * a new one takes its place on the SAME dir, so the transcript continues
   * with one `junco_chat_session_reset{reason:"cwd_changed"}` explaining the
   * jump.
   */
  private async reopen(
    key: string,
    slug: string,
    existing: ChatSession,
  ): Promise<ChatResult<ChatSession>> {
    // Never swap the session out from under a running turn (a steer lands
    // here too): the flag stays set, so the next idle open re-checks.
    if (existing.streaming) return { ok: true, value: existing };
    this.recheckCwd.delete(slug);
    const cfg = this.deps.cfg();
    const cwd = await (this.deps.resolveCwd ?? resolveChatCwd)(cfg, key);
    if (!cwd.ok) {
      // The repo left the watchlist (#452): `junco unwatch` has already
      // removed the dir this session appends to, so drop it rather than let
      // the next write latch `degraded`. Any other error is transient — a
      // checkout being re-created — and keeps the session it has.
      if (cwd.error !== "unknown_key") return { ok: true, value: existing };
      await this.evict(slug, existing, "unwatched");
      return { ok: false, error: cwd.error };
    }
    if (cwd.cwd === existing.cwd) return { ok: true, value: existing };
    await this.evict(slug, existing, "cwd_changed");
    const session = this.build(key, slug, cwd, cfg);
    this.sessions.set(slug, session);
    await session.ensureMeta();
    session.writeRecord({ type: "junco_chat_session_reset", reason: "cwd_changed" });
    return { ok: true, value: session };
  }

  /** Drop a session for good: out of the registry FIRST (so nothing new
   *  reaches it), then drained — subscribers get their terminal event, the
   *  SDK session is disposed. Never throws. */
  private async evict(slug: string, session: ChatSession, reason: string): Promise<void> {
    this.sessions.delete(slug);
    this.recheckCwd.delete(slug);
    try {
      await session.drain();
    } catch (e) {
      log.warn("chat session drain failed while evicting", {
        slug,
        error: e instanceof Error ? e.message : String(e),
      });
    }
    log.info("chat session dropped", { slug, reason });
  }

  /**
   * Watchlist reconciliation (#452), called off the daemon's poll loop so an
   * `unwatch` — or a config reload that drops a repo — is picked up within a
   * tick. `junco unwatch owner/repo` deletes the repo's chat dir and parked
   * drafts but only blocks on live TICKETS: a live ChatSession for that key
   * would keep appending to the removed dir (latching `degraded`) and keep
   * showing in /health.chats until the daemon restarted.
   *
   * Watched keys only: a local row is not in the watchlist to begin with, and
   * resolving one costs a `git rev-parse` we will not pay every poll. Free
   * when there are no sessions, which is the common case.
   */
  async reconcile(): Promise<void> {
    if (this.draining || this.sessions.size === 0) return;
    const cfg = this.deps.cfg();
    const resolve = this.deps.resolveCwd ?? resolveChatCwd;
    for (const [slug, session] of [...this.sessions]) {
      if (!isWatchedKey(session.key)) continue;
      const cwd = await resolve(cfg, session.key);
      if (!cwd.ok) {
        // Only "unknown_key" means the repo left the watchlist; a checkout
        // that is merely absent right now keeps the session it has.
        if (cwd.error === "unknown_key") await this.evict(slug, session, "unwatched");
        continue;
      }
      // A moved entry is only FLAGGED here: swapping the session from a
      // background tick would abort a turn the operator is watching stream.
      // The next open pays for it (#453).
      if (cwd.cwd !== session.cwd) this.recheckCwd.add(slug);
    }
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

  /**
   * Ruling R33: resolves on ADMISSION — the gate check plus the
   * prompt/steer decision — so the HTTP route can answer 202/200/409 while
   * the model is still streaming. The turn itself (spend, the draft hook, the
   * one auto-lint follow-up) runs detached on `done`, which never rejects.
   */
  async prompt(
    key: string,
    text: string,
    opts: { source?: "operator" | "auto_lint" } = {},
  ): Promise<ChatResult<AdmittedPrompt>> {
    // Before `get()` — the manager's half of the draining 503 (#446). A
    // prompt admitted after drain() bumped the generation would have
    // `ensureSession()` rebuild the SDK session it just disposed, and the
    // new tail would be tracked by a drain that is already past its wait.
    if (this.draining) return { ok: false, error: "draining" };
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
      return { ok: true, value: { mode: "rejected", done: Promise.resolve() } };
    }
    const cfg = this.deps.cfg();
    const timeoutMs = (cfg.chat.turnTimeoutMinutes ?? cfg.defaultTimeoutMinutes) * 60_000;
    const started = await session.startPrompt(text, {
      source,
      timeoutMs,
      abortGraceMs: this.deps.abortGraceMs,
      classify: (m) => classifyProviderFailure(m),
    });
    const done = this.track(session.slug, this.finishTurn(key, session, started.done, source));
    return { ok: true, value: { mode: started.mode, done } };
  }

  /**
   * The turn's tail, after the route has answered. NEVER rejects: a model
   * failure is already a `junco_chat_turn_end{status:"error"}` record and a
   * gate report, so anything reaching the catch is a bug in this layer and is
   * logged as one.
   */
  private async finishTurn(
    key: string,
    session: ChatSession,
    turn: Promise<ChatTurnResult>,
    source: "operator" | "auto_lint",
  ): Promise<void> {
    try {
      const result = await turn;
      // A steer opened no turn of its own: it neither counts nor spends — the
      // running turn's end record carries the usage it contributed to.
      if (result.mode === "steer") return;
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
      let followUp: string | undefined;
      if (this.deps.onTurnComplete) {
        try {
          const r = await this.deps.onTurnComplete(session, result, source);
          followUp = r && "followUp" in r ? r.followUp : undefined;
        } catch (e) {
          log.warn("chat onTurnComplete threw; ignoring", {
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
      // Spec §6.3: exactly one automatic lint follow-up, never chained — the
      // `operator` guard is what makes that hold no matter what the hook returns
      // off the retry turn. Not while draining: the session is already stopping,
      // and drain() waits on these tails.
      if (followUp !== undefined && source === "operator" && !this.draining) {
        const retry = await this.prompt(key, followUp, { source: "auto_lint" });
        if (retry.ok) await retry.value.done;
      }
    } catch (e) {
      log.error("chat turn tail failed", {
        key,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /** Per-slug in-flight tails, so drain() can wait for every one of them. */
  private track(slug: string, done: Promise<void>): Promise<void> {
    const set = this.inFlightTurns.get(slug) ?? new Set<Promise<void>>();
    this.inFlightTurns.set(slug, set);
    set.add(done);
    void done.finally(() => {
      set.delete(done);
      if (set.size === 0) this.inFlightTurns.delete(slug);
    });
    return done;
  }

  /** POST /chat/decide (spec 2026-09-03 §4.5): the dashboard's y/n for a
   *  pending `junco_submit`. `settled: false` is the 409 — a stale card, or a
   *  decision that raced the confirm timeout. */
  async decide(
    key: string,
    commandId: string,
    decision: "run" | "decline",
  ): Promise<ChatResult<{ settled: boolean }>> {
    const got = await this.get(key);
    if (!got.ok) return got;
    return { ok: true, value: { settled: got.value.decide(commandId, decision) } };
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
    // ...but the checkout is re-resolved on the next open (spec §2.2, #453):
    // "on open" is the contract, and a reset session is opened again.
    this.recheckCwd.add(got.value.slug);
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
   * clients open past the shutdown deadline. Then the detached tails (R33):
   * the abort above makes each turn settle, and this is what waits for the
   * spend/hook/record work that used to sit inside the POST. `draining`
   * stops an auto-lint follow-up — and, since #446, any new prompt — from
   * being admitted mid-shutdown, which is also what makes the loop terminate.
   *
   * Bounded by DRAIN_GRACE_MS (#446): the wait is best-effort, so a hook that
   * never returns leaves its tail detached and shutdown carries on rather
   * than holding the health server open for the rest of the turn timeout.
   * Every subscriber has already had its terminal event by then — that
   * happens inside `session.drain()`, which the grace only ever cuts short in
   * the pathological case. */
  async drain(): Promise<void> {
    this.draining = true;
    const work = (async () => {
      await Promise.all([...this.sessions.values()].map((s) => s.drain()));
      while (this.inFlightTurns.size > 0)
        await Promise.all([...this.inFlightTurns.values()].flatMap((s) => [...s]));
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const grace = new Promise<"grace">((resolve) => {
      timer = setTimeout(() => resolve("grace"), this.deps.drainGraceMs ?? DRAIN_GRACE_MS);
      // Never the reason the process stays alive: the daemon is stopping.
      timer.unref?.();
    });
    try {
      const outcome = await Promise.race([
        work.then(
          () => "done" as const,
          (e: unknown) => {
            log.warn("chat drain failed", { error: e instanceof Error ? e.message : String(e) });
            return "done" as const;
          },
        ),
        grace,
      ]);
      if (outcome === "grace")
        log.warn("chat drain grace expired; leaving turn tails detached", {
          sessions: this.sessions.size,
          pending: this.inFlightTurns.size,
        });
    } finally {
      clearTimeout(timer);
    }
  }
}
