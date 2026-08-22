import { describe, it, expect } from "vitest";
import {
  parseResultMeta,
  upsertResultPrUrl,
  clearResultPrQueued,
  PR_QUEUED_SENTENCE,
} from "../src/resultMeta.js";

const BLOCK = (meta: string): string =>
  `# t\n\nbody\n\n---\n<!-- junco-result\n${meta}\n-->\n\n## Result\n\nok\n`;

describe("parseResultMeta", () => {
  it("parses status, duration_seconds, and pr_url from a PR result block", () => {
    const c = BLOCK(
      "status: timeout_partial\nstop_reason: length\nduration_seconds: 3661\npr_url: https://github.com/o/r/pull/7\nbranch: junco/x\npushed: true",
    );
    expect(parseResultMeta(c)).toEqual({
      status: "timeout_partial",
      durationSeconds: 3661,
      prUrl: "https://github.com/o/r/pull/7",
      dependencyFailed: null,
      superseded: null,
      prQueued: false,
    });
  });

  it("parses a Q&A block (no pr fields)", () => {
    expect(parseResultMeta(BLOCK("status: completed\nduration_seconds: 12"))).toEqual({
      status: "completed",
      durationSeconds: 12,
      prUrl: null,
      dependencyFailed: null,
      superseded: null,
      prQueued: false,
    });
  });

  it("parses the superseded marker (planSets.ts's supersedeUnclaimed)", () => {
    expect(parseResultMeta(BLOCK("status: failed\nsuperseded: abc123")).superseded).toBe("abc123");
  });

  it("last block wins on a retried ticket", () => {
    const c =
      BLOCK("status: failed\nduration_seconds: 5") +
      BLOCK("status: completed\nduration_seconds: 9");
    expect(parseResultMeta(c).status).toBe("completed");
    expect(parseResultMeta(c).durationSeconds).toBe(9);
  });

  it("returns all-null on content without a result block and never throws on garbage", () => {
    expect(parseResultMeta("# plain ticket\n")).toEqual({
      status: null,
      durationSeconds: null,
      prUrl: null,
      dependencyFailed: null,
      superseded: null,
      prQueued: false,
    });
    expect(parseResultMeta("<!-- junco-result\nstatus:")).toEqual({
      status: "",
      durationSeconds: null,
      prUrl: null,
      dependencyFailed: null,
      superseded: null,
      prQueued: false,
    });
  });

  it("non-numeric duration_seconds yields null, not NaN", () => {
    expect(
      parseResultMeta(BLOCK("status: completed\nduration_seconds: soon")).durationSeconds,
    ).toBeNull();
  });

  it("parses pr_queued", () => {
    expect(
      parseResultMeta("<!-- junco-result\nstatus: completed\npr_queued: true\n-->").prQueued,
    ).toBe(true);
    expect(parseResultMeta("<!-- junco-result\nstatus: completed\n-->").prQueued).toBe(false);
  });
});

describe("upsertResultPrUrl", () => {
  it("adds pr_url to the last block and clears pr_queued", () => {
    const before =
      "body\n<!-- junco-result\nstatus: completed\npushed: true\npr_queued: true\n-->\n";
    const after = upsertResultPrUrl(before, "https://github.com/o/r/pull/7");
    expect(parseResultMeta(after).prUrl).toBe("https://github.com/o/r/pull/7");
    expect(parseResultMeta(after).prQueued).toBe(false);
    expect(after).toContain("status: completed");
    expect(after).toContain("pushed: true");
  });

  it("rewrites only the LAST block", () => {
    const two =
      "<!-- junco-result\nstatus: failed\n-->\n<!-- junco-result\nstatus: completed\npr_queued: true\n-->\n";
    const after = upsertResultPrUrl(two, "https://x/1");
    expect(after).toContain("status: failed");
    expect(parseResultMeta(after).prUrl).toBe("https://x/1");
  });

  it("leaves content with no block untouched", () => {
    expect(upsertResultPrUrl("no block here\n", "https://x/1")).toBe("no block here\n");
  });

  it("replaces an existing pr_url with the new one, leaving exactly one occurrence", () => {
    const before =
      "body\n<!-- junco-result\nstatus: completed\npr_url: https://github.com/o/r/pull/7\npushed: true\n-->\n";
    const after = upsertResultPrUrl(before, "https://github.com/o/r/pull/9");
    const occurrences = after.match(/^pr_url:/gm) ?? [];
    expect(occurrences).toHaveLength(1);
    expect(parseResultMeta(after).prUrl).toBe("https://github.com/o/r/pull/9");
    expect(after).toContain("status: completed");
    expect(after).toContain("pushed: true");
  });

  // Self-consistency: the human `## Result` section (finalize.ts's
  // renderPrResult) says "PR queued for offline push…" with no link while
  // the machine block sits right above it. Left alone, a successful
  // write-back would make the document contradict itself — the metadata says
  // pr_url, the prose still says "queued". Review minor (final fix wave).
  it("also replaces the human PR-queued sentence with a PR link", () => {
    const before =
      `body\n<!-- junco-result\nstatus: completed\npushed: true\npr_queued: true\n-->\n\n` +
      `## Result\n\n**Elapsed:** 3s\n\n${PR_QUEUED_SENTENCE}\n\nsome reply text\n`;
    const after = upsertResultPrUrl(before, "https://github.com/o/r/pull/7");
    expect(after).not.toContain(PR_QUEUED_SENTENCE);
    expect(after).toContain("**PR:** https://github.com/o/r/pull/7");
    expect(after).toContain("some reply text"); // rest of the prose untouched
  });

  it("sentence replacement is idempotent — a second call is a no-op on the prose", () => {
    const before =
      `body\n<!-- junco-result\nstatus: completed\npushed: true\npr_queued: true\n-->\n\n` +
      `## Result\n\n${PR_QUEUED_SENTENCE}\n`;
    const once = upsertResultPrUrl(before, "https://x/1");
    const twice = upsertResultPrUrl(once, "https://x/1");
    expect(twice).toBe(once);
  });

  it("only rewrites the LAST attempt's Result section, never an earlier retry's prose", () => {
    const earlier = `<!-- junco-result\nstatus: failed\n-->\n\n## Result\n\n${PR_QUEUED_SENTENCE}\n\n`;
    const latest = `<!-- junco-result\nstatus: completed\npr_queued: true\n-->\n\n## Result\n\n${PR_QUEUED_SENTENCE}\n`;
    const after = upsertResultPrUrl(earlier + latest, "https://x/9");
    // Earlier attempt's historical prose is untouched...
    expect(after).toContain(`status: failed\n-->\n\n## Result\n\n${PR_QUEUED_SENTENCE}`);
    // ...only the latest attempt's sentence became a link.
    expect(after.split(PR_QUEUED_SENTENCE)).toHaveLength(2); // one remaining occurrence
    expect(after).toContain("**PR:** https://x/9");
  });

  it("never interprets $-patterns from the url in the replacement (function replacer)", () => {
    const before = `<!-- junco-result\nstatus: completed\npr_queued: true\n-->\n\n## Result\n\n${PR_QUEUED_SENTENCE}\n`;
    // A pathological URL containing a $-pattern token — a naive
    // String.replace(pattern, stringWithDollar) would interpret "$&" as
    // "insert the whole match" rather than literal text.
    const weirdUrl = "https://x/$&$`$'";
    const after = upsertResultPrUrl(before, weirdUrl);
    expect(after).toContain(`**PR:** ${weirdUrl}`);
  });
});

describe("clearResultPrQueued", () => {
  it("removes pr_queued from the LAST block, leaving other fields intact", () => {
    const before =
      "body\n<!-- junco-result\nstatus: completed\npushed: true\npr_queued: true\n-->\n";
    const after = clearResultPrQueued(before);
    expect(parseResultMeta(after).prQueued).toBe(false);
    expect(after).toContain("status: completed");
    expect(after).toContain("pushed: true");
    expect(after).not.toMatch(/pr_queued/);
  });

  it("leaves content with no block untouched", () => {
    expect(clearResultPrQueued("no block here\n")).toBe("no block here\n");
  });

  it("leaves content with a block but no pr_queued marker untouched", () => {
    const before = "<!-- junco-result\nstatus: completed\npushed: true\n-->\n";
    expect(clearResultPrQueued(before)).toBe(before);
  });

  it("rewrites only the LAST block", () => {
    const two =
      "<!-- junco-result\nstatus: failed\npr_queued: true\n-->\n<!-- junco-result\nstatus: completed\npr_queued: true\n-->\n";
    const after = clearResultPrQueued(two);
    // The earlier block's pr_queued survives untouched...
    expect(after).toContain("status: failed\npr_queued: true");
    // ...only the last block lost it.
    expect(parseResultMeta(after).prQueued).toBe(false);
  });

  it("is idempotent — clearing an already-clear block is a no-op", () => {
    const before = "<!-- junco-result\nstatus: completed\npushed: true\n-->\n";
    expect(clearResultPrQueued(clearResultPrQueued(before))).toBe(before);
  });
});
