# TUI Live Log View Design

**Date:** 2026-07-20
**Status:** Approved (approach A — shared file-tailer + ring buffer; both surfaces: compact LOCAL section + full-screen overlay; three filters: level / ticket / text)

## Problem

Watching what the daemon is doing means dropping to a separate terminal and running `junco logs -f`. The TUI already surfaces queue, daemon, repos, and worktree state, but the log stream — the most direct window into what a running ticket is actually doing — is absent. Operators want to tail the daemon log live without leaving the dashboard, and to narrow it (a level threshold when hunting a problem, one ticket's lines, a substring) once something looks wrong.

## Constraints that shape the design

- The TUI is a **separate process** from the daemon; it cannot tap the daemon's in-memory log. It reads `<dataDir>/worker.log` from disk — the same JSON-lines file `junco logs` reads, written by the daemon's rotating sink (`openRotatingLogSink`, 10 MB → `worker.log.1`). This is a feature: the view works whether the daemon is up or down (a down daemon still leaves the last tail on disk), and needs no protocol.
- `logsCmd.ts` already implements the hard part — incremental byte-offset tail, poll-based follow (500 ms; `fs.watch` is unreliable across filesystems), rotation reset (size shrink → head), partial-line carry. The design **extracts** that loop into a reusable reader rather than duplicating it.
- Every side effect goes behind an injectable deps seam; tests never touch a real daemon or real fs beyond a tmp fixture.
- The TUI's strict keyboard/mouse parity rule: every actionable surface responds to both.

## Goals

1. A compact **logs section** in the LOCAL rail that tails the latest lines live.
2. A **full-screen log overlay** (expand from the section, or a key) with scrollback, a follow toggle, and three filters: level threshold, ticket focus, substring search.
3. Extract the shared tailer so `junco logs` and the TUI have one follow implementation.

Non-goals (out of scope, possible follow-ups): cross-rotation scrollback into `worker.log.1`; regex search; multi-file merge; changing the daemon's log level from the TUI; daemon-side log streaming; persisting filter state across TUI restarts.

## Component 1 — shared tailer (`src/logReader.ts`)

A new leaf module owning all file-follow mechanics, with a deps seam over `stat/open/read/close/exists`.

```ts
export interface LogEntry {
  ts: string | null; // ISO from the JSON line, null for non-JSON
  level: "debug" | "info" | "warn" | "error" | null;
  ticket: string | null; // "-" normalized to null
  msg: string; // parsed msg, or the raw line for non-JSON
  fields: Record<string, unknown>; // remaining keys (ts/level/ticket/msg stripped)
  raw: string; // original line (passthrough source of truth)
}

export interface LogReaderDeps {
  statFn?: (p: string) => { size: number };
  openFn?: (p: string, flags: string) => number;
  readFn?: (fd: number, buf: Buffer, off: number, len: number, pos: number) => void;
  closeFn?: (fd: number) => void;
  existsFn?: (p: string) => boolean;
}

export function parseLogLine(raw: string): LogEntry; // tolerant; never throws
export function readTail(path: string, n: number, deps?: LogReaderDeps): LogEntry[]; // last n entries, [] if absent
export interface LogTailer {
  poll(): LogEntry[]; // entries appended since the last poll; [] when unchanged
  rotated: boolean; // set true on the poll that detected a rotation, for a marker row
  reset(): void; // drop offset + carry (re-tail from head)
}
export function makeLogTailer(path: string, deps?: LogReaderDeps): LogTailer;
```

`makeLogTailer` holds the byte offset and partial-line carry exactly as `logsCmd` does today: on `poll()` it stats the file, resets to head on size-shrink (rotation) and flags `rotated`, reads only `[offset, size)`, splits on `\n`, carries the trailing partial, and returns `parseLogLine`d entries. Missing file → `[]` (never throws). `parseLogLine` strips the canonical keys into `fields`, normalizes `ticket: "-"` to null, and falls back to `{ raw, msg: raw, level: null, ... }` for a non-JSON line (crash output).

## Component 2 — `logsCmd` refactor

`src/logsCmd.ts` switches its initial tail to `readTail` and its follow loop to `makeLogTailer().poll()` on the same 500 ms interval, rendering via the existing `formatHumanLine`/`--json` paths. Behavior is unchanged (the existing `logsCmd` tests are the regression net); the follow logic now lives once.

## Component 3 — TUI state & poll

- **Ring buffer:** a bounded `LogEntry[]` (cap `LOG_BUFFER_CAP = 2000`, drop-oldest) held in `App.tsx`, seeded by `readTail(path, 200)` on first entry into the logs surface and grown by the tailer poll.
- **Dedicated poll:** a new `logsPollMs` interval (default 500 ms) whose effect is **gated on visibility** — it runs only when `uiMode === "local" && localSection === "logs"` OR the log overlay is open. On teardown (leaving the surface) the tailer and buffer are dropped so re-entry re-seeds fresh. No disk reads when logs aren't on screen; nothing added to the cheap/heavy ticks.
- **Filter state:** `{ minLevel: Level; ticket: string | null; search: string }`, applied by a pure `filterEntries(buffer, filters)`.

## Component 4 — rendering (`src/tui/components/LogView.tsx`)

One row renderer (`HH:MM:SS` dim · `LEVEL` colored · `[ticket]` dim · `msg` · `{fields}` dim, truncated to width) feeding two layouts:

- **Compact section body** (LOCAL rail, `logs` selected): the last k filtered rows, always following the tail, no scrollback; a rotation marker row when `rotated`. Header shows a follow dot + buffer count. Not individually row-selectable (it is a viewport, like the daemon panel), but the pane is clickable to expand and wheel-scrolls the overlay's equivalent.
- **Full-screen overlay:** scrollable window over `filterEntries(buffer)`, follow toggle (`f`; scrolling up pauses follow, `G`/End resumes), filter chips in the header (`level ≥ warn · #46 · "push"`), and the level/ticket/search key bindings below. Reuses `QueueView`/`DaemonSection` window arithmetic (`clampScroll`/`maxScroll`).

Level colors reuse `logging.ts`'s mapping (debug dim, info cyan, warn yellow, error red) via `theme`.

### Keys (overlay)

- `f` toggle follow · `l` cycle level threshold (debug→info→warn→error→debug) · `t` cycle ticket focus (`all` ∪ distinct tickets in buffer) · `/` open substring search field (Enter applies, Esc clears) · `G`/End jump to bottom + resume follow · `esc` close overlay. The overlay owns input while open, so these bindings don't collide with the dashboard's global keys (e.g. the top-level `t` queue view).
- Enter/click on the compact section expands to the overlay. All key actions have a mouse equivalent where one is meaningful (wheel scroll, click-expand, click chips to cycle).

## Component 5 — wiring

- `LocalSection` (`src/tui/localSnapshot.ts`) gains `"logs"`; `SECTIONS` (`LocalDashboard.tsx`) and `LOCAL_SECTIONS` + the cursor record (`App.tsx`) add it. Rail badge: a live `●` dot **only while the logs poll is active** (i.e. while the section/overlay is on screen) — deliberately _not_ a warn/error count, since counting warn+ from the rail would require the background disk reads this design explicitly avoids. Passively surfacing errors from other sections is a non-goal (a possible follow-up that piggybacks the cheap tick).
- `LocalDashboard`'s body switch renders `<LogView variant="section" …>` for `logs`.
- A top-level overlay slot renders `<LogView variant="full" …>` when open; `Enter`/click on the compact section opens it, `esc` closes.
- The log path is `join(cfg.dataDir, "worker.log")`, resolved once where the other dashboard paths are.

## Data flow

poll (500 ms, visibility-gated) → `tailer.poll()` → append to ring buffer (drop past cap) → `filterEntries(buffer, filters)` → render windowed slice. Compact section always tails; overlay follows unless the user scrolled up. Seed via `readTail` on entry; drop on exit.

## Edge cases

- No file yet (daemon never started): both surfaces show the `junco logs` placeholder wording ("the daemon writes it once started").
- Daemon down: file still readable (stale tail); the header notes the down state the daemon section already tracks — logs aren't implied to be live.
- Rotation mid-view: tailer resets to head, emits one `· rotated` marker row; the buffer keeps prior lines (they scrolled from the old file), continuity preserved.
- Non-JSON lines (crash dumps): passed through raw at `level: null` (rendered plain).
- Empty filter result: "no lines match `<filters>`" rather than a blank pane.

## Testing

- `logReader`: `parseLogLine` (JSON, non-JSON, `ticket:"-"`, field stripping); `readTail` (last-n, absent file, fewer-than-n); `makeLogTailer` append/rotation-reset/partial-line-carry/no-change via a fake fs (byte-offset fakes, not real files).
- `logsCmd`: existing suite green through the extracted reader (regression).
- `LogView`: row rendering + level colors; each filter (level threshold, ticket focus, substring) applied over a fixture buffer; follow vs paused; compact vs full-screen; rotation marker; no-file + empty-result placeholders. Ink discipline: loop-until-condition, never a fixed tick.
- `App`: `logs` in section navigation; overlay open/close; the logs poll runs only when the surface is visible (assert no read when hidden) and re-seeds on re-entry; keyboard/mouse parity for expand + scroll + filter cycling.

## Compatibility

Additive: a new module, a new TUI section + overlay, a new visibility-gated poll. No change to the log file format, the daemon, `ticketSchema`, config, or `/health`. `logsCmd`'s observable behavior is unchanged. No new Config field (the 500 ms poll is an internal default, injectable in tests via the existing `*PollMs` prop convention — not a config lever).

## Implementation deviations

Small departures from the design above, discovered during implementation:

(a) The rail badge for `logs` is `""` (no badge), not the `●` dot Component 5 originally specified. The live/follow indicator lives in the `LogView` header instead (`● following` / `⏸ paused`) — a rail dot would be redundant with the `▌` cursor, since the logs poll is active exactly when the section is selected. Passively surfacing a warn/error count from other sections without the section being on screen remains a non-goal (it would require the background disk reads this design explicitly avoids).

(b) The compact section shows the latest **unfiltered** tail — filters (level/ticket/search) apply only in the full-screen overlay, never to the compact rail view.

(c) `logPath` is threaded as an explicit `App` prop (`AppProps.logPath`), resolved once in `dashboardCmd.ts` (`join(cfg.dataDir, "worker.log")`) rather than derived inside `App` — `App` has no `cfg` in scope. This mirrors the existing `clonesDir` prop, which resolves `<dataDir>/clones/watched` the same way.

(d) The compact section's row count is `k = max(1, height - 3)`, not the plan's `height - 2`. The bordered box already consumes 2 rows (top/bottom border) plus 1 for the pinned `logs  ●  <count>` header; `height - 2` would let the tail overflow the box by one row. `k = height - 3` matches the arithmetic `QueueView` already uses for the same bordered-box-plus-header shape.

(e) The overlay's filter chips (level/ticket/search) are **display-only** — the spec mentioned "click chips to cycle", but filters cycle via keys (`l`/`t`/`/`) only. Mouse/keyboard parity is not owed for non-actionable display chips (the same rule the footer applies to movement hints: an inert chip has no click handler).

(f) The `LogView` header `●` indicates **follow state** (`● following` / `⏸ paused`), not daemon liveness; the spec's "daemon-down note in the header" was not implemented — the file still renders when the daemon is down (the placeholder only distinguishes "no log file yet"). Threading daemon-up state into the overlay header is left to a follow-up issue.
