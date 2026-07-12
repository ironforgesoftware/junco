import { describe, it, expect } from "vitest";
import { listCatalogProviders } from "../src/agent/session.js";

// The sandbox wiring in makePiSessionFactory depends on these SDK symbols being
// on the PACKAGE ROOT. The deep import `dist/core/tools/index.js` is blocked by
// the package `exports` map (and `createToolDefinition` is not root-exported),
// so the wiring uses the per-tool `create<X>ToolDefinition` factories instead.
// If a future SDK bump drops any of these from the root, this test fails loudly.
describe("Pi SDK import surface (sandbox wiring depends on these)", () => {
  it("exposes the per-tool definition factories + resource loader on the root", async () => {
    const mod = (await import("@earendil-works/pi-coding-agent")) as Record<string, unknown>;
    for (const name of [
      "createBashToolDefinition",
      "createReadToolDefinition",
      "createWriteToolDefinition",
      "createEditToolDefinition",
      "createGrepToolDefinition",
      "createFindToolDefinition",
      "createLsToolDefinition",
      "DefaultResourceLoader",
    ]) {
      expect(typeof mod[name], name).toBe("function");
    }
  });
});

describe("Pi SDK import surface (hosted-provider factory wiring depends on these)", () => {
  it("exposes the session-construction statics on the root", async () => {
    const mod = (await import("@earendil-works/pi-coding-agent")) as Record<string, any>;
    for (const name of [
      "createAgentSession",
      "AuthStorage",
      "ModelRegistry",
      "SessionManager",
      "SettingsManager",
    ]) {
      expect(mod[name], name).toBeDefined();
    }
    expect(typeof mod.AuthStorage.inMemory, "AuthStorage.inMemory").toBe("function");
    expect(typeof mod.SettingsManager.inMemory, "SettingsManager.inMemory").toBe("function");
    expect(typeof mod.ModelRegistry.inMemory, "ModelRegistry.inMemory").toBe("function");
    expect(typeof mod.ModelRegistry.create, "ModelRegistry.create").toBe("function");
  });
});

describe("Pi SDK import surface (catalog enumeration depends on this)", () => {
  it("exposes ModelRegistry.prototype.getAll on the root", async () => {
    const mod = (await import("@earendil-works/pi-coding-agent")) as Record<string, any>;
    expect(typeof mod.ModelRegistry.prototype.getAll, "ModelRegistry#getAll").toBe("function");
  });

  // Integration-flavored: exercises the real SDK (no network — the catalog is
  // embedded data), proving listCatalogProviders' grouping/sorting against the
  // actual shape ModelRegistry.getAll() returns, not just a pinned method name.
  it("listCatalogProviders returns a non-empty, sorted catalog", async () => {
    const catalog = await listCatalogProviders();
    expect(catalog.length).toBeGreaterThan(0);
    for (const entry of catalog) {
      expect(entry).toMatchObject({ provider: expect.any(String), ids: expect.any(Array) });
      expect(entry.ids.length).toBeGreaterThan(0);
      expect(entry.ids).toEqual([...entry.ids].sort());
    }
    const providers = catalog.map((e) => e.provider);
    expect(providers).toEqual([...providers].sort());
  });
});
