import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  splitModelId,
  apiBaseUrl,
  buildInlineProviderConfig,
  resolveProbeBaseUrl,
  catalogEligible,
  resolveModelViaRegistries,
  shouldProbeEndpoint,
} from "../src/agent/modelSetup.js";
import type { Config, ModelConfig } from "../src/types.js";

const MODEL_DEFAULTS: ModelConfig = {
  id: "omlx/Qwen3.6-27B-oQ8-mtp",
  source: "auto",
  baseUrlExplicit: false,
  retry: { maxRetries: null, baseDelayMs: null },
  modelsJson: null,
  api: "openai-completions",
  baseUrl: "http://127.0.0.1:1234/v1",
  apiKey: "1234",
  reasoning: true,
  input: ["text", "image"],
  contextWindow: 131072,
  maxTokens: 49152,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  thinkingLevel: "medium",
  compat: { maxTokensField: "max_tokens", thinkingFormat: "qwen-chat-template" },
};

function mkCfg(model: Partial<ModelConfig> = {}): Config {
  return { model: { ...MODEL_DEFAULTS, ...model } } as Config;
}

describe("splitModelId / apiBaseUrl", () => {
  it("splits on the first slash; defaults provider to local", () => {
    expect(splitModelId("omlx/Qwen3.6")).toEqual({ provider: "omlx", modelId: "Qwen3.6" });
    expect(splitModelId("openrouter/anthropic/claude")).toEqual({
      provider: "openrouter",
      modelId: "anthropic/claude",
    });
    expect(splitModelId("bare")).toEqual({ provider: "local", modelId: "bare" });
  });
  it("strips a trailing /models from the base url", () => {
    expect(apiBaseUrl("http://h:1/v1/models")).toBe("http://h:1/v1");
    expect(apiBaseUrl("http://h:1/v1/models/")).toBe("http://h:1/v1");
    expect(apiBaseUrl("http://h:1/v1")).toBe("http://h:1/v1");
  });
});

describe("buildInlineProviderConfig", () => {
  it("maps the default model config to a provider config", () => {
    const { provider, modelId, providerConfig } = buildInlineProviderConfig(mkCfg());
    expect(provider).toBe("omlx");
    expect(modelId).toBe("Qwen3.6-27B-oQ8-mtp");
    expect(providerConfig.api).toBe("openai-completions");
    expect(providerConfig.baseUrl).toBe("http://127.0.0.1:1234/v1");
    const m = (providerConfig.models as any[])[0];
    expect(m.id).toBe("Qwen3.6-27B-oQ8-mtp");
    expect(m.contextWindow).toBe(131072);
    expect(m.maxTokens).toBe(49152);
    expect(m.reasoning).toBe(true);
    expect(m.compat.thinkingFormat).toBe("qwen-chat-template");
    expect(m.compat.maxTokensField).toBe("max_tokens");
  });

  it("flows configured overrides through (api, context window, compat)", () => {
    const { provider, providerConfig } = buildInlineProviderConfig(
      mkCfg({
        id: "anthropic/claude",
        api: "anthropic-messages",
        baseUrl: "https://api.example.com/v1",
        contextWindow: 200000,
        maxTokens: 8192,
        reasoning: false,
        compat: { thinkingFormat: "anthropic" },
      }),
    );
    expect(provider).toBe("anthropic");
    expect(providerConfig.api).toBe("anthropic-messages");
    const m = (providerConfig.models as any[])[0];
    expect(m.id).toBe("claude");
    expect(m.contextWindow).toBe(200000);
    expect(m.maxTokens).toBe(8192);
    expect(m.reasoning).toBe(false);
    expect(m.compat.thinkingFormat).toBe("anthropic");
  });

  it("normalizes a /models base url to the API root", () => {
    const { providerConfig } = buildInlineProviderConfig(
      mkCfg({ baseUrl: "http://127.0.0.1:1234/v1/models" }),
    );
    expect(providerConfig.baseUrl).toBe("http://127.0.0.1:1234/v1");
  });
});

describe("resolveProbeBaseUrl", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it("inline mode: returns the normalized base_url", () => {
    expect(resolveProbeBaseUrl(mkCfg({ baseUrl: "http://h:9/v1/models" }))).toBe("http://h:9/v1");
  });

  it("file mode: reads the provider baseUrl from the models.json", () => {
    dir = mkdtempSync(join(tmpdir(), "junco-models-"));
    const p = join(dir, "models.json");
    writeFileSync(
      p,
      JSON.stringify({
        providers: { omlx: { baseUrl: "http://from-file:7/v1/models", api: "openai-completions" } },
      }),
    );
    const cfg = mkCfg({ id: "omlx/x", modelsJson: p, baseUrl: "http://ignored/v1" });
    expect(resolveProbeBaseUrl(cfg)).toBe("http://from-file:7/v1");
  });

  it("file mode: falls back to base_url when the file is missing/unreadable", () => {
    const cfg = mkCfg({ modelsJson: "/no/such/models.json", baseUrl: "http://fallback/v1" });
    expect(resolveProbeBaseUrl(cfg)).toBe("http://fallback/v1");
  });
});

describe("shouldProbeEndpoint", () => {
  it("skips the probe for catalog-eligible configs without a models.json", () => {
    expect(shouldProbeEndpoint(mkCfg({ id: "anthropic/claude-x", modelsJson: null }).model)).toBe(
      false,
    );
  });

  it("probes local/inline configs and any models.json config", () => {
    expect(shouldProbeEndpoint(mkCfg({ id: "local/my-model", modelsJson: null }).model)).toBe(true);
    expect(
      shouldProbeEndpoint(
        mkCfg({ id: "anthropic/claude-x", modelsJson: "/tmp/models.json" }).model,
      ),
    ).toBe(true);
  });
});

describe("catalogEligible", () => {
  it("auto + non-local provider + no explicit baseUrl → eligible", () => {
    expect(
      catalogEligible({
        source: "auto",
        id: "anthropic/claude-sonnet-4-5",
        baseUrlExplicit: false,
      }),
    ).toBe(true);
  });

  it("auto + explicit baseUrl → inline (deliberate proxy/override)", () => {
    expect(
      catalogEligible({ source: "auto", id: "anthropic/claude-sonnet-4-5", baseUrlExplicit: true }),
    ).toBe(false);
  });

  it("auto + local provider (bare or prefixed) → never eligible", () => {
    expect(catalogEligible({ source: "auto", id: "my-model", baseUrlExplicit: false })).toBe(false);
    expect(catalogEligible({ source: "auto", id: "local/my-model", baseUrlExplicit: false })).toBe(
      false,
    );
  });

  it("explicit source wins over the heuristic in both directions", () => {
    expect(catalogEligible({ source: "catalog", id: "openai/gpt-x", baseUrlExplicit: true })).toBe(
      true,
    );
    expect(catalogEligible({ source: "inline", id: "openai/gpt-x", baseUrlExplicit: false })).toBe(
      false,
    );
  });
});

/** A minimal RegistryLike fake. After an inline registration, find() resolves
 * the registered model — mirrors the real registry (registerProvider replaces
 * provider models for that name). */
function fakeRegistry(models: Record<string, unknown>) {
  const registered: Array<{ name: string; config: Record<string, unknown> }> = [];
  return {
    registered,
    find: (p: string, m: string) =>
      models[`${p}/${m}`] ?? (registered.length > 0 ? { fromInline: true } : undefined),
    registerProvider: (name: string, config: Record<string, unknown>) => {
      registered.push({ name, config });
    },
  };
}

/** Fails the test if called — asserts a cascade branch is never reached. */
const fail = async (): Promise<never> => {
  throw new Error("must not be called");
};

describe("resolveModelViaRegistries", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it("models.json hit wins (path models_json), no provider registered", async () => {
    dir = mkdtempSync(join(tmpdir(), "junco-models-"));
    const existingModelsJsonPath = join(dir, "models.json");
    writeFileSync(existingModelsJsonPath, JSON.stringify({ providers: {} }));

    const sentinel = { catalog: "file" };
    const file = fakeRegistry({ "anthropic/claude-x": sentinel });
    const mem = fakeRegistry({});
    const cfg = mkCfg({ id: "anthropic/claude-x", modelsJson: existingModelsJsonPath });
    const out = await resolveModelViaRegistries(cfg, {
      fromFile: async () => file,
      inMemory: async () => mem,
    });
    expect(out).toMatchObject({ model: sentinel, path: "models_json" });
    expect(file.registered).toEqual([]);
  });

  it("catalog hit resolves WITHOUT registerProvider (the clobber bug stays dead)", async () => {
    const sentinel = { catalog: "builtin" };
    const mem = fakeRegistry({ "anthropic/claude-x": sentinel });
    const cfg = mkCfg({ id: "anthropic/claude-x", modelsJson: null, apiKey: null });
    const out = await resolveModelViaRegistries(cfg, { fromFile: fail, inMemory: async () => mem });
    expect(out).toMatchObject({ model: sentinel, path: "catalog" });
    expect(mem.registered).toEqual([]);
  });

  it("catalog miss falls through to inline when a key exists", async () => {
    const mem = fakeRegistry({});
    const cfg = mkCfg({ id: "unknownprov/m1", modelsJson: null, apiKey: "k" });
    const out = await resolveModelViaRegistries(cfg, { fromFile: fail, inMemory: async () => mem });
    expect(out.path).toBe("inline");
    expect(mem.registered[0]?.name).toBe("unknownprov");
  });

  it("catalog miss with a null key throws an actionable config error", async () => {
    const mem = fakeRegistry({});
    const cfg = mkCfg({ id: "unknownprov/m1", modelsJson: null, apiKey: null });
    await expect(
      resolveModelViaRegistries(cfg, { fromFile: fail, inMemory: async () => mem }),
    ).rejects.toThrow(/did not resolve from the builtin catalog/);
  });

  it("ineligible (local) config goes straight to inline", async () => {
    const mem = fakeRegistry({});
    const cfg = mkCfg({ id: "local/my-model", modelsJson: null, apiKey: "1234" });
    const out = await resolveModelViaRegistries(cfg, { fromFile: fail, inMemory: async () => mem });
    expect(out.path).toBe("inline");
  });
});
