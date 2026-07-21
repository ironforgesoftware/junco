import React from "react";
import { Box, Text } from "ink";
import type { LogEntry } from "../../logReader.js";
import { filterEntries, type LogFilters } from "../logFilter.js";
import { ROTATED_MARKER } from "../useLogTail.js";
import { clampScroll, maxScroll } from "../window.js";
import { theme } from "../theme.js";
import { ClickableBox } from "../ClickableBox.js";
import { Scrollbar } from "./primitives/Scrollbar.js";

// Shared placeholder wording with `junco logs` (logsCmd.ts): the file only
// exists once the daemon has run, so both surfaces say the same thing.
const NO_FILE = "no log file yet — the daemon writes it once started";

// Null-level (unstructured crash line) marker, aligned under the padEnd(5)
// uppercase labels below.
const NULL_LEVEL = "·····";

/** Header liveness note when the daemon is down (#239): worker.log is still
 * readable (the last tail on disk), so say exactly that instead of letting
 * old lines sit under a header that could read as live. */
function DownNote({ daemonUp }: { daemonUp?: boolean }): React.JSX.Element | null {
  if (daemonUp !== false) return null;
  return (
    <>
      {"  "}
      <Text dimColor>daemon down — showing last logs</Text>
    </>
  );
}

interface LogViewProps {
  variant: "section" | "full";
  entries: LogEntry[]; // the raw buffer (unfiltered)
  height: number;
  focused: boolean;
  hasFile: boolean; // false → the daemon-not-started placeholder
  /** Daemon liveness (cheap-poll `daemon.up`) — false marks the header with a
   * dim `daemon down — showing last logs` note so old lines never read as live.
   * DISTINCT from the follow indicator (● following is follow-state, #239).
   * Absent (tests / pre-first-tick) → no marker. */
  daemonUp?: boolean;
  // full-variant only:
  filters?: LogFilters;
  follow?: boolean;
  searchMode?: boolean; // true → render the live search-entry prompt in the header
  scroll?: number; // top offset when paused
  onScrollMax?: (max: number) => void;
  onExpand?: () => void; // section: click to open the overlay
  onWheel?: (dir: 1 | -1) => void;
}

/** One log line, shared by both variants. Mirrors `junco logs`'
 * `formatHumanLine`: `HH:MM:SS` dim · `LEVEL` (uppercase, padEnd 5) in its
 * color · `[ticket]` dim · `msg` · compact `{fields}` dim; truncated to width.
 * The rotation marker (`useLogTail`'s `ROTATED_MARKER`) renders as a centered
 * dim rule instead of a data row. */
function LogRow({ entry }: { entry: LogEntry }): React.JSX.Element {
  if (entry.raw === "" && entry.msg === ROTATED_MARKER.msg) {
    return (
      <Box justifyContent="center">
        <Text dimColor>{entry.msg}</Text>
      </Box>
    );
  }
  // `ts.slice(11, 19)` is exactly `HH:MM:SS`; blank (same width) when null so
  // the level column stays aligned.
  const time = entry.ts !== null ? entry.ts.slice(11, 19) : "        ";
  const hasFields = Object.keys(entry.fields).length > 0;
  return (
    <Text wrap="truncate-end">
      <Text dimColor>{time}</Text> {level(entry.level)}{" "}
      {entry.ticket !== null ? <Text dimColor>{`[${entry.ticket}] `}</Text> : ""}
      {entry.msg}
      {hasFields ? <Text dimColor>{` ${JSON.stringify(entry.fields)}`}</Text> : ""}
    </Text>
  );
}

/** The colored, 5-wide level label. Reuses `logging.ts`'s color mapping
 * (debug dim, info cyan, warn yellow, error red) via `theme`; a null level
 * (unstructured line) shows a dim `·····`. */
function level(l: LogEntry["level"]): React.JSX.Element {
  if (l === null) return <Text dimColor>{NULL_LEVEL}</Text>;
  const label = l.toUpperCase().padEnd(5);
  if (l === "debug") return <Text dimColor>{label}</Text>;
  const color = l === "info" ? theme.info : l === "warn" ? theme.warn : theme.error;
  return <Text color={color}>{label}</Text>;
}

/**
 * Compact LOCAL-section tail and full-screen overlay for the daemon log,
 * rendered from one shared row renderer.
 *
 * - `section`: the last `k` entries of the buffer **unfiltered** (the compact
 *   section always tails all levels — filtering is overlay-only), newest at the
 *   bottom, under a `logs  ●  <count>` follow header. The whole pane is a
 *   `ClickableBox` (click → `onExpand`, wheel → `onWheel`). `k = max(1, height-3)`
 *   reserves the bordered box's two chrome rows plus the pinned header — one row
 *   tighter than the plan's `height-2` so the frame never exceeds `height` (the
 *   Ink duplicate-redraw hazard QueueView guards against with the same math).
 * - `full`: a scrollable window over `filterEntries(entries, filters)` with
 *   filter chips + a follow/paused indicator in the header (the key hints live
 *   in the Chrome LOG_OVERLAY_HINTS chip row — one source, #238). `visible =
 *   max(1, height-3)` (border 2 + header 1); `start` follows the tail
 *   (`maxScroll`) or clamps `scroll` when paused; the reported `maxScroll`
 *   lets the owner clamp its offset without duplicating the arithmetic.
 */
export function LogView(props: LogViewProps): React.JSX.Element {
  return props.variant === "section" ? sectionView(props) : fullView(props);
}

function sectionView(props: LogViewProps): React.JSX.Element {
  const { entries, height, focused, hasFile, onExpand, onWheel } = props;
  const k = Math.max(1, height - 3);
  const tail = hasFile ? entries.slice(-k) : [];
  return (
    <ClickableBox
      flexDirection="column"
      borderStyle="round"
      borderColor={focused ? theme.accent : theme.border}
      paddingX={1}
      flexGrow={1}
      height={height}
      onPress={onExpand}
      onWheel={onWheel}
    >
      <Text wrap="truncate-end">
        <Text bold color={focused ? theme.accent : undefined}>
          logs
        </Text>
        {hasFile ? (
          <>
            {"  "}
            <Text color={theme.success}>●</Text>
            {"  "}
            <Text dimColor>{entries.length}</Text>
          </>
        ) : (
          ""
        )}
        <DownNote daemonUp={props.daemonUp} />
      </Text>
      {hasFile ? (
        tail.map((en, i) => <LogRow key={i} entry={en} />)
      ) : (
        <Text dimColor wrap="truncate-end">
          {NO_FILE}
        </Text>
      )}
    </ClickableBox>
  );
}

function fullView(props: LogViewProps): React.JSX.Element {
  const { entries, height, focused, hasFile, onScrollMax, onWheel } = props;
  const filters = props.filters ?? { minLevel: "debug", ticket: null, search: "" };
  const follow = props.follow ?? true;
  const scroll = props.scroll ?? 0;

  const rows = filterEntries(entries, filters);
  // border 2 + header 1 — the old internal key-hint footer is gone (#238):
  // the Chrome LOG_OVERLAY_HINTS chip row is the one source of overlay hints.
  const visible = Math.max(1, height - 3);
  const max = maxScroll(rows.length, visible);
  onScrollMax?.(max);
  const start = follow ? max : clampScroll(scroll, rows.length, visible);

  // Filter chips (display-only — the overlay cycles them via keys): the level
  // threshold only shows once it's above the floor, then ticket, then search.
  // While search-entry mode is active the term renders as a live prompt
  // (`/<term>▏`) — a visible cue that keystrokes are extending the term, shown
  // even before the first char is typed — instead of the committed quoted chip.
  const chips: string[] = [];
  if (filters.minLevel !== "debug") chips.push(`level ≥ ${filters.minLevel}`);
  if (filters.ticket !== null) chips.push(`#${filters.ticket}`);
  if (props.searchMode === true) chips.push(`/${filters.search}▏`);
  else if (filters.search.trim() !== "") chips.push(`"${filters.search.trim()}"`);

  // `hasFile === false` shows the daemon-not-started placeholder unconditionally
  // (BOTH variants, per the brief) — never real rows, even if a stale buffer
  // still passes the filter. Only with a file present does an empty filter
  // result become `no lines match`.
  const body =
    !hasFile || rows.length === 0 ? (
      <Text dimColor wrap="truncate-end">
        {hasFile ? "no lines match" : NO_FILE}
      </Text>
    ) : (
      <Box flexGrow={1}>
        <Box flexDirection="column" flexGrow={1} minWidth={0}>
          {rows.slice(start, start + visible).map((en, i) => (
            <LogRow key={start + i} entry={en} />
          ))}
        </Box>
        <Scrollbar offset={start} viewport={visible} total={rows.length} height={visible} />
      </Box>
    );

  return (
    <ClickableBox
      flexDirection="column"
      borderStyle="round"
      borderColor={focused ? theme.accent : theme.border}
      paddingX={1}
      flexGrow={1}
      height={height}
      onWheel={onWheel}
    >
      <Text wrap="truncate-end">
        <Text bold color={focused ? theme.accent : undefined}>
          logs
        </Text>
        {chips.length > 0 ? <Text dimColor>{`  ${chips.join(" · ")}`}</Text> : ""}
        {"  "}
        {follow ? (
          <Text color={theme.success}>● following</Text>
        ) : (
          <Text color={theme.warn}>⏸ paused</Text>
        )}
        <DownNote daemonUp={props.daemonUp} />
      </Text>
      {body}
      <Box flexGrow={1} />
    </ClickableBox>
  );
}
