/**
 * Tests for src/planSets.ts — the plan-set store (spec 2026-08-20, Layer 2):
 * the durable record of a compiled set — the approved plan's markdown copy plus
 * a JSON record naming the children — under the data tree (transcripts precedent).
 * Written FIRST (TDD).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import type { Config } from "../src/types.js";
import {
  materializePlanSet,
  readPlanSetRecord,
  listPlanSetRecords,
  plansDir,
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
});
