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
import type { ChatCommandRecord, GuardDecisionRecord } from "./agent/transcriptSchema.js";
import { commandAnchor, draftAnchor } from "./transcriptSummary.js";
import type { RunSummary, ToolResultSummary, TranscriptSummary } from "./transcriptSummary.js";
import { splitThinkingText } from "./chat/thinkSplitter.js";
import { parseBlocks } from "./tui/markdown/blocks.js";
import {
  createMdCache,
  renderMarkdown,
  type HighlightFn,
  type MdCache,
} from "./tui/markdown/render.js";

/** `thinking`: the model's reasoning body (spec 2026-09-06 §4.3 — dim italic). */
export type RowTone = "dim" | "accent" | "error" | "warn" | "bold" | "success" | "thinking";

/** A markdown link the row's text carries as `text (url)` (F3, #512):
 * TranscriptBody wraps `text` in an OSC 8 hyperlink post-layout. */
export interface RowLink {
  text: string;
  url: string;
}

export interface TranscriptRow {
  text: string;
  tone?: RowTone;
  /** Links whose `text` appears in this row (markdown/render.ts); absent on
   * every other row so the plain paint path stays the common one. */
  links?: readonly RowLink[];
  /** Set on a tool-call row: the toolCallId the cursor/expand key targets.
   * A thinking header carries `thinkingAnchor(run, turn)` — not part of the
   * cursor's index space (transcriptSummary.ts's anchorIds/toolCallIds), it
   * only names the row. */
  anchor?: string;
}

export interface RenderOpts {
  /** Wrap/truncate column; values below MIN_WIDTH are raised to it. */
  width: number;
  /** Spec 2026-09-06 §4.3: every finished turn's thinking block is a collapsed
   * `▸ thinking` header unless pinned (`t`), which opens them all. */
  pinned: boolean;
  /** toolCallIds whose result body renders inline under the tool row. */
  expanded: ReadonlySet<string>;
  /** Spec 2026-09-06 §4.2: typeset a chat answer (`flow: "chat"` runs ONLY —
   * ticket transcripts stay plain, spec Non-goals) as markdown via
   * `chatAnswerRows`. Off by default so `junco transcript` prints the prose
   * as recorded; the dashboard's chat view (FinishedTurns.tsx) turns it on. */
  markdown?: boolean;
  /** Code-fence highlighter for `markdown`; null/absent shows raw fences. */
  highlight?: HighlightFn | null;
  /** Per-turn `MdCache`s keyed by `mdCacheKey(runIdx, turnIdx)`, owned by
   * the caller across renders so an unchanged finished turn is not re-typeset
   * on every call. Entries are dropped/revalidated by renderMarkdown itself
   * (width/highlighter/source mismatch); a stale key is simply never read. */
  mdCache?: Map<string, MdCache>;
}

/** The chat answer's label — the other side of the prompt's `you:`. */
export const CHAT_LABEL = "junco: ";

/** Key of a finished turn's markdown cache in `RenderOpts.mdCache`. */
export const mdCacheKey = (runIdx: number, turnIdx: number): string => `md:${runIdx}:${turnIdx}`;

/**
 * A chat answer typeset as markdown (spec 2026-09-06 §4.2), shared by the
 * finished turns (renderTranscriptRows, `markdown: true`) and the live turn
 * (tui/components/LiveTurn.tsx) so nothing jumps when the turn ends.
 *
 * The label rides on the first row in tone accent, like the prompt's `you:`:
 * when the answer opens with a paragraph the label is wrapped WITH it (the
 * label becomes part of the markdown source, so the first row fits the width
 * like every other — and the cache, keyed on source, stays stable); when it
 * opens with a heading, list, fence, quote, rule or table the label stands
 * alone on its row, since those rows carry their own shape. Every following
 * row is indented two columns under the label. Fence rows arrive from the
 * highlighter with ANSI and are never truncated here (TranscriptBody clips
 * them with `wrap="truncate-end"`).
 *
 * `[]` for a whitespace-only answer: a tool-only turn carries "" and gets no
 * bare label row.
 */
export function chatAnswerRows(
  text: string,
  width: number,
  md: { highlight: HighlightFn | null; cache?: MdCache },
): TranscriptRow[] {
  const body = text.trim();
  if (body === "") return [];
  // The first block's kind is decided by its first line (blocks.ts has no
  // setext headings), so the whole text need not be parsed twice per frame.
  const head = parseBlocks(body.split("\n", 1)[0] ?? "");
  const first = head.closed[0] ?? head.open;
  const labelled = first?.kind === "paragraph";
  const rows = renderMarkdown(labelled ? `${CHAT_LABEL}${body}` : body, {
    width: Math.max(MIN_WIDTH, width) - 2,
    highlight: md.highlight ?? undefined,
    cache: md.cache,
  });
  const out: TranscriptRow[] = [];
  if (!labelled) out.push({ text: CHAT_LABEL.trimEnd(), tone: "accent" });
  rows.forEach((r, i) => {
    if (labelled && i === 0)
      out.push(r.links === undefined ? { text: r.text, tone: "accent" } : { ...r, tone: "accent" });
    else if (r.text === "") out.push(r);
    else out.push(indented(r));
  });
  return out;
}

/** A markdown row indented under the label — memoized on the row object, so
 * a row the `MdCache` handed back unchanged maps to the SAME indented row and
 * a memoized consumer sees the finished turn as unchanged. Weak: a row the
 * cache dropped takes its indented twin with it. */
const INDENTED = new WeakMap<TranscriptRow, TranscriptRow>();
function indented(r: TranscriptRow): TranscriptRow {
  let hit = INDENTED.get(r);
  if (hit === undefined) {
    hit = { ...r, text: `  ${r.text}` };
    INDENTED.set(r, hit);
  }
  return hit;
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

/**
 * A prose block (`turn.text` / `turn.thinking`) wrapped for display: real model
 * output is newline-padded — `"\n\nFiles match the spec…\n\n"`, sometimes only
 * newlines — and `wrapText` keeps every blank line, which is right inside a
 * paragraph but wrong at the block's edges (35–46% of a real transcript's rows
 * rendered blank). Collapses 3+ newlines to a paragraph break and trims the
 * edges; `[]` for a block that is only whitespace. The summary keeps the block
 * raw, so `junco transcript --json` stays lossless.
 */
export function proseLines(block: string, width: number): string[] {
  const prose = block.replace(/\n{3,}/g, "\n\n").trim();
  return prose === "" ? [] : wrapText(prose, width);
}

/** `740` / `1.8k` / `34.7k` — local (not tui/queueFmt) to keep this module
 * free of a root → tui import. */
function fmtK(n: number): string {
  return n < 1000 ? `${n}` : `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
}

export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

/** Anchor of the thinking header of turn `turnIdx` (TurnSummary.index) in the
 * summary's `runIdx`-th run (0-based position in `runs`). */
export const thinkingAnchor = (runIdx: number, turnIdx: number): string =>
  `think:${runIdx}:${turnIdx}`;

/**
 * The thinking block's header row (spec 2026-09-06 §4.3), shared by the live
 * turn (LiveTurn.tsx) and the finished turns below so the row does not change
 * shape when the turn ends: `· thinking · 3s` while it streams, `▸ thinking ·
 * 3s` folded, `▾ thinking · 3s` pinned open; the duration segment is dropped
 * when `ms` is null (a finished turn whose duration is not knowable).
 */
export function fmtThinkingHeader(
  state: "streaming" | "collapsed" | "pinned",
  ms: number | null,
): string {
  const glyph = state === "streaming" ? "·" : state === "collapsed" ? "▸" : "▾";
  return ms === null ? `${glyph} thinking` : `${glyph} thinking · ${fmtDuration(ms)}`;
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

/** Rows of streamed output a running card shows (spec 2026-09-06 §4.4: N = 6). */
export const TOOL_TAIL_LINES = 6;

/**
 * A tool card's input: the live turn's tool block (chat/liveBlocks.ts) as is,
 * or a finished `ToolCallSummary` lifted into the same shape (`output: ""`,
 * `done` = has a result) — so the two render through ONE function and the
 * card does not change shape when the turn ends.
 */
export interface ToolCardBlock {
  id: string;
  name: string;
  args: unknown;
  output: string;
  result: string | null;
  isError: boolean;
  truncated: boolean;
  done: boolean;
}

export interface ToolCardOpts {
  width: number;
  /** The operator's toggle for this id — a toggle AGAINST the card's default,
   * which is closed for a result and OPEN for an error. */
  expanded: boolean;
  /** The running glyph: a spinner frame from the dashboard, null for a static
   * surface (`junco transcript`, a ticket transcript's provisional turn) which
   * prints `…`. Ignored once `done`. */
  spinner: string | null;
}

/**
 * One tool card (spec 2026-09-06 §4.4, D6), anchored on the tool-call id:
 *
 *     ▸ bash npm test  ⠋          running: header + the last TOOL_TAIL_LINES
 *         line 4                    of `output`, dim (a `…` row first when
 *         line 5                    the rolling cap dropped the head)
 *     ▸ bash npm test  ✓          done, closed: one dim summary row
 *         → 3 lines
 *     ▸ bash npm test  ✗          done, open (an error is open by default):
 *           ENOENT: nope            the result wrapped, capped at
 *           …                       TOOL_BODY_MAX_LINES, `… (truncated)` when
 *                                   the daemon cut the result
 *
 * The header is in tone `error` for an error; the call's argument summary is
 * `fmtToolCall`'s, the summary row `fmtToolResult`'s — the same vocabulary the
 * ticket transcript has always used.
 */
export function renderToolCard(b: ToolCardBlock, o: ToolCardOpts): TranscriptRow[] {
  const width = Math.max(MIN_WIDTH, o.width);
  const rows: TranscriptRow[] = [];
  const push = (text: string, tone?: RowTone, anchor?: string): void => {
    const row: TranscriptRow = { text: truncate(text, width) };
    if (tone !== undefined) row.tone = tone;
    if (anchor !== undefined) row.anchor = anchor;
    rows.push(row);
  };
  const args: Record<string, unknown> =
    typeof b.args === "object" && b.args !== null ? (b.args as Record<string, unknown>) : {};
  const glyph = !b.done ? (o.spinner ?? "…") : b.isError ? "✗" : "✓";
  // 2 (indent) + 2 (`▸ `) + call + 2 + 1 (glyph) ≤ width.
  const call = fmtToolCall(b.name, args, Math.max(8, width - 7));
  push(`  ▸ ${call}  ${glyph}`, b.isError ? "error" : undefined, b.id);
  if (!b.done) {
    // A static surface has no spinner to say "still running": keep the
    // `→ …` row the ticket transcript has always printed for a call without
    // a result. The dashboard's spinner says it, and the tail follows.
    if (b.output === "") {
      if (o.spinner === null) push(`    ${fmtToolResult(null)}`, "dim");
      return rows;
    }
    const lines = b.output.split("\n");
    if (lines.at(-1) === "") lines.pop(); // a trailing newline is not a blank line
    if (b.truncated) push("    …", "dim");
    for (const l of lines.slice(-TOOL_TAIL_LINES)) push(`    ${l}`, "dim");
    return rows;
  }
  const open = o.expanded !== b.isError;
  if (!open) {
    const summary =
      b.result === null
        ? null
        : {
            text: b.result,
            lines: b.result === "" ? 0 : b.result.split("\n").length,
            isError: b.isError,
          };
    push(`    ${fmtToolResult(summary)}`, "dim");
    return rows;
  }
  const body = b.result === null || b.result === "" ? ["(empty)"] : b.result.split("\n");
  for (const raw of body.slice(0, TOOL_BODY_MAX_LINES))
    for (const l of wrapText(raw, width - 6)) push(`      ${l}`, "dim");
  if (body.length > TOOL_BODY_MAX_LINES)
    push(`      … +${body.length - TOOL_BODY_MAX_LINES} more lines`, "dim");
  if (b.truncated) push("      … (truncated)", "dim");
  return rows;
}

/** Display-only rename for a run header's recorded flow id (RunSummary.flow,
 * transcriptSchema.ts's FlowKind): the recorded transcript data keeps its
 * internal `"assess"`/`"analyze"` values (out of surface-legibility Task 2's
 * scope — old transcripts on disk will always say so), but the CLI verbs that
 * produce those runs are now `junco audit`/`junco investigate`, so the
 * rendered header tracks that rename instead of resurrecting the retired
 * words — same pattern as the queue row's fmtQueueKind (src/tui/queueFmt.ts). */
function fmtFlow(flow: string): string {
  return flow === "assess" ? "audit" : flow === "analyze" ? "investigate" : flow;
}

/** The run header's outcome segment. `live` = this is the file's open last run. */
export function fmtRunOutcome(run: RunSummary, live: boolean): { text: string; tone: RowTone } {
  const end = run.end;
  if (end === null)
    return live ? { text: "◐ running…", tone: "accent" } : { text: "truncated", tone: "warn" };
  // A chat turn aborted mid-stream (junco_chat_turn_aborted, spec §1.3) — the
  // reason (operator/timeout/daemon_stopped/crash) rides in stopReason since
  // RunEnd has no chat-specific field.
  if (end.stopReason?.startsWith("aborted:")) {
    const parts = [`aborted (${end.stopReason.slice(8)})`];
    if (end.durationMs !== null) parts.push(fmtDuration(end.durationMs));
    if (end.usage !== null) parts.push(`in ${fmtK(end.usage.input)} out ${fmtK(end.usage.output)}`);
    return { text: parts.join(" · "), tone: "warn" };
  }
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
    if (run.prompt !== null)
      for (const l of wrapText(`you: ${run.prompt}`, width)) push(l, "accent");
    // R23: a note (e.g. junco_chat_turn_rejected) that lands before ANY run
    // parks on a synthetic, prompt-less, turn-less run closed with a null
    // stopReason (transcriptSummary.ts's noteRun) purely so it has somewhere
    // to render — printing `── run 1/1 · chat · ? · stop ──` above it would
    // claim a run happened when none did. Skip the header (and the
    // error/guard rows that hang off it — a run in this shape carries
    // neither) for such a run; the notes below still render.
    const syntheticNoteRun = run.flow === "chat" && run.prompt === null && run.turns.length === 0;
    if (!syntheticNoteRun) {
      const live = s.live && i === s.runs.length - 1;
      const outcome = fmtRunOutcome(run, live);
      const head = [
        `run ${run.index}/${s.runs.length}`,
        run.flow === null ? "v1" : fmtFlow(run.flow),
        run.modelId ?? "?",
        run.startedAt === null ? null : hhmmss(run.startedAt),
        outcome.text,
      ]
        .filter((x): x is string => x !== null)
        .join(" · ");
      push(truncate(`── ${head} ──`, width), "bold");
      // String(): a malformed record's errorMessage need not be a string (the
      // transcript schema is not validated at parse time) — the renderer runs
      // inside React's render, where a throw takes the whole dashboard down.
      if (run.end?.errorMessage)
        for (const l of wrapText(`✗ ${firstLine(String(run.end.errorMessage))}`, width - 3))
          push(`   ${l}`, "error");
    }
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
      // Spec 2026-09-06 §4.3 / §2.1 last paragraph: the persisted turn keeps
      // its `<think>` tags (the splitter runs on the live stream only), so a
      // tag-carrying text is split here, at render time, and the finished
      // turn looks exactly like the live one did.
      const split =
        turn.thinking === null && turn.text !== null && turn.text.includes("<think>")
          ? splitThinkingText(turn.text)
          : null;
      const thinking = split === null ? turn.thinking : split.thinking;
      const text = split === null ? turn.text : split.text.trimStart();
      if (thinking !== null) {
        // A turn has no duration of its own; the run's is the block's only
        // when the turn is the run's only turn.
        const ms = run.turns.length === 1 ? (run.end?.durationMs ?? null) : null;
        push(
          `  ${fmtThinkingHeader(o.pinned ? "pinned" : "collapsed", ms)}`,
          undefined,
          thinkingAnchor(i, turn.index),
        );
        if (o.pinned)
          for (const l of proseLines(thinking, width - 4))
            push(l === "" ? "" : `    ${l}`, "thinking");
      }
      if (text !== null) {
        // A chat answer carries the other side's label, the way the prompt
        // carries `you:` — inline on the first line in the same tone, the
        // rest indented under it. The label is wrapped WITH the text so the
        // first row fits the width like every other; ticket transcripts have
        // no dialogue to label.
        // A tool-only turn carries "" (not null): no prose, so no label either.
        const chat = run.flow === "chat" && text.trim() !== "";
        if (chat && o.markdown) {
          // Spec 2026-09-06 §4.2: the dashboard typesets the answer; the rows
          // are pushed as built (fence rows carry ANSI — `truncate` counts
          // escapes as columns and could cut one in half).
          let cache = o.mdCache?.get(mdCacheKey(i, turn.index));
          if (o.mdCache && cache === undefined) {
            cache = createMdCache();
            o.mdCache.set(mdCacheKey(i, turn.index), cache);
          }
          rows.push(...chatAnswerRows(text, width, { highlight: o.highlight ?? null, cache }));
        } else {
          const lines = proseLines(chat ? `${CHAT_LABEL}${text.trim()}` : text, width - 2);
          lines.forEach((l, li) => {
            if (chat && li === 0) push(l, "accent");
            else push(l === "" ? "" : `  ${l}`);
          });
        }
      }
      // Spec 2026-09-06 §4.4: the same card the live turn showed, so nothing
      // changes shape at turn end; a call without a result (a ticket
      // transcript's provisional turn) is a static `…` card.
      for (const c of turn.toolCalls)
        rows.push(
          ...renderToolCard(
            {
              id: c.id,
              name: c.name,
              args: c.args,
              output: "",
              result: c.result?.text ?? null,
              isError: c.result?.isError ?? false,
              truncated: false,
              done: c.result !== null,
            },
            { width, expanded: o.expanded.has(c.id), spinner: null },
          ),
        );
      for (const g of run.guardDecisions) if (g.turnIndex === turn.index) guardRow(g);
    }
    for (const g of run.guardDecisions) if (g.turnIndex >= run.turns.length) guardRow(g);
    for (const n of run.notes) {
      switch (n.kind) {
        case "rejected":
          push(
            truncate(
              `   ⏸ turn rejected: ${n.reason}${n.until ? ` (until ${hhmmss(n.until)})` : ""}`,
              width,
            ),
            "warn",
          );
          break;
        case "draft": {
          const what = `${n.draftKind} · ${n.ids.join(", ") || n.draftId}`;
          const text =
            n.status === "parked"
              ? `   ▣ draft parked · ${what} — s submit · e edit · r route · D discard`
              : n.status === "lint_failed"
                ? `   ▣ draft parked (lint failed) · ${what} — e edit · D discard`
                : n.status === "submitted"
                  ? `   ▣ draft submitted → ${n.destination ?? "?"} · ${what}`
                  : `   ▣ draft discarded · ${what}`;
          push(
            truncate(text, width),
            n.status === "lint_failed" ? "warn" : n.status === "submitted" ? "success" : "bold",
            draftAnchor(n.draftId),
          );
          break;
        }
        case "command": {
          const what = n.ids.join(", ") || n.draftId;
          const anchor = commandAnchor(n.commandId);
          const rows: Record<ChatCommandRecord["status"], [string, RowTone]> = {
            proposed: [
              `   ▸ submit ${what} → ${n.route} — awaiting you · y submit · n keep parked`,
              "accent",
            ],
            // #478: the window between the operator's `y` and the CLI's exit.
            running: [`   ▸ submitting ${what} → ${n.route}…`, "accent"],
            ran: [
              // A `ran` CAN carry a caveat (the CLI queued the ticket but the
              // draft did not archive), and without it the row reads as a clean
              // success beside a card still marked parked (#479).
              `   ✓ submitted → ${n.route} · ${what} · exit ${n.exitCode ?? "?"}${
                n.detail === null ? "" : ` · ${n.detail}`
              }`,
              "success",
            ],
            failed: [
              // The detail carries the only thing the row cannot infer — and
              // sometimes contradicts the tail (a draft the dashboard already
              // submitted is not "parked"), so it replaces it (final review #2c).
              n.detail === null
                ? `   ✗ submit failed · exit ${n.exitCode ?? "?"} · ${what} — draft stays parked`
                : `   ✗ submit failed · exit ${n.exitCode ?? "?"} · ${what} · ${n.detail}`,
              "error",
            ],
            declined: [`   – submit declined · ${what} · draft stays parked`, "dim"],
            expired: [
              `   ⌛ submit expired · ${n.detail ?? "no decision"} · draft stays parked`,
              "warn",
            ],
            aborted: [`   – submit aborted with the turn · ${what} · draft stays parked`, "dim"],
          };
          const [text, tone] = rows[n.status];
          push(truncate(text, width), tone, anchor);
          if (o.expanded.has(anchor) && n.output !== null) {
            const body = n.output === "" ? ["(no output)"] : n.output.split("\n");
            for (const raw of body.slice(0, TOOL_BODY_MAX_LINES))
              for (const l of wrapText(raw, width - 6)) push(`      ${l}`, "dim");
          }
          break;
        }
        case "reset":
          push(`   ↺ session reset (${n.reason})`, "warn");
          break;
        case "degraded":
          push("   ⚠ transcript disabled — history will not survive a reconnect", "warn");
          break;
        case "compaction":
          push(n.phase === "start" ? "   ⋯ compacting context…" : "   ⋯ context compacted", "dim");
          break;
      }
    }
  });
  return rows;
}
