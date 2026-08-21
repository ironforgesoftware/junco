/**
 * Tests for src/planSetBridge.ts — the plan-set dispatch door (spec
 * 2026-08-20, Layer 2): compile → materialize → fan-out, called from
 * pollGithubInbox's plan-ready branch when planSets.enabled. Written FIRST
 * (TDD). dispatchPlanSet itself needs NO gh — it is pure fs (compiler +
 * planSets store), so these tests exercise it directly with no gh fakes.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, existsSync, readdirSync, renameSync, rmSync } from "node:fs";
import type { Config, Paths } from "../src/types.js";
import { queuePaths } from "../src/config.js";
import { readPlanSetRecord } from "../src/planSets.js";
import { dispatchPlanSet } from "../src/planSetBridge.js";
import { makeConfig } from "./helpers/config.js";

const NOW = "2026-08-20T12:00:00.000Z";

const FENCE = `version: 1
tasks:
  - {id: a, title: T A, depends_on: [], description: Build A., acceptance: [works]}
  - {id: b, title: T B, depends_on: [a], description: Build B., acceptance: [works]}
`;

describe("dispatchPlanSet", () => {
  let root: string;
  let cfg: Config;
  let qp: Paths;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "junco-bridge-"));
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
      { planSets: { enabled: true, mergePollSeconds: 60, maxTasks: 10 } },
    );
    qp = queuePaths(cfg);
    mkdirSync(qp.inbox, { recursive: true });
    mkdirSync(qp.processing, { recursive: true });
    mkdirSync(qp.done, { recursive: true });
    mkdirSync(qp.failed, { recursive: true });
  });

  it("compiles, materializes, and fans out; record carries the children", () => {
    const r = dispatchPlanSet(cfg, { nwo: "acme/api", path: "/sbxroot/clone" }, 9, FENCE, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.submitted).toHaveLength(2);
    const rec = readPlanSetRecord(cfg, r.submitted[0].replace(/-a$/, ""));
    expect(rec).not.toBeNull();
    expect(rec?.tasks.map((t) => t.id)).toEqual(["a", "b"]);
    expect(rec?.github).toEqual({ nwo: "acme/api", issue: 9 });
    expect(existsSync(join(qp.inbox, `${rec?.planId}-a.md`))).toBe(true);
  });

  it("compile errors dispatch nothing and return the whole error list", () => {
    const r = dispatchPlanSet(
      cfg,
      { nwo: "acme/api", path: "/p" },
      9,
      "version: 1\ntasks: []",
      NOW,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.length).toBeGreaterThan(0);
    expect(readdirSync(qp.inbox)).toEqual([]);
  });

  it("re-dispatch after a crash resubmits only missing children (done child skipped)", () => {
    const first = dispatchPlanSet(cfg, { nwo: "acme/api", path: "/p" }, 9, FENCE, NOW);
    if (!first.ok) throw new Error("setup");
    const planId = first.submitted[0].replace(/-a$/, "");
    // child a "finished" while the label swap was lost:
    renameSync(join(qp.inbox, `${planId}-a.md`), join(qp.done, `${planId}-a.md`));
    rmSync(join(qp.inbox, `${planId}-b.md`));
    const again = dispatchPlanSet(cfg, { nwo: "acme/api", path: "/p" }, 9, FENCE, NOW);
    expect(again.ok && again.submitted).toEqual([`${planId}-b`]);
    expect(again.ok && again.skipped).toEqual([`${planId}-a`]);
  });
});
