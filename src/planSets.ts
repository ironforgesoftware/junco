/**
 * Plan-set store (spec 2026-08-20, Layer 2): the durable record of a compiled
 * set — the approved plan's markdown copy plus a JSON record naming the
 * children — under the data tree (transcripts precedent). fs only; the gh side
 * lives in planSetBridge.ts.
 */
import { readdirSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import type { Config } from "./types.js";
import { dataTreePaths } from "./dataTree.js";
import { queuePaths } from "./config.js";
import { ticketState, findTicketFile } from "./ticketDeps.js";
import { uniqueDestPath } from "./uniqueDest.js";
import { parseResultMeta } from "./resultMeta.js";
import { parseTicket } from "./ticket.js";
import { submitTicket } from "./dispatch.js";
import type { CompiledChild } from "./planCompiler.js";

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
  /** When `closed` was set (ISO). Records closed longer ago than
   * PLAN_SET_COLD_MS stop being probed for plan-comment edits — without this,
   * every set ever created costs one paginated `gh api …/comments` call on
   * every sweep, forever (#298). Additive: a closed record written before this
   * field existed has no closedAt and is treated as WARM, so the change can
   * only remove cost, never silently drop a supersede. Limitation: once a
   * record goes cold, editing its plan comment and re-approving (the
   * trySupersede gesture) is no longer noticed — there is no gh-driven hook
   * that re-warms it (see planSetBridge.ts's maintainPlanSets), so a plan set
   * closed longer than the window must be re-submitted from scratch instead
   * of edited in place. */
  closedAt?: string;
  /** Last dashboard body successfully written to the status comment (bridge
   * sets, Task 10). Byte-identical render on the next sweep skips the gh
   * call entirely. Additive — absent on records from before this field
   * existed; readPlanSetRecord only checks `v === 1`, so those tolerate it
   * being undefined (the next sweep just re-syncs unconditionally once). */
  lastDashboard?: string;
  /** Hash of the last plan-comment fence a supersede recompile FAILED to
   * compile (Task 11). Bounds re-entry: without it, a compile error that the
   * human hasn't fixed yet would re-trigger — and re-post the same failure
   * comment — on every single sweep forever. The supersede trigger requires
   * the candidate hash to differ from BOTH `hash` (no edit) and this field
   * (already-failed edit, unchanged) — the human must edit again (a NEW
   * hash) or the check never re-fires. Additive, same tolerance as
   * `lastDashboard`. */
  lastFailedHash?: string;
  /** Ticket ids whose submit THREW during a supersede fan-out (not ids that
   * were legitimately skipped as already-landed). The fresh record carries the
   * new hash, so trySupersede's gate would otherwise block any re-trigger and
   * — since the child never landed — there is no failed/ file for `junco
   * retry` either, stranding it until the human edits the plan again (#298).
   * The next sweep retries these before the gate. Additive: absent = none. */
  pendingFanout?: string[];
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
export type TaskRunState =
  | "queued"
  | "waiting"
  | "processing"
  | "done"
  | "failed"
  | "superseded"
  | "absent";
export interface TaskStatus {
  id: string;
  ticketId: string;
  state: TaskRunState;
  prUrl: string | null;
  dependencyFailed: string | null;
  /** The plan revision that pre-empted this child before it ran (from the
   * result block's `superseded:` marker). Null for every other state. */
  superseded: string | null;
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
    let superseded: string | null = null;
    if (st === "done" || st === "failed") {
      state = st;
      const f = findTicketFile(st === "done" ? paths.done : paths.failed, t.ticketId);
      if (f) {
        const meta = parseResultMeta(readFileSync(f, "utf8"));
        prUrl = meta.prUrl;
        dependencyFailed = meta.dependencyFailed;
        superseded = meta.superseded;
        // A disposed child was pre-empted by a plan edit — it never ran, so it
        // is NOT a failure: counting it would trip the degraded comment and
        // the set-level junco:failed label for what is ordinary set
        // re-cycling (#298). It IS terminal, though — see the widened
        // terminal() below.
        if (st === "failed" && superseded !== null) state = "superseded";
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
    return { id: t.id, ticketId: t.ticketId, state, prUrl, dependencyFailed, superseded };
  });
  const terminal = (s: TaskRunState): boolean =>
    s === "done" || s === "failed" || s === "superseded";
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
    if (t.state === "superseded")
      detail = t.superseded ? `superseded — pre-empted by rev \`${t.superseded}\`` : "superseded";
    if (t.state === "waiting") {
      const deps = record.tasks.find((r) => r.id === t.id)?.dependsOn ?? [];
      detail = `waiting on: ${deps.map((d) => `\`${d}\``).join(", ")}`;
    }
    lines.push(`- [${box}] \`${t.id}\` — ${detail}`);
  }
  lines.push("", "_Maintained by the worker each sweep; edits here are overwritten._");
  return lines.join("\n") + "\n";
}

/** Injectable side effects (tests only; production callers omit this — see
 * SubmitTicketDeps/AnalyzeCmdDeps for the same optional-and-defaults-to-real
 * shape). `submitFn` is typed against the real `submitTicket`, not
 * `BridgeDeps`'s looser structural signature, so a signature change to
 * `submitTicket` is caught here at compile time. */
export interface SubmitPlanSetDeps {
  submitFn?: typeof submitTicket;
}

/** Idempotent fan-out: a child whose id exists ANYWHERE in the queue —
 * done/ and failed/ included — is skipped, never re-run. This is deliberately
 * stricter than the bridge's single-ticket ticketInFlight guard (inbox+
 * processing only): a set child that finished between a crash and the
 * re-sweep must not execute twice; set re-cycling goes through supersede,
 * not the remove-label gesture. `submitted` carries the real destination
 * `submitFn` returned (#298) — callers must not reconstruct it themselves,
 * since a future uniqueDest-style rename would make a reconstructed path
 * print one that doesn't exist. A caller driving its OWN supersede (the CLI
 * door, the bridge's trySupersede) must resubmit a just-disposed id directly
 * instead of routing it through this guard: the disposed file now sits in
 * failed/, which this function correctly treats as not-absent. */
export function submitPlanSet(
  cfg: Config,
  children: CompiledChild[],
  deps: SubmitPlanSetDeps = {},
): { submitted: { ticketId: string; dst: string }[]; skipped: string[] } {
  const submitFn = deps.submitFn ?? submitTicket;
  const paths = queuePaths(cfg);
  const submitted: { ticketId: string; dst: string }[] = [];
  const skipped: string[] = [];
  for (const c of children) {
    if (ticketState(paths, c.ticketId) !== "absent") {
      skipped.push(c.ticketId);
      continue;
    }
    const dst = submitFn(cfg, c.content, { idHint: c.ticketId });
    submitted.push({ ticketId: c.ticketId, dst });
  }
  return { submitted, skipped };
}

/** Dispose every UNCLAIMED (still in inbox/) child of `record` ahead of a
 * supersede recompile: a done/processing child is left running/finished (its
 * work already happened or is in flight — not ours to discard), but an inbox
 * child that never started would otherwise collide on re-fan-out (the new
 * plan reuses the same planId, so an edited-but-same-id task compiles to the
 * identical ticketId). Mirrors cascadeFail's file mechanics (tmp+rename the
 * result marker in place, then uniqueDest-move into failed/) but deliberately
 * NOT its `dependency_failed` marker or metrics.recordTask call: these
 * children never ran, so this is not a task failure to report — it is
 * pre-emption by a newer approved plan. One batch per call. */
export function supersedeUnclaimed(
  cfg: Config,
  record: PlanSetRecord,
  newHash: string,
): { disposed: string[] } {
  const paths = queuePaths(cfg);
  const disposed: string[] = [];
  for (const t of record.tasks) {
    const f = findTicketFile(paths.inbox, t.ticketId);
    if (!f) continue; // done/processing/failed/absent — not ours to dispose
    const content = readFileSync(f, "utf8");
    const body =
      `${content.trimEnd()}\n\n---\n<!-- junco-result\n` +
      `status: failed\nsuperseded: ${newHash}\n-->\n\n## Result\n\n` +
      `> Superseded before running — the plan was edited and re-approved (rev \`${newHash}\`).\n`;
    const tmp = f + ".tmp";
    writeFileSync(tmp, body, "utf8");
    renameSync(tmp, f);
    mkdirSync(paths.failed, { recursive: true });
    renameSync(f, uniqueDestPath(paths.failed, basename(f)));
    disposed.push(t.ticketId);
  }
  return { disposed };
}
