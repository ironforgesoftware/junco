import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  isTransientFailure,
  upsertFrontmatterKey,
  requeueTicket,
  CLAIM_PREFIX_RE,
} from "../src/requeue.js";
import { parseTicket } from "../src/ticket.js";
import { metrics } from "../src/metrics.js";
import type { Config, RunResult } from "../src/types.js";

const res = (over: Partial<RunResult>): RunResult => ({
  finalText: "",
  toolCalls: [],
  usage: { input: 0, output: 0, cacheRead: 0, total: 0 },
  stopReason: null,
  errorMessage: null,
  timedOut: false,
  durationMs: 1,
  abortedByGuard: false,
  ...over,
});

describe("isTransientFailure", () => {
  it("session error with no commits → transient", () =>
    expect(isTransientFailure(res({ errorMessage: "fetch failed" }), 0)).toBe(true));

  it("stop_reason error/length with no commits → transient", () => {
    expect(isTransientFailure(res({ stopReason: "error" }), 0)).toBe(true);
    expect(isTransientFailure(res({ stopReason: "length" }), 0)).toBe(true);
  });

  it("never transient with commits, on timeout, on guard abort, or on clean stop", () => {
    expect(isTransientFailure(res({ errorMessage: "x" }), 2)).toBe(false);
    expect(isTransientFailure(res({ timedOut: true }), 0)).toBe(false);
    expect(
      isTransientFailure(res({ abortedByGuard: true, errorMessage: "supervisor kill" }), 0),
    ).toBe(false);
    expect(isTransientFailure(res({ stopReason: "stop" }), 0)).toBe(false);
  });
});

describe("upsertFrontmatterKey", () => {
  it("inserts a new key inside existing frontmatter", () => {
    const out = upsertFrontmatterKey("---\nid: a\n---\nbody\n", "retry_count", 1);
    expect(out).toBe("---\nid: a\nretry_count: 1\n---\nbody\n");
  });

  it("replaces an existing key in place", () => {
    const out = upsertFrontmatterKey("---\nretry_count: 1\nid: a\n---\nb", "retry_count", 2);
    expect(out).toBe("---\nretry_count: 2\nid: a\n---\nb");
  });

  it("creates frontmatter when there is none", () => {
    expect(upsertFrontmatterKey("just a body\n", "retry_count", 1)).toBe(
      "---\nretry_count: 1\n---\n\njust a body\n",
    );
  });
});

describe("requeueTicket", () => {
  let root: string;
  let cfg: Config;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "junco-rq-"));
    mkdirSync(join(root, "inbox"), { recursive: true });
    mkdirSync(join(root, "processing"), { recursive: true });
    cfg = {
      vaultRoot: root,
      juncoSubdir: "",
      maxTransientRetries: 2,
      retryBackoffSeconds: 60,
    } as unknown as Config;
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const claimedFile = (content: string, name = "2026-06-10T1200Z__t1.md"): string => {
    const p = join(root, "processing", name);
    writeFileSync(p, content, "utf8");
    return p;
  };

  it("moves the ticket back to inbox with retry_count+1, a future not_before, and the claim stamp stripped", () => {
    const p = claimedFile("---\nid: t1\n---\ndo it\n");
    const t = parseTicket(p, readFileSync(p, "utf8"));
    const out = requeueTicket(cfg, p, t, "stop_reason=error");
    expect(out.requeued).toBe(true);
    expect(out.attempt).toBe(1);
    expect(out.dst).toBe(join(root, "inbox", "t1.md"));
    expect(existsSync(p)).toBe(false);
    const moved = readFileSync(out.dst!, "utf8");
    const parsed = parseTicket(out.dst!, moved);
    expect(parsed.retryCount).toBe(1);
    expect(Date.parse(parsed.notBefore!)).toBeGreaterThan(Date.now());
    expect(moved).not.toMatch(/junco-result/); // no result artifacts added
    expect(moved).toMatch(/do it/); // body intact
  });

  it("declines when the budget is exhausted", () => {
    const p = claimedFile("---\nid: t1\nretry_count: 2\n---\nx");
    const t = parseTicket(p, readFileSync(p, "utf8"));
    expect(requeueTicket(cfg, p, t, "r").requeued).toBe(false);
    expect(existsSync(p)).toBe(true); // untouched — caller finalizes to failed/
  });

  it("suffixes the name when the inbox already holds a same-named ticket", () => {
    writeFileSync(join(root, "inbox", "t1.md"), "occupied", "utf8");
    const p = claimedFile("---\nid: t1\n---\nx");
    const t = parseTicket(p, readFileSync(p, "utf8"));
    const out = requeueTicket(cfg, p, t, "r");
    expect(out.dst).toBe(join(root, "inbox", "t1-r1.md"));
  });

  it("declines a malformed-frontmatter ticket so the caller routes it to failed/ instead of looping (#108)", () => {
    // A frontmatter block with valid fences but invalid YAML re-parses to
    // retryCount 0 on every cycle; the textual upsert can't make the increment
    // stick, so the budget check would never trip → a backoff-free hot loop.
    const p = claimedFile("---\nid: t1\nfoo: [1, 2\n---\ndo it\n");
    const t = parseTicket(p, readFileSync(p, "utf8"));
    expect(t.retryCount).toBe(0); // malformed → parses as 0 (budget check passes forever)
    const before = metrics.snapshot().requeues;
    const out = requeueTicket(cfg, p, t, "stop_reason=error");
    expect(out.requeued).toBe(false); // NOT requeued
    expect(out.malformed).toBe(true); // signalled unexecutable so the caller finalizes to failed/
    expect(existsSync(p)).toBe(true); // left in processing/ for the caller to finalize
    expect(existsSync(join(root, "inbox", "t1.md"))).toBe(false); // never re-queued
    expect(metrics.snapshot().requeues).toBe(before); // not counted as a requeue
  });

  it("second retry stamps retry_count 2 and replaces (not duplicates) the keys", () => {
    const p = claimedFile(
      '---\nid: t1\nretry_count: 1\nnot_before: "2026-01-01T00:00:00Z"\n---\nx',
    );
    const t = parseTicket(p, readFileSync(p, "utf8"));
    const out = requeueTicket(cfg, p, t, "again");
    expect(out.attempt).toBe(2);
    const moved = readFileSync(out.dst!, "utf8");
    expect(moved.match(/retry_count:/g)).toHaveLength(1);
    expect(moved.match(/not_before:/g)).toHaveLength(1);
    expect(parseTicket(out.dst!, moved).retryCount).toBe(2);
  });

  it("CLAIM_PREFIX_RE matches the queue claim stamp", () => {
    expect(CLAIM_PREFIX_RE.test("2026-06-10T1200Z__x.md")).toBe(true);
    expect(CLAIM_PREFIX_RE.test("plain.md")).toBe(false);
  });

  it("counts a successful requeue in RunMetrics but not a declined one (#37)", () => {
    const before = metrics.snapshot().requeues;
    const ok = claimedFile("---\nid: t1\n---\nx");
    requeueTicket(cfg, ok, parseTicket(ok, readFileSync(ok, "utf8")), "r");
    expect(metrics.snapshot().requeues).toBe(before + 1);

    // Budget exhausted → no move, no count.
    const declined = claimedFile("---\nid: t2\nretry_count: 2\n---\nx", "2026-06-10T1200Z__t2.md");
    requeueTicket(cfg, declined, parseTicket(declined, readFileSync(declined, "utf8")), "r");
    expect(metrics.snapshot().requeues).toBe(before + 1);
  });
});
