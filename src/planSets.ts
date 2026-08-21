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
import { queuePaths } from "./config.js";
import { ticketState, findTicketFile } from "./ticketDeps.js";
import { parseResultMeta } from "./resultMeta.js";
import { parseTicket } from "./ticket.js";

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

export const PLAN_STATUS_MARKER = "<!-- junco:plan-status -->";
export type TaskRunState = "queued" | "waiting" | "processing" | "done" | "failed" | "absent";
export interface TaskStatus {
  id: string;
  ticketId: string;
  state: TaskRunState;
  prUrl: string | null;
  dependencyFailed: string | null;
}
export interface SetState {
  tasks: TaskStatus[];
  allTerminal: boolean;
  allDone: boolean;
  anyFailed: boolean;
  anyProcessing: boolean;
}

/** Recompute a set's task states from queue reality — the single source the
 * dashboard/labels derive from. Sweep-driven on purpose: cascaded children
 * never pass through the reporter, so event-driven state would go stale. */
export function resolveSetState(cfg: Config, record: PlanSetRecord): SetState {
  const paths = queuePaths(cfg);
  const tasks: TaskStatus[] = record.tasks.map((t) => {
    const st = ticketState(paths, t.ticketId);
    let state: TaskRunState;
    let prUrl: string | null = null;
    let dependencyFailed: string | null = null;
    if (st === "done" || st === "failed") {
      state = st;
      const f = findTicketFile(st === "done" ? paths.done : paths.failed, t.ticketId);
      if (f) {
        const meta = parseResultMeta(readFileSync(f, "utf8"));
        prUrl = meta.prUrl;
        dependencyFailed = meta.dependencyFailed;
      }
    } else if (st === "processing") {
      state = "processing";
    } else if (st === "inbox") {
      const f = findTicketFile(paths.inbox, t.ticketId);
      let pending = false;
      if (f) {
        try {
          const parsed = parseTicket(f, readFileSync(f, "utf8"));
          pending = parsed.dependsOn.some((d) => !parsed.depsSatisfied.includes(d));
        } catch {
          /* vanished/unreadable — treat as queued; next sweep refreshes */
        }
      }
      state = pending ? "waiting" : "queued";
    } else {
      state = "absent";
    }
    return { id: t.id, ticketId: t.ticketId, state, prUrl, dependencyFailed };
  });
  const terminal = (s: TaskRunState): boolean => s === "done" || s === "failed";
  return {
    tasks,
    allTerminal: tasks.every((t) => terminal(t.state)),
    allDone: tasks.every((t) => t.state === "done"),
    anyFailed: tasks.some((t) => t.state === "failed"),
    anyProcessing: tasks.some((t) => t.state === "processing"),
  };
}

export function renderDashboard(record: PlanSetRecord, state: SetState): string {
  const lines: string[] = [
    PLAN_STATUS_MARKER,
    `**Plan set status** — plan \`${record.planId}\`, rev \`${record.hash}\``,
    "",
  ];
  for (const t of state.tasks) {
    const box = t.state === "done" ? "x" : " ";
    let detail: string = t.state;
    if (t.state === "done" && t.prUrl) detail = `done — ${t.prUrl}`;
    if (t.state === "failed")
      detail = t.dependencyFailed
        ? `failed — dependency \`${t.dependencyFailed}\` failed`
        : "failed";
    if (t.state === "waiting") {
      const deps = record.tasks.find((r) => r.id === t.id)?.dependsOn ?? [];
      detail = `waiting on: ${deps.map((d) => `\`${d}\``).join(", ")}`;
    }
    lines.push(`- [${box}] \`${t.id}\` — ${detail}`);
  }
  lines.push("", "_Maintained by the worker each sweep; edits here are overwritten._");
  return lines.join("\n") + "\n";
}
