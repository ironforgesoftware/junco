import type { Config, RunResult } from "../types.js";
import { RunAccumulator } from "./runResult.js";

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
}

/**
 * Run a single prompt against an injected session and reduce its event stream
 * to a `RunResult`. The session is dependency-injected so the orchestrator
 * (Task 8) is testable with a fake; the real wiring lives in
 * `makePiSessionFactory` and is proven by the e2e (Task 9).
 */
export async function runAgent(opts: RunAgentOptions): Promise<RunResult> {
  const acc = new RunAccumulator();
  const session = await opts.createSession();
  const unsubscribe = session.subscribe((e) => acc.observe(e));
  const start = Date.now();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    // abort() resolves the in-flight prompt() so runAgent can return.
    void session.abort();
  }, opts.timeoutMs);
  try {
    await session.prompt(opts.body);
  } catch (e: any) {
    acc.setError(String(e?.message ?? e));
  } finally {
    clearTimeout(timer);
    unsubscribe();
    session.dispose();
  }
  return acc.result(Date.now() - start, timedOut);
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
 * The exact `ProviderConfigInput` shape used below (provider `omlx`,
 * `api: "openai-completions"`, one model `{ id, name, reasoning, input, cost,
 * contextWindow, maxTokens }`) matches both `docs/custom-provider.md`
 * ("Register New Provider" / "Config Reference" / "Model Definition Reference")
 * and the on-disk schema in `docs/models.md`.
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
 * `thinkingLevel: "off"` is a valid `ThinkingLevel`
 * (pi-agent-core/dist/types.d.ts:249: "off" | "minimal" | "low" | "medium" |
 * "high" | "xhigh"); we keep the local run deterministic and reasoning-free.
 */
export function makePiSessionFactory(cfg: Config, cwd: string): () => Promise<AgentSessionLike> {
  return async () => {
    const { createAgentSession, AuthStorage, ModelRegistry, SessionManager } =
      await import("@earendil-works/pi-coding-agent");

    const { provider, modelId } = splitModelId(cfg.modelId);

    const authStorage = AuthStorage.create();
    authStorage.setRuntimeApiKey(provider, cfg.omlx.apiKey);

    const modelRegistry = ModelRegistry.inMemory(authStorage);
    modelRegistry.registerProvider(provider, {
      name: provider,
      baseUrl: cfg.omlx.url,
      api: "openai-completions",
      models: [
        {
          id: modelId,
          name: modelId,
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 32768,
          maxTokens: 8192,
        },
      ],
    });

    const model = modelRegistry.find(provider, modelId);
    if (!model) {
      throw new Error(
        `Pi model "${provider}/${modelId}" not found in registry after registering provider "${provider}" (baseUrl: ${cfg.omlx.url}).`,
      );
    }

    const { session } = await createAgentSession({
      cwd,
      model,
      thinkingLevel: "off",
      authStorage,
      modelRegistry,
      tools: cfg.tools,
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
function splitModelId(full: string): { provider: string; modelId: string } {
  const slash = full.indexOf("/");
  if (slash === -1) return { provider: "omlx", modelId: full };
  return { provider: full.slice(0, slash), modelId: full.slice(slash + 1) };
}
