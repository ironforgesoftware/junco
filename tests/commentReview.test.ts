import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  writeDraft,
  listDrafts,
  readDraft,
  removeDraft,
  draftCount,
  commentReviewPaths,
  composeCommentBody,
  ANALYSIS_FOOTER,
  type PendingComment,
} from "../src/commentReview.js";
import type { Config } from "../src/types.js";

function cfg(stateDir: string): Config {
  return { dataDir: stateDir } as unknown as Config; // only dataDir is read by this module
}

function comment(id: string, overrides: Partial<PendingComment> = {}): PendingComment {
  return {
    id,
    nwo: "o/r",
    issue: 42,
    issueTitle: "Something broke",
    external: true,
    repoPath: "/x",
    createdAt: "2026-07-09T00:00:00.000Z",
    draft: "Here's my analysis of the issue.",
    footer: true,
    ...overrides,
  };
}

describe("commentReview store", () => {
  it("writes, lists, reads, and counts a full PendingComment round-trip", () => {
    const dir = mkdtempSync(join(tmpdir(), "crv-"));
    const c = cfg(dir);
    const d = comment("analyze-o-r-42");
    writeDraft(c, d);
    expect(draftCount(c)).toBe(1);
    expect(listDrafts(c).map((e) => e.id)).toEqual(["analyze-o-r-42"]);
    expect(readDraft(c, "analyze-o-r-42").draft).toEqual(d);
  });

  it("removeDraft archives to posted/ or discarded/ under commentReviewPaths", () => {
    const dir = mkdtempSync(join(tmpdir(), "crv-"));
    const c = cfg(dir);
    writeDraft(c, comment("a-1"));
    writeDraft(c, comment("a-2"));

    removeDraft(c, "a-1", "posted");
    expect(existsSync(join(commentReviewPaths(c).posted, "a-1.json"))).toBe(true);

    removeDraft(c, "a-2", "discarded");
    expect(existsSync(join(commentReviewPaths(c).discarded, "a-2.json"))).toBe(true);

    expect(draftCount(c)).toBe(0);
  });

  it("composeCommentBody appends the footer only when footer is true", () => {
    const withFooter = comment("a-1", { footer: true, draft: "body text" });
    expect(composeCommentBody(withFooter)).toBe(`body text\n\n${ANALYSIS_FOOTER}`);

    const withoutFooter = comment("a-2", { footer: false, draft: "body text" });
    expect(composeCommentBody(withoutFooter)).toBe("body text");
  });

  it("corrupt draft file → readDraft error matches /not valid JSON/", () => {
    const dir = mkdtempSync(join(tmpdir(), "crv-"));
    const c = cfg(dir);
    writeDraft(c, comment("good"));
    writeFileSync(join(commentReviewPaths(c).dir, "bad.json"), "{not json");

    expect(listDrafts(c).map((e) => e.id)).toEqual(["good"]); // bad skipped, not thrown
    expect(readDraft(c, "bad").error).toMatch(/not valid JSON/);
    expect(readDraft(c, "bad").draft).toBeNull();
  });

  it("missing draft reads as {null,null}; missing dir → empty list, zero count", () => {
    const dir = mkdtempSync(join(tmpdir(), "crv-"));
    const c = cfg(dir);
    expect(readDraft(c, "nope")).toEqual({ draft: null, error: null });
    expect(listDrafts(c)).toEqual([]);
    expect(draftCount(c)).toBe(0);
  });
});
