/**
 * Plan-set store (spec 2026-08-20, Layer 2): the durable record of a compiled
 * set — the approved plan's markdown copy plus a JSON record naming the
 * children — under the data tree (transcripts precedent). fs only; the gh side
 * lives in planSetBridge.ts.
 */
import { readdirSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./types.js";
import { dataTreePaths } from "./dataTree.js";

export interface PlanSetRecord {
  v: 1;
  planId: string;
  hash: string;
  repoPath: string;
  github: { nwo: string; issue: number } | null;
  tasks: { id: string; ticketId: string; dependsOn: string[] }[];
  createdAt: string; // ISO
  statusCommentId: number | null; // dashboard comment cache (bridge sets)
  degradedPosted: boolean;
  lastLabel: string | null; // last set-level lifecycle label applied
  closed: boolean; // all-terminal handled; maintenance stops
}

export function plansDir(cfg: Config): string {
  return dataTreePaths(cfg).plans;
}

function atomicWrite(path: string, content: string): void {
  const tmp = path + ".tmp";
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, path);
}

export function writePlanSetRecord(cfg: Config, record: PlanSetRecord): void {
  const dir = plansDir(cfg);
  mkdirSync(dir, { recursive: true });
  atomicWrite(join(dir, `${record.planId}.json`), JSON.stringify(record, null, 2) + "\n");
}

export function readPlanSetRecord(cfg: Config, planId: string): PlanSetRecord | null {
  try {
    const raw = JSON.parse(readFileSync(join(plansDir(cfg), `${planId}.json`), "utf8")) as unknown;
    return raw !== null && typeof raw === "object" && (raw as PlanSetRecord).v === 1
      ? (raw as PlanSetRecord)
      : null;
  } catch {
    return null; // absent or corrupt — callers treat as no record
  }
}

export function listPlanSetRecords(cfg: Config): PlanSetRecord[] {
  let names: string[] = [];
  try {
    names = readdirSync(plansDir(cfg)).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  return names
    .map((n) => readPlanSetRecord(cfg, n.replace(/\.json$/, "")))
    .filter((r): r is PlanSetRecord => r !== null);
}

export function materializePlanSet(cfg: Config, record: PlanSetRecord, fenceBody: string): void {
  const dir = plansDir(cfg);
  mkdirSync(dir, { recursive: true });
  atomicWrite(join(dir, `${record.planId}.md`), fenceBody.trimEnd() + "\n");
  writePlanSetRecord(cfg, record);
}
