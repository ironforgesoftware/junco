/**
 * M5-T3 integration: the finalize → metrics instrumentation point.
 *
 * Verifies that finalize() (Q&A) and finalizePr() (PR) feed the shared
 * `metrics` singleton exactly once per task with the right success/failure
 * bucket + token totals + duration. Uses the finalize harness as a template.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { finalize, finalizePr } from "../src/finalize.js";
import { metrics } from "../src/metrics.js";
import type { RunResult } from "../src/types.js";
import type { PrOutcome } from "../src/prFlow.js";

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "junco-obs-"));
  const processing = join(root, "processing");
  const done = join(root, "done");
  const failed = join(root, "failed");
  [processing, done, failed].forEach((d) => mkdirSync(d));
  const ticket = join(processing, "2026__q1.md");
  writeFileSync(ticket, "---\nid: q1\n---\n# Q\nask\n", "utf8");
  return { ticket, done, failed };
}

const ok: RunResult = {
  finalText: "the answer",
  toolCalls: [],
  usage: { input: 11, output: 7, cacheRead: 0, total: 18, costUsd: 0 },
  stopReason: "stop",
  errorMessage: null,
  timedOut: false,
  durationMs: 2500,
  abortedByGuard: false,
};

function basePrOutcome(): PrOutcome {
  return {
    statusOverride: null,
    nwo: "owner/repo",
    branch: "junco/x",
    baseBranch: "main",
    prUrl: "https://example.com/pr/1",
    commits: [{ sha: "abc123", subject: "do the thing" }],
    pushed: true,
    worktreePath: null,
    worktreePreserved: false,
    amendedPrNumber: null,
    verification: null,
    critic: null,
    criticRetriesUsed: 0,
    prQueued: false,
    staleBase: false,
    applyFallback: null,
  };
}

describe("observability: finalize → metrics", () => {
  beforeEach(() => metrics.reset());

  it("records a successful Q&A task (success bucket + tokens + duration)", () => {
    const { ticket, done, failed } = sandbox();
    finalize(ticket, ok, { done, failed });

    const s = metrics.snapshot();
    expect(s.tasksProcessed).toBe(1);
    expect(s.tasksSucceeded).toBe(1);
    expect(s.tasksFailed).toBe(0);
    expect(s.tasksByStatus.completed).toBe(1);
    expect(s.totalTokensIn).toBe(11);
    expect(s.totalTokensOut).toBe(7);
    expect(s.totalDurationMs).toBe(2500);
    expect(s.lastTaskStatus).toBe("completed");
  });

  it("records a failed (timed-out) Q&A task in the failure bucket", () => {
    const { ticket, done, failed } = sandbox();
    finalize(ticket, { ...ok, timedOut: true }, { done, failed });

    const s = metrics.snapshot();
    expect(s.tasksProcessed).toBe(1);
    expect(s.tasksSucceeded).toBe(0);
    expect(s.tasksFailed).toBe(1);
    expect(s.tasksByStatus.timeout).toBe(1);
    expect(s.lastTaskStatus).toBe("timeout");
  });

  it("records a successful PR task once via finalizePr", () => {
    const { ticket, done, failed } = sandbox();
    finalizePr(ticket, ok, basePrOutcome(), { dirs: { done, failed } });

    const s = metrics.snapshot();
    expect(s.tasksProcessed).toBe(1);
    expect(s.tasksSucceeded).toBe(1);
    expect(s.tasksFailed).toBe(0);
    expect(s.tasksByStatus.completed).toBe(1);
    expect(s.totalTokensIn).toBe(11);
    expect(s.totalTokensOut).toBe(7);
    expect(s.totalDurationMs).toBe(2500);
  });

  it("buckets a guard-aborted-with-no-changes PR run as a failure", () => {
    const { ticket, done, failed } = sandbox();
    const outcome = { ...basePrOutcome(), pushed: false };
    finalizePr(ticket, { ...ok, abortedByGuard: true }, outcome, {
      dirs: { done, failed },
    });

    const s = metrics.snapshot();
    expect(s.tasksProcessed).toBe(1);
    expect(s.tasksFailed).toBe(1);
    expect(s.tasksByStatus.aborted_no_changes).toBe(1);
  });
});
