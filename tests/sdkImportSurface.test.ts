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
