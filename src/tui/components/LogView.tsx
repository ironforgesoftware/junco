import React from "react";
import { Box, Text } from "ink";
import type { LogEntry } from "../../logReader.js";
import { filterEntries, type LogFilters } from "../logFilter.js";
import { ROTATED_MARKER } from "../useLogTail.js";
import { clampScroll, maxScroll } from "../window.js";
import { theme } from "../theme.js";
import { ClickableBox } from "../ClickableBox.js";

// Shared placeholder wording with `junco logs` (logsCmd.ts): the file only
// exists once the daemon has run, so both surfaces say the same thing.
const NO_FILE = "no log file yet — the daemon writes it once started";

// Null-level (unstructured crash line) marker, aligned under the padEnd(5)
// uppercase labels below.
const NULL_LEVEL = "·····";

interface LogViewProps {
  variant: "section" | "full";
  entries: LogEntry[]; // the raw buffer (unfiltered)
  height: number;
  focused: boolean;
  hasFile: boolean; // false → the daemon-not-started placeholder
  // full-variant only:
  filters?: LogFilters;
  follow?: boolean;
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
 *   filter chips + a follow/paused indicator in the header and a key-hint
 *   footer. `visible = max(1, height-4)` (border 2 + header 1 + footer 1);
 *   `start` follows the tail (`maxScroll`) or clamps `scroll` when paused; the
 *   reported `maxScroll` lets the owner clamp its offset without duplicating the
 *   arithmetic.
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
  const visible = Math.max(1, height - 4);
  const max = maxScroll(rows.length, visible);
  onScrollMax?.(max);
  const start = follow ? max : clampScroll(scroll, rows.length, visible);

  // Filter chips (display-only — the overlay cycles them via keys): the level
  // threshold only shows once it's above the floor, then ticket, then search.
  const chips: string[] = [];
  if (filters.minLevel !== "debug") chips.push(`level ≥ ${filters.minLevel}`);
  if (filters.ticket !== null) chips.push(`#${filters.ticket}`);
  if (filters.search.trim() !== "") chips.push(`"${filters.search.trim()}"`);

  const body =
    rows.length === 0 ? (
      <Text dimColor wrap="truncate-end">
        {hasFile ? "no lines match" : NO_FILE}
      </Text>
    ) : (
      rows.slice(start, start + visible).map((en, i) => <LogRow key={start + i} entry={en} />)
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
      </Text>
      {body}
      <Box flexGrow={1} />
      <Text dimColor wrap="truncate-end">
        f follow · l level · t ticket · / search · G bottom · esc close
      </Text>
    </ClickableBox>
  );
}
