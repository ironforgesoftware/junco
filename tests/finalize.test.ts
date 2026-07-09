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
  usage: { input: 1, output: 1, cacheRead: 0, total: 2 },
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
  });

  it("omits the note on a normal PR finalize", () => {
    const { ticket, done, failed } = sandbox();
    const { dst } = finalizePr(
      ticket,
      ok,
      outcome({ prUrl: "https://github.com/owner/repo/pull/1", pushed: true }),
      { dirs: { done, failed } },
    );
    expect(readFileSync(dst, "utf8")).not.toContain("PR queued for offline push");
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
