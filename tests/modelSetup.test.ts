import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  splitModelId,
  apiBaseUrl,
  buildInlineProviderConfig,
  resolveProbeBaseUrl,
} from "../src/agent/modelSetup.js";
import type { Config, ModelConfig } from "../src/types.js";

const MODEL_DEFAULTS: ModelConfig = {
  id: "omlx/Qwen3.6-27B-oQ8-mtp",
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
