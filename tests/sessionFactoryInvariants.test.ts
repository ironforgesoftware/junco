import { describe, it, expect } from "vitest";
import { sdkRegistryOps, NOOP_MODELS_STORE } from "../src/agent/session.js";
import {
  inMemoryCredentialStore,
  type InMemoryCredentialStore,
} from "../src/agent/credentialStore.js";

// `sdkRegistryOps` is the single `ModelRuntime.create` call site behind
// `makePiSessionFactory`, `getResolvedModelInfo` and `listCatalogProviders`.
// Its doc comment calls all four options load-bearing for the key-never-on-disk
// invariant, and every one of them is a *default* the SDK would otherwise fill
// with a file-backed object under ~/.pi: dropping `credentials` makes the SDK
// CREATE ~/.pi/agent/auth.json with the operator's key in it; dropping
// `modelsStore` writes models-store.json next to the operator's models.json.
// These assert the option literal itself, against a fake runtime — no SDK.
function captureRuntime() {
  const calls: Record<string, unknown>[] = [];
  const registered: Array<[string, Record<string, unknown>]> = [];
  const runtime = {
    getModel: (provider: string, modelId: string) => ({ provider, modelId }),
    getModels: () => [],
    registerProvider: (name: string, config: Record<string, unknown>) => {
      registered.push([name, config]);
    },
  };
  return {
    calls,
    registered,
    runtime,
    ModelRuntime: {
      create: async (options: Record<string, unknown>) => {
        calls.push(options);
        return runtime;
      },
    },
  };
}

describe("sdkRegistryOps — key-never-on-disk option invariants", () => {
  it("hands ModelRuntime.create exactly the four load-bearing options", async () => {
    const fake = captureRuntime();
    const credentials = inMemoryCredentialStore({ omlx: "sk-must-not-persist" });

    await sdkRegistryOps(fake.ModelRuntime, credentials).fromFile("/sbxroot/models.json");

    expect(fake.calls).toHaveLength(1);
    const opts = fake.calls[0]!;
    // Exactly these keys: a missing one is a silent fall-back to an SDK
    // file-backed default, so absence matters as much as value.
    expect(Object.keys(opts).sort()).toEqual([
      "credentials",
      "modelsPath",
      "modelsStore",
      "refreshOnCreate",
    ]);
    expect(opts.credentials).toBe(credentials);
    expect(opts.modelsPath).toBe("/sbxroot/models.json");
    expect(opts.refreshOnCreate).toBe(false);
    expect(opts.modelsStore).toBe(NOOP_MODELS_STORE);
  });

  it("states modelsPath explicitly as null on the in-memory path", async () => {
    const fake = captureRuntime();

    await sdkRegistryOps(fake.ModelRuntime, inMemoryCredentialStore()).inMemory();

    const opts = fake.calls[0]!;
    // Explicit null, not omission: an absent `modelsPath` resolves to
    // ~/.pi/agent/models.json.
    expect("modelsPath" in opts).toBe(true);
    expect(opts.modelsPath).toBeNull();
    expect(opts.refreshOnCreate).toBe(false);
    expect(opts.modelsStore).toBe(NOOP_MODELS_STORE);
  });

  it("passes the seeded in-memory credential store straight through", async () => {
    const fake = captureRuntime();
    const credentials = inMemoryCredentialStore({ omlx: "sk-must-not-persist" });

    const ops = sdkRegistryOps(fake.ModelRuntime, credentials);
    await ops.fromFile("/sbxroot/models.json");
    await ops.inMemory();

    for (const opts of fake.calls) {
      const store = opts.credentials as InMemoryCredentialStore;
      expect(store).toBe(credentials);
      // The key reaches the SDK only through this object — reading it back is
      // what proves the store is the in-memory one, not a file-backed default.
      expect(await store.read("omlx")).toEqual({ type: "api_key", key: "sk-must-not-persist" });
    }
  });

  it("uses one no-op models store that reads empty and writes nowhere", async () => {
    const fake = captureRuntime();
    const ops = sdkRegistryOps(fake.ModelRuntime, inMemoryCredentialStore());
    await ops.fromFile("/sbxroot/models.json");
    await ops.inMemory();

    // One shared store on both paths — not a per-call object, and not absent.
    expect(fake.calls[0]!.modelsStore).toBe(NOOP_MODELS_STORE);
    expect(fake.calls[1]!.modelsStore).toBe(NOOP_MODELS_STORE);
    await expect(NOOP_MODELS_STORE.read()).resolves.toBeUndefined();
    await expect(NOOP_MODELS_STORE.write()).resolves.toBeUndefined();
    await expect(NOOP_MODELS_STORE.delete()).resolves.toBeUndefined();
  });

  it("wraps the created runtime as the registry's find/registerProvider/backing", async () => {
    const fake = captureRuntime();

    const registry = await sdkRegistryOps(fake.ModelRuntime, inMemoryCredentialStore()).inMemory();

    expect(registry.find("omlx", "my-model")).toEqual({ provider: "omlx", modelId: "my-model" });
    registry.registerProvider("omlx", { baseUrl: "http://127.0.0.1:1234/v1" });
    expect(fake.registered).toEqual([["omlx", { baseUrl: "http://127.0.0.1:1234/v1" }]]);
    // `backing` is handed to createAgentSession as `modelRuntime`; losing it
    // makes the SDK build a file-backed ModelRuntime under ~/.pi instead.
    expect(registry.backing).toBe(fake.runtime);
  });
});
