import { describe, it, expect } from "vitest";
import { parseResultMeta } from "../src/resultMeta.js";

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
    });
  });

  it("parses a Q&A block (no pr fields)", () => {
    expect(parseResultMeta(BLOCK("status: completed\nduration_seconds: 12"))).toEqual({
      status: "completed",
      durationSeconds: 12,
      prUrl: null,
      dependencyFailed: null,
      superseded: null,
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
    });
    expect(parseResultMeta("<!-- junco-result\nstatus:")).toEqual({
      status: "",
      durationSeconds: null,
      prUrl: null,
      dependencyFailed: null,
      superseded: null,
    });
  });

  it("non-numeric duration_seconds yields null, not NaN", () => {
    expect(
      parseResultMeta(BLOCK("status: completed\nduration_seconds: soon")).durationSeconds,
    ).toBeNull();
  });
});
