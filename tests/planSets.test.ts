/**
 * Tests for src/planSets.ts — the plan-set store (spec 2026-08-20, Layer 2):
 * the durable record of a compiled set — the approved plan's markdown copy plus
 * a JSON record naming the children — under the data tree (transcripts precedent).
 * Written FIRST (TDD).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import type { Config, Paths } from "../src/types.js";
import { queuePaths } from "../src/config.js";
import type { CompiledChild } from "../src/planCompiler.js";
import {
  materializePlanSet,
  readPlanSetRecord,
  listPlanSetRecords,
  plansDir,
  resolveSetState,
  renderDashboard,
  submitPlanSet,
  supersedeUnclaimed,
  PLAN_STATUS_MARKER,
  type PlanSetRecord,
} from "../src/planSets.js";
import { makeConfig } from "./helpers/config.js";

function record(overrides: Partial<PlanSetRecord> = {}): PlanSetRecord {
  return {
    v: 1,
    planId: "p1",
    hash: "abc123",
    repoPath: "/tmp/repo",
    github: { nwo: "owner/repo", issue: 42 },
    tasks: [{ id: "t1", ticketId: "tick1", dependsOn: [] }],
    createdAt: "2026-08-20T00:00:00Z",
    statusCommentId: null,
    degradedPosted: false,
    lastLabel: null,
    closed: false,
    ...overrides,
  };
}

describe("plan-set store", () => {
  let root: string;
  let cfg: Config;
  let qp: Paths;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "junco-pset-"));
    cfg = makeConfig(
      {
        dataDir: join(root, "data"),
        queueRoot: join(root, "queue"),
        worktreeRoot: join(root, "worktrees"),
        tools: [],
        criticEnabled: false,
        planLintEnabled: false,
        verifyEnabled: false,
        supervisorEnabled: false,
        healthEnabled: false,
        removeWorktreeOnSuccess: false,
      },
      { dataLayout: "v2" },
    );
    qp = queuePaths(cfg);
    mkdirSync(qp.inbox, { recursive: true });
    mkdirSync(qp.processing, { recursive: true });
    mkdirSync(qp.done, { recursive: true });
    mkdirSync(qp.failed, { recursive: true });
  });

  it("materializes the plan md + record json and round-trips the record", () => {
    const rec = record();
    materializePlanSet(cfg, rec, "version: 1\ntasks: []");
    expect(readFileSync(join(plansDir(cfg), "p1.md"), "utf8")).toContain("version: 1");
    expect(readPlanSetRecord(cfg, "p1")).toEqual(rec);
    expect(listPlanSetRecords(cfg).map((r) => r.planId)).toEqual(["p1"]);
  });

  it("readPlanSetRecord returns null for absent/corrupt records; list skips corrupt files", () => {
    expect(readPlanSetRecord(cfg, "nope")).toBeNull();
    mkdirSync(plansDir(cfg), { recursive: true });
    writeFileSync(join(plansDir(cfg), "bad.json"), "{not json");
    expect(readPlanSetRecord(cfg, "bad")).toBeNull();
    expect(listPlanSetRecords(cfg)).toEqual([]);
  });

  describe("resolveSetState / renderDashboard", () => {
    it("maps queue reality to per-task states", () => {
      const rec = record({
        tasks: [
          { id: "a", ticketId: "p1-a", dependsOn: [] },
          { id: "b", ticketId: "p1-b", dependsOn: ["p1-a"] },
          { id: "c", ticketId: "p1-c", dependsOn: ["p1-b"] },
          { id: "d", ticketId: "p1-d", dependsOn: [] },
        ],
      });
      writeFileSync(
        join(qp.done, "p1-a.md"),
        "---\nid: p1-a\n---\nB\n\n---\n<!-- junco-result\nstatus: completed\npr_url: https://github.com/a/b/pull/1\n-->\n",
      );
      writeFileSync(join(qp.processing, "2026-08-20T1200Z__p1-b.md"), "---\nid: p1-b\n---\n");
      writeFileSync(join(qp.inbox, "p1-c.md"), "---\nid: p1-c\ndepends_on: [p1-b]\n---\n");
      writeFileSync(
        join(qp.failed, "p1-d.md"),
        "---\nid: p1-d\n---\nB\n\n---\n<!-- junco-result\nstatus: failed\ndependency_failed: p1-x\n-->\n",
      );
      const s = resolveSetState(cfg, rec);
      expect(s.tasks.map((t) => t.state)).toEqual(["done", "processing", "waiting", "failed"]);
      expect(s.tasks[0].prUrl).toBe("https://github.com/a/b/pull/1");
      expect(s.tasks[3].dependencyFailed).toBe("p1-x");
      expect(s.allTerminal).toBe(false);
      expect(s.anyFailed).toBe(true);
      expect(s.anyProcessing).toBe(true);
    });

    it("inbox ticket with all deps satisfied is 'queued', not 'waiting'; absent is 'absent'", () => {
      const rec = record({
        tasks: [
          { id: "a", ticketId: "p1-a", dependsOn: [] },
          { id: "b", ticketId: "p1-b", dependsOn: [] },
        ],
      });
      writeFileSync(join(qp.inbox, "p1-a.md"), "---\nid: p1-a\n---\n");
      const s = resolveSetState(cfg, rec);
      expect(s.tasks[0].state).toBe("queued");
      expect(s.tasks[1].state).toBe("absent");
    });

    it("renderDashboard carries the marker, checkboxes, PR links, and waiting edges", () => {
      const rec = record({ tasks: [{ id: "a", ticketId: "p1-a", dependsOn: [] }] });
      const md = renderDashboard(rec, {
        tasks: [
          {
            id: "a",
            ticketId: "p1-a",
            state: "done",
            prUrl: "https://x/pr/1",
            dependencyFailed: null,
            superseded: null,
          },
        ],
        allTerminal: true,
        allDone: true,
        anyFailed: false,
        anyProcessing: false,
      });
      expect(md).toContain(PLAN_STATUS_MARKER);
      expect(md).toContain("- [x] `a` — done — https://x/pr/1");
      expect(md).toContain(rec.hash);
    });

    it("reports a disposed child as superseded, not failed", () => {
      const rec = record({ tasks: [{ id: "a", ticketId: "p1-a", dependsOn: [] }] });
      writeFileSync(
        join(qp.failed, "p1-a.md"),
        "---\nid: p1-a\n---\nBody\n\n---\n<!-- junco-result\nstatus: failed\nsuperseded: abc123\n-->\n",
      );
      const s = resolveSetState(cfg, rec);
      expect(s.tasks[0].state).toBe("superseded");
      expect(s.tasks[0].superseded).toBe("abc123");
      expect(s.anyFailed).toBe(false);
      expect(s.allTerminal).toBe(true);
    });

    it("still reports an ordinary failure as failed", () => {
      const rec = record({ tasks: [{ id: "a", ticketId: "p1-a", dependsOn: [] }] });
      writeFileSync(
        join(qp.failed, "p1-a.md"),
        "---\nid: p1-a\n---\nBody\n\n---\n<!-- junco-result\nstatus: failed\n-->\n",
      );
      const s = resolveSetState(cfg, rec);
      expect(s.tasks[0].state).toBe("failed");
      expect(s.tasks[0].superseded).toBeNull();
      expect(s.anyFailed).toBe(true);
    });

    it("renders a superseded row distinctly", () => {
      const rec = record({ tasks: [{ id: "a", ticketId: "p1-a", dependsOn: [] }] });
      writeFileSync(
        join(qp.failed, "p1-a.md"),
        "---\nid: p1-a\n---\nBody\n\n---\n<!-- junco-result\nstatus: failed\nsuperseded: abc123\n-->\n",
      );
      const out = renderDashboard(rec, resolveSetState(cfg, rec));
      expect(out).toMatch(/superseded — pre-empted by rev `abc123`/);
      expect(out).not.toMatch(/`a` — failed/);
    });
  });

  describe("submitPlanSet", () => {
    const kid = (id: string): CompiledChild => ({
      taskId: id.split("-").pop() as string,
      ticketId: id,
      dependsOn: [],
      content: `---\nid: ${id}\n---\nBody\n`,
    });

    it("submits absent children; skips ones anywhere in the queue (done included)", () => {
      writeFileSync(join(qp.done, "2026-08-20T1200Z__p1-a.md"), "x"); // finished on a prior crash-recovery cycle
      writeFileSync(join(qp.inbox, "p1-b.md"), "x");
      const r = submitPlanSet(cfg, [kid("p1-a"), kid("p1-b"), kid("p1-c")]);
      expect(r.skipped.sort()).toEqual(["p1-a", "p1-b"]);
      expect(r.stranded).toEqual([]);
      expect(r.submitted).toHaveLength(1);
      expect(r.submitted[0].ticketId).toBe("p1-c");
      expect(r.submitted[0].dst).toBe(join(qp.inbox, "p1-c.md"));
      expect(existsSync(join(qp.inbox, "p1-c.md"))).toBe(true);
    });

    // #298 review round 1: the strict default (resubmitFailed unset) must
    // keep skipping a failed/ child — this is the crash-recovery / remove-
    // label-gesture guarantee dispatchPlanSet relies on. Set true, the SAME
    // failed/ child becomes submit-eligible — this is what a caller doing
    // its OWN supersede (trySupersede, the CLI's `submit --plan` re-run
    // door) needs, since done/inbox/processing must still skip either way.
    it("resubmitFailed: true also submits a `failed` child; done/inbox/processing still skip", () => {
      writeFileSync(join(qp.done, "2026-08-20T1200Z__p1-a.md"), "x");
      writeFileSync(join(qp.inbox, "p1-b.md"), "x");
      writeFileSync(join(qp.failed, "p1-c.md"), "---\nid: p1-c\n---\nOld\n");

      const strict = submitPlanSet(cfg, [kid("p1-a"), kid("p1-b"), kid("p1-c")]);
      expect(strict.skipped.sort()).toEqual(["p1-a", "p1-b", "p1-c"]);
      expect(strict.submitted).toEqual([]);

      const loose = submitPlanSet(cfg, [kid("p1-a"), kid("p1-b"), kid("p1-c")], {
        resubmitFailed: true,
      });
      expect(loose.skipped.sort()).toEqual(["p1-a", "p1-b"]);
      expect(loose.submitted).toHaveLength(1);
      expect(loose.submitted[0].ticketId).toBe("p1-c");
      expect(existsSync(join(qp.inbox, "p1-c.md"))).toBe(true);
      // The old failed/ copy is left as audit, untouched.
      expect(readFileSync(join(qp.failed, "p1-c.md"), "utf8")).toContain("Old");
    });

    it("resubmitFailed: true contains a per-child submit throw on `stranded`", () => {
      const throwing: CompiledChild = kid("p1-x");
      const r = submitPlanSet(cfg, [throwing], {
        resubmitFailed: true,
        submitFn: () => {
          throw new Error("disk full");
        },
      });
      expect(r.submitted).toEqual([]);
      expect(r.skipped).toEqual(["p1-x"]);
      expect(r.stranded).toEqual(["p1-x"]);
    });
  });

  describe("supersedeUnclaimed", () => {
    it("disposes inbox children with a superseded marker; done/processing untouched", () => {
      const rec = record({
        tasks: [
          { id: "a", ticketId: "p1-a", dependsOn: [] },
          { id: "b", ticketId: "p1-b", dependsOn: [] },
          { id: "c", ticketId: "p1-c", dependsOn: [] },
        ],
      });
      writeFileSync(join(qp.inbox, "p1-a.md"), "---\nid: p1-a\n---\nBody A\n");
      writeFileSync(
        join(qp.done, "p1-b.md"),
        "---\nid: p1-b\n---\nBody B\n\n---\n<!-- junco-result\nstatus: completed\n-->\n",
      );
      writeFileSync(join(qp.processing, "p1-c.md"), "---\nid: p1-c\n---\nBody C\n");

      const r = supersedeUnclaimed(cfg, rec, "newhash1");
      expect(r.disposed).toEqual(["p1-a"]);

      // The inbox child moved into failed/ with the superseded marker.
      expect(existsSync(join(qp.inbox, "p1-a.md"))).toBe(false);
      const failedContent = readFileSync(join(qp.failed, "p1-a.md"), "utf8");
      expect(failedContent).toContain("status: failed");
      expect(failedContent).toContain("superseded: newhash1");
      expect(failedContent).not.toContain("dependency_failed");

      // done/processing children are untouched.
      expect(existsSync(join(qp.done, "p1-b.md"))).toBe(true);
      expect(existsSync(join(qp.processing, "p1-c.md"))).toBe(true);
    });
  });
});
