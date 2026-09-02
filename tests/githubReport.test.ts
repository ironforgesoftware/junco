import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildFinalComment, makeGithubReporter, COMMENT_LIMIT } from "../src/githubReport.js";
import { extractPlanSetBody, PLAN_SET_FENCE } from "../src/githubInbox.js";
import type { TicketOutcome } from "../src/reporter.js";
import type { Ticket, Config } from "../src/types.js";
import { GitOpError, type CmdResult } from "../src/git.js";
import { listOps } from "../src/githubOutbox.js";

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
  githubRequest: null,
  assess: null,
  analyze: null,
  workdir: null,
  network: null,
  dependsOn: [],
  depsSatisfied: [],
  plan: null,
});
const gt = { nwo: "acme/api", issue: 42, kind: "pr" as const, external: false };
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
  // Poison path (never written to by any test using the plain `cfg`, only
  // read via dataTreePaths for the transcript-existence check) — onFinal now
  // computes transcriptPathFor(dataTreePaths(cfg).transcripts, ticket.id),
  // which needs SOME string dataDir even for tests that don't otherwise
  // exercise the filesystem. Tests that DO write real files use repCfg below.
  dataDir: "/nonexistent/junco-test-data",
  github: {
    enabled: true,
    triggerLabel: "junco",
    askLabel: "junco:ask",
    pollIntervalSeconds: 60,
    repos: [],
    requireApproval: true,
    plannerModelId: null,
    externalReposRoot: "/tmp/junco-test-external",
  },
  planSets: { enabled: false, mergePollSeconds: 60, maxTasks: 10 },
} as unknown as Config;
// Offline-outbox tests need a real dataDir (enqueueOp writes files under
// <dataDir>/outbox/) — a per-test mkdtemp keeps them sandboxed.
const repCfg = (root: string): Config => ({ ...cfg, dataDir: root }) as Config;
function fakeGh() {
  const calls: string[][] = [];
  const ghFn = async (_c: unknown, args: string[]): Promise<CmdResult> => {
    calls.push(args);
    return { code: 0, stdout: "", stderr: "" };
  };
  return { ghFn, calls };
}

describe("buildFinalComment", () => {
  it("pr success: link + a generous excerpt (not just the first paragraph)", () => {
    const c = buildFinalComment(ticket(gt), out({}));
    expect(c).toContain("Opened https://github.com/acme/api/pull/7");
    expect(c).toContain("Implemented the limiter.");
    expect(c).toContain("More detail here."); // chatty lead-ins no longer eat the summary
  });

  it("pr success: very long final text is cut at a boundary with an ellipsis", () => {
    const long = "word ".repeat(300).trim(); // ~1500 chars, no paragraph breaks
    const c = buildFinalComment(ticket(gt), out({ finalText: long }));
    expect(c).toContain("…");
    expect(c.length).toBeLessThan(long.length);
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

  it("qa success: a forged junco marker and control chars in the answer are stripped (#341)", () => {
    // findOwnPlanComment keys on `<!-- junco:plan -->` in own-authored
    // comments — model output must never be able to plant one.
    const c = buildFinalComment(
      ticket({ ...gt, kind: "ask" }),
      out({
        kind: "qa",
        prUrl: null,
        finalText: "The answer is 42.\n\n<!-- junco:plan -->\x07\x1b[31mtail",
      }),
    );
    expect(c).toContain("The answer is 42.");
    expect(c).toContain("tail");
    expect(c).not.toContain("junco:plan");
    expect(c).not.toContain("<!--");
    expect(c).not.toContain("\x07");
    expect(c).not.toContain("\x1b");
  });

  it("qa success: an answer that is only an HTML comment reads as no answer text", () => {
    const c = buildFinalComment(
      ticket({ ...gt, kind: "ask" }),
      out({ kind: "qa", prUrl: null, finalText: "<!-- junco:plan -->" }),
    );
    expect(c).toContain("_(no answer text)_");
    expect(c).not.toContain("junco:plan");
  });

  it("pr success: the excerpt is sanitized the same way (#341)", () => {
    const c = buildFinalComment(
      ticket(gt),
      out({ finalText: "Implemented the limiter.<!-- junco:plan -->\x07 More detail here." }),
    );
    expect(c).toContain("Opened https://github.com/acme/api/pull/7");
    expect(c).toContain("Implemented the limiter.");
    expect(c).toContain("More detail here.");
    expect(c).not.toContain("junco:plan");
    expect(c).not.toContain("<!--");
    expect(c).not.toContain("\x07");
  });

  it("qa failure: reason + transcript pointer", () => {
    const c = buildFinalComment(
      ticket({ ...gt, kind: "ask" }),
      out({ kind: "qa", status: "failed", prUrl: null, failureReason: "endpoint down" }),
    );
    expect(c).toContain("endpoint down");
    expect(c).toContain("transcript");
  });

  it("pr failure: transcriptExists:false suppresses the pointer (apply tickets produce no transcript)", () => {
    const c = buildFinalComment(
      ticket(gt),
      out({ status: "failed", prUrl: null, failureReason: "git am --3way failed" }),
      { transcriptExists: false },
    );
    expect(c).toContain("git am --3way failed");
    expect(c).not.toContain("transcript");
  });

  it("qa failure: transcriptExists:false suppresses the pointer", () => {
    const c = buildFinalComment(
      ticket({ ...gt, kind: "ask" }),
      out({ kind: "qa", status: "failed", prUrl: null, failureReason: "endpoint down" }),
      { transcriptExists: false },
    );
    expect(c).toContain("endpoint down");
    expect(c).not.toContain("transcript");
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

  it("set children (plan + github) produce zero reporter traffic — the sweep owns set reporting", async () => {
    const f = fakeGh();
    const r = makeGithubReporter(cfg, f as never);
    const setChildTicket: Ticket = {
      ...ticket(gt),
      plan: { id: "p1", task: "schema", hash: "abc" },
    };
    await r.onStart(setChildTicket);
    await r.onRequeue(setChildTicket);
    await r.onFinal(setChildTicket, out({ status: "completed", prUrl: "https://x/pr/1" }));
    expect(f.calls).toEqual([]);
  });
});

describe("makeGithubReporter — transcript pointer wiring", () => {
  // A failed bridged ticket's comment must point at the transcript only when
  // one actually exists — apply tickets (git am, no agent session) never
  // produce one. existsFn is the injectable seam (GithubReporterDeps);
  // makeGithubReporter computes the real per-ticket path via
  // transcriptPathFor(dataTreePaths(cfg).transcripts, t.id) and checks it.
  function captureCommentBody(): {
    calls: string[][];
    ghFn: (cfg: unknown, args: string[]) => Promise<CmdResult>;
    body(): string | null;
  } {
    const calls: string[][] = [];
    let body: string | null = null;
    const ghFn = async (_c: unknown, args: string[]): Promise<CmdResult> => {
      calls.push(args);
      if (args[1] === "comment") {
        const idx = args.indexOf("--body-file");
        body = readFileSync(args[idx + 1], "utf8");
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    return { calls, ghFn, body: () => body };
  }

  it("suppresses the pointer when existsFn reports no transcript for the ticket (apply-ticket failure)", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-rep-transcript-"));
    const rc = repCfg(root);
    const cap = captureCommentBody();
    const existsFn = (): boolean => false;
    const reporter = makeGithubReporter(rc, { ghFn: cap.ghFn, existsFn } as never);
    await reporter.onFinal(
      ticket(gt),
      out({ status: "failed", prUrl: null, failureReason: "git am --3way failed" }),
    );
    expect(cap.body()).toContain("git am --3way failed");
    expect(cap.body()).not.toContain("transcript");
  });

  it("keeps the pointer when existsFn reports a transcript IS present for the ticket (agent-ticket failure)", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-rep-transcript-"));
    const rc = repCfg(root);
    const cap = captureCommentBody();
    const existsFn = (): boolean => true;
    const reporter = makeGithubReporter(rc, { ghFn: cap.ghFn, existsFn } as never);
    await reporter.onFinal(
      ticket(gt),
      out({ status: "failed", prUrl: null, failureReason: "agent session errored" }),
    );
    expect(cap.body()).toContain("agent session errored");
    expect(cap.body()).toContain("transcript");
  });

  it("defaults to a real existsSync check against the ticket's actual transcript path", async () => {
    // No existsFn override: the real filesystem check must resolve to "no
    // transcript" for a ticket id that was never run, and to "transcript
    // present" once a file is written at the exact path the module computes.
    const root = mkdtempSync(join(tmpdir(), "junco-rep-transcript-real-"));
    const rc = repCfg(root);
    const cap1 = captureCommentBody();
    await makeGithubReporter(rc, { ghFn: cap1.ghFn } as never).onFinal(
      ticket(gt),
      out({ status: "failed", prUrl: null, failureReason: "boom" }),
    );
    expect(cap1.body()).not.toContain("transcript");

    // repCfg's dataLayout is unset -> "flat" layout -> <dataDir>/transcripts/.
    // ticket(gt).id is "gh-acme-api-42"; slugifyId leaves it unchanged.
    const transcriptsDir = join(root, "transcripts");
    mkdirSync(transcriptsDir, { recursive: true });
    writeFileSync(join(transcriptsDir, `${ticket(gt).id}.jsonl`), "", "utf8");

    const cap2 = captureCommentBody();
    await makeGithubReporter(rc, { ghFn: cap2.ghFn } as never).onFinal(
      ticket(gt),
      out({ status: "failed", prUrl: null, failureReason: "boom" }),
    );
    expect(cap2.body()).toContain("transcript");
  });
});

describe("plan-kind reporting", () => {
  const planTicket = ticket({ nwo: "acme/api", issue: 42, kind: "plan", external: false });
  // 4-backtick outer fence wrapping an inner ```bash block (the template
  // mandates one in ## Verification) — must NOT truncate at the inner fence.
  const goodFinal = out({
    kind: "qa",
    status: "completed",
    prUrl: null,
    finalText:
      "chatter\n\n````junco-ticket\n# The plan\n\n## Verification\n\n```bash\nnpm test\n```\n````\n",
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

  it("onFinal recovers the plan from allText when finalText (last message) lacks the fence (#86)", async () => {
    const f = fakeGh();
    // The agent emitted its plan fence and then a trailing message; #36 narrowed
    // finalText to that trailing line, so the fence survives only in allText.
    await makeGithubReporter(cfg, f as never).onFinal(
      planTicket,
      out({
        kind: "qa",
        status: "completed",
        prUrl: null,
        allText:
          "````junco-ticket\n# The plan\n\n## Verification\n\n```bash\nnpm test\n```\n````\n\nLet me know if you'd like adjustments.",
        finalText: "Let me know if you'd like adjustments.",
      }),
    );
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

  it("onFinal with an oversized plan: failure comment + planning→failed", async () => {
    const f = fakeGh();
    const bigPlan = "# Big\n\n" + "x".repeat(70_000);
    await makeGithubReporter(cfg, f as never).onFinal(
      planTicket,
      out({
        kind: "qa",
        status: "completed",
        prUrl: null,
        finalText: "````junco-ticket\n" + bigPlan + "\n````\n",
      }),
    );
    expect(f.calls[0][1]).toBe("comment");
    expect(f.calls[1]).toEqual(
      expect.arrayContaining(["--add-label", "junco:failed", "--remove-label", "junco:planning"]),
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

  // #293-critical-1: with planSets.enabled, planPrompt.ts teaches the planner
  // to emit a junco-plan fence INSTEAD of junco-ticket — before this fix, the
  // plan branch only ever tried extractPlanBody (junco-ticket), so this
  // finalText round-tripped through the OLD code as "could not produce a
  // plan (missing/empty junco-ticket fence)" and flipped junco:failed on
  // every plan-set run.
  const setFenceOnly =
    "chatter\n\n```junco-plan\nversion: 1\ntasks:\n" +
    "  - {id: a, title: T A, depends_on: [], description: Build A., acceptance: [works]}\n```\n";

  it("Layer 2 (planSets enabled): a junco-plan-only finalText posts a comment whose fence extractPlanSetBody recovers", async () => {
    const calls: string[][] = [];
    let commentBody: string | null = null;
    const ghFn = async (_c: unknown, args: string[]): Promise<CmdResult> => {
      calls.push(args);
      if (args[1] === "comment") {
        const idx = args.indexOf("--body-file");
        commentBody = readFileSync(args[idx + 1], "utf8");
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const setCfg: Config = {
      ...cfg,
      planSets: { enabled: true, mergePollSeconds: 60, maxTasks: 10 },
    };
    await makeGithubReporter(setCfg, { ghFn } as never).onFinal(
      planTicket,
      out({ kind: "qa", status: "completed", prUrl: null, finalText: setFenceOnly }),
    );
    expect(calls[0][1]).toBe("comment");
    expect(commentBody).not.toBeNull();
    expect(commentBody).toContain("```" + PLAN_SET_FENCE);
    const recovered = extractPlanSetBody(commentBody ?? "");
    expect(recovered).not.toBeNull();
    expect(recovered).toContain("T A");
    // planning → plan-ready, same as the junco-ticket success path.
    expect(calls[1]).toEqual(
      expect.arrayContaining([
        "--add-label",
        "junco:plan-ready",
        "--remove-label",
        "junco:planning",
      ]),
    );
  });

  it("Layer 2 (planSets disabled): the same junco-plan-only finalText still takes the failure path — feature inert when off", async () => {
    const f = fakeGh();
    await makeGithubReporter(cfg, f as never).onFinal(
      planTicket,
      out({ kind: "qa", status: "completed", prUrl: null, finalText: setFenceOnly }),
    );
    expect(f.calls[0][1]).toBe("comment");
    expect(f.calls[1]).toEqual(
      expect.arrayContaining(["--add-label", "junco:failed", "--remove-label", "junco:planning"]),
    );
  });
});

describe("reporter offline (outbox)", () => {
  const NET = new GitOpError("gh failed", "connect: network is unreachable", 1);
  const prTicket = ticket(gt);

  it("onStart label swap queues a labels op when offline", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-rep-obx-"));
    const rc = repCfg(root);
    const ghFn = async (): Promise<CmdResult> => {
      throw NET;
    };
    const reporter = makeGithubReporter(rc, { ghFn } as never);
    await reporter.onStart(prTicket);
    const ops = listOps(rc);
    expect(ops).toHaveLength(1);
    expect(ops[0].op).toMatchObject({
      kind: "labels",
      add: ["junco:working"],
      remove: ["junco:queued"],
    });
  });

  it("onFinal comment + labels queue as two ops offline (comment first)", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-rep-obx2-"));
    const rc = repCfg(root);
    const ghFn = async (): Promise<CmdResult> => {
      throw NET;
    };
    const reporter = makeGithubReporter(rc, { ghFn } as never);
    await reporter.onFinal(
      prTicket,
      out({ status: "completed", prUrl: "https://x/pr/1", finalText: "done!" }),
    );
    const kinds = listOps(rc).map((o) => o.op.kind);
    expect(kinds).toEqual(["comment", "labels"]);
  });

  it("non-network errors keep the warn-and-swallow contract (nothing queued)", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-rep-obx3-"));
    const rc = repCfg(root);
    const ghFn = async (): Promise<CmdResult> => {
      throw new GitOpError("gh failed", "HTTP 403", 1);
    };
    const reporter = makeGithubReporter(rc, { ghFn } as never);
    await expect(reporter.onStart(prTicket)).resolves.toBeUndefined();
    expect(listOps(rc)).toHaveLength(0);
  });

  it("prQueued outcome skips finalize comment AND label flip", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-rep-obx4-"));
    const rc = repCfg(root);
    const f = fakeGh();
    const reporter = makeGithubReporter(rc, f as never);
    await reporter.onFinal(prTicket, out({ prUrl: null, finalText: "x", prQueued: true }));
    expect(f.calls).toHaveLength(0);
    expect(listOps(rc)).toHaveLength(0);
  });

  it("is a complete no-op for external tickets (etiquette invariant)", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-rep-external-"));
    const rc = repCfg(root);
    const f = fakeGh();
    const t = ticket({ nwo: "up/stream", issue: 7, kind: "pr", external: true });
    const reporter = makeGithubReporter(rc, f as never);
    await reporter.onStart(t);
    await reporter.onRequeue(t);
    await reporter.onFinal(t, out({}));
    expect(f.calls).toHaveLength(0);
    expect(listOps(rc)).toHaveLength(0);
  });
});
