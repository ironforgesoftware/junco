import type { Config, RunResult } from "../types.js";
import { RunAccumulator } from "./runResult.js";
import { GuardManager } from "./guardManager.js";

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
  subscribe(listener: (event: any) => void): () => void;
  prompt(text: string, options?: unknown): Promise<void>;
  dispose(): void;
  abort(): Promise<void>;
}

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
}

/**
 * Run a single prompt against an injected session and reduce its event stream
 * to a `RunResult`. The session is dependency-injected so the orchestrator
 * (Task 8) is testable with a fake; the real wiring lives in
 * `makePiSessionFactory` and is proven by the e2e (Task 9).
 */
export async function runAgent(opts: RunAgentOptions): Promise<RunResult> {
  const acc = new RunAccumulator();
  const gm = opts.guardManager;
  const session = await opts.createSession();
  const start = Date.now();
  let timedOut = false;
  let killReason: string | null = null;
  let unsubscribe: (() => void) | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    // abort() resolves the in-flight prompt() so runAgent can return. Guard the
    // rejection so a failed abort can't surface as an unhandled rejection.
    void session.abort().catch(() => {});
  }, opts.timeoutMs);
  try {
    // Subscribe immediately before prompt() (so no startup events are missed),
    // but inside the try so the session is still disposed if subscribe throws.
    unsubscribe = session.subscribe((e) => {
      acc.observe(e);
      if (!gm) return;
      // A kill is terminal — once decided, stop feeding the guard (further
      // events from the aborting run shouldn't produce more decisions).
      if (killReason !== null) return;
      const decision = gm.observe(e);
      if (!decision) return;
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
      }
    });
    await session.prompt(opts.body);
  } catch (e) {
    acc.setError(e instanceof Error ? e.message : String(e));
  } finally {
    clearTimeout(timer);
    unsubscribe?.();
    session.dispose();
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
 * local oMLX OpenAI-compatible server.
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
 * The provider/model values (compat block, reasoning, contextWindow, maxTokens,
 * thinkingFormat) are copied from the VALIDATED `~/.pi/agent/models.json` the
 * Python worker used against this same oMLX server — so the embedded run matches
 * the proven baseline rather than guessed defaults. The `ProviderConfigInput`
 * shape matches `docs/custom-provider.md` + the on-disk schema in `docs/models.md`.
 * (A later milestone can source these from config instead of hardcoding.)
 *
 * baseUrl: `cfg.omlx.url` is the list-models endpoint (`.../v1/models`, used by
 * the health check); the provider API base is its parent (`.../v1`), derived via
 * `apiBaseUrl()`.
 *
 * Auth: the oMLX API key is injected via `authStorage.setRuntimeApiKey(provider,
 * key)` (auth-storage.d.ts:63), which is the HIGHEST-priority source in
 * `getApiKey` (auth-storage.d.ts:124-134) — so no `apiKey` field is needed in
 * the provider config, and nothing is persisted to disk.
 *
 * Model id: `cfg.modelId` is provider-prefixed (e.g. "omlx/Qwen3.6-...-mtp"),
 * mirroring what the Python worker passed to the `--model` CLI flag. We split on
 * the first "/" into provider + bare model id, since the programmatic
 * `registerProvider`/`find` APIs take them separately.
 *
 * The model is a reasoning model (`reasoning: true` + qwen thinking template),
 * matching the validated config; `thinkingLevel: "medium"` keeps thinking on.
 *
 * `overrides` lets a caller (e.g. the post-session critic) build a session with
 * NO tools (`tools: []`) and a different thinking level. When omitted the
 * existing defaults (`cfg.tools`, `"medium"`) are preserved unchanged.
 */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface SessionOverrides {
  tools?: string[];
  thinkingLevel?: ThinkingLevel | string;
}

export function makePiSessionFactory(
  cfg: Config,
  cwd: string,
  overrides?: SessionOverrides,
): () => Promise<AgentSessionLike> {
  return async () => {
    const { createAgentSession, AuthStorage, ModelRegistry, SessionManager } =
      await import("@earendil-works/pi-coding-agent");

    const { provider, modelId } = splitModelId(cfg.modelId);

    const authStorage = AuthStorage.create();
    authStorage.setRuntimeApiKey(provider, cfg.omlx.apiKey);

    const modelRegistry = ModelRegistry.inMemory(authStorage);
    modelRegistry.registerProvider(provider, {
      name: provider,
      baseUrl: apiBaseUrl(cfg.omlx.url),
      // registerProvider RUNTIME-validates that apiKey (or oauth) is present when
      // models are defined — even though the type marks it optional and we also
      // set a runtime key above. The validated models.json carries it inline too.
      apiKey: cfg.omlx.apiKey,
      api: "openai-completions",
      models: [
        {
          id: modelId,
          name: modelId,
          reasoning: true,
          input: ["text", "image"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 131072,
          maxTokens: 49152,
          // compat is per-MODEL in the programmatic ProviderConfigInput API
          // (the on-disk models.json splits it provider/model; we merge here).
          // Copied from the validated ~/.pi/agent/models.json. maxTokensField is
          // load-bearing: oMLX rejects the auto-detected `max_completion_tokens`.
          compat: {
            supportsDeveloperRole: false,
            supportsReasoningEffort: false,
            maxTokensField: "max_tokens",
            supportsUsageInStreaming: true,
            thinkingFormat: "qwen-chat-template",
          },
        },
      ],
    });

    const model = modelRegistry.find(provider, modelId);
    if (!model) {
      throw new Error(
        `Pi model "${provider}/${modelId}" not found in registry after registering provider "${provider}" (baseUrl: ${apiBaseUrl(cfg.omlx.url)}).`,
      );
    }

    const { session } = await createAgentSession({
      cwd,
      model,
      // Reasoning model (qwen thinking template); "medium" matches typical
      // worker operation. The critic overrides this (e.g. cfg.criticThinking).
      thinkingLevel: (overrides?.thinkingLevel ?? "medium") as ThinkingLevel,
      authStorage,
      modelRegistry,
      // The critic passes `[]` (no tools — diff-vs-spec review needs none);
      // default is the configured worker allowlist.
      tools: overrides?.tools ?? cfg.tools,
      sessionManager: SessionManager.inMemory(cwd),
    });
    return session;
  };
}

/**
 * Split a provider-prefixed model id ("omlx/Qwen3.6-...") into its provider and
 * bare model id. Splits on the FIRST "/" only, so model ids that themselves
 * contain slashes (e.g. "openrouter/anthropic/claude") are preserved. If there
 * is no "/", the whole string is treated as the model id under the default
 * "omlx" provider.
 */
export function splitModelId(full: string): { provider: string; modelId: string } {
  const slash = full.indexOf("/");
  if (slash === -1) return { provider: "omlx", modelId: full };
  return { provider: full.slice(0, slash), modelId: full.slice(slash + 1) };
}

/**
 * Derive the OpenAI-compatible API base from the configured oMLX URL. The repo
 * config's `[oMLX].url` points at the list-models endpoint (`.../v1/models`),
 * but the provider baseUrl must be the API root (`.../v1`). Strip a trailing
 * `/models` (with optional trailing slash); otherwise return as-is.
 */
export function apiBaseUrl(url: string): string {
  return url.replace(/\/models\/?$/, "");
}
