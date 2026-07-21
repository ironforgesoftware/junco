import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileFindings } from "../src/assessFiling.js";
import { writePending, readPending, type PendingAssess } from "../src/assessReview.js";
import { findingMarker } from "../src/findings.js";
import { listOps } from "../src/githubOutbox.js";
import type { Config } from "../src/types.js";
import { GitOpError, type gh } from "../src/git.js";

/** Network-shaped GitOpError → isOffline()/isNetworkError() true. */
const NET_ERR = new GitOpError("gh failed", "connect: network is unreachable", 1);
/** Non-network (permission) GitOpError → isOffline() false. */
const PERM_ERR = new GitOpError("gh failed", "HTTP 403: Forbidden", 1);
const NOW = () => new Date("2026-07-19T12:00:00.000Z");
const AT = "2026-07-19T12:00:00.000Z";

function cfg(stateDir: string): Config {
  return { dataDir: stateDir, github: { triggerLabel: "junco" } } as unknown as Config;
}
function pending(external: boolean): PendingAssess {
  return {
    id: "assess-x-1",
    nwo: "o/r",
    external,
    autoPlan: false,
    repoPath: "/x",
    createdAt: "2026-07-09T00:00:00.000Z",
    findings: [
      {
        fingerprint: "f1",
        kind: "code",
        severity: "high",
        ruleId: "R1",
        title: "One",
        description: "d1",
        references: [],
      },
      {
        fingerprint: "f2",
        kind: "code",
        severity: "low",
        ruleId: "R2",
        title: "Two",
        description: "d2",
        references: [],
      },
    ],
  };
}

/** gh fake: records argv; empty issue-list (no prior markers); issue-create prints a URL. */
function ghFake(calls: string[][]): typeof gh {
  return (async (_c: unknown, args: string[]) => {
    calls.push(args);
    if (args[0] === "issue" && args[1] === "list") return { stdout: "[]", stderr: "", code: 0 };
    if (args[0] === "issue" && args[1] === "create")
      return { stdout: "https://github.com/o/r/issues/9\n", stderr: "", code: 0 };
    return { stdout: "", stderr: "", code: 0 };
  }) as unknown as typeof gh;
}

describe("fileFindings", () => {
  it("files the selected findings, stamps them filed, and keeps the batch parked", async () => {
    const dir = mkdtempSync(join(tmpdir(), "afl-"));
    const c = cfg(dir);
    writePending(c, pending(false));
    const calls: string[][] = [];
    const res = await fileFindings(c, pending(false), new Set(["f1"]), {
      ghFn: ghFake(calls),
      nowFn: NOW,
    });

    expect(res.created).toBe(1);
    expect(res.urls).toEqual(["https://github.com/o/r/issues/9"]);
    const creates = calls.filter((a) => a[0] === "issue" && a[1] === "create");
    expect(creates).toHaveLength(1);
    // owned → labelled
    expect(creates[0]).toContain("--label");
    const { batch } = readPending(c, "assess-x-1");
    expect(batch).not.toBeNull();
    expect(batch?.filed).toEqual({
      f1: { at: AT, how: "created", url: "https://github.com/o/r/issues/9" },
    });
    expect(res.batch).toEqual(batch);
  });

  it("external batch files WITHOUT labels and never calls label create", async () => {
    const dir = mkdtempSync(join(tmpdir(), "afl-"));
    const c = cfg(dir);
    writePending(c, pending(true));
    const calls: string[][] = [];
    await fileFindings(c, pending(true), new Set(["f1", "f2"]), { ghFn: ghFake(calls) });

    const creates = calls.filter((a) => a[0] === "issue" && a[1] === "create");
    expect(creates).toHaveLength(2);
    for (const cr of creates) expect(cr).not.toContain("--label");
    expect(calls.some((a) => a[0] === "label")).toBe(false);
  });

  it("offline label ensure keeps labels on the enqueued op (owned)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "afl-"));
    const c = cfg(dir);
    writePending(c, pending(false));
    // Fully offline: label create AND issue create fail network-shaped; list is
    // empty (dedup degrades cleanly). Fix 2: labels must NOT be stripped.
    const ghFn = (async (_c: unknown, args: string[]) => {
      if (args[0] === "label" && args[1] === "create") throw NET_ERR;
      if (args[0] === "issue" && args[1] === "list") return { stdout: "[]", stderr: "", code: 0 };
      if (args[0] === "issue" && args[1] === "create") throw NET_ERR;
      return { stdout: "", stderr: "", code: 0 };
    }) as unknown as typeof gh;

    const res = await fileFindings(c, pending(false), new Set(["f1"]), { ghFn });
    expect(res.queuedOffline).toBe(1);
    expect(res.created).toBe(0);
    // offline is not a permission failure — do not warn about label-free
    expect(res.warnings.some((w) => /label-free/.test(w))).toBe(false);

    const issueOps = listOps(c).filter((o) => o.op.kind === "issue-create");
    expect(issueOps).toHaveLength(1);
    const op = issueOps[0].op;
    expect(op.kind).toBe("issue-create");
    if (op.kind === "issue-create") {
      expect(op.labels).toContain("severity/high");
      expect(op.labels.length).toBeGreaterThan(0);
    }
  });

  it("label create permission failure drops to label-free but still files (owned)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "afl-"));
    const c = cfg(dir);
    writePending(c, pending(false));
    const calls: string[][] = [];
    const ghFn = (async (_c: unknown, args: string[]) => {
      calls.push(args);
      if (args[0] === "label" && args[1] === "create") throw PERM_ERR;
      if (args[0] === "issue" && args[1] === "list") return { stdout: "[]", stderr: "", code: 0 };
      if (args[0] === "issue" && args[1] === "create")
        return { stdout: "https://github.com/o/r/issues/9\n", stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 0 };
    }) as unknown as typeof gh;

    const res = await fileFindings(c, pending(false), new Set(["f1"]), { ghFn });
    expect(res.created).toBe(1);
    expect(res.failed).toBe(0);
    // filed label-free — the create carried no --label, and a warning explains why
    const create = calls.find((a) => a[0] === "issue" && a[1] === "create");
    expect(create).not.toContain("--label");
    expect(res.warnings.some((w) => /label-free/.test(w))).toBe(true);
  });

  it("offline issue create enqueues an issue-create op and counts queuedOffline", async () => {
    const dir = mkdtempSync(join(tmpdir(), "afl-"));
    const c = cfg(dir);
    writePending(c, pending(true));
    const ghFn = (async (_c: unknown, args: string[]) => {
      if (args[0] === "issue" && args[1] === "list") return { stdout: "[]", stderr: "", code: 0 };
      if (args[0] === "issue" && args[1] === "create") throw NET_ERR;
      return { stdout: "", stderr: "", code: 0 };
    }) as unknown as typeof gh;

    const res = await fileFindings(c, pending(true), new Set(["f1"]), { ghFn, nowFn: NOW });
    expect(res.queuedOffline).toBe(1);
    expect(res.created).toBe(0);
    expect(listOps(c).some((o) => o.op.kind === "issue-create")).toBe(true);
    expect(readPending(c, "assess-x-1").batch?.filed?.f1).toEqual({ at: AT, how: "queued" });
  });

  it("skips a finding already filed (marker present in author-scoped list)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "afl-"));
    const c = cfg(dir);
    writePending(c, pending(true));
    const ghFn = (async (_c: unknown, args: string[]) => {
      if (args[1] === "list")
        return { stdout: JSON.stringify([{ body: findingMarker("f1") }]), stderr: "", code: 0 };
      if (args[1] === "create")
        return { stdout: "https://github.com/o/r/issues/9\n", stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 0 };
    }) as unknown as typeof gh;
    const res = await fileFindings(c, pending(true), new Set(["f1", "f2"]), { ghFn, nowFn: NOW });
    expect(res.deduped).toBe(1);
    expect(res.created).toBe(1);
    const { batch } = readPending(c, "assess-x-1");
    expect(batch?.filed?.f1).toEqual({ at: AT, how: "deduped" });
    expect(batch?.filed?.f2).toEqual({
      at: AT,
      how: "created",
      url: "https://github.com/o/r/issues/9",
    });
  });

  it("does NOT archive the batch when every selected finding fails with a non-offline error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "afl-"));
    const c = cfg(dir);
    writePending(c, pending(true));
    // Every issue-create throws a permission (non-offline) error: tryOrEnqueue
    // rethrows, the loop swallows it into result.failed, and fileFindings does
    // NOT throw. The batch must stay parked so `junco assess review`/`file` can
    // retry — a fully-failed filing must not discard the review (#137).
    const ghFn = (async (_c: unknown, args: string[]) => {
      if (args[0] === "issue" && args[1] === "list") return { stdout: "[]", stderr: "", code: 0 };
      if (args[0] === "issue" && args[1] === "create") throw PERM_ERR;
      return { stdout: "", stderr: "", code: 0 };
    }) as unknown as typeof gh;

    const res = await fileFindings(c, pending(true), new Set(["f1", "f2"]), { ghFn });
    expect(res.failed).toBe(2);
    expect(res.created).toBe(0);
    expect(readPending(c, "assess-x-1").batch).not.toBeNull();
    expect(readPending(c, "assess-x-1").batch?.filed).toBeUndefined();
  });

  it("stamps persist for the successful subset even when another finding fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "afl-"));
    const c = cfg(dir);
    writePending(c, pending(true));
    let n = 0;
    const ghFn = (async (_c: unknown, args: string[]) => {
      if (args[0] === "issue" && args[1] === "list") return { stdout: "[]", stderr: "", code: 0 };
      if (args[0] === "issue" && args[1] === "create") {
        n++;
        if (n === 2) throw PERM_ERR; // f2 fails non-offline
        return { stdout: "https://github.com/o/r/issues/9\n", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    }) as unknown as typeof gh;

    const res = await fileFindings(c, pending(true), new Set(["f1", "f2"]), { ghFn, nowFn: NOW });
    expect(res.created).toBe(1);
    expect(res.failed).toBe(1);
    // The rewrite happened despite the failure: f1's stamp is durable, f2 is retryable.
    const { batch } = readPending(c, "assess-x-1");
    expect(batch?.filed).toEqual({
      f1: { at: AT, how: "created", url: "https://github.com/o/r/issues/9" },
    });
  });

  it("a partially-queued pass stamps created + queued and keeps the batch parked", async () => {
    const dir = mkdtempSync(join(tmpdir(), "afl-"));
    const c = cfg(dir);
    writePending(c, pending(true));
    // f1 files live, f2 goes offline (queuedOffline, not failed) — a
    // partially-queued pass. Both outcomes get stamped and the batch stays
    // parked (no auto-archive) for a subsequent retry/discard.
    let n = 0;
    const ghFn = (async (_c: unknown, args: string[]) => {
      if (args[0] === "issue" && args[1] === "list") return { stdout: "[]", stderr: "", code: 0 };
      if (args[0] === "issue" && args[1] === "create") {
        n++;
        if (n === 2) throw NET_ERR;
        return { stdout: "https://github.com/o/r/issues/9\n", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    }) as unknown as typeof gh;

    const res = await fileFindings(c, pending(true), new Set(["f1", "f2"]), { ghFn, nowFn: NOW });
    expect(res.created).toBe(1);
    expect(res.queuedOffline).toBe(1);
    expect(res.failed).toBe(0);
    const { batch } = readPending(c, "assess-x-1");
    expect(batch?.filed?.f1).toEqual({
      at: AT,
      how: "created",
      url: "https://github.com/o/r/issues/9",
    });
    expect(batch?.filed?.f2).toEqual({ at: AT, how: "queued" });
  });

  // SP-3 Task 5: filed findings reference the scoping issue.
  it("threads batch.issue into the filed issue body as a **Context:** line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "afl-"));
    const c = cfg(dir);
    const batch = { ...pending(false), issue: 7 };
    writePending(c, batch);
    const bodies: string[] = [];
    const ghFn = (async (_c: unknown, args: string[]) => {
      if (args[0] === "issue" && args[1] === "list") return { stdout: "[]", stderr: "", code: 0 };
      if (args[0] === "issue" && args[1] === "create") {
        const idx = args.indexOf("--body-file");
        bodies.push(readFileSync(args[idx + 1], "utf8"));
        return { stdout: "https://github.com/o/r/issues/9\n", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    }) as unknown as typeof gh;

    await fileFindings(c, batch, new Set(["f1"]), { ghFn });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain("**Context:** o/r#7");
  });

  it("empty/no-match selection returns zeroed counts and does NOT archive the batch (defense-in-depth for the --only-typo fix, #106)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "afl-"));
    const c = cfg(dir);
    writePending(c, pending(false));
    const calls: string[][] = [];
    // Nothing selected: this is the case the CLI-level --only guard in
    // runAssessFileCommand already rejects, but fileFindings must independently
    // refuse to file or archive on an empty selection — belt-and-suspenders so
    // no future caller of fileFindings can slip an empty set past the guard.
    const res = await fileFindings(c, pending(false), new Set(), { ghFn: ghFake(calls) });

    expect(res).toEqual({
      created: 0,
      queuedOffline: 0,
      deduped: 0,
      failed: 0,
      urls: [],
      warnings: [],
      batch: pending(false),
    });
    // no gh calls at all — not even the dedup list fetch
    expect(calls).toHaveLength(0);
    // the batch is still parked, not archived
    expect(readPending(c, "assess-x-1").batch).not.toBeNull();
  });

  it("a selection matching no known fingerprints behaves the same as an empty selection", async () => {
    const dir = mkdtempSync(join(tmpdir(), "afl-"));
    const c = cfg(dir);
    writePending(c, pending(false));
    const calls: string[][] = [];
    const res = await fileFindings(c, pending(false), new Set(["no-such-fingerprint"]), {
      ghFn: ghFake(calls),
    });

    expect(res.created).toBe(0);
    expect(res.failed).toBe(0);
    expect(calls).toHaveLength(0);
    expect(res.batch.id).toBe("assess-x-1");
    expect(readPending(c, "assess-x-1").batch).not.toBeNull();
  });

  it("without batch.issue, the filed issue body has no **Context:** line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "afl-"));
    const c = cfg(dir);
    writePending(c, pending(false));
    const bodies: string[] = [];
    const ghFn = (async (_c: unknown, args: string[]) => {
      if (args[0] === "issue" && args[1] === "list") return { stdout: "[]", stderr: "", code: 0 };
      if (args[0] === "issue" && args[1] === "create") {
        const idx = args.indexOf("--body-file");
        bodies.push(readFileSync(args[idx + 1], "utf8"));
        return { stdout: "https://github.com/o/r/issues/9\n", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    }) as unknown as typeof gh;

    await fileFindings(c, pending(false), new Set(["f1"]), { ghFn });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toContain("**Context:**");
  });
});

describe("filed-record fidelity (#232)", () => {
  it("re-filing a created finding never downgrades its record to dup", async () => {
    const dir = mkdtempSync(join(tmpdir(), "afl-"));
    const c = cfg(dir);
    const prior: PendingAssess = {
      ...pending(false),
      filed: {
        f1: {
          at: "2026-07-18T00:00:00.000Z",
          how: "created",
          url: "https://github.com/o/r/issues/5",
        },
      },
    };
    writePending(c, prior);
    // The marker for f1 exists upstream → this pass dedups it.
    const ghFn = (async (_c: unknown, args: string[]) => {
      if (args[0] === "issue" && args[1] === "list")
        return { stdout: JSON.stringify([{ body: findingMarker("f1") }]), stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 0 };
    }) as unknown as typeof gh;
    const res = await fileFindings(c, prior, new Set(["f1"]), { ghFn, nowFn: NOW });
    expect(res.deduped).toBe(1);
    // The prior record survives untouched — provenance + URL are never lost.
    const keep = {
      at: "2026-07-18T00:00:00.000Z",
      how: "created",
      url: "https://github.com/o/r/issues/5",
    };
    expect(res.batch.filed?.f1).toEqual(keep);
    expect(readPending(c, "assess-x-1").batch?.filed?.f1).toEqual(keep);
  });

  it("a first-time dedup (no prior record) still stamps `deduped`", async () => {
    const dir = mkdtempSync(join(tmpdir(), "afl-"));
    const c = cfg(dir);
    writePending(c, pending(false));
    const ghFn = (async (_c: unknown, args: string[]) => {
      if (args[0] === "issue" && args[1] === "list")
        return { stdout: JSON.stringify([{ body: findingMarker("f1") }]), stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 0 };
    }) as unknown as typeof gh;
    const res = await fileFindings(c, pending(false), new Set(["f1"]), { ghFn, nowFn: NOW });
    expect(res.batch.filed?.f1).toEqual({ at: AT, how: "deduped" });
  });
});
