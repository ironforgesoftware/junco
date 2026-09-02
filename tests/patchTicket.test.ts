import { describe, it, expect } from "vitest";
import {
  parsePatchSeries,
  unsafePatchPaths,
  MAX_PATCH_BYTES,
  stripPatchFence,
  summarizePatchFenceForPr,
  firstPatchSubject,
  composePatchTicket,
} from "../src/patchTicket.js";
import { lintTicket } from "../src/planLint.js";
import { parseTicket } from "../src/ticket.js";

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

// #339: git emits `diff --git "a/…" "b/…"` (C-quoted) whenever a path holds a
// quote, backslash, tab, or non-ASCII byte under the default core.quotePath.
// The plain-form regex never matched that line, so such a hunk's path never
// reached unsafePatchPaths — a silent blind spot in a containment check.
describe("parsePatchSeries — fails closed on any diff --git line that is not the plain a/… b/… form (#339)", () => {
  const QUOTED = 'diff --git "a/g\\303\\251me.js" "b/g\\303\\251me.js"';

  it("rejects a series whose only hunk carries a C-quoted header", () => {
    const quoted = ONE.replace("diff --git a/game.js b/game.js", QUOTED);
    expect(parsePatchSeries(fence(quoted))).toBe(null);
  });

  it("rejects a mixed series — one ordinary hunk must not carry a quoted-path hunk along unchecked", () => {
    const second = ONE.replace("diff --git a/game.js b/game.js", QUOTED).replace("1/1", "2/2");
    // Before the fix this parsed with files === ["game.js"]: the quoted hunk
    // simply vanished from the file list.
    expect(parsePatchSeries(fence(ONE + second))).toBe(null);
  });

  it("rejects a header quoted on one side only (rename onto a path that needs quoting)", () => {
    const half = ONE.replace(
      "diff --git a/game.js b/game.js",
      'diff --git a/game.js "b/ren amed \\303\\251.js"',
    );
    expect(parsePatchSeries(fence(half))).toBe(null);
  });

  it("rejects a header with no a/ b/ prefix (diff.noprefix / --no-prefix output)", () => {
    const noPrefix = ONE.replace("diff --git a/game.js b/game.js", "diff --git game.js game.js");
    expect(parsePatchSeries(fence(noPrefix))).toBe(null);
  });
});

const RENAME = `From 9f3a1c2e0000000000000000000000000000abcd Mon Sep 17 00:00:00 2001
From: Dispatcher <d@example.com>
Date: Sun, 31 Aug 2026 12:00:00 -0700
Subject: [PATCH 1/1] refactor: move game.js

---
 game.js => level.js | 0
 1 file changed, 0 insertions(+), 0 deletions(-)

diff --git a/game.js b/level.js
similarity index 100%
rename from game.js
rename to level.js
`;

// #339: `git apply` takes a rename/copy header's path over the `diff --git`
// line's (apply.c gitdiff_renamesrc/renamedst/copysrc/copydst overwrite
// old_name/new_name), so a crafted series can say one thing on the header
// line and rename somewhere else in the extended headers. The paths git will
// actually use must be the ones unsafePatchPaths sees.
describe("parsePatchSeries — rename/copy extended headers (#339)", () => {
  it("adds `rename to` / `rename from` paths to files even when the diff --git line disagrees", () => {
    const crafted = RENAME.replace("rename to level.js", "rename to ../level.js");
    const s = parsePatchSeries(fence(crafted));
    expect(s).not.toBe(null);
    expect(s!.files).toEqual(["../level.js", "game.js", "level.js"]);
    expect(unsafePatchPaths(s!.files)).toEqual(["../level.js"]);
  });

  it("adds `copy to` / `copy from` paths the same way", () => {
    const crafted = RENAME.replace("rename from game.js", "copy from ../game.js").replace(
      "rename to level.js",
      "copy to level.js",
    );
    const s = parsePatchSeries(fence(crafted));
    expect(s!.files).toEqual(["../game.js", "game.js", "level.js"]);
    expect(unsafePatchPaths(s!.files)).toEqual(["../game.js"]);
  });

  it("fails closed on a C-quoted rename/copy header", () => {
    const quoted = RENAME.replace("rename to level.js", 'rename to "l\\303\\251vel.js"');
    expect(parsePatchSeries(fence(quoted))).toBe(null);
  });

  it("reads rename/copy headers only from a hunk's extended-header block, not from commit-message prose", () => {
    const prose = RENAME.replace(
      "Subject: [PATCH 1/1] refactor: move game.js\n\n",
      "Subject: [PATCH 1/1] refactor: move game.js\n\nrename to ../whatever the message says\n\n",
    );
    const s = parsePatchSeries(fence(prose));
    expect(s!.files).toEqual(["game.js", "level.js"]);
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

describe("composePatchTicket", () => {
  const compose = (over: Partial<Parameters<typeof composePatchTicket>[0]> = {}) =>
    composePatchTicket({
      patch: ONE,
      repo: "/sbxroot/repo",
      id: "add-a-level-2026-09-01",
      ...over,
    });

  it("emits id/repo frontmatter and omits pr_title when no title is given", () => {
    const out = compose();
    expect(out.startsWith("---\n")).toBe(true);
    expect(out).toContain("id: add-a-level-2026-09-01\n");
    expect(out).toContain('repo: "/sbxroot/repo"\n');
    expect(out).not.toContain("pr_title:");
  });

  it("emits pr_title frontmatter when a title is given", () => {
    const out = compose({ title: "Add a level" });
    expect(out).toContain('pr_title: "Add a level"');
  });

  // The previous version of this test embedded the fence inside a DIFF HUNK,
  // where every line carries a +/-/space prefix — such a line can never
  // match the bare-backtick closing-fence regex (lastFencedBlockRange,
  // githubInbox.ts), so a hand-rolled fixed-length fence parses that payload
  // fine too; the test guarded nothing. The genuine hazard is a fence in the
  // mbox COMMIT MESSAGE BODY — between the Subject/headers and the `---`
  // diffstat separator — where lines are NOT prefixed: a commit message that
  // itself contains a ``` block can terminate a fixed-length outer fence
  // early, truncating the series before the diffstat/diff hunk are ever
  // reached. wrapInFence avoids this by picking a fence longer than any
  // backtick run already inside the payload.
  //
  // Verified empirically (see task report): temporarily replacing
  // composePatchTicket's `wrapInFence(PATCH_FENCE, opts.patch)` call with a
  // hand-rolled fixed fence ("```" + PATCH_FENCE + "\n" + body + "\n```")
  // made this exact test FAIL — parsePatchSeries(out) returned null, because
  // the outer fence closed at the commit message's own inner ``` line and
  // the extracted content never reached the `diff --git` hunk. Restoring
  // wrapInFence made it pass again.
  it("wraps with a fence longer than the payload's own backtick run — survives a fence in the COMMIT MESSAGE BODY, not just a diff hunk", () => {
    const withMsgFence = ONE.replace(
      "Subject: [PATCH 1/1] feat: add a level\n\n",
      "Subject: [PATCH 1/1] feat: add a level\n\nExample usage:\n\n```\necho hi\n```\n\n",
    );
    const out = compose({ patch: withMsgFence });
    const series = parsePatchSeries(out);
    expect(series).not.toBe(null);
    expect(series!.count).toBe(1);
    expect(series!.files).toEqual(["game.js"]);
    // Not just "didn't crash" — the WHOLE series, including the part past
    // the commit message's own fence, must have survived intact.
    expect(series!.raw.trim()).toBe(withMsgFence.trim());
  });

  it("round-trips through parsePatchSeries with the series' own count/files, and raw is byte-identical to the input series (modulo the trailing-whitespace trim every extractor in this file already applies)", () => {
    const out = compose();
    const series = parsePatchSeries(out);
    expect(series).not.toBe(null);
    expect(series!.count).toBe(1);
    expect(series!.files).toEqual(["game.js"]);
    expect(series!.raw).toBe(ONE.trim());
  });

  it("emits the given ## Why text verbatim, or a non-empty default when omitted", () => {
    const withWhy = compose({ why: "because reasons" });
    expect(withWhy).toContain("## Why\n\nbecause reasons");

    const withoutWhy = compose();
    expect(withoutWhy).toMatch(/## Why\n\n\S.+\n/);
    expect(withoutWhy).not.toContain("## Why\n\nbecause reasons");
  });

  it("emits ## Verification only when --verify is given", () => {
    const withVerify = compose({ verify: "node --check game.js" });
    expect(withVerify).toContain("## Verification\n\n```bash\nnode --check game.js\n```");

    const withoutVerify = compose();
    expect(withoutVerify).not.toContain("## Verification");
  });

  it("lints clean (no errors, no patch_has_verification warning) when --verify is given", () => {
    const out = compose({ verify: "node --check game.js" });
    const parsed = parseTicket("composed.md", out);
    const result = lintTicket(parsed.body, parsed.frontmatter, { checkLabels: false });
    expect(result.errors).toEqual([]);
    expect(result.warnings.map((w) => w.rule)).not.toContain("patch_has_verification");
  });

  it("lints clean (no errors) without --verify, but warns patch_has_verification", () => {
    const out = compose();
    const parsed = parseTicket("composed.md", out);
    const result = lintTicket(parsed.body, parsed.frontmatter, { checkLabels: false });
    expect(result.errors).toEqual([]);
    expect(result.warnings.some((w) => w.rule === "patch_has_verification")).toBe(true);
  });

  it("still lints clean when the title contains characters that would break an unquoted YAML scalar", () => {
    const out = compose({ title: "fix: handle `weird` titles: colons, and stuff" });
    const parsed = parseTicket("composed.md", out);
    expect(parsed.frontmatter.pr_title).toBe("fix: handle `weird` titles: colons, and stuff");
    const result = lintTicket(parsed.body, parsed.frontmatter, { checkLabels: false });
    expect(result.errors).toEqual([]);
  });
});
