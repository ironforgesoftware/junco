/**
 * transcriptRender — turns a `TranscriptSummary` (transcriptSummary.ts) into
 * width-bounded text rows for the two consumers: the dashboard's
 * TranscriptView (which maps `tone` to Ink props and `anchor` to the cursor)
 * and `junco transcript` (which prints `text` only). Pure: no fs, no Ink.
 *
 * Invariant: no row is wider than `width` (≥ MIN_WIDTH) — prose and expanded
 * tool bodies are word-wrapped, everything else is truncated — so a surface
 * can render rows with `wrap="truncate-end"` and lose nothing.
 */
import type { GuardDecisionRecord } from "./agent/transcriptSchema.js";
import type { RunSummary, ToolResultSummary, TranscriptSummary } from "./transcriptSummary.js";

export type RowTone = "dim" | "accent" | "error" | "warn" | "bold" | "success";

export interface TranscriptRow {
  text: string;
  tone?: RowTone;
  /** Set on a tool-call row: the toolCallId the cursor/expand key targets. */
  anchor?: string;
}

export interface RenderOpts {
  /** Wrap/truncate column; values below MIN_WIDTH are raised to it. */
  width: number;
  showThinking: boolean;
  /** toolCallIds whose result body renders inline under the tool row. */
  expanded: ReadonlySet<string>;
}

export const TOOL_BODY_MAX_LINES = 400;
export const MIN_WIDTH = 20;

const truncate = (s: string, width: number): string =>
  s.length <= width ? s : `${s.slice(0, Math.max(0, width - 1))}…`;
const firstLine = (s: string): string => s.split("\n")[0] ?? "";
const compactJson = (v: unknown): string => {
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    return "[unserializable]";
  }
};

/** Greedy word wrap: breaks on spaces, hard-splits a token longer than `width`,
 * and keeps blank lines (an empty paragraph → one empty row). */
export function wrapText(text: string, width: number): string[] {
  const w = Math.max(1, width);
  const out: string[] = [];
  for (const para of text.split("\n")) {
    if (para === "") {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of para.split(" ")) {
      let tok = word;
      while (tok.length > w) {
        if (line !== "") {
          out.push(line);
          line = "";
        }
        out.push(tok.slice(0, w));
        tok = tok.slice(w);
      }
      if (line === "") line = tok;
      else if (line.length + 1 + tok.length <= w) line += ` ${tok}`;
      else {
        out.push(line);
        line = tok;
      }
    }
    out.push(line);
  }
  return out;
}

/** `740` / `1.8k` / `34.7k` — local (not tui/queueFmt) to keep this module
 * free of a root → tui import. */
export function fmtK(n: number): string {
  return n < 1000 ? `${n}` : `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
}

export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

/** HH:MM:SS (UTC, matching the log's ISO stamps); the raw string if unparsable. */
const hhmmss = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().slice(11, 19);
};

/** `read src/a.ts`, `bash npm test`, `grep foo in src` — the argument that
 * identifies the call, not its JSON; anything else prints compact JSON. */
export function fmtToolCall(name: string, args: Record<string, unknown>, width: number): string {
  const s = (k: string): string | undefined =>
    typeof args[k] === "string" ? (args[k] as string) : undefined;
  let detail: string;
  switch (name) {
    case "read":
    case "write":
    case "edit":
      detail = s("path") ?? compactJson(args);
      break;
    case "bash":
      detail = firstLine(s("command") ?? compactJson(args));
      break;
    case "grep":
    case "find": {
      const pat = s("pattern");
      const p = s("path");
      detail = pat === undefined ? compactJson(args) : p !== undefined ? `${pat} in ${p}` : pat;
      break;
    }
    default:
      detail = compactJson(args);
  }
  return truncate(`${name} ${detail}`, width);
}

export function fmtToolResult(r: ToolResultSummary | null): string {
  if (r === null) return "→ …";
  if (r.isError) return truncate(`→ ✗ ${firstLine(r.text) || "error"}`, 60);
  if (r.lines === 0) return "→ empty";
  return `→ ${r.lines} line${r.lines === 1 ? "" : "s"}`;
}

/** The run header's outcome segment. `live` = this is the file's open last run. */
export function fmtRunOutcome(run: RunSummary, live: boolean): { text: string; tone: RowTone } {
  const end = run.end;
  if (end === null)
    return live ? { text: "◐ running…", tone: "accent" } : { text: "truncated", tone: "warn" };
  const failed = end.errorMessage !== null || end.stopReason === "error";
  const base = end.abortedByGuard
    ? "killed by guard"
    : end.timedOut
      ? "timeout"
      : failed
        ? "error"
        : (end.stopReason ?? "stop");
  const parts = [base];
  if (end.durationMs !== null) parts.push(fmtDuration(end.durationMs));
  if (end.usage !== null) parts.push(`in ${fmtK(end.usage.input)} out ${fmtK(end.usage.output)}`);
  const tone: RowTone =
    base === "killed by guard" || base === "timeout" ? "warn" : failed ? "error" : "success";
  return { text: parts.join(" · "), tone };
}

export function renderTranscriptRows(s: TranscriptSummary, o: RenderOpts): TranscriptRow[] {
  const width = Math.max(MIN_WIDTH, o.width);
  const rows: TranscriptRow[] = [];
  const push = (text: string, tone?: RowTone, anchor?: string): void => {
    const row: TranscriptRow = { text: truncate(text, width) };
    if (tone !== undefined) row.tone = tone;
    if (anchor !== undefined) row.anchor = anchor;
    rows.push(row);
  };
  if (s.invalidLines > 0)
    push(`${s.invalidLines} invalid line${s.invalidLines === 1 ? "" : "s"} skipped`, "warn");
  if (s.runs.length === 0) {
    push("no events recorded", "dim");
    return rows;
  }
  s.runs.forEach((run, i) => {
    if (i > 0) push("");
    const live = s.live && i === s.runs.length - 1;
    const outcome = fmtRunOutcome(run, live);
    const head = [
      `run ${run.index}/${s.runs.length}`,
      run.flow ?? "v1",
      run.modelId ?? "?",
      run.startedAt === null ? null : hhmmss(run.startedAt),
      outcome.text,
    ]
      .filter((x): x is string => x !== null)
      .join(" · ");
    push(truncate(`── ${head} ──`, width), "bold");
    if (run.end?.errorMessage)
      for (const l of wrapText(`✗ ${firstLine(run.end.errorMessage)}`, width - 3))
        push(`   ${l}`, "error");
    const guardRow = (g: GuardDecisionRecord): void =>
      push(
        truncate(
          `   ⚑ guard ${g.action} (${g.kind}) at turn ${g.turnIndex + 1} — ${g.detail}`,
          width,
        ),
        "warn",
      );
    for (const turn of run.turns) {
      const usage =
        turn.usage === null ? "" : ` · in ${fmtK(turn.usage.input)} out ${fmtK(turn.usage.output)}`;
      push(truncate(`turn ${turn.index + 1}${turn.provisional ? " ◐" : ""}${usage}`, width), "dim");
      if (o.showThinking && turn.thinking !== null)
        for (const l of wrapText(turn.thinking, width - 2)) push(`  ${l}`, "dim");
      if (turn.text !== null) for (const l of wrapText(turn.text, width - 2)) push(`  ${l}`);
      for (const c of turn.toolCalls) {
        const suffix = fmtToolResult(c.result);
        push(
          `  ▸ ${fmtToolCall(c.name, c.args, Math.max(8, width - 6 - suffix.length))}  ${suffix}`,
          undefined,
          c.id,
        );
        if (o.expanded.has(c.id) && c.result !== null) {
          const body = c.result.text === "" ? ["(empty)"] : c.result.text.split("\n");
          for (const raw of body.slice(0, TOOL_BODY_MAX_LINES))
            for (const l of wrapText(raw, width - 6)) push(`      ${l}`, "dim");
          if (body.length > TOOL_BODY_MAX_LINES)
            push(
              truncate(`      … +${body.length - TOOL_BODY_MAX_LINES} more lines`, width),
              "dim",
            );
        }
      }
      for (const g of run.guardDecisions) if (g.turnIndex === turn.index) guardRow(g);
    }
    for (const g of run.guardDecisions) if (g.turnIndex >= run.turns.length) guardRow(g);
  });
  return rows;
}
