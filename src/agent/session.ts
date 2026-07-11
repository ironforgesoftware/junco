import { existsSync, mkdirSync, createWriteStream, mkdtempSync, type WriteStream } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir, homedir } from "node:os";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { Config, RunResult } from "../types.js";
import { RunAccumulator } from "./runResult.js";
import { GuardManager, type GuardDecision } from "./guardManager.js";
import { log } from "../logging.js";
import { buildInlineProviderConfig, splitModelId, apiBaseUrl } from "./modelSetup.js";
import { buildPolicy, type SandboxPolicy } from "./sandbox/policy.js";
import {
  selectBackend,
  defaultExecProbe,
  type SandboxBackend,
  type ExecProbe,
} from "./sandbox/backend.js";
import { buildSandbox, SandboxUnavailableError, type SdkToolFactories } from "./sandbox/index.js";

// Re-exported for back-compat: these helpers moved to ./modelSetup.js.
export { splitModelId, apiBaseUrl } from "./modelSetup.js";

/**
 * The SDK's session event union, re-exported under junco's name so consumers
 * (runResult, guards, tests) need no direct SDK import. Type-only — the SDK
 * module itself is still lazy-loaded at runtime inside makePiSessionFactory.
 */
export type AgentEvent = AgentSessionEvent;

/**
 * Minimal structural type of what we use from a Pi `AgentSession`. Keeping the
 * surface this small lets `runAgent` be exercised with a fake (see
 * tests/session.test.ts) and isolates the real SDK to `makePiSessionFactory`.
 *
 * Verified against the installed SDK (`dist/core/agent-session.d.ts`):
 *   - subscribe(listener): () => void   (line 240)
 *   - prompt(text, options?): Promise<void>  (line 326; resolves after the agent loop finishes)
 *   - dispose(): void   (line 256)
 *   - abort(): Promise<void>   (line 402)
 */
export interface AgentSessionLike {
  subscribe(listener: (event: AgentEvent) => void): () => void;
  prompt(text: string, options?: unknown): Promise<void>;
  dispose(): void;
  abort(): Promise<void>;
}

/**
 * Sink for the per-ticket transcript. `runAgent` writes one already-serialized
 * JSON line per non-delta event (plus synthetic guard-decision records) through
 * this seam — injectable so the fs writes sit behind a deps boundary like every
 * other side effect (createSession/onProgress/onGuardDecision), instead of tests
 * reaching for `vi.mock('node:fs')` (CLAUDE.md "every side effect behind an
 * injectable deps seam"; #128).
 */
export interface TranscriptSink {
  /** Append one line (caller includes the trailing newline). Best-effort — a
   *  failed write must NOT throw up through the SDK's synchronous emit. */
  write(line: string): void;
  /** Flush/close. Best-effort. */
  end(): void;
}

/**
 * Builds a `TranscriptSink` for a path, or returns null when the sink could not
 * be opened (the run continues without a transcript). Defaults to
 * `defaultTranscriptSink` (real fs) so existing callers are unchanged.
 */
export type TranscriptSinkFactory = (path: string) => TranscriptSink | null;

/**
 * The default fs-backed transcript sink. Creates the parent dir and appends to
 * the file; open/write failures degrade to a warning and drop the transcript
 * (subsequent writes become no-ops) rather than crashing the ticket.
 */
export const defaultTranscriptSink: TranscriptSinkFactory = (path) => {
  let stream: WriteStream | null;
  try {
    mkdirSync(dirname(path), { recursive: true });
    stream = createWriteStream(path, { flags: "a" });
  } catch (e) {
    log.warn("transcript disabled (path not writable)", {
      path,
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
  // createWriteStream opens the file ASYNCHRONOUSLY: open and write failures
  // (EACCES, ENOSPC, ...) arrive as an 'error' event, never a throw — without a
  // listener that event crashes the process mid-ticket. Degrade to a warning
  // and drop the transcript (later writes become no-ops).
  stream.on("error", (e: Error) => {
    log.warn("transcript disabled (stream error)", { path, error: e.message });
    stream = null;
  });
  return {
    write(line: string): void {
      stream?.write(line);
    },
    end(): void {
      stream?.end();
    },
  };
};

export interface RunAgentOptions {
  body: string;
  cwd: string;
  timeoutMs: number;
  createSession: () => Promise<AgentSessionLike>;
  /**
   * Optional loop-guard + supervisor. When present, runAgent feeds every event
   * to it; a "nudge" decision injects a corrective steering prompt mid-run, a
   * "kill" decision aborts the run. Absent → M1 behavior is unchanged.
   */
  guardManager?: GuardManager;
  /**
   * External abort (operator force-stop). Treated like a guard kill: the run
   * is aborted softly and any commits already made are salvaged.
   */
  abortSignal?: AbortSignal;
  /**
   * Called on turn ends and tool starts with a cheap progress snapshot —
   * wired to the metrics singleton so /health can show live progress.
   */
  onProgress?: (p: { turns: number; lastTool: string | null; outputTokens: number }) => void;
  /**
   * Called once per realized guard decision (nudge or kill), at the decision
   * point — wired to the metrics singleton so /health and `junco status` can
   * count nudges/kills (#37). runAgent also logs and transcribes the decision;
   * this hook is purely the metrics seam (session.ts stays free of the
   * metrics singleton, mirroring onProgress).
   */
  onGuardDecision?: (decision: GuardDecision) => void;
  /**
   * Append every non-delta event as a JSON line — the debugging record for
   * failed runs. Parent dir is created; write failures only warn.
   */
  transcriptPath?: string;
  /**
   * Factory for the transcript sink (used only when `transcriptPath` is set).
   * Injectable so the fs writes go through a deps seam like every other side
   * effect; defaults to the real fs-backed `defaultTranscriptSink` (#128).
   */
  transcriptSink?: TranscriptSinkFactory;
  /**
   * Grace period (ms) to wait for the in-flight prompt() to actually settle
   * AFTER an abort is initiated, before treating the run as wedged and
   * returning the accumulated result anyway. Defaults to ABORT_GRACE_MS (60s).
   * Injectable so tests can short-circuit it.
   */
  abortGraceMs?: number;
}

/**
 * How long runAgent waits for a soft-aborted prompt() to actually settle
 * before treating the run as wedged and returning anyway (issue #51). abort()
 * only resolves once the SDK run promise settles; a run that never notices the
 * abort (a surviving tool child, a wedged transport) would otherwise hang
 * runAgent — and, at max_concurrent=1, the whole worker — indefinitely, since
 * the ticket timeout has already fired and does nothing further.
 */
const ABORT_GRACE_MS = 60_000;

/**
 * Run a single prompt against an injected session and reduce its event stream
 * to a `RunResult`. The session is dependency-injected so the orchestrator
 * (Task 8) is testable with a fake; the real wiring lives in
 * `makePiSessionFactory` and is proven by the e2e (Task 9).
 */
export async function runAgent(opts: RunAgentOptions): Promise<RunResult> {
  const acc = new RunAccumulator();
  const gm = opts.guardManager;
  const start = Date.now();
  let timedOut = false;
  let killReason: string | null = null;

  // Result for a run that was force-stopped before any prompt was in flight —
  // same shape as a mid-run kill (soft abort → PR-flow salvage semantics).
  const preAbortedResult = (): RunResult => {
    killReason = "force-stop requested by operator";
    const summary = gm ? gm.supervisorSummary : "no nudges issued";
    acc.setError(`supervisor kill: ${killReason} (${summary})`);
    return acc.result(Date.now() - start, timedOut, true);
  };

  // A pre-aborted signal means "do not run": the SDK does NOT latch aborts —
  // abort() is `this.activeRun?.abortController.abort()` (pi-agent-core
  // dist/agent.js), a no-op with no active run, and each prompt() creates a
  // fresh AbortController. Calling abort() here would let the prompt run the
  // whole session to completion with every guard decision suppressed by the
  // `killReason !== null` gate below. Skip the run entirely instead.
  if (opts.abortSignal?.aborted) return preAbortedResult();

  const session = await opts.createSession();

  // Re-check: the signal may have fired while createSession() was awaited —
  // still before any run is in flight, so abort() would be the same no-op.
  if (opts.abortSignal?.aborted) {
    session.dispose();
    return preAbortedResult();
  }

  let unsubscribe: (() => void) | undefined;

  // Fallback deadline for a wedged abort (#51). abort() only settles the
  // in-flight prompt() when the SDK run settles; if it never does, this timer
  // resolves the race below so runAgent returns the accumulated result instead
  // of hanging forever. Armed once, by whichever abort path fires first.
  let wedged = false;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveWedge: (() => void) | undefined;
  const wedgePromise = new Promise<void>((resolve) => {
    resolveWedge = resolve;
  });
  const armAbortGrace = (): void => {
    if (graceTimer !== undefined) return; // first abort wins; don't re-arm
    graceTimer = setTimeout(() => {
      wedged = true;
      resolveWedge?.();
    }, opts.abortGraceMs ?? ABORT_GRACE_MS);
  };

  const timer = setTimeout(() => {
    timedOut = true;
    // abort() resolves the in-flight prompt() so runAgent can return. Guard the
    // rejection so a failed abort can't surface as an unhandled rejection.
    void session.abort().catch(() => {});
    armAbortGrace();
  }, opts.timeoutMs);
  // Operator force-stop: soft-abort exactly like a guard kill so the PR-flow
  // salvages any commits already made. (A run is in flight by the time this
  // can fire — the pre-aborted cases returned above.)
  const onExternalAbort = (): void => {
    if (killReason === null) killReason = "force-stop requested by operator";
    void session.abort().catch(() => {});
    armAbortGrace();
  };
  opts.abortSignal?.addEventListener("abort", onExternalAbort, { once: true });
  // Transcript writes go through an injectable sink (#128), defaulting to the
  // real fs-backed sink. Sink-internal failures degrade to a warning and drop
  // the transcript, so the write sites below stay best-effort.
  let transcript: TranscriptSink | null = null;
  if (opts.transcriptPath) {
    transcript = (opts.transcriptSink ?? defaultTranscriptSink)(opts.transcriptPath);
  }
  try {
    // Subscribe immediately before prompt() (so no startup events are missed),
    // but inside the try so the session is still disposed if subscribe throws.
    unsubscribe = session.subscribe((e) => {
      acc.observe(e);
      // Observability is best-effort (#78): transcript.write (a broken stream)
      // or a buggy onProgress hook must NOT throw up through the SDK's
      // synchronous emit and reject/wedge the in-flight prompt() — degrade to a
      // warning instead. (acc.observe stays outside: it is the run's result.)
      try {
        // Skip per-token deltas — the transcript records turns/tools/results.
        if (transcript && e?.type !== "message_update") transcript.write(JSON.stringify(e) + "\n");
        if (opts.onProgress && (e?.type === "turn_end" || e?.type === "tool_execution_start")) {
          opts.onProgress(acc.progress());
        }
      } catch (err) {
        log.warn("observability hook threw; ignoring", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      if (!gm) return;
      // A kill is terminal — once decided, stop feeding the guard (further
      // events from the aborting run shouldn't produce more decisions).
      if (killReason !== null) return;
      const decision = gm.observe(e);
      if (!decision) return;
      // Observability (#37): a guard decision — especially a *successful* nudge,
      // which otherwise never surfaces — leaves a structured log line, a
      // synthetic transcript record (reconstructible per ticket alongside the
      // raw SDK events), and a metrics increment. The nudge message / kill
      // reason travels under one key so log queries don't branch on action.
      const reasonOrMessage =
        decision.action === "nudge"
          ? { nudgeMessage: decision.message }
          : { reason: decision.reason };
      // Same best-effort discipline (#78): the log line, the synthetic
      // transcript record, and the metrics hook must not prevent the nudge/kill
      // ACTION below — the already-going-wrong moment the hook is exercised —
      // from firing when one of them throws.
      try {
        log.warn("guard decision", {
          kind: decision.kind,
          action: decision.action,
          detail: decision.detail,
          turnIndex: decision.turnIndex,
          ...reasonOrMessage,
        });
        if (transcript) {
          transcript.write(
            JSON.stringify({
              type: "junco_guard_decision",
              kind: decision.kind,
              action: decision.action,
              detail: decision.detail,
              turnIndex: decision.turnIndex,
              ...reasonOrMessage,
              ts: new Date().toISOString(),
            }) + "\n",
          );
        }
        opts.onGuardDecision?.(decision);
      } catch (err) {
        log.warn("guard-decision observability threw; ignoring", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      if (decision.action === "nudge") {
        // Inject a corrective steering prompt mid-run. "steer" redirects the
        // CURRENT run (delivered after the current assistant turn finishes its
        // tool calls, before the next LLM call) — verified against the SDK
        // (docs/rpc.md:62, PromptOptions.streamingBehavior). Fire-and-forget:
        // the outer `await session.prompt(body)` resolves only after the
        // steered continuation also finishes, so one await still suffices.
        void session.prompt(decision.message, { streamingBehavior: "steer" }).catch(() => {});
      } else {
        // Kill: record the reason and abort the run. abort() resolves the
        // in-flight prompt() so runAgent returns. Guard the rejection.
        killReason = decision.reason;
        void session.abort().catch(() => {});
        armAbortGrace();
      }
    });
    const runPromise = session.prompt(opts.body);
    // If the wedge deadline wins the race, the prompt may still reject later
    // with nobody awaiting it — swallow that so it can't surface as an
    // unhandled rejection. (The original runPromise still rejects into the
    // race below when it loses to a real error, so this doesn't hide errors.)
    runPromise.catch(() => {});
    await Promise.race([runPromise, wedgePromise]);
    if (wedged) {
      log.warn("agent session wedged after abort — returning salvaged result", {
        graceMs: opts.abortGraceMs ?? ABORT_GRACE_MS,
        timedOut,
        killReason,
      });
    }
  } catch (e) {
    acc.setError(e instanceof Error ? e.message : String(e));
  } finally {
    clearTimeout(timer);
    if (graceTimer !== undefined) clearTimeout(graceTimer);
    opts.abortSignal?.removeEventListener("abort", onExternalAbort);
    unsubscribe?.();
    transcript?.end();
    // Best-effort: a wedged session's dispose may throw; don't let it mask the
    // salvaged result.
    try {
      session.dispose();
    } catch {
      /* ignore */
    }
  }
  // Surface a guard kill into errorMessage (so finalize() routes the ticket to
  // failed/) with the supervisor summary, mirroring the Python banner.
  if (killReason !== null) {
    const summary = gm ? gm.supervisorSummary : "no nudges issued";
    acc.setError(`supervisor kill: ${killReason} (${summary})`);
  }
  // A guard KILL is a SOFT abort (parity with Python aborted_by_repetition):
  // the PR-flow continues past it to salvage any commits made before the abort.
  return acc.result(Date.now() - start, timedOut, killReason !== null);
}

/**
 * Real SDK session factory (validated by the e2e in Task 9; not unit-tested
 * here). Returns a thunk that builds a headless `AgentSession` pointed at the
 * configured OpenAI-compatible endpoint.
 *
 * PROVIDER/MODEL RESOLUTION — chosen path: in-memory `ModelRegistry` +
 * `registerProvider` (a typed variant of plan path "A"; NOT the disk
 * `models.json` nor the path "B" extension/resourceLoader route).
 *
 * Why this over the alternatives (verified against the installed SDK type defs):
 *   - `ModelRegistry.inMemory(authStorage)` exists
 *     (dist/core/model-registry.d.ts:30) and `registerProvider(name, config)`
 *     is a PUBLIC method (model-registry.d.ts:96) whose `config` is the typed
 *     `ProviderConfigInput` interface (model-registry.d.ts:120-149). Because the
 *     provider/model shape is type-checked at build time, `npm run build`
 *     catches a malformed provider config — a disk `models.json` is parsed only
 *     at runtime and gives no such safety. `registry.find(provider, id)` then
 *     returns the resolved `Model` (model-registry.d.ts:60) BEFORE
 *     `createAgentSession` needs it.
 *   - Path "B" (resourceLoader.getExtensions calling pi.registerProvider) is
 *     only required when you cannot touch the registry directly; here we own the
 *     registry, so the extension machinery is unnecessary.
 *
 * The provider/model values (api, compat block, reasoning, contextWindow,
 * maxTokens, thinkingFormat) come from the resolved `cfg.model` config — built
 * either from a Pi models.json (`cfg.model.modelsJson`, path A) or from the
 * inline `[model].*` TOML fields via `buildInlineProviderConfig` (path B). The
 * `ProviderConfigInput` shape matches `docs/custom-provider.md` + the on-disk
 * schema in `docs/models.md`.
 *
 * baseUrl: `cfg.model.baseUrl` may point at the list-models endpoint
 * (`.../v1/models`); the provider API base is its parent (`.../v1`), derived via
 * `apiBaseUrl()`.
 *
 * Auth: the API key is injected via `authStorage.setRuntimeApiKey(provider,
 * cfg.model.apiKey)` (auth-storage.d.ts:63), the HIGHEST-priority source in
 * `getApiKey` (auth-storage.d.ts:124-134); nothing is persisted to disk.
 *
 * Model id: `cfg.model.id` is provider-prefixed (e.g. "openai/gpt-4o-mini").
 * We split on the first "/" into provider + bare model id, since the
 * programmatic `registerProvider`/`find` APIs take them separately.
 *
 * `overrides` lets a caller (e.g. the post-session critic) build a session with
 * NO tools (`tools: []`) and a different thinking level. When omitted the
 * defaults (`cfg.tools`, `cfg.model.thinkingLevel`) are preserved unchanged.
 */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface SessionOverrides {
  tools?: string[];
  thinkingLevel?: ThinkingLevel | string;
  /** Per-ticket egress opt-in; overrides cfg.sandbox.network for this session. */
  network?: boolean;
}

export interface ResolveSandboxDeps {
  probe?: ExecProbe;
  makeScratch?: () => string;
  platform?: NodeJS.Platform;
  home?: string;
}

export interface ResolvedSandbox {
  backend: SandboxBackend;
  policy: SandboxPolicy;
}

/**
 * Decide sandbox backend + policy for a session, failing closed when a required
 * OS backend is unavailable. Returns null when sandboxing is disabled (the
 * factory then behaves exactly as before). Side effects (probe, scratch dir,
 * platform, home) are injectable so the decision is unit-testable.
 */
export async function resolveSandbox(
  cfg: Config,
  cwd: string,
  overrides: SessionOverrides | undefined,
  deps: ResolveSandboxDeps = {},
): Promise<ResolvedSandbox | null> {
  if (!cfg.sandbox.enabled) return null;
  const probe = deps.probe ?? defaultExecProbe;
  const platform = deps.platform ?? process.platform;
  const home = deps.home ?? homedir();
  const makeScratch = deps.makeScratch ?? (() => mkdtempSync(join(tmpdir(), "junco-sbx-")));

  const backend = selectBackend(cfg.sandbox.backend, platform);
  if (backend.name !== "none" && !(await backend.isAvailable(probe))) {
    throw new SandboxUnavailableError(
      `sandbox backend "${backend.name}" unavailable (binary missing or non-functional). ` +
        `Set [sandbox].enabled=false to opt out, or backend="none" to skip OS isolation.`,
    );
  }
  const network = overrides?.network ?? cfg.sandbox.network === "allow";
  const scratchDir = makeScratch();
  const policy = buildPolicy({
    cfg: cfg.sandbox,
    cwd,
    scratchDir,
    home,
    stateDir: cfg.stateDir,
    network,
  });
  return { backend, policy };
}

export function makePiSessionFactory(
  cfg: Config,
  cwd: string,
  overrides?: SessionOverrides,
): () => Promise<AgentSessionLike> {
  return async () => {
    const { createAgentSession, AuthStorage, ModelRegistry, SessionManager } =
      await import("@earendil-works/pi-coding-agent");

    const { provider, modelId } = splitModelId(cfg.model.id);

    const authStorage = AuthStorage.create();
    authStorage.setRuntimeApiKey(provider, cfg.model.apiKey);

    // Path A (file): load the provider+model from a Pi models.json when it's
    // configured and present — single source of truth, zero drift. Path B
    // (inline): build the provider+model from the cfg.model.* fields. If the
    // file path can't resolve the model, fall through to inline.
    let modelRegistry: any;
    let model: any;
    if (cfg.model.modelsJson && existsSync(cfg.model.modelsJson)) {
      modelRegistry = ModelRegistry.create(authStorage, cfg.model.modelsJson);
      model = modelRegistry.find(provider, modelId);
      if (!model) {
        log.warn("model not in models.json; using inline [model] config", {
          modelsJson: cfg.model.modelsJson,
          provider,
          modelId,
        });
      }
    }
    if (!model) {
      const { providerConfig } = buildInlineProviderConfig(cfg);
      modelRegistry = ModelRegistry.inMemory(authStorage);
      modelRegistry.registerProvider(provider, providerConfig as any);
      model = modelRegistry.find(provider, modelId);
    }
    if (!model) {
      throw new Error(
        `Pi model "${provider}/${modelId}" not found in registry (baseUrl: ${apiBaseUrl(cfg.model.baseUrl)}).`,
      );
    }

    // Sandbox (opt-in): replace built-in tools with sandboxed operations and
    // freeze ambient extension loading. Inert when [sandbox].enabled is false —
    // resolveSandbox returns null and the session is built exactly as before.
    let sandboxTools: unknown[] | undefined;
    let sandboxLoader: unknown;
    const resolved = await resolveSandbox(cfg, cwd, overrides);
    if (resolved) {
      // The per-tool create<X>ToolDefinition factories + DefaultResourceLoader
      // are the root-exported symbols the sandbox glue needs (the generic
      // createToolDefinition is not root-exported; the deep import is blocked by
      // the SDK exports map — see tests/sdkImportSurface.test.ts).
      const sdk = (await import("@earendil-works/pi-coding-agent")) as unknown as SdkToolFactories;
      const built = buildSandbox(sdk, {
        cwd,
        toolNames: overrides?.tools ?? cfg.tools,
        backend: resolved.backend,
        policy: resolved.policy,
        home: homedir(),
      });
      sandboxTools = built.customTools;
      sandboxLoader = built.resourceLoader;
    }

    const { session } = await createAgentSession({
      cwd,
      model,
      // Worker default from config; the critic overrides this (cfg.criticThinking).
      thinkingLevel: (overrides?.thinkingLevel ?? cfg.model.thinkingLevel) as ThinkingLevel,
      authStorage,
      modelRegistry,
      // The critic passes `[]` (no tools — diff-vs-spec review needs none);
      // default is the configured worker allowlist.
      tools: overrides?.tools ?? cfg.tools,
      sessionManager: SessionManager.inMemory(cwd),
      // Sandboxed tool set + no-extensions loader (only when enabled). The
      // sandbox glue is intentionally SDK-free (returns unknown[]); cast here at
      // the single SDK boundary. Shapes are validated by tests/sandboxBuild +
      // the platform-gated integration suite.
      ...(sandboxTools ? { customTools: sandboxTools as never } : {}),
      ...(sandboxLoader ? { resourceLoader: sandboxLoader as never } : {}),
    });
    return session;
  };
}
