import { describe, it, expect } from "vitest";
import { inferProvider, fetchModels, parseModelsJson } from "../src/wizard/models.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("inferProvider", () => {
  it.each([
    ["https://api.openai.com/v1", "openai"],
    ["https://openrouter.ai/api/v1", "openrouter"],
    ["https://api.anthropic.com/v1", "anthropic"],
    ["http://127.0.0.1:1234/v1", "local"],
    ["http://localhost:1234/v1", "local"],
    ["https://api.together.xyz/v1", "together"],
    ["https://my-llm.fly.dev/v1", "fly"],
    ["not a url", "custom"],
  ])("%s → %s", (url, want) => expect(inferProvider(url)).toBe(want));
});

describe("fetchModels", () => {
  it("parses data[].id and sends Bearer auth to <base>/models", async () => {
    let seenUrl = "",
      seenAuth = "";
    const fetchFn = (async (url: string, init: RequestInit) => {
      seenUrl = String(url);
      seenAuth = String((init.headers as Record<string, string>).Authorization);
      return { ok: true, json: async () => ({ data: [{ id: "m-a" }, { id: "m-b" }] }) } as Response;
    }) as unknown as typeof fetch;
    const ids = await fetchModels("http://h:1/v1", "sk-x", { fetchFn });
    expect(ids).toEqual(["m-a", "m-b"]);
    expect(seenUrl).toBe("http://h:1/v1/models");
    expect(seenAuth).toBe("Bearer sk-x");
  });

  it("returns [] on non-200", async () => {
    const fetchFn = (async () => ({ ok: false }) as Response) as unknown as typeof fetch;
    expect(await fetchModels("http://h/v1", "k", { fetchFn })).toEqual([]);
  });

  it("returns [] when fetch throws", async () => {
    const fetchFn = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    expect(await fetchModels("http://h/v1", "k", { fetchFn })).toEqual([]);
  });

  it("returns [] on timeout", async () => {
    const fetchFn = (async (_u: string, init: RequestInit) =>
      new Promise<Response>((_res, rej) => {
        (init.signal as AbortSignal).addEventListener("abort", () => rej(new Error("aborted")));
      })) as unknown as typeof fetch;
    expect(await fetchModels("http://h/v1", "k", { fetchFn, timeoutMs: 5 })).toEqual([]);
  });
});

describe("parseModelsJson", () => {
  it("lists provider/model for every entry", () => {
    const dir = mkdtempSync(join(tmpdir(), "junco-mj-"));
    const p = join(dir, "models.json");
    writeFileSync(
      p,
      JSON.stringify({
        providers: {
          omlx: { models: [{ id: "alpha" }, { id: "beta" }] },
          openai: { models: [{ id: "gpt-x" }] },
        },
      }),
    );
    expect(parseModelsJson(p).sort()).toEqual(["omlx/alpha", "omlx/beta", "openai/gpt-x"].sort());
    rmSync(dir, { recursive: true, force: true });
  });
  it("returns [] for a missing/invalid file", () => {
    expect(parseModelsJson("/no/such/models.json")).toEqual([]);
  });
});
