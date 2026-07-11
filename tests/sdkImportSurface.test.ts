import { describe, it, expect } from "vitest";

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
