import React from "react";
import { Box, Text } from "ink";
import { bumpRender } from "../renderCount.js";
import { theme } from "../theme.js";
import { derivePrState, prStateMeta, type DashPr } from "../prState.js";
import { isBotAuthored } from "../state.js";
import { fmtClock } from "../queueFmt.js";
import { relTime } from "./IssueList.js";
import { ClickableBox } from "../ClickableBox.js";
import { TableHeader, type Column } from "./primitives/TableHeader.js";
import { Badge } from "./primitives/Badge.js";

/** Exported for the header width-calc test (checks column width derives from
 * the widest rendered string across the current dataset). */
export function checksToString(checks: {
  pass: number;
  fail: number;
  pending: number;
  total: number;
}): string {
  const parts: string[] = [];
  if (checks.fail > 0) parts.push(`✗${checks.fail}`);
  if (checks.pass > 0) parts.push(`✓${checks.pass}`);
  if (checks.pending > 0) parts.push(`◍${checks.pending}`);
  return parts.join(" ");
}

/** Widest the dim repo cell may grow; longer nwos truncate from the start so
 * the repo-name tail (the discriminating part) stays visible. Exported so
 * callers composing their own title (pane 3's repo-scoped monitor) can mirror
 * this same clamp instead of inventing a second budget. */
export const NWO_MAX_WIDTH = 24;

/** Widest the age cell can need — `relTime` can emit "365d". */
const AGE_W = 4;

/** Smallest title cell worth rendering. The title is the flexible column, so it
 * absorbs whatever the fixed cells leave; below this it stops being readable and
 * we would rather drop a fixed column than shave the title to nothing. */
const MIN_TITLE_W = 10;

export interface PrListColumnOpts {
  prs: DashPr[];
  showNwo: boolean;
  /** Outer width of the pane this list renders into — App passes
   * `layout.previewWidth` for the repo-scoped monitor. Undefined means no budget
   * pressure (the full-width PRs view), and every column always renders. */
  paneWidth?: number;
}

export interface PrListColumnSpec {
  columns: Column[];
  /** Inner pill width (badge text without the two pad spaces) — the Badge's `padTo`. */
  pillInner: number;
  repoW: number;
  checksW: number;
  /** False when the width budget dropped the checks column. */
  showChecks: boolean;
}

/** The single source of truth for this list's geometry: header cells and row
 * cells both read it, so they can never drift. Widths come from the CURRENT
 * dataset (or the header labels' own widths) — never from the selected row, so
 * moving the cursor can never shift a column.
 *
 * When `paneWidth` is given and the fixed cells cannot leave the title a
 * readable share, the CHECKS column drops. It is the only column whose signal
 * has another home: `derivePrState` folds checks-failing / checks-pending into
 * the lifecycle the state pill renders. Dropping it beats letting the row's
 * `overflow="hidden"` belt clip the trailing `age` cell away silently (#247). */
export function prListColumns({ prs, showNwo, paneWidth }: PrListColumnOpts): PrListColumnSpec {
  const badges = prs.map((p) => prStateMeta(derivePrState(p)).badge);
  const pillInner = Math.max("state".length, ...badges.map((b) => b.length), 0);
  const repoW = showNwo
    ? Math.min(NWO_MAX_WIDTH, Math.max("repo".length, ...prs.map((p) => p.nwo.length), 0))
    : 0;
  const checksW = Math.max("checks".length, ...prs.map((p) => checksToString(p.checks).length), 0);

  const build = (withChecks: boolean): Column[] => [
    { label: "", width: 1 },
    { label: "", width: 1 },
    { label: "#", width: 5, align: "right" },
    { label: "title", width: "flex" },
    ...(showNwo ? [{ label: "repo", width: repoW } as Column] : []),
    ...(withChecks ? [{ label: "checks", width: checksW } as Column] : []),
    { label: "state", width: pillInner + 2 },
    { label: "age", width: AGE_W, align: "right" },
  ];

  // Interior = pane width minus the round border (2) and paddingX (2). Every
  // adjacent pair costs one gap column (TableHeader and the rows both gap 1).
  const fits = (cols: Column[]): boolean => {
    if (paneWidth === undefined) return true;
    const fixed = cols.reduce((n, c) => n + (c.width === "flex" ? 0 : c.width), 0);
    return fixed + (cols.length - 1) + MIN_TITLE_W <= paneWidth - 4;
  };

  const withChecks = build(true);
  const showChecks = fits(withChecks);
  return { columns: showChecks ? withChecks : build(false), pillInner, repoW, checksW, showChecks };
}

export interface PrListProps {
  prs: DashPr[]; // already sorted by the App
  selected: number; // index into prs
  focused: boolean;
  height: number;
  now: Date;
  staleAt: string | null; // any repo served from cache → oldest fetchedAt
  window: { start: number; end: number };
  showNwo?: boolean; // show nwo cell; default true for multi-repo view
  title?: string; // pane title; default "pull requests · N"
  emptyText?: string; // empty-state message; default the cross-repo copy below
  /** The junco bot account's gh login (App resolves it via botLoginFn); rows
   * opened by this login render their number cell in accent. */
  botLogin?: string | null;
  /** Mouse: press on a PR row (registry index into prs). */
  onRowPress?: (index: number) => void;
  /** Mouse: press on the pane background (no row). */
  onPanePress?: () => void;
  /** Mouse: wheel over the pane (down → +1, up → −1). */
  onWheel?: (dir: 1 | -1) => void;
  /** Outer pane width, for the column budget — see prListColumns. */
  paneWidth?: number;
}

/** Pane 2: windowed PR rows with full-row selection bars and aligned
 * metadata. Selection list for PRs across watched repos. Memoized (perf
 * pass, spec 2026-07-21-tui-app-decomposition task 16). */
export const PrList = React.memo(function PrList({
  prs,
  selected,
  focused,
  height,
  now,
  staleAt,
  window,
  showNwo = true,
  title,
  emptyText,
  botLogin,
  onRowPress,
  onPanePress,
  onWheel,
  paneWidth,
}: PrListProps): React.JSX.Element {
  bumpRender("PrList"); // no-op unless JUNCO_RENDER_COUNT=1 (perf-pass measurement seam)
  const { columns, pillInner, repoW, checksW, showChecks } = prListColumns({
    prs,
    showNwo,
    paneWidth,
  });
  const PILL_W = pillInner + 2;
  const metaOf = prs.map((p) => prStateMeta(derivePrState(p)));

  return (
    <ClickableBox
      flexDirection="column"
      borderStyle="round"
      borderColor={focused ? theme.accent : theme.border}
      paddingX={1}
      flexGrow={1}
      height={height}
      onPress={onPanePress}
      onWheel={onWheel}
    >
      <Text bold color={focused ? theme.accent : undefined} wrap="truncate">
        {title ?? `pull requests · ${prs.length}`}
        {staleAt !== null && <Text color={theme.warn}> offline · {fmtClock(staleAt)}</Text>}
      </Text>
      <TableHeader columns={columns} />
      {prs.length === 0 && (
        <Text dimColor>
          {emptyText ??
            "no junco PRs found across watched repos — junco opens PRs from dispatched tickets"}
        </Text>
      )}
      {prs.slice(window.start, window.end).map((prItem, i) => {
        const idx = window.start + i;
        const sel = idx === selected;
        const meta = metaOf[idx];
        const botAuthored = isBotAuthored(prItem.author, botLogin);
        const checksStr = checksToString(prItem.checks);
        const checksColor =
          prItem.checks.fail > 0
            ? theme.error
            : prItem.checks.pending > 0
              ? theme.warn
              : theme.success;

        // Every cell except the title is flexShrink 0 (the Chrome.tsx header-chip
        // guarantee): a row must never wrap to a second line, or the height and
        // windowing math above corrupts. The title is the ONLY flexible cell.
        // overflow="hidden" is the structural belt: at pathological widths the
        // row CLIPS rather than wrapping (a clipped row beats a corrupted frame).
        return (
          <ClickableBox
            key={`${prItem.nwo}#${prItem.number}`}
            width="100%"
            overflow="hidden"
            backgroundColor={sel ? theme.selectionBg : undefined}
            hoverBg={sel ? theme.selectionBg : theme.hoverBg}
            gap={1}
            onPress={onRowPress ? () => onRowPress(idx) : undefined}
          >
            <Box flexShrink={0} width={1}>
              <Text color={theme.accent}>{sel ? "▌" : " "}</Text>
            </Box>
            <Box flexShrink={0} width={1}>
              <Text color={meta.color}>{meta.glyph}</Text>
            </Box>
            <Box flexShrink={0} width={5}>
              <Text
                color={botAuthored ? theme.accent : undefined}
                dimColor={!sel && !botAuthored}
                wrap="truncate-start"
              >
                {`#${prItem.number}`.padStart(5)}
              </Text>
            </Box>
            <Box flexGrow={1} minWidth={0}>
              <Text wrap="truncate">{prItem.title}</Text>
            </Box>
            {showNwo && (
              <Box flexShrink={0} width={repoW}>
                <Text dimColor wrap="truncate-start">
                  {prItem.nwo}
                </Text>
              </Box>
            )}
            {showChecks && (
              <Box flexShrink={0} width={checksW}>
                <Text color={checksColor}>{checksStr}</Text>
              </Box>
            )}
            <Box flexShrink={0} width={PILL_W}>
              <Badge label={meta.badge} color={meta.color} padTo={pillInner} />
            </Box>
            <Box flexShrink={0} width={AGE_W} justifyContent="flex-end">
              <Text dimColor>{relTime(prItem.updatedAt, now)}</Text>
            </Box>
          </ClickableBox>
        );
      })}
      <Box flexGrow={1} />
      {prs.length > window.end - window.start && (
        <Text dimColor>
          {Math.min(selected + 1, prs.length)}/{prs.length}
        </Text>
      )}
    </ClickableBox>
  );
});
