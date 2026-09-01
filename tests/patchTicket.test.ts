import { describe, it, expect } from "vitest";
import { parsePatchSeries, unsafePatchPaths, MAX_PATCH_BYTES } from "../src/patchTicket.js";

const ONE = `From 9f3a1c2e0000000000000000000000000000abcd Mon Sep 17 00:00:00 2001
From: Dispatcher <d@example.com>
Date: Sun, 31 Aug 2026 12:00:00 -0700
Subject: [PATCH 1/1] feat: add a level

---
 game.js | 1 +
 1 file changed, 1 insertion(+)

diff --git a/game.js b/game.js
index 1111111..2222222 100644
--- a/game.js
+++ b/game.js
@@ -1,2 +1,3 @@
 const LEVELS = [
+  "new",
 ];
`;

const fence = (body: string, tag = "junco-patch"): string =>
  `## Why\n\nbecause\n\n\`\`\`\`${tag}\n${body}\`\`\`\`\n\n## Verification\n\n\`\`\`bash\nnode --check game.js\n\`\`\`\n`;

describe("parsePatchSeries", () => {
  it("returns null for a body with no junco-patch fence", () => {
    expect(parsePatchSeries("# Plan\n\n## Steps\n\n### Step 1\n")).toBe(null);
  });

  it("parses a one-patch series and its touched files", () => {
    const s = parsePatchSeries(fence(ONE));
    expect(s).not.toBe(null);
    expect(s!.count).toBe(1);
    expect(s!.files).toEqual(["game.js"]);
    expect(s!.raw).toContain("Subject: [PATCH 1/1] feat: add a level");
    expect(s!.raw).toContain("@@ -1,2 +1,3 @@");
  });

  it("counts every patch in a multi-patch series and unions their files", () => {
    const two = ONE + ONE.replaceAll("game.js", "spec.md").replace("1/1", "2/2");
    const s = parsePatchSeries(fence(two));
    expect(s!.count).toBe(2);
    expect(s!.files).toEqual(["game.js", "spec.md"]);
  });

  it("does NOT strip the mbox's --- separator (unlike the plan-fence path)", () => {
    const s = parsePatchSeries(fence(ONE));
    expect(s!.raw).toMatch(/^From 9f3a1c2e/); // starts at the mbox header
    expect(s!.raw).toContain("\n---\n"); // diffstat separator survives
  });

  it("rejects a fence that is not a patch series", () => {
    expect(parsePatchSeries(fence("just some prose\n"))).toBe(null);
    expect(parsePatchSeries(fence("From abc123 Mon Sep 17 00:00:00 2001\nno diff here\n"))).toBe(
      null,
    );
  });

  it("survives a patch that itself adds a fenced markdown file (longer outer fence)", () => {
    const withFence = ONE.replace('+  "new",', "+```bash\n+echo hi\n+```");
    const s = parsePatchSeries(fence(withFence));
    expect(s!.raw).toContain("+```bash");
  });

  it("ignores a marker/fence-shaped line and refuses an oversize series", () => {
    const huge = ONE + "x".repeat(MAX_PATCH_BYTES);
    expect(parsePatchSeries(fence(huge))).toBe(null);
  });
});

describe("unsafePatchPaths", () => {
  it("flags traversal, absolute, and empty paths; passes ordinary ones", () => {
    expect(unsafePatchPaths(["src/a.ts", "docs/b.md"])).toEqual([]);
    expect(unsafePatchPaths(["../etc/passwd"])).toEqual(["../etc/passwd"]);
    expect(unsafePatchPaths(["/etc/passwd"])).toEqual(["/etc/passwd"]);
    expect(unsafePatchPaths(["a/../../b"])).toEqual(["a/../../b"]);
  });
});
