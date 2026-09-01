import { describe, it, expect } from "vitest";
import {
  parsePatchSeries,
  unsafePatchPaths,
  MAX_PATCH_BYTES,
  stripPatchFence,
  summarizePatchFenceForPr,
  firstPatchSubject,
} from "../src/patchTicket.js";

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

  it("does not overcount a commit-message-body line that merely starts with From <hex> — only a real mbox header (hex sha + the asctime date) counts", () => {
    const withFromInBody = ONE.replace(
      "Subject: [PATCH 1/1] feat: add a level\n\n",
      "Subject: [PATCH 1/1] feat: add a level\n\nFrom deadbeef1234567 unrelated mention, not a header\n\n",
    );
    const s = parsePatchSeries(fence(withFromInBody));
    expect(s).not.toBe(null);
    expect(s!.count).toBe(1); // was 2 before the fix: the body line matched too
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

describe("stripPatchFence", () => {
  it("removes the fenced mbox, leaving prose before and after intact", () => {
    const body = fence(ONE);
    const stripped = stripPatchFence(body);
    expect(stripped).toContain("## Why\n\nbecause");
    expect(stripped).toContain("## Verification");
    expect(stripped).not.toContain("diff --git");
    expect(stripped).not.toContain("Subject: [PATCH");
  });

  it("returns the body unchanged when there is no complete fence", () => {
    const body = "# Plan\n\n## Steps\n\n### Step 1\n";
    expect(stripPatchFence(body)).toBe(body);
  });
});

describe("summarizePatchFenceForPr", () => {
  it("replaces the fenced mbox with a one-line summary and keeps the prose", () => {
    const body = fence(ONE);
    const series = parsePatchSeries(body)!;
    const summarized = summarizePatchFenceForPr(body, series);
    expect(summarized).toContain("## Why\n\nbecause");
    expect(summarized).toContain("## Verification");
    expect(summarized).not.toContain("diff --git");
    expect(summarized).not.toContain("Subject: [PATCH");
    expect(summarized).toContain("1 patch(es) applied");
    expect(summarized).toContain("1 file(s) touched");
  });
});

describe("firstPatchSubject", () => {
  it("returns the first Subject line with a [PATCH n/m] tag stripped", () => {
    const series = parsePatchSeries(fence(ONE))!;
    expect(firstPatchSubject(series)).toBe("feat: add a level");
  });

  it("returns null when the series carries no Subject line", () => {
    const noSubject = ONE.replace("Subject: [PATCH 1/1] feat: add a level\n", "");
    const series = parsePatchSeries(fence(noSubject))!;
    expect(firstPatchSubject(series)).toBe(null);
  });
});
