/**
 * One repo's chat session (spec 2026-09-01 §2.3). Owns: meta.json, the
 * transcript (a synchronous best-effort append so every persisted line's
 * end-offset is known at write time — the SSE `id`, §5.2), the in-memory
 * record bus (live fan-out; message_update is bus-only), the lazily built SDK
 * session, and the current turn. Never imports the SDK: the two SDK-touching
 * helpers come from agent/session.ts through deps.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "../types.js";
import {
  makeChatSessionFactory,
  makeSessionManager,
  type ChatSessionLike,
  type SessionOverrides,
} from "../agent/session.js";
import {
  TRANSCRIPT_VERSION,
  parseTranscriptLine,
  type ChatRecord,
  type MetaRecord,
} from "../agent/transcriptSchema.js";
import type { ProviderFailureClass } from "../providerFailure.js";
import { READ_ONLY_TOOLS } from "../runOnce.js";
import { log } from "../logging.js";
import { chatSlug } from "./chatKey.js";
import { runChatTurn, type ChatTurnResult } from "./chatTurn.js";

export interface ChatMeta {
  key: string;
  kind: "watched" | "local";
  cwd: string;
  nwo: string | null;
  sdkSessionFile: string;
  createdAt: string;
}

export interface ChatSubscriber {
  /** offset = byte position after the line's newline; null for bus-only lines. */
  onLine(line: string, offset: number | null): void;
  onEnd(reason: "daemon_stopped" | "session_reset"): void;
}

export interface ChatFs {
  existsSync: typeof existsSync;
  readFileSync: (p: string, enc: "utf8") => string;
  appendFileSync: (p: string, s: string) => void;
  writeFileSync: (p: string, s: string) => void;
  mkdirSync: (d: string) => void;
  renameSync: typeof renameSync;
  statSync: (p: string) => { size: number };
}

export interface ChatSessionDeps {
  makeSessionManager?: typeof makeSessionManager;
  sessionFactoryFor?: (
    cfg: Config,
    cwd: string,
    overrides: SessionOverrides,
  ) => () => Promise<ChatSessionLike>;
  fs?: Partial<ChatFs>;
  now?: () => number;
}

/**
 * The caller's view of a record: no `ts` (writeRecord stamps it) and, for
 * junco_meta, no `version` either. DISTRIBUTIVE on purpose — a bare
 * `Omit<ChatRecord, "ts">` collapses a union to its COMMON keys (`keyof` of a
 * union is the intersection), leaving `{ type }` and rejecting every real
 * record's own fields under excess-property checking.
 */
type Unstamped<T> = T extends unknown ? Omit<T, "ts" | "version"> : never;
export type ChatWriteRecord = Unstamped<ChatRecord> | Unstamped<MetaRecord>;

/** The chat's Config view (spec §2.3): read-only tool subset, model id chain
 * chat.modelId → github.plannerModelId → model.id. Never widens tools. */
export function chatCfgFor(cfg: Config): Config {
  return {
    ...cfg,
    tools: cfg.tools.filter((t) => READ_ONLY_TOOLS.has(t)),
    model: { ...cfg.model, id: cfg.chat.modelId ?? cfg.github.plannerModelId ?? cfg.model.id },
  };
}

const realFs: ChatFs = {
  existsSync,
  readFileSync: (p, enc) => readFileSync(p, enc),
  appendFileSync: (p, s) => appendFileSync(p, s, "utf8"),
  writeFileSync: (p, s) => writeFileSync(p, s, "utf8"),
  mkdirSync: (d) => mkdirSync(d, { recursive: true }),
  renameSync,
  statSync: (p) => statSync(p),
};

export class ChatSession {
  readonly slug: string;
  readonly key: string;
  readonly kind: "watched" | "local";
  readonly cwd: string;
  readonly nwo: string | null;
  readonly dir: string;
  readonly transcriptPath: string;
  readonly metaPath: string;
  turns = 0;
  lastActivityAt: string | null = null;
  degraded = false;

  private readonly cfg: Config;
  private readonly fs: ChatFs;
  private readonly now: () => number;
  private readonly makeSm: typeof makeSessionManager;
  private readonly factoryFor: NonNullable<ChatSessionDeps["sessionFactoryFor"]>;
  private readonly subscribers = new Set<ChatSubscriber>();
  private metaReady = false;
  private sdk: ChatSessionLike | null = null;
  private sdkPending: Promise<ChatSessionLike> | null = null;
  private size = 0;
  private turnAbort: AbortController | null = null;
  private inFlight: Promise<ChatTurnResult> | null = null;
  private drainReason: "daemon_stopped" | null = null;

  constructor(
    opts: {
      cfg: Config;
      key: string;
      kind: "watched" | "local";
      cwd: string;
      nwo: string | null;
      dir: string;
    },
    deps: ChatSessionDeps = {},
  ) {
    this.cfg = opts.cfg;
    this.key = opts.key;
    this.slug = chatSlug(opts.key);
    this.kind = opts.kind;
    this.cwd = opts.cwd;
    this.nwo = opts.nwo;
    this.dir = opts.dir;
    this.transcriptPath = join(opts.dir, "transcript.jsonl");
    this.metaPath = join(opts.dir, "meta.json");
    this.fs = { ...realFs, ...deps.fs };
    this.now = deps.now ?? (() => Date.now());
    this.makeSm = deps.makeSessionManager ?? makeSessionManager;
    this.factoryFor = deps.sessionFactoryFor ?? makeChatSessionFactory;
  }

  get streaming(): boolean {
    return this.inFlight !== null;
  }

  // ---- transcript + bus ----------------------------------------------------

  private persist(line: string): number | null {
    if (this.degraded) return null;
    try {
      this.fs.appendFileSync(this.transcriptPath, line);
      this.size += Buffer.byteLength(line, "utf8");
      return this.size;
    } catch (e) {
      this.degraded = true;
      log.warn("chat transcript disabled (append failed)", {
        slug: this.slug,
        error: e instanceof Error ? e.message : String(e),
      });
      this.publish(
        JSON.stringify({ type: "junco_chat_transcript_degraded", ts: this.ts() }) + "\n",
        null,
      );
      return null;
    }
  }

  private publish(line: string, offset: number | null): void {
    for (const s of this.subscribers) {
      try {
        s.onLine(line, offset);
      } catch (e) {
        log.warn("chat subscriber threw; dropping it", {
          error: e instanceof Error ? e.message : String(e),
        });
        this.subscribers.delete(s);
      }
    }
  }

  private ts(): string {
    return new Date(this.now()).toISOString();
  }

  /** Stamp ts, persist (unless degraded), publish. junco_meta gets version. */
  writeRecord(rec: ChatWriteRecord): void {
    const full =
      rec.type === "junco_meta"
        ? { ...rec, version: TRANSCRIPT_VERSION, ts: this.ts() }
        : { ...rec, ts: this.ts() };
    const line = JSON.stringify(full) + "\n";
    this.publish(line, this.persist(line));
  }

  /** SDK event: bus always; file unless message_update (spec §1.3). */
  private emitSdk(event: unknown): void {
    const line = JSON.stringify(event) + "\n";
    const type = (event as { type?: unknown } | null)?.type;
    this.publish(line, type === "message_update" ? null : this.persist(line));
  }

  /** Complete lines from `since`; each offset is the position after its newline. */
  readLines(since: number): Array<{ offset: number; line: string }> {
    let raw: string;
    try {
      raw = this.fs.readFileSync(this.transcriptPath, "utf8");
    } catch {
      return [];
    }
    const buf = Buffer.from(raw, "utf8");
    const out: Array<{ offset: number; line: string }> = [];
    let pos = Math.max(0, since);
    while (pos < buf.length) {
      const nl = buf.indexOf(0x0a, pos);
      if (nl === -1) break; // torn tail: held until its newline arrives
      out.push({ offset: nl + 1, line: buf.subarray(pos, nl).toString("utf8") });
      pos = nl + 1;
    }
    return out;
  }

  subscribe(sub: ChatSubscriber): () => void {
    this.subscribers.add(sub);
    return () => {
      this.subscribers.delete(sub);
    };
  }

  private endSubscribers(reason: "daemon_stopped" | "session_reset"): void {
    for (const s of this.subscribers) {
      try {
        s.onEnd(reason);
      } catch {
        /* best effort */
      }
    }
    this.subscribers.clear();
  }

  // ---- meta + lifecycle ------------------------------------------------------

  private readMeta(): ChatMeta | null {
    try {
      const m = JSON.parse(this.fs.readFileSync(this.metaPath, "utf8")) as ChatMeta;
      return typeof m.sdkSessionFile === "string" ? m : null;
    } catch {
      return null;
    }
  }

  private writeMeta(meta: ChatMeta): void {
    this.fs.writeFileSync(this.metaPath, JSON.stringify(meta, null, 2) + "\n");
  }

  /** meta.json + junco_meta header + crash stamp. No SDK. Idempotent. */
  async ensureMeta(): Promise<void> {
    if (this.metaReady) return;
    this.fs.mkdirSync(this.dir);
    try {
      this.size = this.fs.statSync(this.transcriptPath).size;
    } catch {
      this.size = 0;
    }
    if (this.readMeta() === null) {
      const { file } = await this.makeSm({ create: { cwd: this.cwd, dir: this.dir } });
      const createdAt = this.ts();
      this.writeMeta({
        key: this.key,
        kind: this.kind,
        cwd: this.cwd,
        nwo: this.nwo,
        sdkSessionFile: file,
        createdAt,
      });
      if (this.size === 0) this.writeRecord({ type: "junco_meta", ticketId: this.slug, createdAt });
    }
    this.stampCrashIfNeeded();
    this.metaReady = true;
  }

  /** Spec §11: a transcript whose last turn record is turn_start died mid-turn. */
  private stampCrashIfNeeded(): void {
    let lastTurn: string | null = null;
    for (const { line } of this.readLines(0)) {
      const p = parseTranscriptLine(line);
      if (p.kind !== "junco") continue;
      const t = p.record.type;
      if (
        t === "junco_chat_turn_start" ||
        t === "junco_chat_turn_end" ||
        t === "junco_chat_turn_aborted"
      )
        lastTurn = t;
    }
    if (lastTurn === "junco_chat_turn_start")
      this.writeRecord({ type: "junco_chat_turn_aborted", reason: "crash" });
  }

  /** True once the transcript holds a completed turn — the line between
   * "nothing to lose" and "a reset the operator must see" (Ruling R5). */
  private hasCompletedTurn(): boolean {
    for (const { line } of this.readLines(0)) {
      const p = parseTranscriptLine(line);
      if (p.kind === "junco" && p.record.type === "junco_chat_turn_end") return true;
    }
    return false;
  }

  /** Lazily build the SDK session (spec §11, Ruling R5). SDK 0.84.2 facts
   * (verified in Task 3, see makeSessionManager's doc comment in
   * src/agent/session.ts): `SessionManager.open()` on a MISSING path never
   * throws — it yields a fresh empty session at that path — and `create()`
   * writes nothing until the first assistant message. So "missing" is not an
   * error: it is a reset only when the transcript proves turns were lost.
   * "Corrupt" is the file existing and `open` OR the session build throwing
   * (makePiSessionFactory passes the manager straight to createAgentSession,
   * which reads the file back via `sessionManager.buildSessionContext()` —
   * SDK 0.84.2 `dist/core/sdk.js:81`) → archive to corrupt-<ts>/, create
   * fresh, record the reset. */
  async ensureSession(): Promise<ChatSessionLike> {
    if (this.sdk) return this.sdk;
    if (this.sdkPending) return this.sdkPending;
    this.sdkPending = (async () => {
      await this.ensureMeta();
      const meta = this.readMeta()!;
      const chatCfg = chatCfgFor(this.cfg);
      const build = async (manager: unknown): Promise<ChatSessionLike> =>
        this.factoryFor(chatCfg, this.cwd, {
          tools: chatCfg.tools,
          thinkingLevel: this.cfg.chat.thinkingLevel ?? this.cfg.model.thinkingLevel,
          sessionManager: manager,
        })();
      if (!this.fs.existsSync(meta.sdkSessionFile)) {
        if (this.hasCompletedTurn()) {
          log.warn("chat SDK session file missing; starting fresh", { slug: this.slug });
          this.writeRecord({ type: "junco_chat_session_reset", reason: "missing" });
        }
        const { manager } = await this.makeSm({
          open: { file: meta.sdkSessionFile, dir: this.dir, cwd: this.cwd },
        });
        this.sdk = await build(manager);
        return this.sdk;
      }
      try {
        const { manager } = await this.makeSm({
          open: { file: meta.sdkSessionFile, dir: this.dir, cwd: this.cwd },
        });
        this.sdk = await build(manager);
        return this.sdk;
      } catch (e) {
        log.warn("chat SDK session file corrupt; starting fresh", {
          slug: this.slug,
          error: e instanceof Error ? e.message : String(e),
        });
        const corruptDir = join(this.dir, `corrupt-${this.now()}`);
        this.fs.mkdirSync(corruptDir);
        this.fs.renameSync(meta.sdkSessionFile, join(corruptDir, "session.jsonl"));
        const created = await this.makeSm({ create: { cwd: this.cwd, dir: this.dir } });
        this.writeMeta({ ...meta, sdkSessionFile: created.file, cwd: this.cwd });
        this.writeRecord({ type: "junco_chat_session_reset", reason: "corrupt" });
        this.sdk = await build(created.manager);
        return this.sdk;
      }
    })();
    try {
      return await this.sdkPending;
    } finally {
      this.sdkPending = null;
    }
  }

  // ---- turns ---------------------------------------------------------------------

  async prompt(
    text: string,
    opts: {
      source: "operator" | "auto_lint";
      timeoutMs: number;
      abortGraceMs?: number;
      /** The manager owns the gate + classifier; it passes one in so the end
       *  record carries the class (spec §1.3). Absent → null. */
      classify?: (message: string) => ProviderFailureClass | null;
    },
  ): Promise<ChatTurnResult> {
    const sdk = await this.ensureSession();
    const chatCfg = chatCfgFor(this.cfg);
    if (sdk.isStreaming) {
      // steer: the running turn's own records frame this
      this.writeRecord({ type: "junco_chat_prompt", text, mode: "steer", source: opts.source });
      return runChatTurn(sdk, { text, timeoutMs: opts.timeoutMs, emit: () => {} });
    }
    this.writeRecord({ type: "junco_chat_prompt", text, mode: "prompt", source: opts.source });
    this.writeRecord({
      type: "junco_chat_turn_start",
      modelId: chatCfg.model.id,
      tools: chatCfg.tools,
      timeoutMs: opts.timeoutMs,
    });
    this.turnAbort = new AbortController();
    const run = runChatTurn(sdk, {
      text,
      timeoutMs: opts.timeoutMs,
      abortGraceMs: opts.abortGraceMs,
      abortSignal: this.turnAbort.signal,
      emit: (e) => this.emitSdk(e),
      now: this.now,
    });
    this.inFlight = run;
    try {
      const r = await run;
      this.turns++;
      this.lastActivityAt = this.ts();
      if (r.status === "aborted") {
        this.writeRecord({
          type: "junco_chat_turn_aborted",
          reason: this.drainReason ?? r.abortReason ?? "operator",
        });
      } else {
        this.writeRecord({
          type: "junco_chat_turn_end",
          status: r.status,
          errorClass: r.errorMessage !== null ? (opts.classify?.(r.errorMessage) ?? null) : null,
          errorMessage: r.errorMessage,
          usage: r.usage,
          durationMs: r.durationMs,
        });
      }
      return r;
    } finally {
      this.inFlight = null;
      this.turnAbort = null;
    }
  }

  /** Operator abort; true when a turn was in flight. */
  async abort(): Promise<boolean> {
    if (!this.inFlight) return false;
    this.turnAbort?.abort();
    await this.inFlight.catch(() => undefined);
    return true;
  }

  /** Graceful stop (spec §2.4): abort, stamp daemon_stopped, end subscribers, dispose. */
  async drain(): Promise<void> {
    this.drainReason = "daemon_stopped";
    await this.abort();
    this.endSubscribers("daemon_stopped");
    this.disposeSdk();
  }

  /** /new (spec §2.4): abort, dispose, archive the dir; drafts untouched. */
  async reset(reason: "operator_new"): Promise<void> {
    await this.abort();
    this.disposeSdk();
    this.endSubscribers("session_reset");
    if (this.fs.existsSync(this.dir)) {
      const archive = join(dirname(this.dir), "_archive");
      this.fs.mkdirSync(archive);
      this.fs.renameSync(this.dir, join(archive, `${this.slug}-${this.now()}`));
    }
    this.metaReady = false;
    this.size = 0;
    this.turns = 0;
    log.info("chat session reset", { slug: this.slug, reason });
  }

  private disposeSdk(): void {
    try {
      this.sdk?.dispose();
    } catch {
      /* best effort */
    }
    this.sdk = null;
  }
}
