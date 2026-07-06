import { describe, it, expect } from "vitest";
import { buildFinalComment, makeGithubReporter, COMMENT_LIMIT } from "../src/githubReport.js";
import type { TicketOutcome } from "../src/reporter.js";
import type { Ticket, Config } from "../src/types.js";
import type { CmdResult } from "../src/git.js";

const ticket = (github: Ticket["github"]): Ticket => ({
  path: "/q/t.md",
  id: "gh-acme-api-42",
  priority: "normal",
  timeoutSeconds: 60,
  body: "b",
  frontmatter: {},
  hasRepo: true,
  notBefore: null,
  retryCount: 0,
  tools: null,
  github,
  workdir: null,
});
const gt = { nwo: "acme/api", issue: 42, kind: "pr" as const };
const out = (o: Partial<TicketOutcome>): TicketOutcome => ({
  kind: "pr",
  status: "completed",
  prUrl: "https://github.com/acme/api/pull/7",
  finalText: "Implemented the limiter.\n\nMore detail here.",
  failureReason: null,
  ...o,
});
const cfg = {
  ghBin: "gh",
  github: {
    enabled: true,
    triggerLabel: "junco",
    askLabel: "junco:ask",
    pollIntervalSeconds: 60,
    repos: [],
    requireApproval: true,
    plannerModelId: null,
  },
} as unknown as Config;
function fakeGh() {
  const calls: string[][] = [];
  const ghFn = async (_c: unknown, args: string[]): Promise<CmdResult> => {
    calls.push(args);
    return { code: 0, stdout: "", stderr: "" };
  };
  return { ghFn, calls };
}

describe("buildFinalComment", () => {
  it("pr success: link + first-paragraph summary", () => {
    const c = buildFinalComment(ticket(gt), out({}));
    expect(c).toContain("Opened https://github.com/acme/api/pull/7");
    expect(c).toContain("Implemented the limiter.");
    expect(c).not.toContain("More detail here."); // only the first paragraph
  });

  it("partial salvage is called out explicitly", () => {
    const c = buildFinalComment(ticket(gt), out({ status: "timeout_partial" }));
    expect(c).toContain("Partial run");
    const c2 = buildFinalComment(ticket(gt), out({ status: "aborted_partial" }));
    expect(c2).toContain("Partial run");
  });

  it("pr failure: reason + transcript pointer", () => {
    const c = buildFinalComment(
      ticket(gt),
      out({ status: "failed", prUrl: null, failureReason: "push exploded" }),
    );
    expect(c.toLowerCase()).toContain("failed");
    expect(c).toContain("push exploded");
    expect(c).toContain("transcript");
  });

  it("no-changes completion is reported without a PR", () => {
    const c = buildFinalComment(ticket(gt), out({ status: "completed_no_changes", prUrl: null }));
    expect(c).toContain("no pull request");
  });

  it("qa success: the answer is the comment", () => {
    const c = buildFinalComment(
      ticket({ ...gt, kind: "ask" }),
      out({ kind: "qa", prUrl: null, finalText: "The answer is 42." }),
    );
    expect(c).toContain("The answer is 42.");
  });

  it("qa failure: reason + transcript pointer", () => {
    const c = buildFinalComment(
      ticket({ ...gt, kind: "ask" }),
      out({ kind: "qa", status: "failed", prUrl: null, failureReason: "endpoint down" }),
    );
    expect(c).toContain("endpoint down");
    expect(c).toContain("transcript");
  });

  it("truncates at the comment limit with a note", () => {
    const c = buildFinalComment(
      ticket({ ...gt, kind: "ask" }),
      out({ kind: "qa", prUrl: null, finalText: "x".repeat(70_000) }),
    );
    expect(c.length).toBeLessThanOrEqual(COMMENT_LIMIT + 200);
    expect(c).toContain("truncated");
  });
});

describe("makeGithubReporter", () => {
  it("onStart flips queued→working", async () => {
    const f = fakeGh();
    await makeGithubReporter(cfg, f as never).onStart(ticket(gt));
    expect(f.calls[0]).toEqual(
      expect.arrayContaining([
        "issue",
        "edit",
        "42",
        "--repo",
        "acme/api",
        "--add-label",
        "junco:working",
        "--remove-label",
        "junco:queued",
      ]),
    );
  });

  it("onRequeue flips working→queued", async () => {
    const f = fakeGh();
    await makeGithubReporter(cfg, f as never).onRequeue(ticket(gt));
    expect(f.calls[0]).toEqual(
      expect.arrayContaining(["--add-label", "junco:queued", "--remove-label", "junco:working"]),
    );
  });

  it("onFinal comments first, then flips to done for TERMINAL_DONE statuses", async () => {
    const f = fakeGh();
    await makeGithubReporter(cfg, f as never).onFinal(ticket(gt), out({ status: "completed" }));
    expect(f.calls[0][0]).toBe("issue");
    expect(f.calls[0][1]).toBe("comment");
    expect(f.calls[0]).toContain("--body-file");
    expect(f.calls[1]).toEqual(expect.arrayContaining(["--add-label", "junco:done"]));
  });

  it("onFinal flips to failed for non-done statuses", async () => {
    const f = fakeGh();
    await makeGithubReporter(cfg, f as never).onFinal(
      ticket(gt),
      out({ status: "failed", prUrl: null }),
    );
    expect(f.calls[1]).toEqual(expect.arrayContaining(["--add-label", "junco:failed"]));
  });

  it("ignores local tickets (github: null) — zero gh calls", async () => {
    const f = fakeGh();
    const r = makeGithubReporter(cfg, f as never);
    await r.onStart(ticket(null));
    await r.onRequeue(ticket(null));
    await r.onFinal(ticket(null), out({}));
    expect(f.calls).toHaveLength(0);
  });

  it("never throws when gh fails", async () => {
    const ghFn = async (): Promise<CmdResult> => {
      throw new Error("network sad");
    };
    const r = makeGithubReporter(cfg, { ghFn } as never);
    await expect(r.onStart(ticket(gt))).resolves.toBeUndefined();
    await expect(r.onFinal(ticket(gt), out({}))).resolves.toBeUndefined();
  });

  it("a comment failure still attempts the label flip", async () => {
    const calls: string[][] = [];
    const ghFn = async (_c: unknown, args: string[]): Promise<CmdResult> => {
      calls.push(args);
      if (args[1] === "comment") throw new Error("comment rejected");
      return { code: 0, stdout: "", stderr: "" };
    };
    await makeGithubReporter(cfg, { ghFn } as never).onFinal(ticket(gt), out({}));
    expect(calls.find((c) => c[1] === "edit")).toEqual(
      expect.arrayContaining(["--add-label", "junco:done"]),
    );
  });
});

describe("plan-kind reporting", () => {
  const planTicket = ticket({ nwo: "acme/api", issue: 42, kind: "plan" });
  const goodFinal = out({
    kind: "qa",
    status: "completed",
    prUrl: null,
    finalText: "chatter\n\n```junco-ticket\n# The plan\n## Steps\n- x\n```\n",
  });

  it("onStart/onRequeue are label no-ops for plan tickets", async () => {
    const f = fakeGh();
    const r = makeGithubReporter(cfg, f as never);
    await r.onStart(planTicket);
    await r.onRequeue(planTicket);
    expect(f.calls).toHaveLength(0);
  });

  it("onFinal success: posts the plan comment then flips planning→plan-ready", async () => {
    const f = fakeGh();
    await makeGithubReporter(cfg, f as never).onFinal(planTicket, goodFinal);
    expect(f.calls[0][1]).toBe("comment");
    expect(f.calls[1]).toEqual(
      expect.arrayContaining([
        "--add-label",
        "junco:plan-ready",
        "--remove-label",
        "junco:planning",
      ]),
    );
  });

  it("onFinal with no extractable plan: failure comment + planning→failed", async () => {
    const f = fakeGh();
    await makeGithubReporter(cfg, f as never).onFinal(
      planTicket,
      out({ kind: "qa", status: "completed", prUrl: null, finalText: "no fence here" }),
    );
    expect(f.calls[0][1]).toBe("comment");
    expect(f.calls[1]).toEqual(
      expect.arrayContaining(["--add-label", "junco:failed", "--remove-label", "junco:planning"]),
    );
  });

  it("onFinal failure status: failure comment + planning→failed", async () => {
    const f = fakeGh();
    await makeGithubReporter(cfg, f as never).onFinal(
      planTicket,
      out({ kind: "qa", status: "failed", prUrl: null, failureReason: "endpoint died" }),
    );
    expect(f.calls[1]).toEqual(expect.arrayContaining(["--add-label", "junco:failed"]));
  });
});
