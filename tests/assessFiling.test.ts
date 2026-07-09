import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
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

function cfg(stateDir: string): Config {
  return { stateDir, github: { triggerLabel: "junco" } } as unknown as Config;
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
  it("files only the selected findings and archives the batch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "afl-"));
    const c = cfg(dir);
    writePending(c, pending(false));
    const calls: string[][] = [];
    const res = await fileFindings(c, pending(false), new Set(["f1"]), { ghFn: ghFake(calls) });

    expect(res.created).toBe(1);
    expect(res.urls).toEqual(["https://github.com/o/r/issues/9"]);
    const creates = calls.filter((a) => a[0] === "issue" && a[1] === "create");
    expect(creates).toHaveLength(1);
    // owned → labelled
    expect(creates[0]).toContain("--label");
    // archived
    expect(readPending(c, "assess-x-1").batch).toBeNull();
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

    const res = await fileFindings(c, pending(true), new Set(["f1"]), { ghFn });
    expect(res.queuedOffline).toBe(1);
    expect(res.created).toBe(0);
    expect(listOps(c).some((o) => o.op.kind === "issue-create")).toBe(true);
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
    const res = await fileFindings(c, pending(true), new Set(["f1", "f2"]), { ghFn });
    expect(res.deduped).toBe(1);
    expect(res.created).toBe(1);
  });
});
