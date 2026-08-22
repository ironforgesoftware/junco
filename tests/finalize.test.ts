import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { finalize, finalizePr, computePrStatus } from "../src/finalize.js";
import type { PrOutcome } from "../src/prFlow.js";
import type { RunResult } from "../src/types.js";
import { metrics } from "../src/metrics.js";

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "junco-fin-"));
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
  usage: { input: 1, output: 1, cacheRead: 0, total: 2, costUsd: 0 },
  stopReason: "stop",
  errorMessage: null,
  timedOut: false,
  durationMs: 1000,
  abortedByGuard: false,
};

describe("finalize", () => {
  it("writes reply + status to done/ and leaves no temp file", () => {
    const { ticket, done, failed } = sandbox();
    const { dst, status } = finalize(ticket, ok, { done, failed });
    expect(status).toBe("completed");
    expect(dst.startsWith(done)).toBe(true);
    const text = readFileSync(dst, "utf8");
    expect(text).toContain("status: completed");
    expect(text).toContain("the answer");
    expect(existsSync(ticket)).toBe(false);
    expect(readdirSync(done).some((n) => n.endsWith(".tmp"))).toBe(false);
  });

  it("routes timed-out runs to failed/", () => {
    const { ticket, done, failed } = sandbox();
    const { dst, status } = finalize(ticket, { ...ok, timedOut: true }, { done, failed });
    expect(status).toBe("timeout");
    expect(dst.startsWith(failed)).toBe(true);
    expect(readFileSync(dst, "utf8")).toContain("status: timeout");
  });

  it("routes errored runs to failed/", () => {
    const { ticket, done, failed } = sandbox();
    const { dst, status } = finalize(ticket, { ...ok, errorMessage: "boom" }, { done, failed });
    expect(status).toBe("failed");
    expect(dst.startsWith(failed)).toBe(true);
    expect(readFileSync(dst, "utf8")).toContain("status: failed");
  });

  it("renders cost=$X.XXXX (4dp) in the Tokens line", () => {
    const { ticket, done, failed } = sandbox();
    const { dst } = finalize(
      ticket,
      { ...ok, usage: { ...ok.usage, costUsd: 0.0246 } },
      {
        done,
        failed,
      },
    );
    expect(readFileSync(dst, "utf8")).toContain("**Tokens:** in=1 out=1 cost=$0.0246");
  });

  it("passes costUsd through to metrics.recordTask, accumulating into totalCostUsd", () => {
    const { ticket, done, failed } = sandbox();
    const before = metrics.snapshot().totalCostUsd;
    finalize(ticket, { ...ok, usage: { ...ok.usage, costUsd: 0.0246 } }, { done, failed });
    expect(metrics.snapshot().totalCostUsd).toBeCloseTo(before + 0.0246, 4);
  });
});

describe("finalize — collision safety (issue #48)", () => {
  it("does not overwrite a same-named terminal record; uniquifies the new one", () => {
    const { ticket, done, failed } = sandbox();
    // A prior failure record already occupies the destination name.
    writeFileSync(join(done, "2026__q1.md"), "ATTEMPT ONE — must survive", "utf8");

    const { dst, status } = finalize(ticket, ok, { done, failed });
    expect(status).toBe("completed");
    // The pre-existing audit trail is intact.
    expect(readFileSync(join(done, "2026__q1.md"), "utf8")).toBe("ATTEMPT ONE — must survive");
    // The new record landed at a uniquified name, not on top of the old one.
    expect(dst).not.toBe(join(done, "2026__q1.md"));
    expect(dst.startsWith(done)).toBe(true);
    expect(readFileSync(dst, "utf8")).toContain("the answer");
    expect(readdirSync(done).filter((n) => n.endsWith(".md"))).toHaveLength(2);
  });
});

describe("finalizePr — collision safety (issue #48)", () => {
  const outcome: PrOutcome = {
    statusOverride: null,
    nwo: null,
    branch: null,
    baseBranch: null,
    prUrl: null,
    commits: [],
    pushed: false,
    worktreePath: null,
    worktreePreserved: false,
    amendedPrNumber: null,
    verification: null,
    critic: null,
    criticRetriesUsed: 0,
    prQueued: false,
    staleBase: false,
  };

  it("uniquifies rather than clobbering an existing failed/ record", () => {
    const { ticket, done, failed } = sandbox();
    writeFileSync(join(failed, "2026__q1.md"), "ATTEMPT ONE", "utf8");
    const { dst, status } = finalizePr(ticket, { ...ok, errorMessage: "boom" }, outcome, {
      dirs: { done, failed },
    });
    expect(status).toBe("failed");
    expect(readFileSync(join(failed, "2026__q1.md"), "utf8")).toBe("ATTEMPT ONE");
    expect(dst).not.toBe(join(failed, "2026__q1.md"));
    expect(readdirSync(failed).filter((n) => n.endsWith(".md"))).toHaveLength(2);
  });
});

describe("finalizePr — cost accounting (Phase-3)", () => {
  const outcome: PrOutcome = {
    statusOverride: null,
    nwo: null,
    branch: null,
    baseBranch: null,
    prUrl: null,
    commits: [],
    pushed: false,
    worktreePath: null,
    worktreePreserved: false,
    amendedPrNumber: null,
    verification: null,
    critic: null,
    criticRetriesUsed: 0,
    prQueued: false,
    staleBase: false,
  };

  it("renders cost=$X.XXXX (4dp) in the Tokens line", () => {
    const { ticket, done, failed } = sandbox();
    const { dst } = finalizePr(
      ticket,
      { ...ok, usage: { ...ok.usage, costUsd: 0.0246 } },
      outcome,
      { dirs: { done, failed } },
    );
    expect(readFileSync(dst, "utf8")).toContain("**Tokens:** in=1 out=1 cost=$0.0246");
  });

  it("passes costUsd through to metrics.recordTask, accumulating into totalCostUsd", () => {
    const { ticket, done, failed } = sandbox();
    const before = metrics.snapshot().totalCostUsd;
    finalizePr(ticket, { ...ok, usage: { ...ok.usage, costUsd: 0.0246 } }, outcome, {
      dirs: { done, failed },
    });
    expect(metrics.snapshot().totalCostUsd).toBeCloseTo(before + 0.0246, 4);
  });
});

describe("computePrStatus (timeout salvage)", () => {
  const emptyOutcome = (over: Partial<PrOutcome> = {}): PrOutcome => ({
    statusOverride: null,
    nwo: null,
    branch: null,
    baseBranch: null,
    prUrl: null,
    commits: [],
    pushed: false,
    worktreePath: null,
    worktreePreserved: false,
    amendedPrNumber: null,
    verification: null,
    critic: null,
    criticRetriesUsed: 0,
    prQueued: false,
    staleBase: false,
    ...over,
  });

  it("timeout with pushed commits → timeout_partial (done/ routing)", () => {
    expect(computePrStatus({ ...ok, timedOut: true }, emptyOutcome({ pushed: true }), null)).toBe(
      "timeout_partial",
    );
  });

  it("timeout without a push → timeout (failed/ routing)", () => {
    expect(computePrStatus({ ...ok, timedOut: true }, emptyOutcome(), null)).toBe("timeout");
    expect(computePrStatus({ ...ok, timedOut: true }, null, null)).toBe("timeout");
  });

  // Guard-abort branches (issue #125): the SOFT-abort twin of the timeout ones.
  it("guard abort with pushed commits → aborted_partial (done/ routing)", () => {
    expect(
      computePrStatus({ ...ok, abortedByGuard: true }, emptyOutcome({ pushed: true }), null),
    ).toBe("aborted_partial");
  });

  it("guard abort without a push → aborted_no_changes (failed/ routing)", () => {
    expect(computePrStatus({ ...ok, abortedByGuard: true }, emptyOutcome(), null)).toBe(
      "aborted_no_changes",
    );
    expect(computePrStatus({ ...ok, abortedByGuard: true }, null, null)).toBe("aborted_no_changes");
  });

  // Offline soft-abort salvage (issue #123): the push never landed (pushed:false)
  // but the composite op is parked in the outbox (prQueued) — or, for an amend,
  // only the push (pushQueued). The queued op WILL land the branch, so the status
  // must route to done/ (*_partial) exactly like the online twin, not failed/.
  it("offline timeout salvage (prQueued, pushed:false) → timeout_partial", () => {
    expect(computePrStatus({ ...ok, timedOut: true }, emptyOutcome({ prQueued: true }), null)).toBe(
      "timeout_partial",
    );
  });

  it("offline guard-abort salvage (prQueued, pushed:false) → aborted_partial", () => {
    expect(
      computePrStatus({ ...ok, abortedByGuard: true }, emptyOutcome({ prQueued: true }), null),
    ).toBe("aborted_partial");
  });

  it("offline amend soft-abort (pushQueued, pushed:false) → *_partial", () => {
    expect(
      computePrStatus({ ...ok, timedOut: true }, emptyOutcome({ pushQueued: true }), null),
    ).toBe("timeout_partial");
    expect(
      computePrStatus({ ...ok, abortedByGuard: true }, emptyOutcome({ pushQueued: true }), null),
    ).toBe("aborted_partial");
  });

  // A normal (non-soft-abort) offline run stays `completed` — the queued-op
  // treatment only flips the timeout/guard branches, never the happy path.
  it("normal offline run (prQueued, not timed-out/aborted) stays completed", () => {
    expect(computePrStatus(ok, emptyOutcome({ prQueued: true }), null)).toBe("completed");
  });
});

describe("finalizePr offline note", () => {
  const outcome = (over: Partial<PrOutcome> = {}): PrOutcome => ({
    statusOverride: null,
    nwo: "owner/repo",
    branch: "junco/q1",
    baseBranch: "main",
    prUrl: null,
    commits: [],
    pushed: false,
    worktreePath: null,
    worktreePreserved: true,
    amendedPrNumber: null,
    verification: null,
    critic: null,
    criticRetriesUsed: 0,
    prQueued: false,
    staleBase: false,
    ...over,
  });

  it("renders the offline-queue note in the Result section when prQueued", () => {
    const { ticket, done, failed } = sandbox();
    const { dst, status } = finalizePr(ticket, ok, outcome({ prQueued: true }), {
      dirs: { done, failed },
    });
    expect(status).toBe("completed");
    expect(dst.startsWith(done)).toBe(true);
    const text = readFileSync(dst, "utf8");
    expect(text).toContain(
      "PR queued for offline push — junco will open it automatically when GitHub is reachable.",
    );
    // Machine-readable twin (#298): the dependency sweep reads this marker to
    // know a PR is coming but does not exist yet.
    expect(text).toMatch(/^pr_queued: true$/m);
  });

  it("omits the note on a normal PR finalize", () => {
    const { ticket, done, failed } = sandbox();
    const { dst } = finalizePr(
      ticket,
      ok,
      outcome({ prUrl: "https://github.com/owner/repo/pull/1", pushed: true }),
      { dirs: { done, failed } },
    );
    const text = readFileSync(dst, "utf8");
    expect(text).not.toContain("PR queued for offline push");
    expect(text).not.toContain("pr_queued: true");
  });

  // Issue #50: an offline AMEND parks only the push (the PR URL is already
  // known), so the result block must say the push is queued rather than
  // reading as unqualified success — mirroring the offline-fresh prQueued note,
  // without a new terminal status.
  it("renders the queued-push note for an offline amend (pushQueued), staying completed", () => {
    const { ticket, done, failed } = sandbox();
    const { dst, status } = finalizePr(
      ticket,
      ok,
      outcome({
        pushQueued: true,
        pushed: false,
        prUrl: "https://github.com/owner/repo/pull/1",
        amendedPrNumber: 1,
      }),
      { dirs: { done, failed } },
    );
    expect(status).toBe("completed");
    expect(dst.startsWith(done)).toBe(true);
    const text = readFileSync(dst, "utf8");
    expect(text).toContain("Amend push queued for offline delivery");
    // Not the fresh-path wording (a PR already exists here).
    expect(text).not.toContain("PR queued for offline push");
  });

  it("omits the queued-push note when the amend push landed", () => {
    const { ticket, done, failed } = sandbox();
    const { dst } = finalizePr(
      ticket,
      ok,
      outcome({ pushed: true, prUrl: "https://github.com/owner/repo/pull/1", amendedPrNumber: 1 }),
      { dirs: { done, failed } },
    );
    expect(readFileSync(dst, "utf8")).not.toContain("Amend push queued");
  });
});
