# Transcript Viewer — Design

Date: 2026-08-28
Status: approved (chat review); plan: `docs/superpowers/plans/2026-08-28-transcript-viewer.md`

## Motivation

After a ticket finishes, junco has no surface that shows **what the agent actually did**.
`junco status`, `junco list`, `junco logs`, and the dashboard's queue card all stop at the
outcome line (`completed · 667s · in 34.7k out 1.9k`); `junco assess review` shows only
findings (and is empty on a clean audit); `junco replay` reports guard decisions, not the
run. The work itself — which files the agent read, what it grepped, what each tool
returned, its reasoning, its final answer — lives only in the per-ticket event transcript
(`<dataDir>/data/transcripts/<id>.jsonl`), which today has no reader except a text editor.

This landed as a real gap on 2026-08-28: an assess run against `alxedelweiss/arkanoid_oQ4e`
returned zero findings, and the only way to verify that was a correct verdict (a
zero-dependency client-only game — it was) was to parse the JSONL by hand.

The viewer closes that gap in two places — a dashboard view and a CLI command — over one
pure summarize/render core.

## Key finding that shapes the design

The transcript already carries everything the viewer needs, so **no live-path change is
required**:

- `junco_run_start` / `junco_run_end` (v2, `agent/transcriptSchema.ts`) frame every run with
  flow, model id, tools, and the final `RunResult` fields (`stopReason`, `errorMessage`,
  `timedOut`, `abortedByGuard`, `usage`, `durationMs`).
- The SDK's `turn_end` event carries the full assistant `message` (`thinking` / `text` /
  `toolCall` content blocks plus per-message `usage`) **and** the turn's `toolResults[]`
  (each with `toolCallId`, `toolName`, `content[]`, `isError`) — one event per completed
  turn, authoritative.
- `tool_execution_start` / `tool_execution_end` stream _within_ a turn (`toolCallId`,
  `toolName`, `args`, `result`), which is what makes a live view possible between
  `turn_end`s (a turn can take minutes).
- `junco_guard_decision` records nudges/kills with a `turnIndex`.
- One file accumulates every attempt of a ticket (a 404-retried ticket has 4 runs in one
  file), and the sink is an append stream (`session.ts:87`), so a reader sees lines as they
  are written.
- `parseTranscriptLine` already tolerates torn/invalid lines; v1 files (no `junco_*`
  frames) fall back to `agent_start`/`agent_end` run boundaries exactly as `agent/replay.ts`
  does.

## Decisions

- **One pure core, two consumers.** `src/transcriptSummary.ts` (lines → `TranscriptSummary`)
  and `src/transcriptRender.ts` (`TranscriptSummary` → `TranscriptRow[]`) are fs-free and
  SDK-free (type-only imports), like `transcriptSchema.ts`. The dashboard view and
  `junco transcript` both call them; every formatting decision is unit-tested without Ink
  or a subprocess.
- **The dashboard entry is structural `enter`, not a mnemonic.** In the LOCAL `queue`
  section the cursor already sits on queue rows and `enter` does nothing there. `enter`
  opens the transcript for the highlighted ticket — the same "enter = detail" affordance the
  rail, issues pane, PR pane, and review view use. (A `transcript` verb would derive the key
  `n` because `retry` already owns `t` in that context — a bad key for the most-used action.)
- **Running rows become selectable.** QueueView's "RUNNING rows are never selectable" rule
  exists because there is no action on them. There is one now. The actionable index space
  becomes `running ⧺ waiting ⧺ recent`; `retry`/`delete` keep their `kind` guards, so they
  stay inert on running rows exactly as they are on done rows.
- **Live tail, size-gated.** A running ticket's view polls its file at the queue cadence
  (1 s); the client stats the file first and re-parses only when the size changed. Follow is
  on by default for a live open and pauses on any upward movement (landing at the tail first,
  mirroring the log overlay), `G` resumes. Liveness comes from the file itself — the last
  run has no end record — not from the queue row, so a ticket that finishes while the view
  is open flips to its final header without a reopen.
- **Tool results are summarized by default and expandable on demand.** A tool line shows
  the call and a one-line result summary (`→ 214 lines`, `→ ✗ ENOENT …`). `enter`/`space`
  on a tool line expands the full result body inline (wrapped, dim, capped at 400 lines
  with a `… +N more lines` marker). The cursor moves over tool lines only (`j`/`k`); `[`/`]`
  scroll the viewport row-wise. A transcript with no tool calls (some Q&A runs) is scroll-only.
- **Thinking is hidden by default.** Local reasoning models at `thinkingLevel: xhigh` emit
  far more thinking than text; `t` toggles it in both consumers (`--thinking` on the CLI).
- **A provisional open turn.** After the last `turn_end`, `tool_execution_start/end` events
  build an in-progress turn so a live view shows activity as it happens; the next `turn_end`
  replaces it with the authoritative record. The same mechanism shows the partial last turn
  of a crash-truncated transcript instead of dropping it.
- **`junco transcript` mirrors `junco replay`'s shape.** Same deps seam (`loadCfg`,
  `readFile`, `stdout`), same target resolution — a bare ticket id resolves through
  `transcriptPathFor(dataTreePaths(cfg).transcripts, id)`, a direct `.jsonl` path reads
  as-is with config optional — lazy-imported from `cli.ts`, own argv parsing. It also joins
  the dashboard palette roster.
- **No config knobs.** Poll cadence, body cap, and defaults are constants; nothing here
  warrants a `Config` field (and so nothing touches `tests/helpers/config.ts`).

## Non-goals

- Searching or filtering inside a transcript (`/`) — the log overlay has it; add here only
  if asked.
- Rendering tool-result bodies beyond text blocks (images render as `[image block]`).
- Editing, deleting, or exporting transcripts; the viewer is read-only.
- Following a transcript from the CLI (`--follow`); `junco logs -f` remains the live CLI
  surface.

---

## 1. Data model (`src/transcriptSummary.ts`)

```ts
export interface TranscriptSummary {
  ticketId: string | null; // junco_meta.ticketId; null for a v1 file
  version: number | null; // junco_meta.version; null for v1
  runs: RunSummary[]; // in file order; at least one when any event exists
  live: boolean; // last run has no end record (file still being written)
  invalidLines: number; // torn/malformed lines skipped (surfaced in the header)
}

export interface RunSummary {
  index: number; // 1-based, for "run 2/4"
  flow: FlowKind | null; // junco_run_start.flow; null for v1
  modelId: string | null;
  startedAt: string | null; // junco_run_start.ts; null for v1 (SDK events carry no ts)
  end: RunEnd | null; // null while live / for a truncated run
  turns: TurnSummary[];
  guardDecisions: GuardDecisionRecord[]; // as recorded, ordered by turnIndex
  toolCallCount: number;
}

export interface RunEnd {
  stopReason: string | null;
  errorMessage: string | null;
  timedOut: boolean;
  abortedByGuard: boolean;
  durationMs: number | null; // null for the v1 agent_end fallback
  usage: Usage | null; // null for v1
}

export interface TurnSummary {
  index: number; // 0-based; the guard records' turnIndex space
  provisional: boolean; // built from tool_execution_* after the last turn_end
  thinking: string | null; // concatenated thinking blocks
  text: string | null; // concatenated text blocks
  toolCalls: ToolCallSummary[];
  usage: { input: number; output: number } | null;
}

export interface ToolCallSummary {
  id: string; // toolCallId — the cursor/expand identity
  name: string;
  args: Record<string, unknown>;
  result: ToolResultSummary | null; // null = not returned yet (live) / lost (truncated)
}

export interface ToolResultSummary {
  text: string; // text blocks joined with "\n"; non-text → "[<type> block]"
  lines: number; // text.split("\n").length (0 for "")
  isError: boolean;
}

export function summarizeTranscript(lines: string[]): TranscriptSummary;
```

**Reduction rules.**

- A run opens at `junco_run_start` (v2) or, when no `junco_run_start` has been seen for the
  current run, at `agent_start` (v1 / unframed prefix). It closes at `junco_run_end` (v2) or
  `agent_end` (v1). A `junco_run_end` without a preceding open (defensive) opens and closes
  an empty run. Events before any open (only `junco_meta` in practice) attach to no run;
  `junco_meta` feeds `ticketId`/`version`. A `junco_run_start` while a run is still open
  closes the open run with `end: null` (the `truncated` outcome) before opening the next.
- `turn_end` is the turn's authoritative record: `thinking`/`text`/`toolCall` blocks come
  from `message.content`; results are matched to calls by `toolCallId` from
  `toolResults[]`. It replaces any provisional turn in progress.
- `tool_execution_start` opens (or extends) the provisional turn with a result-less call;
  `tool_execution_end` fills the matching call's result. Provisional turns are appended only
  while the run is open and only after the last `turn_end`.
- `message_end` is ignored (it duplicates `turn_end` for the assistant role and would
  double-count).
- `junco_guard_decision` records attach to the open run.
- `invalid` lines are counted, never fatal.
- `live` = the last run exists and `end === null`. An empty file → `runs: []`, `live: false`.

## 2. Rendering (`src/transcriptRender.ts`)

```ts
export interface TranscriptRow {
  text: string;
  tone?: "dim" | "accent" | "error" | "warn" | "bold" | "success";
  /** Set on a tool-call line: the toolCallId the cursor/expand key targets. */
  anchor?: string;
}

export interface RenderOpts {
  width: number; // wrap column for prose and bodies (≥ 20)
  showThinking: boolean;
  expanded: ReadonlySet<string>; // toolCallIds whose result body renders inline
}

export const TOOL_BODY_MAX_LINES = 400;

export function renderTranscriptRows(s: TranscriptSummary, o: RenderOpts): TranscriptRow[];
export function fmtToolCall(name: string, args: Record<string, unknown>, width: number): string;
export function fmtToolResult(r: ToolResultSummary | null): string;
```

**Row grammar** (indentation is literal; `‹›` marks variable text):

```
── run ‹i›/‹n› · ‹flow› · ‹modelId› · ‹startedAt HH:MM:SS› · ‹outcome› ──      bold
   ✗ ‹errorMessage first line, wrapped›                                        error   (failed runs)
   ⚑ guard ‹action› (‹kind›) at turn ‹n› — ‹detail›                             warn    (per decision)
turn ‹n› · in ‹x›k out ‹y›k                                                     dim
  ‹thinking, wrapped›                                                           dim     (showThinking)
  ‹text, wrapped›
  ▸ ‹fmtToolCall›  → ‹fmtToolResult›                                            (anchor)
      ‹expanded result body, wrapped, ≤ 400 lines›                             dim
      … +‹N› more lines                                                         dim
(blank line between runs)
```

Within a turn the order is the message's content order — thinking, then text, then the
tool calls that closed the turn (their results arrive afterwards, so they render last).

- `‹outcome›`: `stop · 11m07s · in 34.7k out 1.9k` from `end.usage`/`durationMs`; `error`,
  `timeout`, `killed by guard` (with the same suffix when present); `◐ running…` while
  live; `truncated` for a closed-by-EOF v2 run with no end record that is not the last run.
- `fmtToolCall` prints the argument that identifies the call, not the JSON: `read`/`write`/
  `edit` → `path`; `bash` → first line of `command`; `grep`/`find` → `pattern` (+ ` in
‹path›` when given); anything else → compact JSON. All truncated to `width`.
- `fmtToolResult`: `→ ‹lines› lines` / `→ empty` / `→ ✗ ‹first line›` / `→ …` (pending).
- Prose wraps at `width` on whitespace (a single over-long token is hard-split); rows never
  exceed `width`, so the Ink surface can render them with `wrap="truncate-end"` and lose
  nothing. `width` is also what the CLI passes from `process.stdout.columns`.
- A `provisional` turn renders its header as `turn ‹n› ◐` with no usage.

## 3. Reading (`DashboardClient.readTranscript`)

```ts
export type TranscriptRead =
  | { kind: "missing"; path: string }
  | { kind: "unchanged"; size: number }
  | { kind: "read"; size: number; summary: TranscriptSummary };

readTranscript(id: string, prevSize: number | null): Promise<Result<TranscriptRead>>;
```

- Path: `transcriptPathFor(dataTreePaths(cfg).transcripts, id)`.
- `statFn` (new `GhClientDeps.statFn`, default `statSync(p).size`) first; ENOENT →
  `missing`. `size === prevSize` → `unchanged` without reading. Otherwise `readFileFn` →
  `summarizeTranscript(content.split("\n"))` → `read`.
- Any other throw → `ok: false` with the message (the `attempt` wrapper).

## 4. Dashboard state (`src/tui/hooks/useTranscript.ts`)

```ts
export interface TranscriptState {
  id: string;
  path: string | null;
  expectLive: boolean; // opened from a running row → "waiting…" rather than "missing"
  loading: boolean;
  error: string | null; // terminal read error, or "no transcript for <id>"
  size: number | null;
  summary: TranscriptSummary | null;
  showThinking: boolean; // default false
  follow: boolean; // default = expectLive
  cursor: number; // index into the flat tool-call list (clamped on shrink)
  expanded: ReadonlySet<string>;
}

export function useTranscript({ client, aliveRef, pollMs = 1_000 }): {
  transcript: TranscriptState | null;
  openTranscript(id: string, opts: { expectLive: boolean }): void;
  closeTranscript(): void;
  toggleThinking(): void;
  setFollow(on: boolean): void;
  moveCursor(delta: number): void; // clamps; pauses follow
  toggleExpanded(): void; // the cursor's toolCallId
};
```

- `openTranscript` sets a fresh state (loading) and performs the first read immediately.
- A poll interval runs while `transcript !== null && (summary?.live ?? expectLive)`; each
  tick calls `readTranscript(id, size)`; `unchanged` is a no-op; `missing` while
  `expectLive` keeps polling (header: `waiting for the agent to start…`); `missing` when not
  `expectLive` is the terminal error `no transcript for ‹id›`. When a read shows
  `live: false`, the interval stops (the last read is final).
- Like `useReview`, the hook never calls `setView`; App's `enter` handler opens the state
  and navigates, and `close` navigates back and clears it.
- Everything the effect closes over is state or a stable callback, so its dependency array
  is complete without memo tricks (`react-hooks/exhaustive-deps` is at `error` under
  `src/tui/**`).

## 5. Dashboard view (`src/tui/components/TranscriptView.tsx`, App wiring)

**Component props:** `{ state, scroll, height, focused, onScrollMax, onWheel }` — the
`CommandOutput`/`LogView` shape. Header: `transcript · ‹id› · ‹n› runs · ‹status›` where
status is `◐ live` (live), `waiting for the agent to start…` (missing + expectLive), or the
last run's outcome. Body: `renderTranscriptRows(summary, { width: innerWidth, showThinking,
expanded })`, sliced; `Scrollbar`; footer `↑/↓ tool · enter expand · [/] scroll · t
thinking · ‹f follow (live only)› · ‹start›–‹end›/‹total›`. Reserved rows: borders ×2,
header, footer → `visible = max(1, height − 4)`.

**Window math (in the component, mirroring QueueView):** `start = follow ?
maxScroll(rows, visible) : clampScroll(scroll, rows, visible)`; then, when the cursor's
anchor row is outside `[start, start + visible)`, nudge `start` so it is visible (the
`windowSlice` rule). `onScrollMax(maxScroll(...))` is reported during render as every
surface does.

**App wiring:**

- `View` and `viewActions.OverlayView` gain `"transcript"`; `VIEW_OPTIONS.transcript =
[{ id: "thinking", label: "thinking" }, { id: "follow", label: "follow" }, CLOSE]` →
  keys `t`, `f`, `q`; `viewStructural("transcript")` → `↑/↓ tool`, `enter expand`, `[/]
scroll`, `esc back`. `bindingContext` routes `"transcript"` through the `kind: "view"`
  group; `crumbs` → `["transcript", id]`; `scrollKey` → `transcript:‹id›` (so `t`/expand
  keep the offset and the clamp absorbs any shrink).
- LOCAL `queue` section rows (App's `sectionRowsFor("queue")`) become
  `running ⧺ waiting ⧺ recent` with a new `{ kind: "running"; id }` member; QueueView's
  `selectable` mode highlights running rows at index `i`, waiting at `running.length + i`,
  recent at `running.length + waiting.length + j`; `onRowPress` uses the same indices.
  The INVARIANT comment on `LocalRow` is updated to say running rows are selectable and why.
- In `handleSectionBodyInput`, for `sysSection === "queue"`, `key.return` with a `running`
  or `recent` target calls `openTranscript(id, { expectLive: kind === "running" })` and
  `setView("transcript")`; a `waiting` target toasts `not started yet — no transcript`.
- Transcript-view input branch (in the cascade before `cmdOutput`): `esc`/`q` → close
  (`closeTranscript()`, `setView("main")` — pane and section cursor were never touched, so
  they restore for free, as with `prDetail`); `j`/`↓` and `k`/`↑` → `moveCursor(±1)`;
  `enter`/`space` → `toggleExpanded()`; `]`/`[` → `scrollBy(±1)` (and `[` pauses follow after
  `toEnd()`, the log-overlay recipe); `G`/`end` → `setFollow(true)` when live; `g` →
  cursor 0 + scroll 0. `t`/`f` dispatch through the action table (`thinking`, `follow`).
- Mouse: `onWheel` → the `[`/`]` recipe; a press on a tool row moves the cursor to it and
  toggles expansion (same handler as the keys, so they cannot diverge).
- `AppProps` is unchanged — the client is the only new dependency and it already arrives via
  `props.client`.

## 6. CLI (`src/transcriptCmd.ts`, `cli.ts`)

```
junco transcript <ticket-id|path.jsonl> [--thinking] [--tools] [--width N] [--json]
```

- Deps: `{ loadCfg, readFile, stdout, columns }` — `columns` is `process.stdout.columns ??
100`, injected by `cli.ts`; `--width` overrides.
- Target resolution and error text mirror `replayCmd` (`junco transcript: no config found —
cannot resolve ticket id …`, `junco transcript: no transcript at ‹path› (transcripts dir:
…)`).
- Output: `renderTranscriptRows` with `showThinking = --thinking`, `expanded = all
toolCallIds when --tools`, one row per line, tones dropped (plain text). `--json` prints
  `JSON.stringify(summary, null, 2)` instead. A live file renders as-is with the `◐
running…` outcome — no follow.
- Exit codes: 0 rendered, 1 not found, 2 usage error. Lazy-imported in `cli.ts` like
  `replay`, with a help-text entry beside it.
- `PALETTE_COMMANDS` gains `cmd("transcript", "<ticket-id> [--thinking] [--tools]",
"Render a ticket's event transcript")` (default timeout).

## 7. Error handling

| Situation                               | Dashboard                                                              | CLI                       |
| --------------------------------------- | ---------------------------------------------------------------------- | ------------------------- |
| No transcript file, ticket finished     | header `no transcript for ‹id›` (pre-transcript ticket, legacy layout) | exit 1 with the path hint |
| No transcript file, ticket running      | `waiting for the agent to start…`, keeps polling                       | renders nothing → exit 1  |
| Torn last line (crash / mid-write read) | line skipped, `‹n› invalid lines` in header                            | same, in the first row    |
| v1 file (no `junco_*` frames)           | runs from `agent_start`/`agent_end`; header shows `v1`                 | same                      |
| Read throws (EACCES, EISDIR)            | terminal error row with the message                                    | exit 1 with the message   |
| Tool result > 400 lines expanded        | capped with `… +N more lines`                                          | same                      |

Nothing here writes to disk or the network; every failure degrades to text in the view.

## 8. Testing

- `tests/transcriptSummary.test.ts` — v2 multi-run file (4 runs: three `error` runs and one
  `stop`), v1 fallback, torn last line counted not fatal, `toolResults` matched by id,
  provisional turn from `tool_execution_*` then replaced by `turn_end`, `live` true/false,
  guard decisions attached to the right run, empty file. Fixtures reuse the record builders
  in `tests/replayCmd.test.ts` (extracted to `tests/helpers/transcriptFixtures.ts`).
- `tests/transcriptRender.test.ts` — run header outcomes (stop/error/timeout/killed/live/
  truncated), `fmtToolCall` per tool family, `fmtToolResult` states, thinking hidden/shown,
  expansion with the 400-line cap, wrap invariant (no row longer than `width`), anchors set
  only on tool rows.
- `tests/tuiGhClient.test.ts` — `readTranscript`: missing / unchanged / read, stat-gated
  (no `readFileFn` call when the size is unchanged).
- `tests/useTranscript.test.tsx` — open → first read; live polling stops when a read
  returns `live: false`; `missing` + `expectLive` keeps polling; cursor clamps on shrink;
  `toggleExpanded` keyed by id.
- `tests/tuiTranscriptView.test.tsx` — header states, footer range, follow pins to the
  bottom, cursor nudge keeps the anchor row visible, expanded body renders dim under its
  tool row.
- `tests/tuiQueue.test.tsx` — running rows highlight in `selectable` mode; index space
  `running ⧺ waiting ⧺ recent`; `retry`/`delete` inert on a running row.
- `tests/tuiApp.test.tsx` — `enter` on a recent row opens the view with the breadcrumb;
  `esc` returns with the section cursor preserved; `t` toggles thinking; `enter` on a
  waiting row toasts; chips show `esc back`. Loop-until-condition, never a single tick.
- `tests/tuiViewActions.test.ts` — the pinned `transcript` overlay keymap (`t`, `f`, `q`).
- `tests/transcriptCmd.test.ts` — bare id resolution, direct path with no config, missing
  file exit 1, `--json`, `--tools` expands, `--width` wraps, usage exit 2.

## 9. Documentation

- `ARCHITECTURE.md` module map: rows for `transcriptSummary.ts`, `transcriptRender.ts`,
  `transcriptCmd.ts` beside the `replayCmd.ts` row; the `tui/` row gains `TranscriptView` +
  `useTranscript`.
- `README.md` "CLI at a glance": a `junco transcript <ticket-id>` row.
- `docs/dashboard.md`: the breadcrumb list (`transcript ▸ <id>`), the `enter` row of the key
  table and the queue-row key line, the Queue system-row paragraph, the "rows the daemon
  owns are never selectable" paragraph (running rows are now selectable; their actions still
  guard), the palette's args-taking command list, and a new "The transcript view" subsection
  after the Logs bullet.
- `docs/operations.md` "Transcripts" paragraph: how to read one (CLI + dashboard).
- `CLAUDE.md` "Debugging & visibility": one line — the transcript is now readable via
  `junco transcript <id>` or `enter` on the dashboard's queue row.
- `CHANGELOG.md` `[Unreleased]` → Added.
