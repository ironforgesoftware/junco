import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runAnalyzeFlow } from "../src/analyzeFlow.js";
import { listDrafts, draftCount } from "../src/commentReview.js";
import { parseTicket } from "../src/ticket.js";
import type { Config, Ticket } from "../src/types.js";
import { makeConfig } from "./helpers/config.js";

// ---------------------------------------------------------------------------
// Fixtures — the shared Config fixture, a scriptable AgentSessionLike, and
// scriptable git fakes. No network, no real model; everything lives under real
// tmpdirs. Analyze is read-only: no gh, no npm.
// ---------------------------------------------------------------------------

function cfg(root: string): Config {
  return makeConfig(
    {
      dataDir: root,
      queueRoot: join(root, "Junco"),
      worktreeRoot: "/tmp/worktrees",
      tools: ["read"],
      criticEnabled: true,
      planLintEnabled: true,
      verifyEnabled: true,
      supervisorEnabled: true,
      healthEnabled: false,
      removeWorktreeOnSuccess: true,
    },
    {
      defaultTimeoutMinutes: 1, // short so timeout paths are reachable in-test
      planLintBlockOnError: true,
      planLintCheckLabels: true,
      github: {
        enabled: false,
        triggerLabel: "junco",
        askLabel: "junco:ask",
        pollIntervalSeconds: 60,
        repos: [],
        requireApproval: true,
        plannerModelId: null,
        externalReposRoot: "/tmp/junco-test-external",
      },
      botAccount: { enabled: false, configDir: "/tmp/junco-gh" },
    },
  );
}

/** A sandbox with the four queue dirs. */
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "junco-analyze-"));
  const j = join(root, "Junco");
  ["inbox", "processing", "done", "failed"].forEach((d) =>
    mkdirSync(join(j, d), { recursive: true }),
  );
  return { root, j };
}

/** A tmp repo dir (analyze reads it read-only; no files needed on disk). */
function mkRepo(): string {
  return mkdtempSync(join(tmpdir(), "junco-repo-"));
}

/** Materialize a managed external clone under `externalRoot`. Set the returned
 * root as cfg.github.externalReposRoot so path-based external detection fires. */
function mkExternalRepo(externalRoot: string, nwo = "up/stream"): string {
  const [owner, name] = nwo.split("/");
  const repo = join(externalRoot, owner, name);
  mkdirSync(repo, { recursive: true });
  return repo;
}

function claim(j: string, content: string, id = "analyze-o-r-5"): { path: string; ticket: Ticket } {
  const path = join(j, "processing", `2026-07-08T0000Z__${id}.md`);
  writeFileSync(path, content, "utf8");
  const ticket = parseTicket(path, content, 1);
  return { path, ticket };
}

/** An analyze ticket: repo + an analyze: block (issue + title). */
function ticketContent(repo: string, issue = 5, title = "Investigate the crash"): string {
  return (
    `---\nid: analyze-o-r-5\nrepo: ${JSON.stringify(repo)}\n` +
    `analyze:\n  issue: ${issue}\n  title: ${JSON.stringify(title)}\n---\n` +
    `# Analyze issue ${issue}\ninvestigate\n`
  );
}

/** A junco-comment fenced block carrying `text`. */
function commentFence(text: string): string {
  return "```junco-comment\n" + text + "\n```";
}

/** A scriptable AgentSessionLike that emits `finalText` as one text delta.
 * `costUsd` (default 0) lands in the turn's usage.cost.total — runResult.ts
 * folds that into RunResult.usage.costUsd, which is what a `deps.spend` wire
 * records (Phase-3 Task 3). */
function fakeSession(finalText: string, costUsd = 0) {
  return async () => ({
    subscribe(l: (e: any) => void) {
      queueMicrotask(() => {
        l({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: finalText },
        });
        l({
          type: "turn_end",
          message: {
            stopReason: "stop",
            usage: { input: 1, output: 1, cacheRead: 0, totalTokens: 2, cost: { total: costUsd } },
          },
        });
        l({ type: "agent_end", messages: [], willRetry: false });
      });
      return () => {};
    },
    async prompt() {
      await new Promise((r) => setTimeout(r, 1));
    },
    dispose() {},
    abort: async () => {},
  });
}

/** A scriptable AgentSessionLike that emits each of `messages` as its own
 * assistant message (message_start + text_delta), reproducing #36's
 * finalText = last-message-only while allText keeps the whole run —
 * the same fixture as tests/assessFlow.test.ts's fakeMultiMessageSession. */
function fakeMultiMessageSession(messages: string[]) {
  return async () => ({
    subscribe(l: (e: any) => void) {
      queueMicrotask(() => {
        for (const m of messages) {
          l({ type: "message_start", message: { role: "assistant" } });
          l({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: m } });
        }
        l({
          type: "turn_end",
          message: {
            stopReason: "stop",
            usage: { input: 1, output: 1, cacheRead: 0, totalTokens: 2 },
          },
        });
        l({ type: "agent_end", messages: [], willRetry: false });
      });
      return () => {};
    },
    async prompt() {
      await new Promise((r) => setTimeout(r, 1));
    },
    dispose() {},
    abort: async () => {},
  });
}

/** A session whose prompt() throws — the Q&A transient-failure signature. */
function throwingSession() {
  return async () => ({
    subscribe() {
      return () => {};
    },
    async prompt() {
      throw new Error("fetch failed: ECONNREFUSED");
    },
    dispose() {},
    abort: async () => {},
  });
}

/** A git fake that answers `remote get-url origin` and records every call, so a
 * test can assert whether the external freshness sync (fetch + reset) ran. */
function fakeGitCalls(remoteStdout: string) {
  const calls: string[][] = [];
  const gitFn = (async (_cfg: unknown, args: string[]) => {
    calls.push(args);
    if (args[0] === "remote") return { code: 0, stdout: remoteStdout, stderr: "" };
    return { code: 0, stdout: remoteStdout, stderr: "" };
  }) as never;
  const synced = (): boolean => calls.some((a) => a.includes("fetch"));
  const resetHard = (): boolean =>
    calls.some((a) => a[a.indexOf("reset") + 1] === "--hard" && a.includes("reset"));
  return { calls, gitFn, synced, resetHard };
}

const originHttps = "https://github.com/o/r.git\n";
const originUpstream = "https://github.com/up/stream.git\n";

describe("runAnalyzeFlow", () => {
  it("parks a sanitized comment draft in the review store (owned repo, not synced)", async () => {
    const { root, j } = sandbox();
    const repo = mkRepo();
    const { path, ticket } = claim(j, ticketContent(repo));

    const git = fakeGitCalls(originHttps);
    const finalText =
      "Here is my analysis.\n\n" + commentFence("The root cause is a null deref in foo().");
    const r = await runAnalyzeFlow(cfg(root), ticket, path, {
      gitFn: git.gitFn,
      sessionFactoryFor: () => fakeSession(finalText),
    });

    expect(r.parked).toBe(true);
    expect(r.requeued).toBe(false);
    // finalize routes a no-error result to done/.
    expect(r.dst.startsWith(join(j, "done"))).toBe(true);
    expect(readdirSync(join(j, "done"))).toHaveLength(1);
    // An OWNED repo is NEVER hard-reset — the sync must not have run.
    expect(git.synced()).toBe(false);

    // The draft landed in the review store, keyed by ticket id, flagged owned.
    const drafts = listDrafts(cfg(root));
    expect(drafts).toHaveLength(1);
    expect(drafts[0].id).toBe("analyze-o-r-5");
    expect(drafts[0].nwo).toBe("o/r");
    expect(drafts[0].issue).toBe(5);
    expect(drafts[0].external).toBe(false);
    expect(drafts[0].repoPath).toBe(repo);
    expect(drafts[0].footer).toBe(true);
    expect(drafts[0].draft).toContain("null deref in foo()");

    // The done/ summary points the operator at the review step.
    const body = readFileSync(join(j, "done", readdirSync(join(j, "done"))[0]), "utf8");
    expect(body).toContain("junco analyze review analyze-o-r-5");
  });

  it("strips a spoofed junco:finding marker from the parked draft", async () => {
    const { root, j } = sandbox();
    const repo = mkRepo();
    const { path, ticket } = claim(j, ticketContent(repo));

    const git = fakeGitCalls(originHttps);
    const finalText = commentFence("before <!-- junco:finding:dead --> after");
    const r = await runAnalyzeFlow(cfg(root), ticket, path, {
      gitFn: git.gitFn,
      sessionFactoryFor: () => fakeSession(finalText),
    });

    expect(r.parked).toBe(true);
    const [d] = listDrafts(cfg(root));
    expect(d.draft).not.toContain("junco:finding");
    expect(d.draft).toContain("before");
    expect(d.draft).toContain("after");
  });

  it("no junco-comment fence → failed/, parks nothing", async () => {
    const { root, j } = sandbox();
    const repo = mkRepo();
    const { path, ticket } = claim(j, ticketContent(repo));

    const git = fakeGitCalls(originHttps);
    const r = await runAnalyzeFlow(cfg(root), ticket, path, {
      gitFn: git.gitFn,
      sessionFactoryFor: () => fakeSession("I could not find anything conclusive."),
    });

    expect(r.status).toBe("failed");
    expect(r.parked).toBe(false);
    expect(draftCount(cfg(root))).toBe(0);
    expect(r.dst.startsWith(join(j, "failed"))).toBe(true);
    const failed = readdirSync(join(j, "failed"));
    expect(failed).toHaveLength(1);
    const body = readFileSync(join(j, "failed", failed[0]), "utf8");
    expect(body).toContain("status: failed");
    expect(body.toLowerCase()).toContain("no comment draft");
  });

  it("parks the draft when the fence precedes a trailing assistant message (#67 class)", async () => {
    const { root, j } = sandbox();
    const repo = mkRepo();
    const { path, ticket } = claim(j, ticketContent(repo));

    const git = fakeGitCalls(originHttps);
    // The agent banks its comment fence, THEN emits a closing verification
    // message. Under #36 (finalText = last message only) the fence survives
    // only in allText — extraction must read allText ?? finalText, mirroring
    // assessFlow.ts:299.
    const r = await runAnalyzeFlow(cfg(root), ticket, path, {
      gitFn: git.gitFn,
      sessionFactoryFor: () =>
        fakeMultiMessageSession([
          commentFence("The regression was introduced in commit abc123."),
          "Double-checked the blame output; the analysis above stands.",
        ]),
    });

    expect(r.parked).toBe(true);
    expect(r.status).toBe("completed");
    const [d] = listDrafts(cfg(root));
    expect(d.draft).toContain("commit abc123");
  });

  it("external clone (under externalReposRoot) is fetched + hard-reset before analysis", async () => {
    const { root, j } = sandbox();
    const externalRoot = mkdtempSync(join(tmpdir(), "junco-ext-root-"));
    const repo = mkExternalRepo(externalRoot, "up/stream");
    const c = { ...cfg(root), github: { ...cfg(root).github, externalReposRoot: externalRoot } };
    const { path, ticket } = claim(j, ticketContent(repo));

    const git = fakeGitCalls(originUpstream);
    const r = await runAnalyzeFlow(c, ticket, path, {
      gitFn: git.gitFn,
      sessionFactoryFor: () => fakeSession(commentFence("upstream analysis")),
    });

    expect(r.parked).toBe(true);
    const [d] = listDrafts(c);
    expect(d.external).toBe(true);
    expect(d.nwo).toBe("up/stream");
    // An external clone IS synced to upstream before the analysis.
    expect(git.synced()).toBe(true);
    expect(git.resetHard()).toBe(true);
  });

  it("owned repo is NOT synced (no fetch/reset against the operator's tree)", async () => {
    const { root, j } = sandbox();
    const repo = mkRepo();
    const { path, ticket } = claim(j, ticketContent(repo));

    const git = fakeGitCalls(originHttps);
    await runAnalyzeFlow(cfg(root), ticket, path, {
      gitFn: git.gitFn,
      sessionFactoryFor: () => fakeSession(commentFence("owned analysis")),
    });

    expect(git.synced()).toBe(false);
    expect(git.resetHard()).toBe(false);
  });

  it("transient agent failure requeues to inbox, parks nothing", async () => {
    const { root, j } = sandbox();
    const repo = mkRepo();
    const { path, ticket } = claim(j, ticketContent(repo));

    const git = fakeGitCalls(originHttps);
    const r = await runAnalyzeFlow(cfg(root), ticket, path, {
      gitFn: git.gitFn,
      sessionFactoryFor: () => throwingSession(),
    });

    expect(r.requeued).toBe(true);
    expect(r.parked).toBe(false);
    expect(draftCount(cfg(root))).toBe(0);
    expect(readdirSync(join(j, "done"))).toHaveLength(0);
    expect(readdirSync(join(j, "failed"))).toHaveLength(0);
    const inbox = readdirSync(join(j, "inbox"));
    expect(inbox).toHaveLength(1);
    const content = readFileSync(join(j, "inbox", inbox[0]), "utf8");
    expect(content).toMatch(/retry_count: 1/);
  });

  it("a fence that sanitizes to empty (HTML-comment-only) → failed/, parks nothing", async () => {
    const { root, j } = sandbox();
    const repo = mkRepo();
    const { path, ticket } = claim(j, ticketContent(repo));

    const git = fakeGitCalls(originHttps);
    // A non-whitespace fence (clears the fence===null / trim==="" guard) whose
    // only content is an HTML comment — sanitizeFindingText strips it, leaving
    // an empty draft: the Phase-6 "nothing to review after sanitize" branch.
    const r = await runAnalyzeFlow(cfg(root), ticket, path, {
      gitFn: git.gitFn,
      sessionFactoryFor: () => fakeSession(commentFence("<!-- nothing but a comment -->")),
    });

    expect(r.status).toBe("failed");
    expect(r.parked).toBe(false);
    expect(draftCount(cfg(root))).toBe(0);
    expect(r.dst.startsWith(join(j, "failed"))).toBe(true);
    expect(readdirSync(join(j, "failed"))).toHaveLength(1);
    const body = readFileSync(join(j, "failed", readdirSync(join(j, "failed"))[0]), "utf8");
    expect(body.toLowerCase()).toContain("no comment draft");
  });

  it("a whitespace-only fence → failed/, parks nothing", async () => {
    const { root, j } = sandbox();
    const repo = mkRepo();
    const { path, ticket } = claim(j, ticketContent(repo));

    const git = fakeGitCalls(originHttps);
    // extractLastFencedBlock returns a non-null but all-whitespace body: the
    // Phase-5 `fence.trim() === ""` branch (distinct from `fence === null`).
    const r = await runAnalyzeFlow(cfg(root), ticket, path, {
      gitFn: git.gitFn,
      sessionFactoryFor: () => fakeSession(commentFence("   \t  ")),
    });

    expect(r.status).toBe("failed");
    expect(r.parked).toBe(false);
    expect(draftCount(cfg(root))).toBe(0);
    expect(readdirSync(join(j, "failed"))).toHaveLength(1);
    const body = readFileSync(join(j, "failed", readdirSync(join(j, "failed"))[0]), "utf8");
    expect(body.toLowerCase()).toContain("no comment draft");
  });

  it("Phase-1 containment rejection (repo outside allowedRepoRoots) → failed/, no agent run", async () => {
    const { root, j } = sandbox();
    const repo = mkRepo();
    // A real, existing allowed root that does NOT contain `repo`: repo is a
    // directory (clears the isDir guard) but fails the containment check.
    const allowed = mkdtempSync(join(tmpdir(), "junco-allowed-"));
    const c = { ...cfg(root), allowedRepoRoots: [allowed] };
    const { path, ticket } = claim(j, ticketContent(repo));

    const git = fakeGitCalls(originHttps);
    const r = await runAnalyzeFlow(c, ticket, path, {
      gitFn: git.gitFn,
      // If the flow reached the agent this would throw; containment must return first.
      sessionFactoryFor: () => throwingSession(),
    });

    expect(r.status).toBe("failed");
    expect(r.parked).toBe(false);
    expect(draftCount(c)).toBe(0);
    // Phase 1 returns before ever reading the origin remote.
    expect(git.calls).toHaveLength(0);
    expect(r.result.errorMessage).toContain("repo path not permitted");
    const body = readFileSync(join(j, "failed", readdirSync(join(j, "failed"))[0]), "utf8");
    expect(body).toContain("repo path not permitted");
  });

  it("Phase-2 unparseable origin remote (non-GitHub) → failed/, no agent run", async () => {
    const { root, j } = sandbox();
    const repo = mkRepo();
    const { path, ticket } = claim(j, ticketContent(repo));

    // A well-formed URL that nwoFromRemoteUrl cannot resolve to owner/repo.
    const git = fakeGitCalls("https://gitlab.com/o/r.git\n");
    const r = await runAnalyzeFlow(cfg(root), ticket, path, {
      gitFn: git.gitFn,
      sessionFactoryFor: () => throwingSession(),
    });

    expect(r.status).toBe("failed");
    expect(r.parked).toBe(false);
    expect(draftCount(cfg(root))).toBe(0);
    // The remote WAS read (Phase 2) but no agent ran.
    expect(git.calls.some((a) => a[0] === "remote")).toBe(true);
    expect(r.result.errorMessage).toContain("not a parseable GitHub repo");
    const body = readFileSync(join(j, "failed", readdirSync(join(j, "failed"))[0]), "utf8");
    expect(body).toContain("not a parseable GitHub repo");
  });

  it("transient-exhausted run (no fence) preserves the original errorMessage instead of clobbering it", async () => {
    const { root, j } = sandbox();
    const repo = mkRepo();
    // retry_count already at cfg.maxTransientRetries (2): requeueTicket refuses
    // (budget exhausted), so the transient failure falls through to the no-fence
    // finalize path instead of looping back to inbox/.
    const content =
      `---\nid: analyze-o-r-5\nrepo: ${JSON.stringify(repo)}\nretry_count: 2\n` +
      `analyze:\n  issue: 5\n  title: ${JSON.stringify("Investigate the crash")}\n---\n` +
      `# Analyze issue 5\ninvestigate\n`;
    const { path, ticket } = claim(j, content);

    const git = fakeGitCalls(originHttps);
    const r = await runAnalyzeFlow(cfg(root), ticket, path, {
      gitFn: git.gitFn,
      sessionFactoryFor: () => throwingSession(),
    });

    expect(r.requeued).toBe(false);
    expect(r.status).toBe("failed");
    expect(r.parked).toBe(false);
    // The finalized errorMessage must CONTAIN the original transient reason, not
    // just the generic "no comment draft" phrase that would clobber it.
    expect(r.result.errorMessage).toContain("fetch failed: ECONNREFUSED");
  });

  // -------------------------------------------------------------------------
  // Spend ledger wiring (Phase 3 Task 3 — mirrors the Q&A/prFlow pattern)
  // -------------------------------------------------------------------------

  it("records the agent session's resolved cost via deps.spend, right after the agent run", async () => {
    const { root, j } = sandbox();
    const repo = mkRepo();
    const { path, ticket } = claim(j, ticketContent(repo));
    const git = fakeGitCalls(originHttps);
    const calls: number[] = [];
    const spend = { recordUsd: (usd: number) => calls.push(usd) };
    const finalText = "Here is my analysis.\n\n" + commentFence("root cause: null deref");

    const r = await runAnalyzeFlow(cfg(root), ticket, path, {
      gitFn: git.gitFn,
      sessionFactoryFor: () => fakeSession(finalText, 0.0042),
      spend,
    });

    expect(r.parked).toBe(true);
    expect(calls).toEqual([0.0042]);
  });

  it("deps.spend absent is a no-op — no throw, same result as without it", async () => {
    const { root, j } = sandbox();
    const repo = mkRepo();
    const { path, ticket } = claim(j, ticketContent(repo));
    const git = fakeGitCalls(originHttps);
    const finalText = "Here is my analysis.\n\n" + commentFence("root cause: null deref");

    const r = await runAnalyzeFlow(cfg(root), ticket, path, {
      gitFn: git.gitFn,
      sessionFactoryFor: () => fakeSession(finalText, 0.0042),
    });

    expect(r.parked).toBe(true);
  });
});
