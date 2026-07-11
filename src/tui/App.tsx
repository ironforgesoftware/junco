/**
 * Dashboard composition root: wires the fullscreen workspace, routes keystrokes
 * by view then pane, polls issues + health + queue on intervals, and applies
 * actions optimistically (local label delta shown immediately, rolled back with
 * a toast if gh fails). Holds NO queue state — every issue's lifecycle is
 * derived from its labels.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import type { DashboardClient, HealthInfo } from "./ghClient.js";
import type { DashAction, DashIssue } from "./state.js";
import { allowedActions, deriveState, filterIssues, sortIssues } from "./state.js";
import { lifecycleLabels, parseRepoInput } from "../githubInbox.js";
import type { WatchlistEntry } from "../watchlist.js";
import { readWatchlist, writeWatchlist } from "../watchlist.js";
import { expandHome } from "../config.js";
import { join } from "node:path";
import type { GithubRepoMapping } from "../types.js";
import { useTerminalSize, type TerminalSize } from "./useTerminalSize.js";
import { computeLayout } from "./layout.js";
import { windowSlice } from "./window.js";
import { headerTabBands, listRowsHeight, railListHeight } from "./geometry.js";
import type { UiMode } from "./geometry.js";
import { Workspace } from "./components/Workspace.js";
import { Header, hintsFor, localHintsFor, type HintView } from "./components/Chrome.js";
import LocalDashboard from "./components/LocalDashboard.js";
import type { LocalCheap, LocalHeavy, LocalSection, LocalRepo } from "./localSnapshot.js";
import { Rail, type RailRepo } from "./components/Rail.js";
import { IssueList } from "./components/IssueList.js";
import { Preview } from "./components/Preview.js";
import { PrList, NWO_MAX_WIDTH } from "./components/PrList.js";
import { PrPreview } from "./components/PrPreview.js";
import { derivePrState, sortPrs, type DashPr } from "./prState.js";
import { Modal } from "./components/Modal.js";
import { HelpModal } from "./components/HelpModal.js";
import { AddRepoForm } from "./components/AddRepoForm.js";
import { CommandPalette, filterCommands } from "./components/CommandPalette.js";
import { CommandOutput } from "./components/CommandOutput.js";
import { QueueView } from "./components/QueueView.js";
import { ReviewView, type ReviewState } from "./components/ReviewView.js";
import { ConfigView } from "./components/ConfigView.js";
import { PALETTE_COMMANDS, runCliCommand, type CliRunResult } from "./cliRunner.js";
import type { QueueSnapshot } from "./queueSnapshot.js";
import { theme, type ToastKind } from "./theme.js";
import { useMouse } from "./useMouse.js";
import { hitTest, type HitContext } from "./hitTest.js";
import { isMouseInput, type MouseEvent as TuiMouseEvent } from "./mouse.js";

export interface AppProps {
  client: DashboardClient;
  trigger: string;
  /** `cfg.branchPrefix` — recovers a PR's ticket slug from its head branch. */
  branchPrefix: string;
  configRepos: GithubRepoMapping[]; // read-only entries
  watchlistFile: string; // read/write via watchlist.ts
  /** Resolved config path — spawned palette commands target the same config. */
  configPath: string;
  /** Managed clones root (<state_dir>/repos) — auto-clone destination. */
  clonesDir: string;
  /** Unified view-scoped refresh cadence (issues + PRs). Default 30_000;
   * tests pass large values. */
  refreshPollMs?: number;
  healthPollMs?: number; // default 5_000
  /** Local queue snapshot source (dashboardCmd wires makeQueueSnapshotFn). */
  queueFn: () => Promise<QueueSnapshot>;
  queuePollMs?: number; // default 2_000
  /** LOCAL cheap snapshot (@3s): queue + counts + outbox + daemon detail. */
  localCheapFn: (opts?: { section?: LocalSection }) => Promise<LocalCheap>;
  /** LOCAL heavy snapshot (@15s, repos/worktrees sections only): repos + worktrees. */
  localHeavyFn: (signal?: AbortSignal) => Promise<LocalHeavy>;
  /** Which surface the dashboard opens on (github when github is enabled). */
  initialUiMode: UiMode;
  /** When false the GITHUB tab dims and `m`/tab-click into github toasts off. */
  githubEnabled: boolean;
  localCheapPollMs?: number; // default 3_000
  localHeavyPollMs?: number; // default 15_000
  /** Palette command runner override (tests). Defaults to the real subprocess. */
  runCliFn?: (name: string, extraArgs: string[]) => Promise<CliRunResult>;
  /** Fixed terminal size (tests) — ink-testing-library has no resizable stdout. */
  sizeOverride?: TerminalSize;
  onExit: () => void;
}

// Panes: 1 repos (rail), 2 issues (list), 3 PRs for the selected repo (wide
// terminals only).
type Pane = 1 | 2 | 3;

/** What a loader actually delivered — the unified cycle aggregates these to
 * stamp refreshedAt (oldest cache staleAt wins; nothing delivered → no stamp). */
type Delivery = { delivered: boolean; staleAt: string | null };
type View =
  | "main"
  | "detail"
  | "help"
  | "addRepo"
  | "config"
  | "palette"
  | "cmdOutput"
  | "queue"
  | "prs"
  | "prDetail"
  | "review";

/** LOCAL destructive-action gate: a `y/n` modal that owns input while open.
 * `onConfirm` fires the (already-composed) spawn on `y`/enter; `n`/esc drops it. */
interface ConfirmState {
  title: string;
  body: string;
  danger: boolean;
  onConfirm: () => void;
}
interface CmdState {
  title: string;
  running: boolean;
  output: string;
  exitCode: number | null;
  timedOut: boolean;
  /** The invocation, kept for `r` re-run. */
  name: string;
  extraArgs: string[];
  /** Monotonic run token — a stale resolution (same command re-run while the
   * first subprocess was still going) must not clobber the newer run. */
  token: number;
}
interface DetailState {
  issue: DashIssue; // snapshot taken at open — never re-read from the live list
  nwo: string; // frozen with the issue snapshot — the open target never depends on live rail state
  body: string | null;
  planComment: string | null;
  loading: boolean;
}
/** The fullscreen PR detail overlay — reached from pane 3 (`enter`) or the p
 * view (`enter`); `from` is where `esc`/`q` returns focus/selection to. No
 * fetch: PrPreview renders straight off the already-loaded `DashPr`. */
interface PrDetailState {
  pr: DashPr;
  from: "main" | "prs";
}

/** Pane 3's title composes "3 PRs · <nwo>" from a nwo of unbounded length —
 * mirrors PrList's own truncate-start nwo cell (NWO_MAX_WIDTH) so the title
 * clamps to the same budget rather than wrapping the pane onto a second line,
 * which would corrupt PrList's height/windowing math (CHROME one-line
 * discipline: every pane title is exactly one row). */
function truncateNwoStart(nwo: string): string {
  if (nwo.length <= NWO_MAX_WIDTH) return nwo;
  return `…${nwo.slice(nwo.length - (NWO_MAX_WIDTH - 1))}`;
}

/** First non-empty, trimmed line of a captured CLI output — where assessCmd's
 * queued / "not watched" / "already queued" messages live (src/assessCmd.ts
 * prints exactly one line per outcome, sometimes followed by blank padding). */
function firstNonEmptyLine(s: string): string | null {
  for (const raw of s.split("\n")) {
    const line = raw.trim();
    if (line) return line;
  }
  return null;
}

/** Compute the optimistic label set for an action — the operator sees motion
 * immediately; the bridge later reconciles to the authoritative labels. */
function optimisticLabels(action: DashAction, labels: string[], trigger: string): string[] {
  const ll = lifecycleLabels(trigger);
  const set = new Set(labels);
  switch (action) {
    case "dispatch":
      set.add(trigger);
      set.add(ll.planning);
      break;
    case "dispatchAsk":
      set.add(trigger);
      set.add(ll.queued);
      break;
    case "approve":
      set.add(ll.approved);
      break;
    case "replan":
      set.delete(ll.planReady);
      set.delete(ll.approved);
      break;
    case "recycle":
      set.delete(ll.done);
      set.delete(ll.failed);
      set.delete(ll.denied);
      break;
  }
  return [...set];
}

export function App(props: AppProps): React.JSX.Element {
  const {
    client,
    trigger,
    branchPrefix,
    configRepos,
    watchlistFile,
    configPath,
    clonesDir,
    queueFn,
    onExit,
  } = props;
  const refreshPollMs = props.refreshPollMs ?? 30_000;
  const healthPollMs = props.healthPollMs ?? 5_000;
  const queuePollMs = props.queuePollMs ?? 2_000;
  const localCheapPollMs = props.localCheapPollMs ?? 3_000;
  const localHeavyPollMs = props.localHeavyPollMs ?? 15_000;
  const LOCAL_SECTIONS: LocalSection[] = ["queue", "outbox", "repos", "worktrees", "daemon"];
  const runCliFn =
    props.runCliFn ??
    ((name: string, extraArgs: string[]) => runCliCommand(configPath, name, extraArgs));
  const { exit } = useApp();

  const size = useTerminalSize(props.sizeOverride);
  const layout = useMemo(() => computeLayout(size.columns, size.rows), [size]);

  const initialWatchlist = readWatchlist(watchlistFile);
  const [watchlistEntries, setWatchlistEntries] = useState<WatchlistEntry[]>(
    initialWatchlist.entries,
  );
  const [watchlistError, setWatchlistError] = useState<string | null>(initialWatchlist.error);
  const [repoIdx, setRepoIdx] = useState(0);
  const [issues, setIssues] = useState<Record<string, DashIssue[]>>({});
  // Per-repo listIssues staleAt (cache-served while offline); null = fresh.
  const [staleAt, setStaleAt] = useState<Record<string, string | null>>({});
  // The top bar's single ↻ stamp: when the last unified refresh cycle
  // completed. Cache-served (offline) sources pull it back to the oldest
  // cache staleAt, so data that arrived stale never reads as fresh.
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null);
  // Selection is anchored to the issue NUMBER (per repo), NOT a positional index,
  // so a poll that re-sorts the list keeps the cursor on the same issue.
  const [selectedNum, setSelectedNum] = useState<Record<string, number>>({});
  // Cross-repo PR aggregate — one flat, already-sorted list (attention-first).
  const [prs, setPrs] = useState<DashPr[]>([]);
  // Per-repo listPrs staleAt so a SCOPED refresh clears only its own repo's
  // marker; the list-level prStaleAt derives as the oldest non-null entry
  // among watched repos (any offline repo → a stale marker).
  const [prStaleByRepo, setPrStaleByRepo] = useState<Record<string, string | null>>({});
  // PR selection anchor: {nwo, number} because PR numbers collide across repos —
  // a bare-number anchor would jump on re-sort.
  const [prSel, setPrSel] = useState<{ nwo: string; number: number } | null>(null);
  // Pane-3 selection anchor: a bare PR NUMBER, because every candidate here is
  // already scoped to ONE repo (no {nwo, number} collision risk). Unlike the
  // anchors above, a repo swap resets this explicitly — see the effect below.
  const [pane3SelNum, setPane3SelNum] = useState<number | null>(null);
  const [pane, setPane] = useState<Pane>(1);
  const [view, setView] = useState<View>("main");
  const [detail, setDetail] = useState<DetailState | null>(null);
  const [prDetail, setPrDetail] = useState<PrDetailState | null>(null);
  const [reviewState, setReviewState] = useState<ReviewState>({
    loading: false,
    error: null,
    batches: [],
    drafts: [],
    cursor: 0,
    open: null,
  });
  const [scroll, setScroll] = useState(0);
  const [filter, setFilter] = useState("");
  const [filtering, setFiltering] = useState(false);
  const [toast, setToast] = useState<{ kind: ToastKind; text: string } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [queueSnap, setQueueSnap] = useState<QueueSnapshot | null>(null);
  const [queueNow, setQueueNow] = useState<Date>(() => new Date());
  const [addRepoError, setAddRepoError] = useState<string | null>(null);
  const [addRepoBusy, setAddRepoBusy] = useState<string | null>(null);
  const [paletteFilter, setPaletteFilter] = useState("");
  const [paletteSel, setPaletteSel] = useState(0);
  const [paletteArgsMode, setPaletteArgsMode] = useState(false);
  const [paletteArgs, setPaletteArgs] = useState("");
  const [cmd, setCmd] = useState<CmdState | null>(null);
  const [cmdElapsed, setCmdElapsed] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  // Last resolved positional index — the fallback when the selected issue number
  // vanishes from the list (closed/filtered), so the cursor stays near its slot.
  const lastIdxRef = useRef(0);
  // Same fallback, for the PR list: the slot the cursor returns to when the
  // anchored {nwo, number} vanishes (merged/closed and rolled off the limit).
  const lastPrIdxRef = useRef(0);
  // Same fallback, for pane 3's repo-scoped PR list.
  const lastPane3IdxRef = useRef(0);

  // ── LOCAL mode: a uiMode axis above `View`, with its own section/focus/cursor
  // cluster. GitHub state above is untouched; when uiMode==="github" every path
  // below stays byte-identical. ──
  const [uiMode, setUiMode] = useState<UiMode>(props.initialUiMode);
  const [localSection, setLocalSection] = useState<LocalSection>("queue");
  const [localFocus, setLocalFocus] = useState<"rail" | "body">("rail");
  const [localCursor, setLocalCursor] = useState<Record<LocalSection, number>>({
    queue: 0,
    outbox: 0,
    repos: 0,
    worktrees: 0,
    daemon: 0,
  });
  const [localScroll, setLocalScroll] = useState(0);
  const [localCheap, setLocalCheap] = useState<LocalCheap | null>(null);
  const [localHeavy, setLocalHeavy] = useState<LocalHeavy | null>(null);
  const [localRefreshedAt, setLocalRefreshedAt] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  // Dedupe key set for in-flight spawned actions (mirrors assessInFlightRef).
  const localActionInFlightRef = useRef<Set<string>>(new Set());

  // Selectable rows for the current section. INVARIANT: this list is the EXACT
  // rendered list each section component highlights, in the same order and
  // 1:1 by index — so the `▌` cursor (localCursorSafe) and the x/R action
  // target (localTarget) are always the SAME row. That means we do NOT pre-
  // filter out non-actionable rows here (a done RECENT row, a live worktree):
  // they stay in the list, exactly where the component draws them, and the
  // x/R handlers guard them into a safe toast instead. RUNNING/processing rows
  // are the one exception — QueueView never makes them selectable (the daemon
  // owns processing/), and they are absent here too, so the mapping still holds.
  // Gives x/R/o/f an explicit LOCAL target instead of the github currentRepo.
  type LocalRow =
    | { kind: "waiting"; id: string }
    | { kind: "recent"; id: string; status: "done" | "failed" }
    | { kind: "outboxOp"; id: string }
    | { kind: "repo"; repo: LocalRepo }
    | { kind: "worktree"; path: string; slug: string; klass: "live" | "stale" | "backup" };

  const localRowsFor = (section: LocalSection): LocalRow[] => {
    switch (section) {
      case "queue": {
        const q = localCheap?.queue;
        if (!q) return [];
        // waiting THEN all recent (done+failed) — the identical index space
        // QueueView highlights (`selectedRow === waiting.length + j`).
        return [
          ...q.waiting.map((w) => ({ kind: "waiting" as const, id: w.id })),
          ...q.recent.map((rr) => ({ kind: "recent" as const, id: rr.id, status: rr.status })),
        ];
      }
      case "outbox":
        return (localCheap?.outbox.ops ?? []).map((o) => ({ kind: "outboxOp" as const, id: o.id }));
      case "repos":
        return (localHeavy?.repos ?? []).map((repo) => ({ kind: "repo" as const, repo }));
      case "worktrees":
        // ALL worktrees, in render order — the identical index space
        // WorktreesSection highlights (`idx === cursor`). live rows are kept
        // (and guarded in the x handler) so highlight and target never diverge.
        return (localHeavy?.worktrees ?? []).map((w) => ({
          kind: "worktree" as const,
          path: w.path,
          slug: w.slug,
          klass: w.kind,
        }));
      case "daemon":
        return [];
    }
  };
  const localRows = localRowsFor(localSection);
  const localCursorSafe = Math.max(0, Math.min(localCursor[localSection], localRows.length - 1));
  const localTarget = localRows[localCursorSafe];

  const moveLocalCursor = (delta: number): void => {
    if (localRows.length === 0) return;
    const next = Math.max(0, Math.min(localCursorSafe + delta, localRows.length - 1));
    setLocalCursor((m) => ({ ...m, [localSection]: next }));
  };
  const moveLocalSection = (delta: number): void => {
    const i = LOCAL_SECTIONS.indexOf(localSection);
    const next = Math.max(0, Math.min(i + delta, LOCAL_SECTIONS.length - 1));
    setLocalSection(LOCAL_SECTIONS[next]);
    setLocalScroll(0); // section switch resets the daemon-panel scroll
  };

  const showToast = useCallback((kind: ToastKind, text: string) => {
    setToast({ kind, text });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4000);
  }, []);
  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    [],
  );

  // Config repos ∪ watchlist, deduped by nwo (config wins) — recomputed after
  // every watchlist write since setWatchlistEntries drives this memo.
  const repoMappings = useMemo(() => {
    const out = configRepos.map((r) => ({
      nwo: r.nwo,
      path: r.path,
      fromConfig: true,
      external: false,
    }));
    const seen = new Set(out.map((r) => r.nwo.toLowerCase()));
    for (const e of watchlistEntries) {
      if (seen.has(e.nwo.toLowerCase())) continue;
      seen.add(e.nwo.toLowerCase());
      // external === true → fork-PR mode: dispatch queues a ticket (no labels).
      out.push({ nwo: e.nwo, path: e.path, fromConfig: false, external: e.external === true });
    }
    return out;
  }, [configRepos, watchlistEntries]);

  const repoIdxSafe = Math.max(0, Math.min(repoIdx, repoMappings.length - 1));
  const currentRepo = repoMappings[repoIdxSafe];
  const currentNwo = currentRepo?.nwo;
  const currentIssues = currentNwo ? (issues[currentNwo] ?? []) : [];
  // The live `/` filter is applied before selection resolves; the number anchor
  // survives re-filtering and the issueIdxSafe clamp handles a shrinking list.
  const filteredIssues = useMemo(
    () => filterIssues(currentIssues, filter, trigger),
    [currentIssues, filter, trigger],
  );
  // Resolve the anchored number to a live index; fall back to the clamped last
  // index only when that issue is gone (closed, or filtered out).
  const selNum = currentNwo ? selectedNum[currentNwo] : undefined;
  const byNum = selNum !== undefined ? filteredIssues.findIndex((i) => i.number === selNum) : -1;
  const issueIdxSafe =
    filteredIssues.length === 0
      ? 0
      : byNum >= 0
        ? byNum
        : Math.min(lastIdxRef.current, filteredIssues.length - 1);
  lastIdxRef.current = issueIdxSafe;
  const currentIssue = filteredIssues[issueIdxSafe];

  // Resolve the anchored PR to a live index in the sorted aggregate; fall back
  // to the clamped last slot only when that PR is gone (mirrors the issue
  // anchor above — the anchor survives a re-sorting poll).
  const prByAnchor = prSel
    ? prs.findIndex((p) => p.nwo === prSel.nwo && p.number === prSel.number)
    : -1;
  const prIdxSafe =
    prs.length === 0
      ? 0
      : prByAnchor >= 0
        ? prByAnchor
        : Math.min(lastPrIdxRef.current, prs.length - 1);
  lastPrIdxRef.current = prIdxSafe;
  const selectedPr = prs[prIdxSafe] ?? null;

  // Pane-3 data: the cross-repo PR aggregate, scoped to the rail's selected
  // repo and re-sorted the same way the aggregate itself is (attention-first).
  const repoPrs = useMemo(
    () => sortPrs(prs.filter((p) => p.nwo === currentNwo)),
    [prs, currentNwo],
  );
  // Resolve the anchored PR number to a live index in `repoPrs`; fall back to
  // the clamped last slot only when the anchor is gone (mirrors the prSel
  // resolution above, scoped to one repo).
  const pane3ByNum = pane3SelNum !== null ? repoPrs.findIndex((p) => p.number === pane3SelNum) : -1;
  const pane3IdxSafe =
    repoPrs.length === 0
      ? 0
      : pane3ByNum >= 0
        ? pane3ByNum
        : Math.min(lastPane3IdxRef.current, repoPrs.length - 1);
  lastPane3IdxRef.current = pane3IdxSafe;
  const selectedPane3Pr = repoPrs[pane3IdxSafe] ?? null;
  // Pane 3's title identifies the scoped repo (mockup: "3 PRs · acme/reef");
  // no repo selected (empty rail) falls back to the bare pane label.
  const pane3Title = currentNwo ? `3 PRs · ${truncateNwoStart(currentNwo)}` : "3 PRs";

  // Window slices live HERE (not inside the list components) so that rendering
  // and mouse hit-testing share one offset — the sticky prevStart refs move up
  // with them. Geometry helpers keep the budgets in lockstep with the panes.
  const railPrev = useRef(0);
  const railWindow = windowSlice(
    repoMappings.length,
    railListHeight(layout.bodyRows),
    repoIdxSafe,
    railPrev.current,
  );
  railPrev.current = railWindow.start;
  const issuePrev = useRef(0);
  const issueWindow = windowSlice(
    filteredIssues.length,
    listRowsHeight(layout.bodyRows),
    issueIdxSafe,
    issuePrev.current,
  );
  issuePrev.current = issueWindow.start;
  const prPrev = useRef(0);
  const prWindow = windowSlice(
    prs.length,
    listRowsHeight(layout.bodyRows),
    prIdxSafe,
    prPrev.current,
  );
  prPrev.current = prWindow.start;
  // Pane 3's repo-scoped monitor is a windowed PrList too — same lifted-offset rule.
  const pane3Prev = useRef(0);
  const pane3Window = windowSlice(
    repoPrs.length,
    listRowsHeight(layout.bodyRows),
    pane3IdxSafe,
    pane3Prev.current,
  );
  pane3Prev.current = pane3Window.start;

  // Per-repo issue counts for the rail badges, derived from loaded issues.
  const repoRows: RailRepo[] = repoMappings.map((r) => {
    const counts: RailRepo["counts"] = {};
    for (const iss of issues[r.nwo] ?? []) {
      const st = deriveState(iss.labels, trigger);
      counts[st] = (counts[st] ?? 0) + 1;
    }
    return { nwo: r.nwo, fromConfig: r.fromConfig, counts };
  });

  // Header pulse: issues needing operator review (plan-ready or approved)
  // across the currently watched repos whose issues have loaded so far —
  // issues are fetched lazily per selection, so unvisited repos contribute 0.
  // Scoped to repoMappings (not the raw issues map) so an unwatched repo's
  // leftover entries can never inflate the count.
  const reviewCount = useMemo(
    () =>
      repoMappings.reduce(
        (sum, r) =>
          sum +
          (issues[r.nwo] ?? []).reduce((n, iss) => {
            const st = deriveState(iss.labels, trigger);
            return st === "plan-ready" || st === "approved" ? n + 1 : n;
          }, 0),
        0,
      ),
    [repoMappings, issues, trigger],
  );

  // Header pulse: junco-authored PRs needing attention — checks-failing or
  // changes-requested — across the cross-repo aggregate. prFailing picks the
  // chip's color (error outranks warn — the operator should see the worse
  // news first, same precedence rule as derivePrState itself). Scoped to
  // repoMappings (same rule as reviewCount above) so an unwatched repo's
  // leftover PRs can never inflate the count between polls; unwatch() also
  // prunes `prs` synchronously, so this scoping is the belt to that suspender.
  const prAttention = useMemo(() => {
    const watched = new Set(repoMappings.map((r) => r.nwo));
    return prs.filter((p) => {
      if (!watched.has(p.nwo)) return false;
      const s = derivePrState(p);
      return s === "checks-failing" || s === "changes-requested";
    }).length;
  }, [prs, repoMappings]);
  const prFailing = useMemo(() => {
    const watched = new Set(repoMappings.map((r) => r.nwo));
    return prs.some((p) => watched.has(p.nwo) && derivePrState(p) === "checks-failing");
  }, [prs, repoMappings]);

  const loadIssues = useCallback(
    (nwo: string): Promise<Delivery> => {
      return client.listIssues(nwo).then((res) => {
        if (res.ok) {
          setIssues((prev) => ({ ...prev, [nwo]: sortIssues(res.value.issues, trigger) }));
          setStaleAt((prev) => ({ ...prev, [nwo]: res.value.staleAt }));
          return { delivered: true, staleAt: res.value.staleAt };
        }
        // Only surface the error toast when GITHUB actually owns the screen —
        // this same loader fires on the background poll regardless of mode, and
        // a failing github probe must never flash a red toast over LOCAL.
        if (uiModeRef.current === "github" && props.githubEnabled) showToast("error", res.error);
        return { delivered: false, staleAt: null };
      });
    },
    [client, trigger, showToast, props.githubEnabled],
  );

  // Derived list-level stale marker (see prStaleByRepo above).
  const prStaleAt = useMemo(() => {
    const watched = new Set(repoMappings.map((r) => r.nwo));
    let oldest: string | null = null;
    for (const [nwo, s] of Object.entries(prStaleByRepo)) {
      if (!watched.has(nwo) || s === null) continue;
      if (oldest === null || Date.parse(s) < Date.parse(oldest)) oldest = s;
    }
    return oldest;
  }, [prStaleByRepo, repoMappings]);

  // Cross-repo PR aggregate sweep: fetch every watched repo independently (a
  // failed repo contributes nothing and never blocks the others — and is NOT
  // toasted on the poll path), flatten, sort attention-first.
  const loadPrs = useCallback(
    (isAlive: () => boolean = () => true): Promise<Delivery> => {
      const targets = repoMappings.map((r) => r.nwo);
      return Promise.all(targets.map((nwo) => client.listPrs(nwo))).then((results) => {
        if (!isAlive()) return { delivered: false, staleAt: null };
        const all: DashPr[] = [];
        const staleMap: Record<string, string | null> = {};
        let oldest: string | null = null;
        let delivered = false;
        results.forEach((res, i) => {
          if (!res.ok) return; // one repo down: skip it, never block the rest
          delivered = true;
          all.push(...res.value.prs);
          staleMap[targets[i]] = res.value.staleAt;
          const s = res.value.staleAt;
          if (s !== null && (oldest === null || Date.parse(s) < Date.parse(oldest))) oldest = s;
        });
        setPrs(sortPrs(all));
        setPrStaleByRepo(staleMap);
        return { delivered, staleAt: oldest };
      });
    },
    [client, repoMappings],
  );

  // Scoped sibling of loadPrs: refresh ONE repo's slice of the cross-repo
  // aggregate — main-view cycles poll only the selected repo.
  const loadPrsFor = useCallback(
    (nwo: string, isAlive: () => boolean = () => true): Promise<Delivery> => {
      return client.listPrs(nwo).then((res) => {
        if (!isAlive() || !res.ok) return { delivered: false, staleAt: null };
        setPrs((prev) => sortPrs([...prev.filter((p) => p.nwo !== nwo), ...res.value.prs]));
        setPrStaleByRepo((prev) => ({ ...prev, [nwo]: res.value.staleAt }));
        return { delivered: true, staleAt: res.value.staleAt };
      });
    },
    [client],
  );

  // Live refs so the unified cycle and its interval never go stale as the
  // operator navigates repos or switches views.
  const nwoRef = useRef<string | undefined>(currentNwo);
  nwoRef.current = currentNwo;
  const viewRef = useRef(view);
  viewRef.current = view;
  // Live uiMode for the poll callbacks: a background issues poll must not flash
  // a github error toast while LOCAL owns the screen (the poll fires on its own
  // interval regardless of mode). Read via a ref so loadIssues' identity — and
  // the intervals keyed on it — don't churn on every mode toggle.
  const uiModeRef = useRef(uiMode);
  uiModeRef.current = uiMode;

  // The ONE refresh cycle. Scope follows the view unless overridden (the `p`
  // handler must sweep before the "prs" view state has committed): main →
  // selected repo's issues + PRs; monitor → every watched repo's PRs. Stamps
  // refreshedAt on completion — oldest cache staleAt wins, and a cycle where
  // nothing delivered never advances the stamp.
  const refreshAll = useCallback(
    (opts: { isAlive?: () => boolean; scope?: "main" | "monitor" } = {}): Promise<void> => {
      const isAlive = opts.isAlive ?? ((): boolean => true);
      const inMonitor =
        opts.scope !== undefined
          ? opts.scope === "monitor"
          : viewRef.current === "prs" || viewRef.current === "prDetail";
      const nwo = nwoRef.current;
      const jobs: Promise<Delivery>[] = inMonitor
        ? [loadPrs(isAlive)]
        : nwo
          ? [loadIssues(nwo), loadPrsFor(nwo, isAlive)]
          : [];
      if (jobs.length === 0) return Promise.resolve();
      return Promise.all(jobs).then((outcomes) => {
        if (!isAlive()) return;
        const delivered = outcomes.filter((o) => o.delivered);
        if (delivered.length === 0) return; // nothing arrived: never advance
        let oldest: string | null = null;
        for (const o of delivered) {
          const s = o.staleAt;
          if (s !== null && (oldest === null || Date.parse(s) < Date.parse(oldest))) oldest = s;
        }
        setRefreshedAt(oldest ?? new Date().toISOString());
      });
    },
    [loadIssues, loadPrs, loadPrsFor],
  );

  // Scoped cycle for the selected repo (initial mount + every selection
  // change): the data under the operator's eyes refreshes immediately.
  useEffect(() => {
    if (!currentNwo) return;
    void refreshAll();
  }, [currentNwo, refreshAll]);

  // Clear the live filter when the selected repo changes — a stale query would
  // hide the newly-selected repo's issues (also fires harmlessly on mount).
  useEffect(() => {
    setFilter("");
    setFiltering(false);
  }, [currentNwo]);

  // Keep the per-repo anchored selection valid: pick the top row on first load,
  // and when the selected issue disappears fall back to the same slot. A number
  // that is still present is left untouched so re-sorts don't move the cursor.
  useEffect(() => {
    if (!currentNwo) return;
    const arr = issues[currentNwo];
    if (!arr || arr.length === 0) return;
    setSelectedNum((m) => {
      const cur = m[currentNwo];
      if (cur !== undefined && arr.some((i) => i.number === cur)) return m;
      const idx = Math.max(0, Math.min(lastIdxRef.current, arr.length - 1));
      return { ...m, [currentNwo]: arr[idx].number };
    });
  }, [currentNwo, issues]);

  // Keep the PR anchor valid: top row on first load, and the same slot when the
  // anchored PR disappears. A still-present anchor is left untouched so a
  // re-sorting poll never slides a different PR under the cursor.
  useEffect(() => {
    if (prs.length === 0) return;
    setPrSel((cur) => {
      if (cur && prs.some((p) => p.nwo === cur.nwo && p.number === cur.number)) return cur;
      const idx = Math.max(0, Math.min(lastPrIdxRef.current, prs.length - 1));
      return { nwo: prs[idx].nwo, number: prs[idx].number };
    });
  }, [prs]);

  // Keep pane 3's anchor valid: same rules as the PR anchor above EXCEPT a
  // repo swap (detected via the ref) resets it to the top explicitly — pane 3
  // has no reason to remember a slot from a different repo's list, so it must
  // not fall through to the lastPane3IdxRef clamp on a repo change.
  const pane3RepoRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const repoChanged = pane3RepoRef.current !== currentNwo;
    pane3RepoRef.current = currentNwo;
    if (repoChanged) lastPane3IdxRef.current = 0;
    if (repoPrs.length === 0) {
      if (repoChanged) setPane3SelNum(null);
      return;
    }
    setPane3SelNum((cur) => {
      if (!repoChanged && cur !== null && repoPrs.some((p) => p.number === cur)) return cur;
      const idx = Math.max(0, Math.min(lastPane3IdxRef.current, repoPrs.length - 1));
      return repoPrs[idx].number;
    });
  }, [currentNwo, repoPrs]);

  // The unified poll — one interval, view-scoped via the refs. Immediate
  // cycles fire from the selection effect, the `p` handler, and `r`.
  useEffect(() => {
    let alive = true;
    const id = setInterval(() => void refreshAll({ isAlive: () => alive }), refreshPollMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [refreshAll, refreshPollMs]);

  // Health polling (also fires once on mount).
  useEffect(() => {
    let alive = true;
    const run = async (): Promise<void> => {
      const h = await client.health();
      if (alive) setHealth(h);
    };
    void run();
    const id = setInterval(() => void run(), healthPollMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [client, healthPollMs]);

  // Queue polling (also fires once on mount).
  useEffect(() => {
    let alive = true;
    const run = async (): Promise<void> => {
      const s = await queueFn();
      if (!alive) return;
      setQueueSnap(s);
      setQueueNow(new Date());
    };
    void run();
    const id = setInterval(() => void run(), queuePollMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [queueFn, queuePollMs]);

  // Full sweep on mount and whenever the watchlist changes (refreshAll's
  // identity tracks loadPrs → repoMappings): populates the ⚑ attention chip
  // and the monitor aggregate, so a newly-watched repo's PRs appear without
  // waiting for a monitor visit. Scoped cycles take over in between.
  useEffect(() => {
    let alive = true;
    void refreshAll({ isAlive: () => alive, scope: "monitor" });
    return () => {
      alive = false;
    };
  }, [refreshAll]);

  const setIssueLabels = useCallback((nwo: string, num: number, labels: string[]) => {
    setIssues((prev) => {
      const arr = prev[nwo];
      if (!arr) return prev;
      return { ...prev, [nwo]: arr.map((i) => (i.number === num ? { ...i, labels } : i)) };
    });
  }, []);

  // Flips false on unmount so every async `.then`/`await` continuation below can
  // bail before touching state after the dashboard has exited. `assess` and the
  // other spawned CLIs can resolve up to cliRunner's 120s timeout past unmount;
  // the optimistic/browser/detail handlers resolve fast but carry the same guard
  // for consistency (post-unmount setState is a silent no-op under React 19, so
  // this is a uniformity guard, not a live-bug fix).
  const aliveRef = useRef(true);
  useEffect(
    () => () => {
      aliveRef.current = false;
    },
    [],
  );

  // Optimistic action: apply the label delta locally, call gh with the ORIGINAL
  // labels, restore + toast on failure.
  const runAction = useCallback(
    (action: DashAction) => {
      if (!currentNwo || !currentIssue) return;
      const st = deriveState(currentIssue.labels, trigger);
      if (!allowedActions(st).includes(action)) {
        showToast("error", `${action} not available in state ${st}`);
        return;
      }
      const nwo = currentNwo;
      const num = currentIssue.number;
      const prevLabels = currentIssue.labels;
      setIssueLabels(nwo, num, optimisticLabels(action, prevLabels, trigger));
      void client.applyAction(nwo, num, action, prevLabels).then((res) => {
        if (!aliveRef.current) return;
        if (!res.ok) {
          setIssueLabels(nwo, num, prevLabels);
          showToast("error", res.error);
        } else if (res.value.queued) {
          // GitHub was unreachable — the edit landed durably in the outbox
          // instead of live. The optimistic label is correct either way (the
          // bridge will reconcile once flushed), so this is NOT a rollback.
          showToast("info", `offline — action queued (⇡${queueSnap?.outboxDepth ?? "?"})`);
        } else {
          showToast("success", `${action} applied`);
        }
      });
    },
    [client, currentNwo, currentIssue, trigger, setIssueLabels, showToast, queueSnap],
  );

  const openDetail = useCallback(() => {
    if (!currentNwo || !currentIssue) return;
    const nwo = currentNwo;
    const snapshot = currentIssue; // frozen at open — the header never swaps mid-read
    const num = snapshot.number;
    setScroll(0);
    setDetail({ issue: snapshot, nwo, body: null, planComment: null, loading: true });
    setView("detail");
    void client.issueDetail(nwo, num).then((res) => {
      if (!aliveRef.current) return;
      if (res.ok) {
        setDetail({
          issue: snapshot,
          nwo,
          body: res.value.body,
          planComment: res.value.planComment,
          loading: false,
        });
      } else {
        setDetail({ issue: snapshot, nwo, body: null, planComment: null, loading: false });
        showToast("error", res.error);
      }
    });
  }, [client, currentNwo, currentIssue, showToast]);

  const openBrowser = useCallback(() => {
    if (!currentNwo || !currentIssue) return;
    void client.openInBrowser(currentNwo, currentIssue.number).then((res) => {
      if (!aliveRef.current) return;
      if (!res.ok) showToast("error", res.error);
    });
  }, [client, currentNwo, currentIssue, showToast]);

  // Takes an explicit nwo so LOCAL passes its cursor's LocalRepo target while
  // github passes currentRepo.nwo — the open never depends on the github rail.
  const openRepoBrowser = useCallback(
    (nwo: string) => {
      if (!nwo) return;
      void client.openRepoInBrowser(nwo).then((res) => {
        if (!aliveRef.current) return;
        if (!res.ok) showToast("error", res.error);
      });
    },
    [client, showToast],
  );

  // Snapshot-anchored browser opens for the two detail views — shared by the
  // keyboard `o` and the ↗ line's mouse click, so the two can never diverge
  // on WHICH resource they open (always the one frozen on screen).
  const openDetailIssueInBrowser = useCallback(() => {
    if (!detail) return;
    void client.openInBrowser(detail.nwo, detail.issue.number).then((res) => {
      if (!aliveRef.current) return;
      if (!res.ok) showToast("error", res.error);
    });
  }, [client, detail, showToast]);
  const openPrDetailInBrowser = useCallback(() => {
    if (!prDetail) return;
    const { nwo, number } = prDetail.pr;
    void client.openPrInBrowser(nwo, number).then((res) => {
      if (!aliveRef.current) return;
      if (!res.ok) showToast("error", res.error);
    });
  }, [client, prDetail, showToast]);

  // Repos currently mid-`assess` — guards a second `s`/`S` press on the same
  // repo from double-spawning the CLI while the first run is still going.
  const assessInFlightRef = useRef<Set<string>>(new Set());

  // Immediate LOCAL refresh (rail `r`): cheap always, heavy only for the two
  // git-backed sections. aliveRef drops late results after unmount.
  const forceLocalRefresh = useCallback(async (): Promise<void> => {
    const c = await props.localCheapFn({ section: localSection });
    if (!aliveRef.current) return;
    setLocalCheap(c);
    setLocalRefreshedAt(new Date().toISOString());
    if (localSection === "repos" || localSection === "worktrees") {
      const h = await props.localHeavyFn();
      if (aliveRef.current) setLocalHeavy(h);
    }
  }, [props.localCheapFn, props.localHeavyFn, localSection]);

  // Cheap poll @3s — only while LOCAL is visible. `alive` (per-effect) + aliveRef
  // (per-App) both gate the setState so neither a mode switch nor an unmount
  // clobbers state with a late result; the interval is cleared on either.
  useEffect(() => {
    if (uiMode !== "local") return;
    let alive = true;
    const run = async (): Promise<void> => {
      const c = await props.localCheapFn({ section: localSection });
      if (!alive || !aliveRef.current) return;
      setLocalCheap(c);
      setLocalRefreshedAt(new Date().toISOString());
    };
    void run();
    const id = setInterval(() => void run(), localCheapPollMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [uiMode, localSection, props.localCheapFn, localCheapPollMs]);

  // Heavy poll @15s — LOCAL + repos/worktrees only; AbortController lets the
  // enumerators drop their in-flight git fan-out when the section/mode changes.
  useEffect(() => {
    if (uiMode !== "local") return;
    if (localSection !== "repos" && localSection !== "worktrees") return;
    let alive = true;
    const ctrl = new AbortController();
    const run = async (): Promise<void> => {
      const h = await props.localHeavyFn(ctrl.signal);
      if (!alive || !aliveRef.current) return; // aliveRef drops late results on unmount
      setLocalHeavy(h);
    };
    void run();
    const id = setInterval(() => void run(), localHeavyPollMs);
    return () => {
      alive = false;
      ctrl.abort();
      clearInterval(id);
    };
  }, [uiMode, localSection, props.localHeavyFn, localHeavyPollMs]);

  // Fire-and-toast, mirroring `d`/`a`: no view switch, the selected repo's nwo
  // is captured at press time, and the result surfaces as a toast whenever it
  // lands (Toast renders at the Workspace level regardless of the current view).
  const runAssess = useCallback(
    (autoPlan: boolean, targetOverride?: string) => {
      const target = targetOverride ?? currentNwo;
      if (!target) {
        showToast("error", "no repo selected");
        return;
      }
      if (assessInFlightRef.current.has(target)) {
        showToast("info", "assess already running");
        return;
      }
      assessInFlightRef.current.add(target);
      showToast("info", `assessing ${target}…`);
      const args = autoPlan ? [target, "--auto-plan"] : [target];
      void runCliFn("assess", args).then((r) => {
        assessInFlightRef.current.delete(target);
        if (!aliveRef.current) return;
        const line = firstNonEmptyLine(r.output);
        if (r.code === 0) {
          showToast(
            "success",
            line ? `${target}: ${line} · v to review` : `assessed ${target} · v to review`,
          );
        } else {
          // Nonzero exit: assessCmd's first line carries the reason ("not
          // watched", "already queued", etc.) — relay it as-is.
          showToast("error", line ?? `assess failed for ${target}`);
        }
      });
    },
    [currentNwo, runCliFn, showToast],
  );

  const askConfirm = useCallback((state: ConfirmState) => setConfirm(state), []);

  // Fire-and-toast, mirroring runAssess: spawn the real CLI, dedupe by a key,
  // toast the first output line, then force an immediate cheap re-poll so the
  // mutated state (deleted ticket / drained outbox / gone worktree) shows at once.
  const runLocalAction = useCallback(
    (name: string, args: string[], opts: { key?: string; label?: string } = {}) => {
      const key = opts.key ?? [name, ...args].join(" ");
      if (localActionInFlightRef.current.has(key)) {
        showToast("info", `${opts.label ?? name} already running`);
        return;
      }
      localActionInFlightRef.current.add(key);
      showToast("info", `${opts.label ?? name}…`);
      void runCliFn(name, args).then((rr) => {
        localActionInFlightRef.current.delete(key);
        if (!aliveRef.current) return;
        const line = firstNonEmptyLine(rr.output);
        if (rr.code === 0) showToast("success", line ?? `${name} ok`);
        else showToast("error", line ?? `${name} failed`);
        // Immediate re-poll (cheap fn is cheap; section-gated counts refresh too).
        void props.localCheapFn({ section: localSection }).then((c) => {
          if (aliveRef.current) {
            setLocalCheap(c);
            setLocalRefreshedAt(new Date().toISOString());
          }
        });
      });
    },
    [runCliFn, showToast, props.localCheapFn, localSection],
  );

  // Elapsed ticker for a running palette command (1s resolution).
  useEffect(() => {
    if (!cmd?.running) return;
    setCmdElapsed(0);
    const id = setInterval(() => setCmdElapsed((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [cmd?.running, cmd?.token]);

  const cmdTokenRef = useRef(0);
  const runPaletteCommand = useCallback(
    (name: string, extraArgs: string[]) => {
      const title = ["junco", name, ...extraArgs].join(" ");
      const token = ++cmdTokenRef.current;
      setScroll(0);
      setCmd({
        title,
        running: true,
        output: "",
        exitCode: null,
        timedOut: false,
        name,
        extraArgs,
        token,
      });
      setView("cmdOutput");
      void runCliFn(name, extraArgs).then((r) => {
        setCmd((prev) =>
          prev && prev.token === token
            ? { ...prev, running: false, output: r.output, exitCode: r.code, timedOut: r.timedOut }
            : prev,
        );
      });
    },
    [runCliFn],
  );

  const paletteEnter = useCallback(() => {
    const visible = filterCommands(PALETTE_COMMANDS, paletteFilter);
    const current = visible[Math.min(paletteSel, Math.max(0, visible.length - 1))];
    if (!current) return;
    if (current.excluded !== null) {
      showToast("info", `${current.name}: ${current.excluded}`);
      return;
    }
    if (current.argsHint && !paletteArgsMode) {
      setPaletteArgsMode(true);
      return;
    }
    const typed = paletteArgs.split(/\s+/).filter(Boolean);
    const extraArgs = typed.length > 0 ? typed : current.defaultArgs;
    runPaletteCommand(current.name, extraArgs);
  }, [paletteFilter, paletteSel, paletteArgsMode, paletteArgs, runPaletteCommand, showToast]);

  // Takes an explicit nwo (github passes currentRepo.nwo; LOCAL passes its
  // cursor's LocalRepo.nwo). The config-vs-watchlist decision comes from the
  // matched repoMappings entry; an nwo absent from the union → not in watchlist.
  const unwatch = useCallback(
    (nwo: string) => {
      const mapping = repoMappings.find((r) => r.nwo.toLowerCase() === nwo.toLowerCase());
      if (!mapping) {
        showToast("info", "not in watchlist");
        return;
      }
      if (mapping.fromConfig) {
        showToast("info", `${mapping.nwo} is defined in config.json`);
        return;
      }
      if (watchlistError) {
        showToast("error", "watchlist unreadable — fix it before writing");
        return;
      }
      // Re-read at write time: never clobber a file that went corrupt since mount.
      const { entries: cur, error } = readWatchlist(watchlistFile);
      if (error) {
        setWatchlistError(error);
        showToast("error", "watchlist unreadable — not written");
        return;
      }
      const next = cur.filter((e) => e.nwo.toLowerCase() !== mapping.nwo.toLowerCase());
      writeWatchlist(watchlistFile, next);
      setWatchlistEntries(next);
      // Drop the repo's cached issue state too — the rail badges and the header
      // pulse must never read ghost data for a repo that is no longer watched.
      const gone = mapping.nwo;
      setIssues((prev) => {
        if (!(gone in prev)) return prev;
        const rest = { ...prev };
        delete rest[gone];
        return rest;
      });
      setStaleAt((prev) => {
        if (!(gone in prev)) return prev;
        const rest = { ...prev };
        delete rest[gone];
        return rest;
      });
      setPrStaleByRepo((prev) => {
        if (!(gone in prev)) return prev;
        const rest = { ...prev };
        delete rest[gone];
        return rest;
      });
      // ...and its PRs from the cross-repo aggregate — the ⚑ attention chip and
      // the PRs view must drop the repo immediately, not on the next poll.
      setPrs((prev) => prev.filter((p) => p.nwo !== gone));
      showToast("success", `unwatched ${mapping.nwo}`);
    },
    [repoMappings, watchlistFile, watchlistError, showToast],
  );

  const handleAddRepo = useCallback(
    async (rawNwo: string, path: string): Promise<void> => {
      let nwo = rawNwo;
      if (watchlistError) {
        showToast("error", "watchlist unreadable — fix it before writing");
        return;
      }
      // Accept bare owner/repo or a pasted github.com URL.
      const parsed = parseRepoInput(nwo);
      if (parsed === null) {
        setAddRepoError("enter owner/repo or a github.com URL (e.g. https://github.com/acme/api)");
        return;
      }
      nwo = parsed;
      // No push access → fork-PR mode: junco manages the fork + clone; the
      // bridge never polls this entry (external: true). A failed/unknown probe
      // (offline) falls through to the owned-repo flow unchanged.
      setAddRepoBusy("checking permissions…");
      const perm = await client.repoPermission(nwo);
      if (!aliveRef.current) return;
      if (perm.ok && !perm.value.canPush) {
        if (path.trim() !== "") {
          setAddRepoBusy(null);
          setAddRepoError("no push access to this repo — leave path empty (managed fork mode)");
          return;
        }
        setAddRepoBusy("forking & cloning…");
        const prep = await client.prepareExternalRepo(nwo);
        if (!aliveRef.current) return;
        setAddRepoBusy(null);
        if (!prep.ok) {
          setAddRepoError(prep.error);
          return;
        }
        const { entries: cur, error } = readWatchlist(watchlistFile);
        if (error) {
          setWatchlistError(error);
          setView("main");
          showToast("error", "watchlist unreadable — not written");
          return;
        }
        const next = [...cur, { nwo, path: prep.value.path, external: true }];
        writeWatchlist(watchlistFile, next);
        setWatchlistEntries(next);
        setView("main");
        showToast("success", `watching ${nwo} (fork-PR mode via ${prep.value.forkNwo})`);
        return;
      }
      // Empty path = clone into the managed directory for the operator.
      let expanded: string;
      setAddRepoError(null);
      if (path.trim() === "") {
        const [owner, repo] = nwo.split("/");
        expanded = join(clonesDir, owner ?? nwo, repo ?? "repo");
        setAddRepoBusy("cloning repository…");
        const cloned = await client.cloneRepo(nwo, expanded);
        if (!aliveRef.current) return;
        if (!cloned.ok) {
          setAddRepoBusy(null);
          setAddRepoError(cloned.error);
          return;
        }
      } else {
        expanded = expandHome(path); // ONE expansion point: validate + store agree
      }
      setAddRepoBusy("validating…");
      const res = await client.validateAndPrepareRepo(nwo, expanded);
      if (!aliveRef.current) return;
      setAddRepoBusy(null);
      if (!res.ok) {
        setAddRepoError(res.error);
        return;
      }
      const { entries: cur, error } = readWatchlist(watchlistFile);
      if (error) {
        setWatchlistError(error);
        setView("main");
        showToast("error", "watchlist unreadable — not written");
        return;
      }
      const next = [...cur, { nwo, path: expanded }];
      writeWatchlist(watchlistFile, next);
      setWatchlistEntries(next);
      setView("main");
      showToast("success", `watching ${nwo}`);
    },
    [client, watchlistFile, watchlistError, clonesDir, showToast],
  );

  // A wide terminal that shrinks below 110 cols while pane 3 (the repo-scoped
  // PR monitor) is focused would otherwise leave focus on a pane that no
  // longer renders — pull it back onto the issues pane instead of stranding it.
  useEffect(() => {
    if (layout.mode !== "wide" && pane === 3) setPane(2);
  }, [layout.mode, pane]);

  // Move the anchored NUMBER, not a bare index — a re-sorting poll must keep
  // the cursor on the same issue. Hoisted (was inline in useInput) so both
  // keyboard and mouse (wheel/click) drive the same selection logic.
  const moveIssue = (delta: number): void => {
    if (!currentNwo || filteredIssues.length === 0) return;
    const next = Math.max(0, Math.min(issueIdxSafe + delta, filteredIssues.length - 1));
    setSelectedNum((m) => ({ ...m, [currentNwo]: filteredIssues[next].number }));
  };
  const moveIssueTo = (idx: number): void => {
    if (!currentNwo || filteredIssues.length === 0) return;
    const clamped = Math.max(0, Math.min(idx, filteredIssues.length - 1));
    setSelectedNum((m) => ({ ...m, [currentNwo]: filteredIssues[clamped].number }));
  };

  // Move the anchored {nwo, number}, never a bare index — a re-sorting poll
  // must keep the cursor on the same PR. Hoisted for the same reason as above.
  const movePr = (delta: number): void => {
    if (prs.length === 0) return;
    const next = Math.max(0, Math.min(prIdxSafe + delta, prs.length - 1));
    setPrSel({ nwo: prs[next].nwo, number: prs[next].number });
  };
  const movePrTo = (idx: number): void => {
    if (prs.length === 0) return;
    const clamped = Math.max(0, Math.min(idx, prs.length - 1));
    setPrSel({ nwo: prs[clamped].nwo, number: prs[clamped].number });
  };

  const openSelectedPr = useCallback(() => {
    if (!selectedPr) return;
    const { nwo, number } = selectedPr;
    void client.openPrInBrowser(nwo, number).then((res) => {
      if (!aliveRef.current) return;
      if (!res.ok) showToast("error", res.error);
    });
  }, [client, selectedPr, showToast]);

  // Fullscreen PR overlay opener — shared by keyboard enter (pane 3, prs view)
  // and the mouse's click-on-selected-row path; `from` is where esc/q returns.
  const openPrDetail = (pr: DashPr | null, from: "main" | "prs"): void => {
    if (!pr) return;
    setPrDetail({ pr, from });
    setView("prDetail");
  };

  // Pane-3 movers, hoisted (like moveIssue/movePr) so the mouse handler and
  // the keyboard branch share one anchored-NUMBER implementation.
  const movePane3 = (delta: number): void => {
    if (repoPrs.length === 0) return;
    const next = Math.max(0, Math.min(pane3IdxSafe + delta, repoPrs.length - 1));
    setPane3SelNum(repoPrs[next].number);
  };
  const movePane3To = (idx: number): void => {
    if (repoPrs.length === 0) return;
    const clamped = Math.max(0, Math.min(idx, repoPrs.length - 1));
    setPane3SelNum(repoPrs[clamped].number);
  };

  // Dismiss an active toast on the next input (keyboard keystroke or mouse
  // press) — shared so both useInput and onMouseEvent apply the same rule.
  const dismissToast = (): void => {
    if (!toast) return;
    setToast(null);
    if (toastTimer.current) {
      clearTimeout(toastTimer.current);
      toastTimer.current = null;
    }
  };

  // The mode toggle is inert while a text field (filter / add-repo / palette)
  // or the confirm modal owns input — so `m` can never eat a typed character.
  const canToggleMode = (): boolean =>
    !filtering && view !== "addRepo" && view !== "config" && view !== "palette" && confirm === null;
  // Shift+Tab requires key.shift so a bare Tab still reaches github pane-cycle.
  const isModeToggle = (input: string, key: { tab?: boolean; shift?: boolean }): boolean =>
    input === "m" || (key.tab === true && key.shift === true);

  const handleLocalInput = (
    input: string,
    key: Parameters<Parameters<typeof useInput>[0]>[1],
  ): void => {
    // The help modal owns the screen while open — any key closes it, mirroring
    // the github cascade's "any key closes help" rule (view === "help" there).
    // Without this branch keys fell through to rail/body handling underneath
    // the modal, leaving local help unclosable except by swapping to github.
    if (view === "help") {
      setView("main");
      return;
    }
    // The confirm modal owns input while open (LOCAL-only gate).
    if (confirm) {
      if (key.escape || input === "n") {
        setConfirm(null);
        return;
      }
      if (key.return || input === "y") {
        const fn = confirm.onConfirm;
        setConfirm(null);
        fn();
        return;
      }
      return;
    }
    if (localFocus === "body") {
      if (key.escape || input === "h" || key.leftArrow) {
        setLocalFocus("rail");
        return;
      }
      if (localSection === "daemon") {
        if (input === "[" || key.upArrow) return void setLocalScroll((s) => Math.max(0, s - 1));
        if (input === "]" || key.downArrow) return void setLocalScroll((s) => s + 1);
        if (input === "X") {
          const n = localCheap?.daemon.currentTickets.length ?? 0;
          return void askConfirm({
            title: "restart daemon",
            danger: true,
            body: `Restart will interrupt ${n} in-flight ticket(s) (soft-abort, committed work salvaged). Continue?`,
            onConfirm: () => runLocalAction("restart", [], { label: "restart" }),
          });
        }
        if (input === "f") return void runLocalAction("outbox", ["flush"], { label: "flush" });
        return;
      }
      if (input === "j" || key.downArrow) return void moveLocalCursor(1);
      if (input === "k" || key.upArrow) return void moveLocalCursor(-1);
      if (input === "g") return void setLocalCursor((m) => ({ ...m, [localSection]: 0 }));
      if (input === "G")
        return void setLocalCursor((m) => ({
          ...m,
          [localSection]: Math.max(0, localRows.length - 1),
        }));
      const t = localTarget;
      if (localSection === "queue") {
        if (input === "R") {
          // R acts on exactly the highlighted row (localRows is index-aligned
          // with QueueView's cursor). Only a FAILED recent row is requeuable;
          // a done row is highlightable but guarded into a safe toast — never a
          // retry of a different, non-highlighted target.
          if (t?.kind === "recent" && t.status === "failed")
            return void runLocalAction("retry", [t.id], { label: "requeue" });
          if (t?.kind === "recent" && t.status === "done")
            return void showToast("info", "done tickets can't be requeued");
          return;
        }
        if (input === "x" && t?.kind === "waiting")
          return void askConfirm({
            title: "delete queued ticket",
            danger: true,
            body: `Delete inbox/${t.id}.md? (best-effort; the daemon may have claimed it)`,
            onConfirm: () => runLocalAction("rm", [t.id]),
          });
      }
      if (localSection === "outbox" && input === "f")
        return void runLocalAction("outbox", ["flush"], { label: "flush" });
      if (localSection === "repos" && t?.kind === "repo") {
        if (input === "o") return void openRepoBrowser(t.repo.nwo ?? "");
        if (input === "x")
          return void (t.repo.nwo ? unwatch(t.repo.nwo) : showToast("info", "not in watchlist"));
      }
      if (localSection === "worktrees" && input === "x" && t?.kind === "worktree") {
        // x acts on exactly the highlighted worktree (localRows is index-aligned
        // with WorktreesSection's cursor). A live worktree is highlightable but
        // guarded — the daemon may own it — so x on it is a safe toast, never a
        // prune of a different, non-highlighted row.
        if (t.klass === "live") return void showToast("info", "live worktree — not prunable");
        return void askConfirm({
          title: "prune worktree",
          danger: true,
          body: `Prune ${t.slug} (${t.klass})? git worktree remove --force under the daemon lock.`,
          onConfirm: () => runLocalAction("worktree", ["prune", t.path], { label: "prune" }),
        });
      }
      return;
    }
    // rail focus
    if (input === "q") {
      exit();
      onExit();
      return;
    }
    if (input === "?") return void setView("help");
    if (input === "r") {
      void forceLocalRefresh();
      return;
    }
    if (input === "j" || key.downArrow) return void moveLocalSection(1);
    if (input === "k" || key.upArrow) return void moveLocalSection(-1);
    if (input === "g") {
      setLocalSection("queue");
      setLocalScroll(0);
      return;
    }
    if (input === "G") {
      setLocalSection("daemon");
      setLocalScroll(0);
      return;
    }
    if (input === "l" || key.rightArrow || key.return) return void setLocalFocus("body");
  };

  useInput((input, key) => {
    // Mouse reporting leaks SGR sequences into useInput as keypresses (ink
    // strips the ESC) — drop them; onMouseEvent owns the real events via stdin.
    if (isMouseInput(input)) return; // layer 1

    // The AddRepoForm (+ its TextFields) own all input while open.
    if (view === "addRepo") return; // layer 2 (text field owns input)

    // ConfigView owns all input while open (own useInput + onExit, mirroring
    // addRepo above) — kept ahead of the mode toggle and LOCAL dispatch so
    // neither `m` nor a LOCAL-mode key ever leaks past it mid-edit.
    if (view === "config") return; // layer 2b

    // layer 3 — the global mode toggle (`m` / Shift+Tab), hoisted above the
    // github cascade so `m` never eats a typed char (canToggleMode is false
    // while filtering / addRepo / palette / a confirm modal is open).
    if (canToggleMode() && isModeToggle(input, key)) {
      const target: UiMode = uiMode === "github" ? "local" : "github";
      if (target === "github" && !props.githubEnabled) {
        dismissToast();
        showToast("info", "github mode is off ([github] enabled=false)");
        return;
      }
      setUiMode(target);
      dismissToast();
      return;
    }

    // layer 3b — `,` opens the in-dashboard config editor. Mode-agnostic (it
    // is hoisted ahead of the LOCAL dispatch below) so a github-disabled user
    // — who starts in local mode and can never reach the github cascade that
    // used to own this binding — isn't left with no way to open settings.
    // Gated the same way the mode toggle above is: not while typing a filter,
    // not while the LOCAL confirm modal owns input, and only from the main
    // view (never stealing the key from help/detail/queue/prs/palette/etc.,
    // which in LOCAL mode is moot since local never routes view away from
    // "main"/"help").
    if (input === "," && view === "main" && !filtering && confirm === null) {
      dismissToast();
      setView("config");
      return;
    }

    // layer 4 — LOCAL surface owns everything else while it is the active mode.
    if (uiMode === "local") {
      dismissToast();
      handleLocalInput(input, key);
      return;
    }

    // layer 5 ── the existing github cascade, verbatim ──
    // Toast is dismissed by the next keystroke, before it is acted on.
    dismissToast();

    if (view === "help") {
      setView("main"); // any key closes
      return;
    }

    if (view === "detail") {
      if (key.escape) {
        setScroll(0); // shared offset — don't bleed it into the next view that reads it
        return void setView("main");
      }
      if (input === "o") return void openDetailIssueInBrowser();
      if (input === "]" || key.downArrow) return void setScroll((s) => s + 1);
      if (input === "[" || key.upArrow) return void setScroll((s) => Math.max(0, s - 1));
      return;
    }

    if (view === "prDetail") {
      // esc AND q both return — unlike the issue detail view, the overlay has
      // no dedicated re-open key to double as its close key, so q (otherwise
      // the global quit key, unreachable from any sub-view) fills that slot.
      if (key.escape || input === "q") {
        // `from`'s pane/selection state was never touched while the overlay
        // was open, so returning here restores it for free.
        return void setView(prDetail?.from ?? "main");
      }
      if (input === "o") return void openPrDetailInBrowser();
      return;
    }

    if (view === "queue") {
      if (key.escape || input === "t") {
        setScroll(0); // shared offset — don't bleed it into the next view that reads it
        return void setView("main");
      }
      if (input === "]" || key.downArrow) return void setScroll((s) => s + 1);
      if (input === "[" || key.upArrow) return void setScroll((s) => Math.max(0, s - 1));
      return;
    }

    if (view === "prs") {
      if (key.escape || input === "p") {
        setScroll(0); // shared offset — don't bleed it into the next view that reads it
        return void setView("main");
      }
      if (input === "j" || key.downArrow) return void movePr(1);
      if (input === "k" || key.upArrow) return void movePr(-1);
      if (input === "g") return void movePrTo(0);
      if (input === "G") return void movePrTo(prs.length - 1);
      if (input === "o") return void openSelectedPr();
      if (key.return) return void openPrDetail(selectedPr, "prs");
      if (input === "r") return void refreshAll();
      return;
    }

    if (view === "palette") {
      // Chars/backspace go to the palette's TextFields; the App routes only
      // navigation keys here, so typing 'j' filters instead of moving.
      if (key.escape) {
        if (paletteArgsMode) {
          setPaletteArgsMode(false);
          setPaletteArgs("");
        } else {
          setView("main");
        }
        return;
      }
      if (key.downArrow) {
        const max = Math.max(0, filterCommands(PALETTE_COMMANDS, paletteFilter).length - 1);
        return void setPaletteSel((s) => Math.min(s + 1, max));
      }
      if (key.upArrow) return void setPaletteSel((s) => Math.max(0, s - 1));
      if (key.return) return void paletteEnter();
      return;
    }

    if (view === "cmdOutput") {
      if (key.escape) {
        setScroll(0); // the palette → main path must not carry this offset either
        return void setView("palette");
      }
      if (input === "]" || key.downArrow) return void setScroll((s) => s + 1);
      if (input === "[" || key.upArrow) return void setScroll((s) => Math.max(0, s - 1));
      if (input === "r" && cmd && !cmd.running) {
        return void runPaletteCommand(cmd.name, cmd.extraArgs);
      }
      return;
    }

    if (view === "review") {
      const rs = reviewState;
      // Comment-draft preview mode: scroll, post (f/enter), discard (x), back.
      if (rs.open && rs.open.kind === "draft") {
        const draft = rs.drafts[rs.open.draftIdx];
        if (key.escape) return void setReviewState((s) => ({ ...s, open: null }));
        if (input === "k" || key.upArrow) {
          return void setReviewState((s) =>
            s.open && s.open.kind === "draft"
              ? { ...s, open: { ...s.open, scroll: Math.max(0, s.open.scroll - 1) } }
              : s,
          );
        }
        if (input === "j" || key.downArrow) {
          return void setReviewState((s) => {
            if (!s.open || s.open.kind !== "draft") return s;
            const d = s.drafts[s.open.draftIdx];
            const max = d ? Math.max(0, d.draft.split("\n").length - 1) : 0;
            return { ...s, open: { ...s.open, scroll: Math.min(max, s.open.scroll + 1) } };
          });
        }
        // Optimistic removal shared by post and discard: drop the draft, close
        // the preview, clamp the cursor to the (shrunk) combined list.
        const dropDraft = (id: string): void => {
          setReviewState((s) => {
            const drafts = s.drafts.filter((d) => d.id !== id);
            const total = s.batches.length + drafts.length;
            return { ...s, drafts, open: null, cursor: Math.min(s.cursor, Math.max(0, total - 1)) };
          });
        };
        if (input === "f" || key.return) {
          if (!draft) return;
          const id = draft.id;
          showToast("info", `posting ${draft.nwo}#${draft.issue}…`);
          void client.postCommentDraft(id).then((res) => {
            if (!aliveRef.current) return;
            if (res.ok) {
              const { outcome, url } = res.value;
              showToast(
                "success",
                outcome === "queued"
                  ? "queued offline — will post on next flush"
                  : url
                    ? `posted ${url}`
                    : "posted",
              );
              dropDraft(id);
            } else {
              showToast("error", res.error);
            }
          });
          return;
        }
        if (input === "x") {
          if (!draft) return;
          const id = draft.id;
          void client.discardCommentDraft(id).then((res) => {
            if (!aliveRef.current) return;
            if (res.ok) {
              showToast("success", "discarded");
              dropDraft(id);
            } else {
              showToast("error", res.error);
            }
          });
          return;
        }
        return;
      }
      // Assess checklist mode.
      if (rs.open && rs.open.kind === "batch") {
        const open = rs.open; // stable narrowed binding — survives closures below
        const batch = rs.batches[open.batchIdx];
        if (key.escape) return void setReviewState((s) => ({ ...s, open: null }));
        if (input === "k" || key.upArrow) {
          return void setReviewState((s) =>
            s.open && s.open.kind === "batch"
              ? { ...s, open: { ...s.open, findingCursor: Math.max(0, s.open.findingCursor - 1) } }
              : s,
          );
        }
        if (input === "j" || key.downArrow) {
          return void setReviewState((s) =>
            s.open && s.open.kind === "batch" && batch
              ? {
                  ...s,
                  open: {
                    ...s.open,
                    findingCursor: Math.min(batch.findings.length - 1, s.open.findingCursor + 1),
                  },
                }
              : s,
          );
        }
        if (input === " ") {
          return void setReviewState((s) => {
            if (!s.open || s.open.kind !== "batch" || !batch) return s;
            const checked = new Set(s.open.checked);
            const fp = batch.findings[s.open.findingCursor]?.fingerprint;
            if (fp) {
              if (checked.has(fp)) checked.delete(fp);
              else checked.add(fp);
            }
            return { ...s, open: { ...s.open, checked } };
          });
        }
        if (input === "a") {
          return void setReviewState((s) =>
            s.open && s.open.kind === "batch" && batch
              ? {
                  ...s,
                  open: { ...s.open, checked: new Set(batch.findings.map((f) => f.fingerprint)) },
                }
              : s,
          );
        }
        if (input === "n") {
          return void setReviewState((s) =>
            s.open && s.open.kind === "batch"
              ? { ...s, open: { ...s.open, checked: new Set() } }
              : s,
          );
        }
        if (input === "f" || key.return) {
          if (!batch) return;
          const fps = batch.findings.map((f) => f.fingerprint).filter((fp) => open.checked.has(fp));
          if (fps.length === 0) return void showToast("info", "nothing selected");
          const id = batch.id;
          showToast("info", `filing ${fps.length} on ${batch.nwo}…`);
          void client.fileReview(id, fps).then((res) => {
            if (!aliveRef.current) return;
            if (res.ok) {
              const v = res.value;
              showToast(
                "success",
                `filed ${v.created} · queued ${v.queuedOffline} · dup ${v.deduped} · failed ${v.failed}`,
              );
              setReviewState((s) => {
                const batches = s.batches.filter((b) => b.id !== id); // optimistic removal
                const total = batches.length + s.drafts.length;
                return {
                  ...s,
                  batches,
                  open: null,
                  cursor: Math.min(s.cursor, Math.max(0, total - 1)),
                };
              });
            } else {
              showToast("error", res.error);
            }
          });
          return;
        }
        return;
      }
      // Combined-list mode: cursor over batches then drafts; enter opens either.
      if (key.escape || input === "v") return void setView("main");
      if (input === "k" || key.upArrow)
        return void setReviewState((s) => ({ ...s, cursor: Math.max(0, s.cursor - 1) }));
      if (input === "j" || key.downArrow) {
        return void setReviewState((s) => ({
          ...s,
          cursor: Math.min(Math.max(0, s.batches.length + s.drafts.length - 1), s.cursor + 1),
        }));
      }
      if (key.return) {
        return void setReviewState((s) => {
          if (s.cursor < s.batches.length) {
            const batch = s.batches[s.cursor];
            if (!batch) return s;
            return {
              ...s,
              open: {
                kind: "batch",
                batchIdx: s.cursor,
                findingCursor: 0,
                checked: new Set(batch.findings.map((f) => f.fingerprint)),
              },
            };
          }
          const draftIdx = s.cursor - s.batches.length;
          if (!s.drafts[draftIdx]) return s;
          return { ...s, open: { kind: "draft", draftIdx, scroll: 0 } };
        });
      }
      return;
    }

    // ── main view ──

    // `/` filter typing mode captures all printable input.
    if (filtering) {
      if (key.escape) {
        setFiltering(false);
        setFilter("");
        return;
      }
      if (key.return) {
        setFiltering(false);
        return;
      }
      if (key.backspace || key.delete) {
        setFilter((f) => f.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setFilter((f) => f + input);
        return;
      }
      return;
    }

    if (input === "q") {
      exit();
      onExit();
      return;
    }
    if (input === "?") return void setView("help");
    if (input === "t") {
      setScroll(0);
      setView("queue");
      return;
    }
    // `,` (open config) is handled mode-agnostically by layer 3b above, ahead
    // of this cascade — the settings idiom, free per
    // `grep -n 'input === ' src/tui/App.tsx`.
    if (input === "p") {
      setScroll(0);
      setView("prs");
      // Entering the monitor: immediate full sweep (scope override — viewRef
      // still reads "main" until this render commits).
      void refreshAll({ scope: "monitor" });
      return;
    }
    if (input === ":") {
      setPaletteFilter("");
      setPaletteSel(0);
      setPaletteArgsMode(false);
      setPaletteArgs("");
      setView("palette");
      return;
    }

    // Filter / pane routing.
    if (input === "/") {
      setFiltering(true);
      setPane(2);
      return;
    }
    if (input === "1") return void setPane(1);
    if (input === "2") return void setPane(2);
    if (input === "3") {
      if (layout.mode === "wide") setPane(3);
      return;
    }
    const maxPane: Pane = layout.mode === "wide" ? 3 : 2;
    if (key.tab) {
      return void setPane((p) => (p >= maxPane ? 1 : ((p + 1) as Pane)));
    }
    if (input === "h" || key.leftArrow) return void setPane((p) => (p > 1 ? ((p - 1) as Pane) : p));
    if (input === "l" || key.rightArrow) {
      return void setPane((p) => (p < maxPane ? ((p + 1) as Pane) : p));
    }
    if (input === "i") return void setPane(2);

    // `w` is the watchlist key (opens add-repo).
    if (input === "w") {
      if (watchlistError) {
        showToast("error", "watchlist unreadable — fix it before adding");
        return;
      }
      setAddRepoError(null);
      setView("addRepo");
      return;
    }
    if (input === "r") {
      setRefreshing(true);
      void refreshAll().finally(() => setRefreshing(false));
      return;
    }
    // `s`/`S` assess the rail-selected repo — global to the main view (the
    // selection is global state), unlike `d`/`D`/`a` below which are scoped
    // to the issues pane because they act on the selected ISSUE. Exception:
    // with the issues pane (2) focused AND an issue selected, `s`/`S` scope
    // the assess to that issue (owner/repo#N — the CLI accepts issue-refs).
    // This is a single global binding structurally ahead of the pane-scoped
    // blocks below, so the pane-2 variant is gated here rather than added as
    // a second binding further down.
    if (input === "s" || input === "S") {
      const autoPlan = input === "S";
      if (pane === 2 && currentNwo && currentIssue) {
        return void runAssess(autoPlan, `${currentNwo}#${currentIssue.number}`);
      }
      return void runAssess(autoPlan);
    }
    // `v` opens the review queue — parked assess batches (findings awaiting
    // human confirmation) AND parked comment drafts (analyze output awaiting a
    // post/discard decision), fetched together.
    if (input === "v") {
      setReviewState((s) => ({ ...s, loading: true, error: null, open: null, cursor: 0 }));
      setView("review");
      void Promise.all([client.listReview(), client.listCommentDrafts()]).then(([rev, drafts]) => {
        if (!aliveRef.current) return;
        if (rev.ok && drafts.ok) {
          setReviewState((s) => ({
            ...s,
            loading: false,
            error: null,
            batches: rev.value,
            drafts: drafts.value,
            cursor: 0,
          }));
        } else {
          const error = !rev.ok ? rev.error : !drafts.ok ? drafts.error : "unknown error";
          setReviewState((s) => ({ ...s, loading: false, error }));
        }
      });
      return;
    }

    if (pane === 1) {
      if (input === "j" || key.downArrow) {
        return void setRepoIdx((i) => Math.min(i + 1, repoMappings.length - 1));
      }
      if (input === "k" || key.upArrow) return void setRepoIdx((i) => Math.max(0, i - 1));
      if (input === "g") return void setRepoIdx(0);
      if (input === "G") return void setRepoIdx(repoMappings.length - 1);
      if (input === "x") return void (currentRepo ? unwatch(currentRepo.nwo) : undefined);
      if (input === "o") return void (currentRepo ? openRepoBrowser(currentRepo.nwo) : undefined);
      return;
    }

    if (pane === 3) {
      if (key.escape) return void setPane(2);
      // Move the anchored PR NUMBER, never a bare index — mirrors the prs-view
      // anchor so a re-sorting poll keeps the cursor on the same PR.
      if (input === "j" || key.downArrow) return void movePane3(1);
      if (input === "k" || key.upArrow) return void movePane3(-1);
      if (input === "g") return void movePane3To(0);
      if (input === "G") return void movePane3To(repoPrs.length - 1);
      if (input === "o") {
        if (selectedPane3Pr) {
          const { nwo, number } = selectedPane3Pr;
          void client.openPrInBrowser(nwo, number).then((res) => {
            if (!aliveRef.current) return;
            if (!res.ok) showToast("error", res.error);
          });
        }
        return;
      }
      if (key.return) return void openPrDetail(selectedPane3Pr, "main");
      return;
    }

    // ── issues pane (2) — move the anchored NUMBER, not a bare index. ──
    if (key.escape) {
      if (filter !== "") setFilter("");
      return;
    }
    if (input === "j" || key.downArrow) return void moveIssue(1);
    if (input === "k" || key.upArrow) return void moveIssue(-1);
    if (input === "g") return void moveIssueTo(0);
    if (input === "G") return void moveIssueTo(filteredIssues.length - 1);
    if (key.return) return void openDetail();
    // External (fork-PR) repos have no upstream label lifecycle: `d` queues a
    // ticket via the dispatch core; the label-driven keys explain instead of
    // acting. Owned repos keep the existing optimistic label flow untouched.
    const currentExternal = currentRepo?.external === true;
    if (input === "d") {
      if (!currentExternal) return void runAction("dispatch");
      if (!currentNwo || !currentIssue) return;
      const num = currentIssue.number;
      showToast("info", `dispatching ${currentNwo}#${num}…`);
      void client.dispatchTicket(currentNwo, num).then((res) => {
        if (!aliveRef.current) return;
        if (res.ok) showToast("success", `ticket queued: ${res.value.id}`);
        else showToast("error", res.error);
      });
      return;
    }
    if (input === "D" || input === "a" || input === "R") {
      if (currentExternal) {
        return void showToast(
          "error",
          "not available for external repos — d dispatches a fork-PR ticket",
        );
      }
      if (input === "D") return void runAction("dispatchAsk");
      if (input === "a") return void runAction("approve");
      const st = currentIssue ? deriveState(currentIssue.labels, trigger) : "raw";
      return void runAction(st === "plan-ready" || st === "approved" ? "replan" : "recycle");
    }
    // Analysis drafting works on BOTH owned and external repos — unlike
    // D/a/R above, it never gates on currentExternal.
    if (input === "c") {
      if (!currentNwo || !currentIssue) return;
      const num = currentIssue.number;
      showToast("info", `drafting analysis for ${currentNwo}#${num}…`);
      void client.analyzeIssue(currentNwo, num).then((res) => {
        if (!aliveRef.current) return;
        if (res.ok)
          showToast("success", `analysis queued: ${res.value.id} · v to review when parked`);
        else showToast("error", res.error);
      });
      return;
    }
    if (input === "o") return void openBrowser();
  });

  const onMouseEvent = (ev: TuiMouseEvent): void => {
    // Resolve the clickable header tab band FIRST — before any per-view guard —
    // so a mode switch works from every view. headerTabBands takes the TERMINAL
    // columns (the same value computeLayout gave Header its `mode`), so the
    // bands line up with the rendered tab regardless of layout mode.
    if (ev.y === 0 && ev.kind === "press") {
      const m = headerTabBands(size.columns).hit(ev.x);
      if (m && m !== uiMode) {
        if (m === "github" && !props.githubEnabled) {
          dismissToast();
          showToast("info", "github mode is off ([github] enabled=false)");
          return;
        }
        dismissToast();
        setUiMode(m);
        return;
      }
    }
    if (confirm) return; // the confirm modal owns the screen
    if (uiMode === "local") return; // the LOCAL body is keyboard-first in v1

    // Modal-ish views own the screen; the mouse is keyboard-only territory (v1).
    if (
      view === "help" ||
      view === "palette" ||
      view === "addRepo" ||
      view === "review" ||
      view === "config"
    )
      return;
    if (ev.kind === "release") return; // presses act on press, not release
    if (ev.kind === "press") dismissToast();

    // Full-body scroll views with no click targets: wheel scrolls only.
    if (view === "queue" || view === "cmdOutput") {
      if (ev.kind === "wheelDown") setScroll((s) => s + 1);
      if (ev.kind === "wheelUp") setScroll((s) => Math.max(0, s - 1));
      return;
    }

    // The two detail views: wheel scrolls the issue detail (the PR overlay has
    // nothing to scroll); a press on the ↗ metadata line opens the browser.
    if (view === "detail" || view === "prDetail") {
      if (view === "detail") {
        if (ev.kind === "wheelDown") setScroll((s) => s + 1);
        if (ev.kind === "wheelUp") setScroll((s) => Math.max(0, s - 1));
      }
      if (ev.kind === "press") {
        const hit = hitTest(
          {
            layout,
            columns: size.columns,
            view,
            repoCount: repoMappings.length,
            listCount: 0,
            railStart: 0,
            listStart: 0,
            pane3Count: 0,
            pane3Start: 0,
            hasPreviewTarget: false,
          },
          ev.x,
          ev.y,
        );
        if (hit.type === "linkLine") {
          if (view === "detail") openDetailIssueInBrowser();
          else openPrDetailInBrowser();
        }
      }
      return;
    }

    const ctx: HitContext = {
      layout,
      columns: size.columns,
      view: view === "prs" ? "prs" : "main",
      repoCount: repoMappings.length,
      listCount: view === "prs" ? prs.length : filteredIssues.length,
      railStart: railWindow.start,
      listStart: view === "prs" ? prWindow.start : issueWindow.start,
      pane3Count: repoPrs.length,
      pane3Start: pane3Window.start,
      hasPreviewTarget: layout.mode === "wide" && view === "prs" && selectedPr !== null,
    };
    const hit = hitTest(ctx, ev.x, ev.y);

    if (ev.kind === "wheelUp" || ev.kind === "wheelDown") {
      const d = ev.kind === "wheelDown" ? 1 : -1;
      if (hit.type === "repoRow" || (hit.type === "pane" && hit.pane === 1)) {
        setRepoIdx((i) => Math.max(0, Math.min(i + d, repoMappings.length - 1)));
      } else if (hit.type === "issueRow" || (hit.type === "pane" && hit.pane === 2)) {
        moveIssue(d);
      } else if (hit.type === "prRow") {
        movePr(d);
      } else if (hit.type === "pane3Row" || (hit.type === "pane" && hit.pane === 3)) {
        movePane3(d); // pane 3 is the repo-scoped PR monitor — wheel moves its selection
      }
      return;
    }

    // ev.kind === "press"
    switch (hit.type) {
      case "repoRow":
        setPane(1);
        setRepoIdx(hit.index);
        return;
      case "issueRow":
        if (pane === 2 && hit.index === issueIdxSafe) return void openDetail();
        setPane(2);
        moveIssueTo(hit.index);
        return;
      case "prRow":
        // Click-again = enter, matching the keyboard: the fullscreen PR overlay.
        if (hit.index === prIdxSafe) return void openPrDetail(selectedPr, "prs");
        movePrTo(hit.index);
        return;
      case "pane3Row":
        if (pane === 3 && hit.index === pane3IdxSafe) {
          return void openPrDetail(selectedPane3Pr, "main");
        }
        setPane(3);
        movePane3To(hit.index);
        return;
      case "linkLine":
        // Only the prs view renders a preview card (PrPreview) with a ↗ line.
        return void openSelectedPr();
      case "pane":
        setPane(hit.pane);
        return;
      case "none":
        return;
    }
  };
  useMouse(onMouseEvent);

  const hints =
    view === "config"
      ? // Mode-agnostic, like the view === "config" render branch above: the
        // config editor's own hints apply regardless of which surface opened
        // it, not LOCAL's section-rail hints.
        hintsFor("config", pane, layout.mode, filtering)
      : uiMode === "local"
        ? localHintsFor(localSection, localFocus)
        : hintsFor(view as HintView, pane, layout.mode, filtering);
  const listHeight = layout.bodyRows;
  const paletteProps = {
    commands: PALETTE_COMMANDS,
    filter: paletteFilter,
    selected: paletteSel,
    argsMode: paletteArgsMode,
    argsValue: paletteArgs,
    onFilter: (v: string) => {
      setPaletteFilter(v);
      setPaletteSel(0);
    },
    onArgs: setPaletteArgs,
    onCancel: () => setView("main"),
  };
  const addRepoProps = {
    error: addRepoError,
    busyText: addRepoBusy,
    onSubmit: (nwo: string, path: string) => void handleAddRepo(nwo, path),
    onCancel: () => setView("main"),
  };
  // The LOCAL confirm modal outranks the github modals when open.
  const modal = confirm ? (
    <Modal title={confirm.title} minWidth={54}>
      <Box flexDirection="column" gap={1}>
        <Text color={confirm.danger ? theme.error : undefined}>{confirm.body}</Text>
        <Text dimColor>y/enter confirm · n/esc cancel</Text>
      </Box>
    </Modal>
  ) : view === "help" ? (
    <HelpModal
      view="main"
      pane={pane}
      mode={layout.mode}
      trigger={trigger}
      uiMode={uiMode}
      localSection={localSection}
    />
  ) : view === "palette" ? (
    <Modal title="run a junco command" minWidth={64}>
      <CommandPalette {...paletteProps} />
    </Modal>
  ) : view === "addRepo" ? (
    <Modal title="add repo to watchlist" minWidth={54}>
      <AddRepoForm {...addRepoProps} />
    </Modal>
  ) : null;

  return (
    <Workspace
      size={size}
      layout={layout}
      header={
        <Header
          repoNwo={currentNwo ?? null}
          health={health}
          reviewCount={reviewCount}
          now={queueNow}
          mode={layout.mode}
          queueRunning={queueSnap?.running.length ?? 0}
          queueWaiting={queueSnap?.waiting.length ?? 0}
          watchlistError={watchlistError}
          outboxDepth={queueSnap?.outboxDepth ?? 0}
          prAttention={prAttention}
          prFailing={prFailing}
          refreshedAt={refreshedAt}
          uiMode={uiMode}
          githubEnabled={props.githubEnabled}
        />
      }
      toast={toast}
      hints={hints}
      modal={modal}
      modalAlign={view === "help" ? "top" : "center"}
    >
      {view === "config" ? (
        // Mode-agnostic: `,` (layer 3b) can set view="config" from either
        // surface, so this must be checked ahead of the uiMode branch below
        // or a LOCAL-mode config view would render LocalDashboard instead.
        <ConfigView configPath={configPath} onExit={() => setView("main")} />
      ) : uiMode === "local" ? (
        <LocalDashboard
          cheap={localCheap}
          heavy={localHeavy}
          section={localSection}
          focus={localFocus}
          cursor={localCursorSafe}
          scroll={localScroll}
          layout={layout}
          now={queueNow}
          refreshedAt={localRefreshedAt}
        />
      ) : view === "review" ? (
        <ReviewView state={reviewState} height={listHeight} focused />
      ) : (
        <>
          <Rail
            repos={repoRows}
            selected={repoIdxSafe}
            focused={view === "main" && pane === 1}
            queue={queueSnap}
            width={layout.railWidth}
            height={listHeight}
            window={railWindow}
          />
          {view === "queue" ? (
            <QueueView
              snap={queueSnap}
              scroll={scroll}
              now={queueNow}
              height={listHeight}
              focused
            />
          ) : view === "cmdOutput" && cmd ? (
            <CommandOutput
              title={cmd.title}
              running={cmd.running}
              elapsedS={cmdElapsed}
              output={cmd.output}
              scroll={scroll}
              exitCode={cmd.exitCode}
              timedOut={cmd.timedOut}
              height={listHeight}
            />
          ) : view === "detail" && detail ? (
            <Preview
              issue={detail.issue}
              trigger={trigger}
              body={detail.body}
              planComment={detail.planComment}
              loading={detail.loading}
              error={null}
              scroll={scroll}
              focused
              height={listHeight}
            />
          ) : view === "prDetail" && prDetail ? (
            <PrPreview
              pr={prDetail.pr}
              branchPrefix={branchPrefix}
              now={queueNow}
              height={listHeight}
              focused
              titleLabel="pr"
            />
          ) : view === "prs" ? (
            <PrList
              prs={prs}
              selected={prIdxSafe}
              focused
              height={listHeight}
              now={queueNow}
              staleAt={prStaleAt}
              window={prWindow}
            />
          ) : (
            <IssueList
              issues={filteredIssues}
              trigger={trigger}
              selected={issueIdxSafe}
              focused={view === "main" && pane === 2}
              refreshing={refreshing}
              filter={filter}
              filtering={filtering}
              height={listHeight}
              now={queueNow}
              staleAt={currentNwo ? (staleAt[currentNwo] ?? null) : null}
              window={issueWindow}
            />
          )}
          {layout.mode === "wide" &&
            (view === "prs" ? (
              <PrPreview
                pr={selectedPr}
                branchPrefix={branchPrefix}
                now={queueNow}
                height={listHeight}
                width={layout.previewWidth}
                focused={false}
              />
            ) : view === "main" ? (
              <Box width={layout.previewWidth} height={listHeight}>
                <PrList
                  prs={repoPrs}
                  selected={pane3IdxSafe}
                  showNwo={false}
                  focused={pane === 3}
                  height={listHeight}
                  now={queueNow}
                  staleAt={prStaleAt}
                  window={pane3Window}
                  title={pane3Title}
                  emptyText="no junco PRs for this repo"
                />
              </Box>
            ) : null)}
        </>
      )}
    </Workspace>
  );
}
