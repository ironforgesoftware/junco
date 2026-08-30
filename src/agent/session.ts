import { mkdirSync, createWriteStream, mkdtempSync, type WriteStream } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir, homedir } from "node:os";
import type { AgentSessionEvent, CreateModelRuntimeOptions } from "@earendil-works/pi-coding-agent";
import type { Config, RunResult, ModelCost } from "../types.js";
import { RunAccumulator } from "./runResult.js";
import { GuardManager, type GuardDecision } from "./guardManager.js";
import { log } from "../logging.js";
import {
  splitModelId,
  resolveModelViaRegistries,
  type RegistryLike,
  type RegistryOps,
} from "./modelSetup.js";
import { inMemoryCredentialStore, type InMemoryCredentialStore } from "./credentialStore.js";
import {
  buildPolicy,
  linkedWorktreeWritePaths,
  type GitDirs,
  type SandboxPolicy,
} from "./sandbox/policy.js";
import { resolveGitDirs } from "./sandbox/gitDirs.js";
import { sandboxDenyPaths } from "../dataTree.js";
import {
  selectBackend,
  classifyAvailability,
  noneBackend,
  defaultExecProbe,
  type SandboxBackend,
  type BackendAvailability,
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
 * Verified against the installed SDK 0.84.2 (`dist/core/agent-session.d.ts`):
 *   - subscribe(listener): () => void   (line 276)
 *   - prompt(text, options?): Promise<void>  (line 355; resolves after the agent loop finishes)
 *   - dispose(): void   (line 283)
 *   - abort(): Promise<void>   (line 433)
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
   * Caller-owned, already-open transcript sink (the run envelope). Append
   * every non-delta event as a JSON line — the debugging record for failed
   * runs; write failures only warn. runAgent never end()s it — the caller
   * (runEnveloped) opened it and writes its own junco_run_start/run_end
   * frame around this run's events, so it also owns closing it.
   */
  transcript?: TranscriptSink | null;
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
  // Transcript writes go through a caller-owned sink (#128): runEnveloped
  // opens it and frames it with its own junco_run_start/run_end records.
  // Sink-internal failures degrade to a warning and drop the transcript, so
  // the write sites below stay best-effort. runAgent never end()s it — the
  // caller owns the lifecycle.
  const transcript: TranscriptSink | null = opts.transcript ?? null;
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
    // No transcript.end() here: the caller (runEnveloped) owns the sink's
    // lifecycle and closes it after writing its own run_end frame.
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
 * configured OpenAI-compatible endpoint or a catalog-resolved hosted provider.
 *
 * PROVIDER/MODEL RESOLUTION is delegated to `resolveModelViaRegistries`
 * (./modelSetup.js): the three-way cascade — Pi `models.json` → the SDK's
 * builtin hosted catalog → an inline in-memory `registerProvider` — behind the
 * `RegistryLike`/`RegistryOps` seam so that logic is unit-testable without an
 * SDK import. This factory supplies the registry ops via `sdkRegistryOps`
 * (below), which bridges to the SDK's async `ModelRuntime.create` bound to
 * junco's own `credentials` store, and consumes the resolved
 * `{ model, registry }`.
 *
 * Auth: `credentials` is a junco-owned in-memory `CredentialStore`
 * (`inMemoryCredentialStore`, ./credentialStore.js) seeded with the resolved
 * `cfg.model.apiKey` under `provider` before `ModelRuntime.create` runs — it
 * never touches the operator's real `~/.pi/agent/auth.json`. Passing
 * `credentials` explicitly is load-bearing: `ModelRuntime.create`'s own
 * default is a store file-backed at `authPath`, and that backend CREATES the
 * file (`CreateModelRuntimeOptions.credentials`/`.authPath`, `dist/core/
 * model-runtime.d.ts:4-6`, verified against 0.84.2 — `AuthStorage` itself is
 * no longer exported from the SDK's root; only `readStoredCredential` is,
 * per `dist/index.d.ts:4`). A null `cfg.model.apiKey` seeds nothing and
 * defers to the SDK's own provider env-var fallback at request time.
 *
 * Settings: `SettingsManager.inMemory({ retry })` avoids reading
 * `~/.pi/agent/settings.json` or the target repo's `.pi/settings.json` (the
 * latter trusted by default by the SDK — a repo-controlled injection surface
 * for a queue worker). Retry knobs (`cfg.model.retry`) pass through only when
 * configured; SDK defaults apply otherwise.
 *
 * baseUrl: `cfg.model.baseUrl` may point at the list-models endpoint
 * (`.../v1/models`); the provider API base is its parent (`.../v1`), derived via
 * `apiBaseUrl()`.
 *
 * Model id: `cfg.model.id` is provider-prefixed (e.g. "openai/gpt-4o-mini").
 * We split on the first "/" into provider + bare model id (`splitModelId`,
 * consumed by `resolveModelViaRegistries` for the models.json/catalog/inline
 * cascade); here the split instead feeds the `credentials` seed's key
 * (`{ [provider]: cfg.model.apiKey }`).
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
  /** Where the cwd's git metadata lives (#320) — default asks `git rev-parse`
   *  in the cwd via resolveGitDirs; tests inject the answer (or null). */
  gitDirs?: (cwd: string) => Promise<GitDirs | null>;
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

  let backend = selectBackend(cfg.sandbox.backend, platform);
  const availability: BackendAvailability =
    backend.name === "none" ? { available: true } : await backend.checkAvailability(probe);
  const outcome = classifyAvailability(cfg.sandbox.backend, backend.name, availability.available);
  // #312: the probe's own words, when it had any. "Install bubblewrap" is
  // actively misleading when bubblewrap IS installed and the kernel refused
  // (ubuntu-24.04's kernel.apparmor_restrict_unprivileged_userns=1), so the
  // refusal is quoted verbatim ahead of the install hint. Diagnostic only —
  // `outcome` above is already decided.
  const why = availability.reason === undefined ? "" : ` Probe said: ${availability.reason}.`;
  if (outcome === "fail-closed") {
    // Explicit backend the operator demanded is unavailable — never silently
    // run less-sandboxed than they asked. (auto degrades instead; see below.)
    throw new SandboxUnavailableError(
      `sandbox backend "${backend.name}" unavailable (binary missing or non-functional).${why} ` +
        `Install it, or set sandbox.backend="none" / sandbox.enabled=false.`,
    );
  }
  if (outcome === "degrade") {
    // backend="auto" means "best available"; with no OS backend, fall back to
    // none (env scrub + filesystem tool-jail still apply, but agent bash is NOT
    // OS-confined — reads/network unrestricted) rather than failing the ticket.
    log.warn(
      `sandbox: no OS backend available (${backend.name}); degrading to backend=none — ` +
        `env scrub + filesystem tool-jail still apply, but agent bash is not OS-confined.${why} ` +
        `Install the backend (e.g. bubblewrap on Linux) for full isolation.`,
      {
        platform,
        configured: cfg.sandbox.backend,
        ...(availability.reason === undefined ? {} : { probe: availability.reason }),
      },
    );
    backend = noneBackend;
  }
  const network = overrides?.network ?? cfg.sandbox.network === "allow";
  const scratchDir = makeScratch();
  // #320: a linked worktree's index/objects/refs live under the owning repo's
  // .git, outside the cwd — without these roots the agent's first `git commit`
  // dies with "Unable to create '…/index.lock': Operation not permitted".
  const gitDirs = await (deps.gitDirs ?? ((c: string) => resolveGitDirs(cfg, c)))(cwd);
  const gitWritePaths = gitDirs ? linkedWorktreeWritePaths({ cwd, ...gitDirs }) : [];
  // #277: the data tree is denied WHOLESALE and its execution roots (the
  // worktrees and the clone gitdirs this session's git reads) are allowed
  // back. Both halves must be threaded in — the denies alone would wall the
  // agent out of its own worktree; the allows alone would leave the queue
  // readable. Precedence between them is by specificity, not list order (see
  // sandbox/precedence.ts). #320 threads a third input the same way — the
  // linked worktree's git common dir (`gitWritePaths` above) — as a writable
  // root that out-specifies the data-root deny.
  const dataPaths = sandboxDenyPaths(cfg);
  const policy = buildPolicy({
    cfg: cfg.sandbox,
    cwd,
    scratchDir,
    gitWritePaths,
    home,
    dataDenyPaths: dataPaths,
    dataAllowPaths: dataPaths.allowDirs,
    network,
    botGhConfigDir: cfg.botAccount.configDir,
  });
  return { backend, policy };
}

/** The `ModelRuntime` surface junco uses, kept narrow so the cast at this
 * boundary is auditable (verified against 0.84.2 `dist/core/model-runtime.d.ts`:
 * `getModel`/`getModels`/`registerProvider`). */
interface SdkModelRuntime {
  getModel(providerId: string, modelId: string): unknown;
  getModels(providerId?: string): readonly unknown[];
  registerProvider(providerId: string, config: Record<string, unknown>): void;
}

/**
 * A models store that never touches disk. `ModelRuntime.create` otherwise
 * defaults to a `FileModelsStore` writing `models-store.json` NEXT TO the
 * operator's models.json — junco must not write there.
 */
const NOOP_MODELS_STORE = {
  read: async () => undefined,
  write: async () => {},
  delete: async () => {},
};

/**
 * Bridge from the SDK's async `ModelRuntime.create` to
 * `resolveModelViaRegistries`' SDK-free `RegistryOps` seam. Shared by
 * `makePiSessionFactory`, `getResolvedModelInfo`, and `listCatalogProviders`
 * so the cast-through-`unknown` lives in exactly one place.
 *
 * Every option here is load-bearing for the key-never-on-disk invariant:
 * `credentials` (default is file-backed `~/.pi/agent/auth.json`, and the
 * backend CREATES it), `modelsPath` stated explicitly (default is
 * `~/.pi/agent/models.json`), `refreshOnCreate: false` plus `modelsStore` (the
 * default file store can write beside the operator's models.json).
 * `allowModelNetwork` defaults to false and is left alone. Junco's three
 * cascade paths are all static, so skipping the refresh costs nothing.
 */
// The OBJECT LITERAL passed to `create()` below is annotated with `satisfies
// CreateModelRuntimeOptions` (imported type-only from the SDK root, which
// root-exports it — `dist/index.d.ts`). That gets excess-property checking on
// the four option NAMES: a typo (e.g. `modelPath` for `modelsPath`) is TS2561
// ("Did you mean to write 'modelsPath'?"), not a silent miss — verified by
// injecting that exact typo and confirming `npm run typecheck` names
// `modelsPath` as the intended key, then reverting. `credentials` needed no
// separate cast — `InMemoryCredentialStore` satisfies the SDK's
// `CredentialStore` here because `modify` is declared with method-shorthand
// syntax on both interfaces, which tsc checks bivariantly regardless of
// `strictFunctionTypes`.
function sdkRegistryOps(
  ModelRuntimeStatic: { create(options: Record<string, unknown>): Promise<unknown> },
  credentials: InMemoryCredentialStore,
): RegistryOps {
  const make = async (modelsPath: string | null): Promise<RegistryLike> => {
    const runtime = (await ModelRuntimeStatic.create({
      credentials,
      modelsPath,
      refreshOnCreate: false,
      modelsStore: NOOP_MODELS_STORE,
    } satisfies CreateModelRuntimeOptions)) as SdkModelRuntime;
    return {
      find: (provider, modelId) => runtime.getModel(provider, modelId),
      registerProvider: (name, config) => runtime.registerProvider(name, config),
      backing: runtime,
    };
  };
  return { fromFile: (p) => make(p), inMemory: () => make(null) };
}

/** The subset of the SDK's resolved `Model<Api>` fields `getResolvedModelInfo`
 * surfaces (verified against the installed 0.84.2: `@earendil-works/pi-ai`
 * resolves as a nested dependency of `pi-coding-agent`, not hoisted to the
 * workspace root — `node_modules/@earendil-works/pi-coding-agent/node_modules/
 * @earendil-works/pi-ai/dist/types.d.ts:670-691`: `id`, `provider`, `baseUrl`,
 * `api`, `cost` all present on every resolved model regardless of cascade
 * path). */
interface SdkResolvedModelFields {
  provider: string;
  id: string;
  baseUrl: string;
  api: string;
  cost: ModelCost;
}

export interface ResolvedModelInfo {
  provider: string;
  modelId: string;
  baseUrl: string;
  api: string;
  cost: ModelCost;
  path: "models_json" | "catalog" | "inline";
}

/**
 * Resolve a model id through the same models.json → builtin catalog → inline
 * cascade `makePiSessionFactory` uses (`resolveModelViaRegistries`), and
 * surface the resolved model's fields — for `doctor` and the config wizard to
 * validate a model id without constructing a full agent session.
 *
 * `modelId`, when given, OVERRIDES `cfg.model.id` (same endpoint/apiKey/source
 * — mirrors the planner-model override in runOnce.ts:317) so a planner-model
 * preflight can check the override resolves before a Q&A ticket runs it.
 *
 * Throws whatever `resolveModelViaRegistries` throws on a cascade miss (no
 * models.json match, no catalog match, and no inline apiKey configured) —
 * callers surface that message as-is (doctor prints it; the wizard rejects
 * the input).
 */
export async function getResolvedModelInfo(
  cfg: Config,
  modelId?: string,
): Promise<ResolvedModelInfo> {
  const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");

  const model = modelId !== undefined ? { ...cfg.model, id: modelId } : cfg.model;
  const effectiveCfg: Config = modelId !== undefined ? { ...cfg, model } : cfg;

  // Ephemeral in-memory credentials, exactly like the real factory — never
  // touches ~/.pi/agent/auth.json. See credentialStore.ts for the invariant.
  const credentials = inMemoryCredentialStore(
    model.apiKey !== null ? { [splitModelId(model.id).provider]: model.apiKey } : {},
  );

  const resolved = await resolveModelViaRegistries(
    effectiveCfg,
    sdkRegistryOps(ModelRuntime, credentials),
  );
  const m = resolved.model as SdkResolvedModelFields;
  return {
    provider: m.provider,
    modelId: m.id,
    baseUrl: m.baseUrl,
    api: m.api,
    cost: m.cost,
    path: resolved.path,
  };
}

export interface CatalogEntry {
  provider: string;
  ids: string[];
}

/**
 * Enumerate the SDK's built-in hosted-model catalog, grouped by provider — the
 * COMPLETE list (no filtering/favorites), for the config wizard's provider
 * picker. A `ModelRuntime` built with `modelsPath: null` has no models.json
 * backing it, so `.getModels()` (`model-runtime.d.ts:64`) returns exactly the
 * built-in catalog here. Embedded data — no network call.
 */
export async function listCatalogProviders(): Promise<CatalogEntry[]> {
  const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
  const registry = await sdkRegistryOps(ModelRuntime, inMemoryCredentialStore()).inMemory();
  const models = (registry.backing as SdkModelRuntime).getModels() as SdkResolvedModelFields[];

  const idsByProvider = new Map<string, string[]>();
  for (const m of models) {
    const ids = idsByProvider.get(m.provider);
    if (ids) ids.push(m.id);
    else idsByProvider.set(m.provider, [m.id]);
  }
  return Array.from(idsByProvider.entries())
    .map(([provider, ids]) => ({ provider, ids: ids.sort() }))
    .sort((a, b) => a.provider.localeCompare(b.provider));
}

export function makePiSessionFactory(
  cfg: Config,
  cwd: string,
  overrides?: SessionOverrides,
): () => Promise<AgentSessionLike> {
  return async () => {
    const { createAgentSession, ModelRuntime, SessionManager, SettingsManager } =
      await import("@earendil-works/pi-coding-agent");

    const { provider } = splitModelId(cfg.model.id);

    // In-memory credentials: the SDK's default store file-backs onto the
    // operator's real ~/.pi/agent/auth.json (creating it if absent) — junco
    // must never touch it. A null key seeds nothing and defers to the SDK's
    // request-time provider env-var fallback (ANTHROPIC_API_KEY, … — see
    // resolveApiKey in config.ts).
    const credentials = inMemoryCredentialStore(
      cfg.model.apiKey !== null ? { [provider]: cfg.model.apiKey } : {},
    );

    // models.json → builtin catalog → inline (see resolveModelViaRegistries).
    const resolvedModel = await resolveModelViaRegistries(
      cfg,
      sdkRegistryOps(ModelRuntime, credentials),
      (msg, meta) => log.warn(msg, meta),
    );
    const model = resolvedModel.model as any;
    // The SAME runtime resolution ran on — an inline provider registered
    // during the cascade lives on this object, so the session must use it.
    const modelRuntime = resolvedModel.registry.backing as any;
    if (!modelRuntime) {
      throw new Error(
        "internal: resolved registry carries no SDK runtime handle — createAgentSession would " +
          "fall back to a file-backed ModelRuntime under ~/.pi and lose the inline provider.",
      );
    }

    // Sandbox (on by default): replace built-in tools with sandboxed operations
    // and freeze ambient extension loading. Inert when sandbox.enabled is false —
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
      modelRuntime,
      // The critic passes `[]` (no tools — diff-vs-spec review needs none);
      // default is the configured worker allowlist.
      tools: overrides?.tools ?? cfg.tools,
      sessionManager: SessionManager.inMemory(cwd),
      // Never read ~/.pi/agent/settings.json or the target repo's
      // .pi/settings.json (trusted by default by the SDK — a repo-controlled
      // injection surface for a queue worker). Retry knobs come from config;
      // SDK defaults apply otherwise.
      settingsManager: SettingsManager.inMemory({
        retry: {
          ...(cfg.model.retry.maxRetries !== null
            ? { maxRetries: cfg.model.retry.maxRetries }
            : {}),
          ...(cfg.model.retry.baseDelayMs !== null
            ? { baseDelayMs: cfg.model.retry.baseDelayMs }
            : {}),
        },
      }),
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
