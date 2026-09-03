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
import type { Config, Usage } from "../types.js";
import {
  makeChatSessionFactory,
  makeSessionManager,
  type ChatSessionLike,
  type SessionOverrides,
} from "../agent/session.js";
import {
  TRANSCRIPT_VERSION,
  parseTranscriptLine,
  type ChatCommandRecord,
  type ChatRecord,
  type MetaRecord,
} from "../agent/transcriptSchema.js";
import type { ProviderFailureClass } from "../providerFailure.js";
import { READ_ONLY_TOOLS } from "../runOnce.js";
import { log } from "../logging.js";
import { chatSlug } from "./chatKey.js";
import { TurnDeadline, runChatTurn, type ChatTurnResult } from "./chatTurn.js";
import { buildChatPrompt } from "./chatPrompt.js";
import { findChatDraft } from "./draftStore.js";
import { runSubmit, type SubmitExecDeps } from "./submitExec.js";
import {
  makeSubmitTool,
  SUBMIT_TOOL_NAME,
  type Decision,
  type SubmitProposal,
  type SubmitToolDeps,
} from "./submitTool.js";

export interface ChatMeta {
  key: string;
  kind: "watched" | "local";
  cwd: string;
  nwo: string | null;
  sdkSessionFile: string;
  createdAt: string;
}

export interface PromptOpts {
  source: "operator" | "auto_lint";
  timeoutMs: number;
  abortGraceMs?: number;
  /** The manager owns the gate + classifier; it passes one in so the end
   *  record carries the class (spec §1.3). Absent → null. */
  classify?: (message: string) => ProviderFailureClass | null;
}

/** Ruling R33: what a prompt looks like the moment it is ADMITTED. `done` is
 *  the turn itself — awaited by drain() and by the manager's tail, never by
 *  the HTTP route. */
export interface StartedTurn {
  mode: "prompt" | "steer";
  done: Promise<ChatTurnResult>;
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
  /** How a confirmed `junco_submit` reaches the CLI (spec 2026-09-03 §3.4).
   *  The daemon passes nothing (real spawn, real store); tests inject
   *  `spawnFn`/`cliPath`. */
  submit?: SubmitExecDeps;
  /** Test seam for the confirm wait (default
   *  `cfg.chat.confirmTimeoutMinutes` × 60 000). */
  confirmTimeoutMs?: number;
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

/** A steer opens no turn of its own: the running turn's end record carries the
 * usage the steered text contributed to. */
const ZERO_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, total: 0, costUsd: 0 };

/**
 * Thrown by a session build that finished AFTER reset()/drain() bumped the
 * generation. The built session has already been disposed by the builder and
 * must never be published on `this.sdk`: it would outlive `disposeSdk()` (a
 * live, never-disposed SDK session) and, on the reset path, stay bound to a
 * directory that has since been archived. Distinct type because the corrupt
 * handler in ensureSession() must let it through instead of reading it as
 * "the session file is unreadable" and archiving a healthy one.
 */
class StaleChatSessionError extends Error {
  constructor() {
    super("chat session reset while starting");
    this.name = "StaleChatSessionError";
  }
}

/** Read the opened session file back the way the SDK will (a METHOD call on
 * the injected manager — no SDK import). Throws exactly when the file cannot
 * be turned into a context, which is the file-bound definition of "corrupt". */
function probeSessionContext(manager: unknown): void {
  const fn = (manager as { buildSessionContext?: unknown } | null)?.buildSessionContext;
  if (typeof fn === "function") (fn as () => unknown).call(manager);
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
  /** Bumped by reset()/drain(). A session build that started under an older
   *  generation is stale: its dir may be archived and its owner gone. */
  private generation = 0;
  /** Turns past prompt()'s entry but not yet on `inFlight` — the window in
   *  which the SDK session is still being built. abort() must see these. */
  private starting = 0;
  /** The tool list the session was BUILT with (the read-only subset, plus
   *  junco_submit when it is on) — what `turn_start.tools` must report. */
  private toolNames: string[] | null = null;
  /** The running turn's pausable clock (spec 2026-09-03 §3.3), owned here so
   *  a pending confirmation can stop it. */
  private turnDeadline: TurnDeadline | null = null;
  /** The one `junco_submit` awaiting the operator, if any. */
  private pending: { commandId: string; settle: (d: Decision) => void } | null = null;
  private readonly submitDeps: SubmitExecDeps;
  private readonly confirmTimeoutMs: number;

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
    this.submitDeps = deps.submit ?? {};
    this.confirmTimeoutMs = deps.confirmTimeoutMs ?? opts.cfg.chat.confirmTimeoutMinutes * 60_000;
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
    this.stampDanglingIfNeeded();
    this.metaReady = true;
  }

  /** Spec §11 + spec 2026-09-03 §3.3: a turn record left at turn_start, or a
   *  command left at proposed, died with the daemon. */
  private stampDanglingIfNeeded(): void {
    let lastTurn: string | null = null;
    // commandId → the proposal no terminal record has closed yet.
    const open = new Map<string, ChatCommandRecord>();
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
      if (p.record.type === "junco_chat_command") {
        const c = p.record;
        if (c.status === "proposed") open.set(c.commandId, c);
        else open.delete(c.commandId);
      }
    }
    if (lastTurn === "junco_chat_turn_start")
      this.writeRecord({ type: "junco_chat_turn_aborted", reason: "crash" });
    for (const { ts: _ts, ...rest } of open.values())
      this.writeRecord({ ...rest, status: "expired", detail: "daemon restarted" });
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

  /** Lazily build the SDK session (spec §11, Ruling R5). SDK 0.84.4 facts
   * (verified in Task 3, see makeSessionManager's doc comment in
   * src/agent/session.ts): `SessionManager.open()` on a MISSING path never
   * throws — it yields a fresh empty session at that path — and `create()`
   * writes nothing until the first assistant message. So "missing" is not an
   * error: it is a reset only when the transcript proves turns were lost.
   *
   * Ruling R31: "corrupt" is FILE-BOUND — `open()` throwing, or the
   * `buildSessionContext()` probe below throwing — and nothing else. A
   * factory failure propagates untouched (see openSessionManager). */
  async ensureSession(): Promise<ChatSessionLike> {
    if (this.sdk) return this.sdk;
    if (this.sdkPending) return this.sdkPending;
    this.sdkPending = (async () => {
      const gen = this.generation;
      await this.ensureMeta();
      const meta = this.readMeta()!;
      const chatCfg = chatCfgFor(this.cfg);
      const build = async (manager: unknown): Promise<ChatSessionLike> => {
        // Spec 2026-09-03 §3.2: the SDK enables a custom tool only when the
        // `tools` allowlist names it, so the tool and its name go together —
        // and `buildSandbox` skips names it does not know, so the sandboxed
        // path is unaffected by the extra name.
        const submitTool = this.cfg.chat.submitTool ? makeSubmitTool(this.submitToolDeps()) : null;
        this.toolNames = submitTool ? [...chatCfg.tools, SUBMIT_TOOL_NAME] : chatCfg.tools;
        const built = await this.factoryFor(chatCfg, this.cwd, {
          tools: this.toolNames,
          ...(submitTool ? { customTools: [submitTool] } : {}),
          thinkingLevel: this.cfg.chat.thinkingLevel ?? this.cfg.model.thinkingLevel,
          sessionManager: manager,
          appendSystemPrompt: buildChatPrompt({
            cwd: this.cwd,
            nwo: this.nwo,
            planSetsEnabled: this.cfg.planSets.enabled,
            submitTool: submitTool !== null,
          }),
          // Ruling R14: chat is read-only by contract — the cwd is the
          // operator's live checkout, never a disposable worktree — so the
          // sandbox keeps scratch as the only writable root (the same seam
          // Q&A uses, runOnce.ts ~451).
          readOnly: true,
        })();
        // reset()/drain() landed while this build was in flight. Disposing
        // here — rather than publishing on `this.sdk` — is the whole point:
        // the caller's disposeSdk() has already run, so a session assigned
        // now would leak, and on the reset path it is bound to an archived
        // dir whose transcript any later write would resurrect.
        if (this.generation !== gen) {
          try {
            built.dispose();
          } catch {
            /* best effort */
          }
          throw new StaleChatSessionError();
        }
        return built;
      };
      const manager = await this.openSessionManager(meta);
      try {
        this.sdk = await build(manager);
      } catch (e) {
        // Ruling R31: a factory failure is the operator's to fix (a typo'd
        // chat.modelId, an unreachable endpoint, SKILL.md heading drift), so
        // it is LOGGED and rethrown — never read as a corrupt file. Nothing
        // was archived, no reset was recorded, meta is unchanged, and
        // `sdkPending` clears below, so the next prompt retries the build.
        if (!(e instanceof StaleChatSessionError))
          log.error("chat SDK session build failed", {
            slug: this.slug,
            error: e instanceof Error ? e.message : String(e),
          });
        throw e;
      }
      return this.sdk;
    })();
    try {
      return await this.sdkPending;
    } finally {
      this.sdkPending = null;
    }
  }

  /**
   * The manager to build on, and the ONLY place a session file is judged
   * (Ruling R31). Three cases:
   *
   * - missing → open it anyway (SDK 0.84.4 yields a fresh empty session at
   *   that path); a reset record only when the transcript proves turns were
   *   lost.
   * - present and readable → return the opened manager.
   * - present and unreadable — `open()` throws, or `buildSessionContext()`
   *   throws on a garbled file — → archive to corrupt-<ts>/, create fresh,
   *   record the reset.
   *
   * The probe is what makes "corrupt" file-bound instead of build-bound: it
   * is the same read the SDK's own `createAgentSession` does through
   * `sessionManager.buildSessionContext()` (0.84.4 `dist/core/sdk.js:81`),
   * run HERE where a throw can only be about the file. A manager without the
   * method (a test fake, a future SDK) simply isn't probed.
   */
  private async openSessionManager(meta: ChatMeta): Promise<unknown> {
    const open = { file: meta.sdkSessionFile, dir: this.dir, cwd: this.cwd };
    if (!this.fs.existsSync(meta.sdkSessionFile)) {
      if (this.hasCompletedTurn()) {
        log.warn("chat SDK session file missing; starting fresh", { slug: this.slug });
        this.writeRecord({ type: "junco_chat_session_reset", reason: "missing" });
      }
      return (await this.makeSm({ open })).manager;
    }
    try {
      const { manager } = await this.makeSm({ open });
      probeSessionContext(manager);
      return manager;
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
      return created.manager;
    }
  }

  // ---- turns ---------------------------------------------------------------------

  /** The whole turn, for callers with nothing else to do — `startPrompt`
   *  followed by its `done`. */
  async prompt(text: string, opts: PromptOpts): Promise<ChatTurnResult> {
    return (await this.startPrompt(text, opts)).done;
  }

  /**
   * Ruling R33: resolves once the turn is ADMITTED — the SDK session is
   * built and the prompt/steer decision is made — with the turn itself on
   * `done`. The HTTP route answers off this resolution; a turn that runs for
   * half an hour no longer holds a response open past undici's 300 s
   * headersTimeout.
   */
  async startPrompt(text: string, opts: PromptOpts): Promise<StartedTurn> {
    // All of this happens BEFORE the first await. `starting` is what tells
    // abort()/reset()/drain() that a turn exists during the window in which
    // the SDK session is still being built — `inFlight` is not set until the
    // build returns — and `gen` is how we learn, on the far side of that
    // await, that a reset or drain overtook us. The controller is minted here
    // for the same reason (an abort() during startup must be able to signal
    // this turn), but is published on `this.turnAbort` only when this call
    // owns the turn: a second, concurrent prompt is destined for the steer
    // path and would otherwise orphan the running turn's abort signal.
    const gen = this.generation;
    const startedAt = this.now();
    const ctl = new AbortController();
    const owns = this.inFlight === null && this.starting === 0;
    if (owns) this.turnAbort = ctl;
    this.starting++;
    try {
      // `starting` covers exactly the admission window: by the time this
      // returns, a prompt turn is on `inFlight` and a steer has already been
      // delivered, so abort()/reset()/drain() can see it either way.
      return await this.admit(text, opts, gen, startedAt, ctl);
    } finally {
      this.starting--;
    }
  }

  private async admit(
    text: string,
    opts: PromptOpts,
    gen: number,
    startedAt: number,
    ctl: AbortController,
  ): Promise<StartedTurn> {
    const startedElsewhere = (): StartedTurn => ({
      mode: "prompt",
      done: Promise.resolve(this.abortedWhileStarting(text, opts.source, startedAt)),
    });
    let sdk: ChatSessionLike;
    try {
      sdk = await this.ensureSession();
    } catch (e) {
      if (e instanceof StaleChatSessionError || gen !== this.generation) return startedElsewhere();
      throw e;
    }
    // The build succeeded but a reset/drain landed while it ran (or just
    // after): `this.sdk` has already been disposed and nulled, so this
    // session must not be prompted.
    if (gen !== this.generation) return startedElsewhere();
    const chatCfg = chatCfgFor(this.cfg);
    // A turn is in flight when THIS object owns one (`inFlight`) OR the SDK is
    // mid-run. Testing `sdk.isStreaming` alone loses the same-tick race: two
    // operator POSTs can both observe an idle SDK before the first run starts,
    // and the SDK rejects a second concurrent prompt() (no streamingBehavior).
    // Steer directly rather than through runChatTurn — there is no turn to
    // frame here, and the running turn's own records already cover the text.
    if (this.inFlight !== null || sdk.isStreaming) {
      this.writeRecord({ type: "junco_chat_prompt", text, mode: "steer", source: opts.source });
      const start = this.now();
      await sdk.steer(text);
      return {
        mode: "steer",
        done: Promise.resolve({
          mode: "steer",
          status: "ok",
          abortReason: null,
          errorMessage: null,
          usage: ZERO_USAGE,
          durationMs: this.now() - start,
          finalText: "",
          allText: "",
        }),
      };
    }
    this.writeRecord({ type: "junco_chat_prompt", text, mode: "prompt", source: opts.source });
    this.writeRecord({
      type: "junco_chat_turn_start",
      modelId: chatCfg.model.id,
      // The REAL list the session was built with — junco_submit included when
      // it is on (spec 2026-09-03 §3.2).
      tools: this.toolNames ?? chatCfg.tools,
      timeoutMs: opts.timeoutMs,
    });
    // Take ownership now even if `owns` was false at entry (the turn we would
    // have steered finished during the build): abort() must reach THIS turn.
    this.turnAbort = ctl;
    // Session-owned so confirmSubmit can pause it while the operator decides
    // (spec 2026-09-03 §3.3); runChatTurn arms and clears it exactly as it
    // does its own.
    const deadline = new TurnDeadline(opts.timeoutMs, this.now);
    this.turnDeadline = deadline;
    const run = runChatTurn(sdk, {
      text,
      timeoutMs: opts.timeoutMs,
      abortGraceMs: opts.abortGraceMs,
      deadline,
      // Already aborted when an operator abort() landed during startup;
      // runChatTurn's pre-aborted short-circuit then never prompts the SDK.
      abortSignal: ctl.signal,
      emit: (e) => this.emitSdk(e),
      now: this.now,
    });
    this.inFlight = run;
    return { mode: "prompt", done: this.settle(run, opts) };
  }

  /** The turn's own tail: the end record and the in-flight bookkeeping. Runs
   *  detached from admission (R33) — the route already answered. */
  private async settle(run: Promise<ChatTurnResult>, opts: PromptOpts): Promise<ChatTurnResult> {
    try {
      const r = await run;
      this.turns++;
      this.lastActivityAt = this.ts();
      if (r.status === "aborted") {
        this.writeRecord({
          type: "junco_chat_turn_aborted",
          // A turn that had already timed out keeps saying so: the drain
          // that arrived afterwards is not what ended it, and
          // "daemon_stopped" would send the reader looking at the shutdown
          // instead of at a model that wedged.
          reason:
            r.abortReason === "timeout"
              ? "timeout"
              : (this.drainReason ?? r.abortReason ?? "operator"),
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
      this.turnDeadline = null;
    }
  }

  /**
   * A reset() or drain() landed while this turn was still building its SDK
   * session. On the DRAIN path the dir still exists, so the turn is recorded
   * the way any daemon-stopped turn is. On the RESET path the dir has been
   * archived and nothing may be written: a write would either hit ENOENT (and
   * latch `degraded` right after reset cleared it) or resurrect the archived
   * transcript's path with a stray line.
   */
  private abortedWhileStarting(
    text: string,
    source: "operator" | "auto_lint",
    startedAt: number,
  ): ChatTurnResult {
    if (this.drainReason !== null) {
      this.writeRecord({ type: "junco_chat_prompt", text, mode: "prompt", source });
      this.writeRecord({ type: "junco_chat_turn_aborted", reason: "daemon_stopped" });
    }
    return {
      mode: "prompt",
      status: "aborted",
      abortReason: "operator",
      errorMessage: null,
      usage: ZERO_USAGE,
      durationMs: this.now() - startedAt,
      finalText: "",
      allText: "",
    };
  }

  // ---- the junco_submit handshake (spec 2026-09-03 §3.3) --------------------

  get pendingCommandId(): string | null {
    return this.pending?.commandId ?? null;
  }

  /**
   * The submit tool's `confirm` dep: write the card's record, stop the turn
   * clock, and wait for the dashboard's decision — or the turn's abort, or
   * the confirm budget. Exactly one at a time. Always settles: every exit
   * path clears the timer, drops the abort listener and resumes the deadline.
   */
  async confirmSubmit(p: SubmitProposal, signal?: AbortSignal): Promise<Decision> {
    if (this.pending !== null)
      throw new Error("a submit is already awaiting the operator's confirmation");
    if (signal?.aborted) return "aborted";
    this.writeRecord({
      type: "junco_chat_command",
      commandId: p.commandId,
      command: "submit",
      draftId: p.draftId,
      ids: p.ids,
      route: p.route,
      status: "proposed",
      exitCode: null,
      output: null,
      detail: null,
    });
    this.turnDeadline?.pause();
    try {
      return await new Promise<Decision>((resolve) => {
        const settle = (d: Decision): void => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          if (this.pending?.commandId === p.commandId) this.pending = null;
          resolve(d);
        };
        const timer = setTimeout(() => settle("expired"), this.confirmTimeoutMs);
        const onAbort = (): void => settle("aborted");
        signal?.addEventListener("abort", onAbort, { once: true });
        this.pending = { commandId: p.commandId, settle };
      });
    } finally {
      this.turnDeadline?.resume();
    }
  }

  /** The dashboard's answer (POST /chat/decide). False when nothing with that
   * id is pending — a stale card, or a decision that raced the timeout. */
  decide(commandId: string, decision: "run" | "decline"): boolean {
    if (this.pending === null || this.pending.commandId !== commandId) return false;
    this.pending.settle(decision);
    return true;
  }

  private submitToolDeps(): SubmitToolDeps {
    return {
      findDraft: (ref) => findChatDraft(this.cfg, this.key, ref, this.submitDeps.store),
      confirm: (p, signal) => this.confirmSubmit(p, signal),
      run: (draft, route) => runSubmit(this.cfg, draft, route, this.submitDeps),
      record: (rec) => this.writeRecord(rec),
      confirmTimeoutMinutes: this.cfg.chat.confirmTimeoutMinutes,
    };
  }

  /** Tests only: a turn deadline without a turn, so the pause is observable. */
  deadlineForTest(ms: number): TurnDeadline {
    const deadline = new TurnDeadline(ms, this.now);
    deadline.arm(() => {});
    this.turnDeadline = deadline;
    return deadline;
  }

  /** Operator abort; true when a turn was starting or in flight — or when a
   *  submit confirmation was pending (Ruling R1: it is turn-like state an
   *  abort must always reach, and the SDK aborts the tool's own signal too). */
  async abort(): Promise<boolean> {
    const hadPending = this.pending !== null;
    this.pending?.settle("aborted");
    if (!this.inFlight && this.starting === 0) return hadPending;
    this.turnAbort?.abort();
    // Nothing to await while a turn is only starting: the pending build is
    // reset()/drain()'s to await (this.sdkPending), and an operator abort
    // lets it finish and be short-circuited by runChatTurn instead.
    if (this.inFlight) await this.inFlight.catch(() => undefined);
    return true;
  }

  /** Graceful stop (spec §2.4): abort, stamp daemon_stopped, end subscribers, dispose. */
  async drain(): Promise<void> {
    this.drainReason = "daemon_stopped";
    this.generation++;
    await this.abort();
    // Let an in-flight session build finish and dispose itself (it sees the
    // bumped generation); without this it would materialize after shutdown
    // and leak a live SDK session.
    await this.sdkPending?.catch(() => undefined);
    this.endSubscribers("daemon_stopped");
    this.disposeSdk();
  }

  /** /new (spec §2.4): abort, dispose, archive the dir; drafts untouched. */
  async reset(reason: "operator_new"): Promise<void> {
    this.generation++;
    await this.abort();
    // Same as drain(): a build still running would otherwise be published
    // after disposeSdk() and stay bound to the dir archived just below.
    await this.sdkPending?.catch(() => undefined);
    this.disposeSdk();
    this.endSubscribers("session_reset");
    if (this.fs.existsSync(this.dir)) {
      const archive = join(dirname(this.dir), "_archive");
      this.fs.mkdirSync(archive);
      this.fs.renameSync(this.dir, join(archive, `${this.slug}-${this.now()}`));
    }
    // The archived dir is gone, so the next ensureMeta starts a clean
    // transcript and every bit of state derived from the old one resets with
    // it: the degraded latch (the dead sink was archived away too) and the
    // daemon_stopped abort latch included.
    this.metaReady = false;
    this.size = 0;
    this.turns = 0;
    this.degraded = false;
    this.lastActivityAt = null;
    this.drainReason = null;
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
