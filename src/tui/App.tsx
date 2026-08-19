/**
 * Dashboard composition root: wires the fullscreen workspace, routes keystrokes
 * by view then pane, polls issues + health + queue on intervals, and applies
 * actions optimistically (local label delta shown immediately, rolled back with
 * a toast if gh fails). Holds NO queue state — every issue's lifecycle is
 * derived from its labels.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, type Key } from "ink";
import { bumpRender } from "./renderCount.js";
import type { DashboardClient } from "./ghClient.js";
import type { DashAction, DashIssue, IssueLifecycle } from "./state.js";
import { allowedActions, deriveState } from "./state.js";
import { lifecycleLabels } from "../githubInbox.js";
import { resolve } from "node:path";
import type { GithubRepoMapping } from "../types.js";
import type { UpdateInfo } from "../updateCheck.js";
import { useTerminalSize, type TerminalSize } from "./useTerminalSize.js";
import { computeLayout } from "./layout.js";
import { windowSlice } from "./window.js";
import { listRowsHeight, railListHeight, sectionRowsHeight } from "./geometry.js";
import { Workspace } from "./components/Workspace.js";
import { Header } from "./components/Chrome.js";
import { LogView } from "./components/LogView.js";
import { cycleLevel, distinctTickets } from "./logFilter.js";
import type { LocalCheap, LocalHeavy, LocalSection } from "./localSnapshot.js";
import {
  buildRailRows,
  buildUnifiedRepos,
  bodyKindFor,
  resolveRailIndex,
  rowKey,
  sysKey,
  type SystemSection,
  type UnifiedRepo,
} from "./railModel.js";
import { UnifiedRail } from "./components/UnifiedRail.js";
import { RepoDetail } from "./components/RepoDetail.js";
import {
  OutboxSection,
  WorktreesSection,
  DaemonSection,
  truncStart,
} from "./components/sections.js";
import { buildContextBindings, type BindingContext } from "./viewActions.js";
import type { AssessHistory } from "../assessHistory.js";
import { IssueList } from "./components/IssueList.js";
import { Preview } from "./components/Preview.js";
import { PrList, NWO_MAX_WIDTH } from "./components/PrList.js";
import { PrPreview } from "./components/PrPreview.js";
import { ActivityCard, ReservedNote } from "./components/ActivityCard.js";
import { derivePrState, type DashPr } from "./prState.js";
import { Modal } from "./components/Modal.js";
import { HelpModal } from "./components/HelpModal.js";
import { AddRepoForm } from "./components/AddRepoForm.js";
import { CommandPalette, filterCommands } from "./components/CommandPalette.js";
import { CommandOutput } from "./components/CommandOutput.js";
import { QueueView } from "./components/QueueView.js";
import { ReviewView } from "./components/ReviewView.js";
import { ConfigView } from "./components/ConfigView.js";
import { PALETTE_COMMANDS, runCliCommand, type CliRunResult } from "./cliRunner.js";
import type { QueueSnapshot } from "./queueSnapshot.js";
import { theme } from "./theme.js";
import { useOnAnyMousePress, useOnMouseMiss } from "./MouseProvider.js";
import { ClickableBox } from "./ClickableBox.js";
import { Button } from "./components/primitives/Button.js";
import { useGuardedInput } from "./useGuardedInput.js";
import { useScroll } from "./useScroll.js";
import type { LogReaderDeps } from "../logReader.js";
import { useToast } from "./hooks/useToast.js";
import { useConfirm } from "./hooks/useConfirm.js";
import { useHealth } from "./hooks/useHealth.js";
import { useQueueSnapshot } from "./hooks/useQueueSnapshot.js";
import { useAssessHistory } from "./hooks/useAssessHistory.js";
import { useUpdateCheck } from "./hooks/useUpdateCheck.js";
import { useBotLogin } from "./hooks/useBotLogin.js";
import { useReview } from "./hooks/useReview.js";
import { useCmdOutput } from "./hooks/useCmdOutput.js";
import { usePalette } from "./hooks/usePalette.js";
import { useLogOverlay } from "./hooks/useLogOverlay.js";
import { useAddRepoForm } from "./hooks/useAddRepoForm.js";
import { useWatchlist } from "./hooks/useWatchlist.js";
import { useGithubData } from "./hooks/useGithubData.js";
import { summarizeUnwatchPlan } from "./unwatchSummary.js";
// Type-only: unwatchCmd is a pure module, but the dashboard drives it through
// the CLI (spawned), never in-process — nothing here may pull it into the bundle.
import type { PlanOutcome } from "../unwatchCmd.js";

export interface AppProps {
  client: DashboardClient;
  trigger: string;
  /** `cfg.branchPrefix` — recovers a PR's ticket slug from its head branch. */
  branchPrefix: string;
  configRepos: GithubRepoMapping[]; // read-only entries
  watchlistFile: string; // read/write via watchlist.ts
  /** Resolved config path — spawned palette commands target the same config. */
  configPath: string;
  /** Managed clones root (`<dataDir>/clones/watched`, or `<dataDir>/cache/clones/watched`
   * under the v2 layout) — auto-clone destination. */
  clonesDir: string;
  /** The daemon's log file (`<dataDir>/worker.log`, or `<dataDir>/logs/worker.log`
   * under the v2 layout) — the LOCAL `logs` section and its overlay tail it via
   * useLogTail. Resolved by dashboardCmd where cfg is in scope; read only while
   * the logs surface is on screen. */
  logPath: string;
  /** Unified view-scoped refresh cadence (issues + PRs). Default 30_000;
   * tests pass large values. */
  refreshPollMs?: number;
  healthPollMs?: number; // default 5_000
  /** Local queue snapshot source (dashboardCmd wires makeQueueSnapshotFn). */
  queueFn: () => Promise<QueueSnapshot>;
  queuePollMs?: number; // default 1_000 — queue card / turn counters (local reads only)
  /** Per-repo assess history source (dashboardCmd wires makeAssessHistoryFn). */
  assessHistoryFn: () => Promise<AssessHistory[]>;
  assessHistoryPollMs?: number; // default 15_000 — assess runs take minutes
  /** LOCAL cheap snapshot (@3s): queue + counts + outbox + daemon detail. */
  localCheapFn: (opts?: { section?: LocalSection }) => Promise<LocalCheap>;
  /** Heavy snapshot (@15s): repos + worktrees — feeds the unified rail's
   * local rows, the ⚑ worktree badge, and RepoDetail git state. */
  localHeavyFn: (signal?: AbortSignal) => Promise<LocalHeavy>;
  /** When false no gh poll ever fires and watched nwo rows render the
   * RepoDetail body instead of issues (unified-view spec §6). */
  githubEnabled: boolean;
  localCheapPollMs?: number; // default 3_000
  localHeavyPollMs?: number; // default 15_000
  /** Palette command runner override (tests). Defaults to the real subprocess. */
  runCliFn?: (name: string, extraArgs: string[]) => Promise<CliRunResult>;
  /** Fixed terminal size (tests) — ink-testing-library has no resizable stdout. */
  sizeOverride?: TerminalSize;
  /** Palette "setup" hook: the Root host swaps to the setup walkthrough
   * in-process (no subprocess). Absent when App is mounted standalone. */
  onRequestWizard?: () => void;
  onExit: () => void;
  /** Best-effort npm update check (spec 2026-07-16); absent in tests → no chip. */
  checkUpdateFn?: () => Promise<UpdateInfo | null>;
  /** LOCAL logs poll cadence override (tests); production omits it → the hook's
   * 500ms default. */
  logsPollMs?: number;
  /** useLogTail fs seam (tests inject an in-memory file); production omits it —
   * MUST stay `undefined` so the hook's effect dep array keeps a stable
   * identity and never teardown/re-seeds per render. */
  logReaderDeps?: LogReaderDeps;
  /** Resolves the junco bot account's gh login (dashboardCmd wires
   * resolveBotLogin); absent in tests → no bot-authored highlighting. */
  botLoginFn?: () => Promise<string | null>;
}

// Panes: 1 repos (rail), 2 issues (list), 3 PRs for the selected repo (wide
// terminals only).
type Pane = 1 | 2 | 3;

export type View =
  | "main"
  | "detail"
  | "help"
  | "addRepo"
  | "config"
  | "palette"
  | "cmdOutput"
  | "repoDetail"
  | "prs"
  | "prDetail"
  | "review";

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

/** Pane 3's title composes "PRs · <nwo>" from a nwo of unbounded length —
 * mirrors PrList's own truncate-start nwo cell (NWO_MAX_WIDTH) so the title
 * clamps to the same budget rather than wrapping the pane onto a second line,
 * which would corrupt PrList's height/windowing math (CHROME one-line
 * discipline: every pane title is exactly one row). */
function truncateNwoStart(nwo: string): string {
  if (nwo.length <= NWO_MAX_WIDTH) return nwo;
  return `…${nwo.slice(nwo.length - (NWO_MAX_WIDTH - 1))}`;
}

/** Compile-time exhaustiveness for the section-body switch (#238): adding a
 * SystemSection member without wiring its body arm fails to type-check
 * (`section` no longer narrows to never); the throw is unreachable at runtime. */
function assertNeverSection(section: never): never {
  throw new Error(`unhandled system section: ${String(section)}`);
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
    assessHistoryFn,
    onExit,
    localCheapFn,
    localHeavyFn,
  } = props;
  const refreshPollMs = props.refreshPollMs ?? 30_000;
  const healthPollMs = props.healthPollMs ?? 5_000;
  const queuePollMs = props.queuePollMs ?? 1_000;
  const assessHistoryPollMs = props.assessHistoryPollMs ?? 15_000;
  const localCheapPollMs = props.localCheapPollMs ?? 3_000;
  const localHeavyPollMs = props.localHeavyPollMs ?? 15_000;
  // useMemo'd (perf pass #259): the `??` fallback arrow was rebuilt every
  // render, churning the identity of everything that depends on `runCliFn`
  // (runPaletteCommand, paletteEnter, runAssess, runLocalAction) even when
  // `props.runCliFn` didn't change.
  const runCliFn = useMemo(
    () => props.runCliFn ?? ((name: string, extraArgs: string[]) => runCliCommand(name, extraArgs)),
    [props.runCliFn],
  );
  const { exit } = useApp();
  bumpRender("App"); // no-op unless JUNCO_RENDER_COUNT=1 (perf-pass measurement seam)

  const size = useTerminalSize(props.sizeOverride);
  const layout = useMemo(() => computeLayout(size.columns, size.rows), [size]);

  // No removeEntry here on purpose: the `unwatch` CLI owns the watchlist
  // write (it deletes the repo's state in the same pass) — the dashboard only
  // re-reads the file afterwards via `reloadWatchlist`.
  const {
    repoMappings,
    watchlistError,
    addEntry,
    reload: reloadWatchlist,
  } = useWatchlist(watchlistFile, configRepos);
  // Rail selection: KEY-anchored (rowKey — nwo / path / "sys:section"), never a
  // bare index, so a heavy-poll clone discovery can't slide the cursor onto a
  // different row. null = top row (first repo, or queue when no repos).
  const [railSel, setRailSel] = useState<string | null>(null);
  const [pane, setPane] = useState<Pane>(1);
  const [view, setView] = useState<View>("main");
  const [detail, setDetail] = useState<DetailState | null>(null);
  const [prDetail, setPrDetail] = useState<PrDetailState | null>(null);
  // Flips false on unmount so every async `.then`/`await` continuation below can
  // bail before touching state after the dashboard has exited. `assess` and the
  // other spawned CLIs can resolve up to cliRunner's 120s timeout past unmount;
  // the optimistic/browser/detail handlers resolve fast but carry the same guard
  // for consistency (post-unmount setState is a silent no-op under React 19, so
  // this is a uniformity guard, not a live-bug fix). Declared here (ahead of its
  // original spot) so useReview below — and the scrollKey memo further down that
  // reads reviewState — can both see it.
  const aliveRef = useRef(true);
  useEffect(
    () => () => {
      aliveRef.current = false;
    },
    [],
  );
  const { reviewState, setReviewState, loadReview } = useReview({ client, aliveRef });
  const [filter, setFilter] = useState("");
  const [filtering, setFiltering] = useState(false);
  const { toast, showToast, dismissToast } = useToast();
  const health = useHealth(client, healthPollMs);
  const { queueSnap, queueNow } = useQueueSnapshot(queueFn, queuePollMs);
  const assessHistory = useAssessHistory(assessHistoryFn, assessHistoryPollMs);
  // useConfirm sits above useAddRepoForm because the add-repo flow feeds its
  // bot-grant confirm gate through the same modal (askConfirm is stable).
  const { confirm, askConfirm, clearConfirm } = useConfirm();
  const { addRepoError, addRepoBusy, handleAddRepo, setAddRepoError } = useAddRepoForm({
    client,
    clonesDir,
    addEntry,
    showToast,
    setView,
    aliveRef,
    watchlistError,
    askConfirm,
  });
  const { cmd, cmdElapsed, runPaletteCommand } = useCmdOutput(runCliFn, setView);
  const {
    paletteFilter,
    paletteSel,
    paletteArgsMode,
    paletteArgs,
    setPaletteFilter,
    setPaletteSel,
    setPaletteArgsMode,
    setPaletteArgs,
    resetPalette,
    paletteEnter,
  } = usePalette({
    runPaletteCommand,
    showToast,
    onRequestWizard: props.onRequestWizard,
    setView,
  });
  // ── Local runtime state: system-section cursors + the cheap/heavy snapshots
  // feeding the rail's system rows and section bodies. ──
  const [sectionCursor, setSectionCursor] = useState<Record<SystemSection, number>>({
    queue: 0,
    outbox: 0,
    worktrees: 0,
    daemon: 0,
    logs: 0,
  });
  // The full-width RepoDetail view's frozen target (the `detail` snapshot
  // pattern) — set by enter / click-again on a rail repo row.
  const [repoDetailTarget, setRepoDetailTarget] = useState<UnifiedRepo | null>(null);
  const [localCheap, setLocalCheap] = useState<LocalCheap | null>(null);
  const [localHeavy, setLocalHeavy] = useState<LocalHeavy | null>(null);
  // Latest npm version when newer than the running one (header chip + help
  // line); null when no update is known/available.
  const updateLatest = useUpdateCheck(props.checkUpdateFn);
  // The junco bot account's gh login (resolved once via botLoginFn); null when
  // the feature is inert (disabled, unresolvable, or botLoginFn absent) — rows
  // opened by this login render their number cell in accent (IssueList/PrList).
  const botLogin = useBotLogin(props.botLoginFn);
  // Dedupe key set for in-flight spawned actions (mirrors assessInFlightRef).
  const localActionInFlightRef = useRef<Set<string>>(new Set());

  // ── The unified rail: watched repos ∪ discovered local checkouts, then the
  // five pinned system rows. Selection resolves the key anchor to a live index
  // with the clamp-to-last-slot fallback (lastRailIdxRef). ──
  const unifiedRepos = useMemo(
    () => buildUnifiedRepos(repoMappings, localHeavy?.repos ?? null),
    [repoMappings, localHeavy],
  );
  const railRows = useMemo(() => buildRailRows(unifiedRepos), [unifiedRepos]);
  const lastRailIdxRef = useRef(0);
  const railIdx = resolveRailIndex(railRows, railSel, lastRailIdxRef.current);
  lastRailIdxRef.current = railIdx;
  const selectedRow = railRows[railIdx];
  // What pane 2 shows for the selected row (issues / repoDetail / a section).
  const body = bodyKindFor(selectedRow, props.githubEnabled);
  const sysSection = body?.kind === "section" ? body.section : null;
  const {
    logOverlay,
    logFollow,
    logFilters,
    logSearchMode,
    logEntries,
    setLogOverlay,
    setLogFollow,
    setLogFilters,
    setLogSearchMode,
    onLogExpand,
  } = useLogOverlay({
    logPath: props.logPath,
    logsPollMs: props.logsPollMs,
    logReaderDeps: props.logReaderDeps,
    sysSection,
    view,
  });
  const currentNwo = body?.kind === "issues" ? body.nwo : undefined;
  // The watched mapping behind the selected issues row — external gate, unwatch
  // and the pane-1 `o` read it exactly as they always did.
  const currentRepo = currentNwo
    ? repoMappings.find((r) => r.nwo.toLowerCase() === currentNwo.toLowerCase())
    : undefined;

  // The fused GitHub-data core: issues + PRs + the unified refresh cycle.
  // `nav` is read-only nav-spine state App owns — the hook never writes it.
  const github = useGithubData({
    client,
    trigger,
    githubEnabled: props.githubEnabled,
    repoMappings,
    showToast,
    refreshPollMs,
    filter,
    nav: { currentNwo, view, bodyKind: body?.kind ?? null },
  });
  // Destructured (not `github.<field>`) so the actionHandlers memo below can
  // depend on the exact stable identities it reads instead of the whole
  // `github` object — which is a fresh value every render.
  const {
    refreshAll: githubRefreshAll,
    setRefreshing: githubSetRefreshing,
    setIssueLabels: githubSetIssueLabels,
    evictRepo: githubEvictRepo,
  } = github;

  // One scroll mechanic for every offset-driven surface. Exactly one is mounted
  // at a time (the render tree is config | local | review | rail+one-of), so one
  // instance serves them all; the key is the mounted surface's content identity,
  // and a key change is what resets the offset — this replaces the 18
  // hand-written offset-reset calls (this hook's github-side setter here, plus
  // LOCAL mode's own scroll state, folded into this same instance) that used to
  // stand in for a lifecycle.
  const scrollKey = useMemo(() => {
    // The overlay is its own scroll surface (mounted over the body), so it
    // gets its own key — a change resets the offset when it opens/closes.
    if (logOverlay) return "logOverlay";
    if (view === "review" && reviewState.open?.kind === "draft")
      return `draft:${reviewState.open.draftIdx}`;
    if (view === "cmdOutput" && cmd) return `cmd:${cmd.token}`;
    if (view === "detail" && detail) return `detail:${detail.nwo}#${detail.issue.number}`;
    if (view === "repoDetail" && repoDetailTarget) return `repoView:${repoDetailTarget.key}`;
    if (view === "main" && body?.kind === "repoDetail") return `repo:${body.repo.key}`;
    if (view === "main" && sysSection !== null) return `sys:${sysSection}`;
    return view;
  }, [logOverlay, view, reviewState.open, cmd, detail, repoDetailTarget, body, sysSection]);
  const { scroll, scrollBy, onScrollMax, toEnd } = useScroll(scrollKey);

  // No render-time fs call: an empty/absent file both show the placeholder until
  // the first line arrives (a running daemon fills within one poll).
  const logHasFile = logEntries.length > 0;

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
    | { kind: "worktree"; path: string; slug: string; klass: "live" | "stale" | "backup" };

  const sectionRowsFor = (section: SystemSection): LocalRow[] => {
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
      case "logs":
        // Viewport, no selectable rows (like daemon) — the compact tail is
        // click-to-expand, not row-navigable.
        return [];
    }
  };
  const localRows = sysSection !== null ? sectionRowsFor(sysSection) : [];
  const localCursorSafe =
    sysSection !== null
      ? Math.max(0, Math.min(sectionCursor[sysSection], Math.max(0, localRows.length - 1)))
      : 0;
  const localTarget = localRows[localCursorSafe];

  const moveSectionCursor = (delta: number): void => {
    if (sysSection === null || localRows.length === 0) return;
    const next = Math.max(0, Math.min(localCursorSafe + delta, localRows.length - 1));
    setSectionCursor((m) => ({ ...m, [sysSection]: next }));
  };

  // Section-body windowing (outbox/worktrees lists) — minimal-movement
  // prevStart per section, exactly the LocalDashboard rule it replaces.
  const sectionPrev = useRef<Record<SystemSection, number>>({
    queue: 0,
    outbox: 0,
    worktrees: 0,
    daemon: 0,
    logs: 0,
  });
  // `useMemo`'d (perf #259): `windowSlice` returns a fresh `{start,end}`
  // object literal every call, and this used to run unconditionally every
  // render — a brand-new reference for a memo'd section component's `window`
  // prop even when nothing it depends on had changed. The dep list is the
  // exact set `windowSlice` reads (`localRows.length` as the "total" input —
  // `localRows` itself is rebuilt fresh every render by `sectionRowsFor`
  // above, so depending on the array would defeat this same memo; only its
  // length feeds the computation). `sectionPrev.current` is a ref: reading it
  // inside the memo is safe without listing it as a dep — it only changes as
  // this same computation's own side effect below, so it's already current
  // whenever the memo actually reruns.
  const sectionWin = useMemo(
    () =>
      sysSection !== null
        ? windowSlice(
            localRows.length,
            sectionRowsHeight(layout.bodyRows),
            localCursorSafe,
            sectionPrev.current[sysSection],
          )
        : { start: 0, end: 0 },
    [sysSection, localRows.length, layout.bodyRows, localCursorSafe],
  );
  if (sysSection !== null) sectionPrev.current[sysSection] = sectionWin.start;

  // Issue/PR selection resolution (anchored number/{nwo,number} → a safe live
  // index) now lives inside useGithubData — it owns the fallback refs the
  // anchor-validation effects also read/write. `filteredIssues` — the live
  // `/`-filtered view of `issues[currentNwo]` — is computed there too (the
  // hook takes `filter` as a read-only input; the `filter` STATE itself stays
  // App-owned, same as any other nav-adjacent value the hook consumes).
  const { filteredIssues, issueIdxSafe, currentIssue, prIdxSafe, selectedPr, repoPrs } = github;
  const { pane3IdxSafe, selectedPane3Pr } = github;
  // Pane 3's title identifies the scoped repo (mockup: "PRs · acme/reef");
  // no repo selected (empty rail) falls back to the bare pane label.
  const pane3Title = currentNwo ? `PRs · ${truncateNwoStart(currentNwo)}` : "PRs";

  // Header breadcrumb trail — the active view's scope, most-general first.
  const crumbs = useMemo((): string[] => {
    if (view === "prs") return ["pull requests"];
    if (view === "review") return ["review"];
    if (view === "cmdOutput" && cmd) return ["command", cmd.title];
    if (view === "detail" && detail) return [detail.nwo, `#${detail.issue.number}`];
    if (view === "prDetail" && prDetail) return [prDetail.pr.nwo, `PR #${prDetail.pr.number}`];
    if (view === "repoDetail" && repoDetailTarget)
      return [repoDetailTarget.nwo ?? truncStart(repoDetailTarget.path, 30)];
    if (body?.kind === "section") return ["system", body.section];
    return [currentNwo ?? "no repo"];
  }, [view, cmd, detail, prDetail, repoDetailTarget, body, currentNwo]);

  // Window slices live HERE (not inside the list components) so that rendering
  // and mouse hit-testing share one offset — the sticky prevStart refs move up
  // with them. Geometry helpers keep the budgets in lockstep with the panes.
  // Each is `useMemo`'d (perf #259, same reasoning as `sectionWin` above): a
  // fresh `{start,end}` literal every render was defeating IssueList/PrList/
  // UnifiedRail's memo regardless of their callback props' own stability.
  const railPrev = useRef(0);
  // The rail windows its REPO prefix only (system rows are pinned); the cursor
  // clamps into the prefix so a system-row selection keeps the window parked.
  const repoCount = unifiedRepos.length;
  const railWindow = useMemo(
    () =>
      windowSlice(
        repoCount,
        railListHeight(layout.bodyRows),
        Math.min(railIdx, Math.max(0, repoCount - 1)),
        railPrev.current,
      ),
    [repoCount, layout.bodyRows, railIdx],
  );
  railPrev.current = railWindow.start;
  const issuePrev = useRef(0);
  const issueWindow = useMemo(
    () =>
      windowSlice(
        filteredIssues.length,
        listRowsHeight(layout.bodyRows),
        issueIdxSafe,
        issuePrev.current,
      ),
    [filteredIssues.length, layout.bodyRows, issueIdxSafe],
  );
  issuePrev.current = issueWindow.start;
  const prPrev = useRef(0);
  const prWindow = useMemo(
    () =>
      windowSlice(github.prs.length, listRowsHeight(layout.bodyRows), prIdxSafe, prPrev.current),
    [github.prs.length, layout.bodyRows, prIdxSafe],
  );
  prPrev.current = prWindow.start;
  // Pane 3's repo-scoped monitor is a windowed PrList too — same lifted-offset rule.
  const pane3Prev = useRef(0);
  const pane3Window = useMemo(
    () =>
      windowSlice(repoPrs.length, listRowsHeight(layout.bodyRows), pane3IdxSafe, pane3Prev.current),
    [repoPrs.length, layout.bodyRows, pane3IdxSafe],
  );
  pane3Prev.current = pane3Window.start;

  // Per-repo issue counts for the rail badges, derived from loaded issues —
  // a lookup (not a prebuilt array) so the rail reads counts per nwo row.
  const issueCounts = useCallback(
    (nwo: string): Partial<Record<IssueLifecycle, number>> => {
      const counts: Partial<Record<IssueLifecycle, number>> = {};
      for (const iss of github.issues[nwo] ?? []) {
        const st = deriveState(iss.labels, trigger);
        counts[st] = (counts[st] ?? 0) + 1;
      }
      return counts;
    },
    [github.issues, trigger],
  );

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
          (github.issues[r.nwo] ?? []).reduce((n, iss) => {
            const st = deriveState(iss.labels, trigger);
            return st === "plan-ready" || st === "approved" ? n + 1 : n;
          }, 0),
        0,
      ),
    [repoMappings, github.issues, trigger],
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
    return github.prs.filter((p) => {
      if (!watched.has(p.nwo)) return false;
      const s = derivePrState(p);
      return s === "checks-failing" || s === "changes-requested";
    }).length;
  }, [github.prs, repoMappings]);
  const prFailing = useMemo(() => {
    const watched = new Set(repoMappings.map((r) => r.nwo));
    return github.prs.some((p) => watched.has(p.nwo) && derivePrState(p) === "checks-failing");
  }, [github.prs, repoMappings]);

  // Derived list-level stale marker (see prStaleByRepo above).
  const prStaleAt = useMemo(() => {
    const watched = new Set(repoMappings.map((r) => r.nwo));
    let oldest: string | null = null;
    for (const [nwo, s] of Object.entries(github.prStaleByRepo)) {
      if (!watched.has(nwo) || s === null) continue;
      if (oldest === null || Date.parse(s) < Date.parse(oldest)) oldest = s;
    }
    return oldest;
  }, [github.prStaleByRepo, repoMappings]);

  // Clear the live filter when the selected repo changes — a stale query would
  // hide the newly-selected repo's issues (also fires harmlessly on mount).
  // Domain P (not github) — stays in App even though useGithubData now reads
  // `filter`'s current value for its own issue-side selection resolution.
  useEffect(() => {
    setFilter("");
    setFiltering(false);
  }, [currentNwo]);

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
      githubSetIssueLabels(nwo, num, optimisticLabels(action, prevLabels, trigger));
      void client.applyAction(nwo, num, action, prevLabels).then((res) => {
        if (!aliveRef.current) return;
        if (!res.ok) {
          githubSetIssueLabels(nwo, num, prevLabels);
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
    [client, currentNwo, currentIssue, trigger, githubSetIssueLabels, showToast, queueSnap],
  );

  const openDetail = useCallback(() => {
    if (!currentNwo || !currentIssue) return;
    const nwo = currentNwo;
    const snapshot = currentIssue; // frozen at open — the header never swaps mid-read
    const num = snapshot.number;
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

  // Immediate local refresh (`r`): cheap always, heavy only when a git-backed
  // surface is on screen. aliveRef drops late results after unmount.
  const heavyOnScreen =
    sysSection === "worktrees" || body?.kind === "repoDetail" || view === "repoDetail";
  const forceLocalRefresh = useCallback(async (): Promise<void> => {
    const c = await localCheapFn({ section: sysSection ?? undefined });
    if (!aliveRef.current) return;
    setLocalCheap(c);
    if (heavyOnScreen) {
      const h = await localHeavyFn();
      if (aliveRef.current) setLocalHeavy(h);
    }
  }, [localCheapFn, localHeavyFn, sysSection, heavyOnScreen]);

  // Cheap poll @3s — always on: it feeds the rail's system badges, the header,
  // and whichever section body is on screen. `alive` (per-effect) + aliveRef
  // (per-App) both gate the setState so neither a section switch nor an
  // unmount clobbers state with a late result.
  useEffect(() => {
    let alive = true;
    const run = async (): Promise<void> => {
      const c = await localCheapFn({ section: sysSection ?? undefined });
      if (!alive || !aliveRef.current) return;
      setLocalCheap(c);
    };
    void run();
    const id = setInterval(() => void run(), localCheapPollMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [sysSection, localCheapFn, localCheapPollMs]);

  // Heavy poll @15s — always on: the rail's local-only rows and the ⚑ badge
  // need candidates regardless of what the body shows (bounded git fan-out,
  // --no-optional-locks). First tick immediate so local rows appear at mount;
  // AbortController drops the in-flight fan-out on unmount.
  useEffect(() => {
    let alive = true;
    const ctrl = new AbortController();
    const run = async (): Promise<void> => {
      const h = await localHeavyFn(ctrl.signal);
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
  }, [localHeavyFn, localHeavyPollMs]);

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

  // Fire-and-toast, mirroring runAssess: spawn the real CLI, dedupe by a key,
  // toast the first output line, then force an immediate cheap re-poll so the
  // mutated state (deleted ticket / drained outbox / gone worktree) shows at once.
  // `onSuccess` runs only on a clean exit, after the toast and before the
  // re-poll: the caller's own state reconciliation (evict caches, re-read a
  // file the CLI just rewrote) for effects the cheap snapshot doesn't cover.
  const runLocalAction = useCallback(
    (
      name: string,
      args: string[],
      opts: { key?: string; label?: string; onSuccess?: () => void } = {},
    ) => {
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
        if (rr.code === 0) opts.onSuccess?.();
        // Immediate re-poll (cheap fn is cheap; section-gated counts refresh too).
        void localCheapFn({ section: sysSection ?? undefined }).then((c) => {
          if (aliveRef.current) {
            setLocalCheap(c);
          }
        });
      });
    },
    [runCliFn, showToast, localCheapFn, sysSection],
  );

  // Takes an explicit nwo (github passes currentRepo.nwo; LOCAL passes its
  // cursor's LocalRepo.nwo). The config-vs-watchlist decision comes from the
  // matched repoMappings entry; an nwo absent from the union → not in watchlist.
  //
  // Three hops, never one: `unwatch --plan` (read-only) → the itemized confirm
  // modal → `unwatch` (deletes the repo's junco-owned state AND rewrites the
  // watchlist). The dashboard never writes the file itself any more — it only
  // re-reads it once the CLI has, so the two can't disagree about what a
  // "watched" repo is.
  const unwatch = useCallback(
    (nwo: string) => {
      const mapping = repoMappings.find((r) => r.nwo.toLowerCase() === nwo.toLowerCase());
      if (!mapping) return void showToast("info", "not in watchlist");
      if (mapping.fromConfig)
        return void showToast("info", `${mapping.nwo} is defined in config.json`);
      if (watchlistError)
        return void showToast("error", "watchlist unreadable — fix it before writing");
      void runCliFn("unwatch", [mapping.nwo, "--plan"])
        .then((rr) => {
          if (!aliveRef.current) return;
          // Parse BEFORE branching on the exit code: a refusal exits 1 but still
          // prints its {ok:false, reason} JSON line, and the friendly message
          // beats a raw JSON blob in the toast. (TOCTOU-only path — the guards
          // above already caught both reasons against the current snapshot.)
          // Store warnings may precede the JSON in the merged stream — parse the
          // LAST non-empty line.
          const lines = rr.output.split("\n").filter((l) => l.trim() !== "");
          let outcome: PlanOutcome | null = null;
          try {
            const parsed: unknown = JSON.parse(lines[lines.length - 1] ?? "");
            if (parsed !== null && typeof parsed === "object" && "ok" in parsed)
              outcome = parsed as PlanOutcome;
          } catch {
            /* not JSON — the exit-code branch below owns the toast */
          }
          if (outcome !== null && !outcome.ok)
            return void showToast(
              "error",
              outcome.reason === "config-defined"
                ? `${mapping.nwo} is defined in config.json`
                : "watchlist unreadable — fix it before writing",
            );
          if (rr.code !== 0)
            return void showToast("error", firstNonEmptyLine(rr.output) ?? "unwatch: plan failed");
          // Shape-check a contract-violating {ok:true} payload (no/garbled plan)
          // into a toast — this continuation must never throw (see .catch).
          const plan = outcome?.plan;
          if (plan === undefined || !Array.isArray(plan.items) || !Array.isArray(plan.kept))
            return void showToast("error", "unwatch: unreadable plan");
          if (plan.blocked)
            return void showToast(
              "info",
              `${mapping.nwo}: ticket in flight (${plan.blocked.ticketId}) — wait for it to finish`,
            );
          askConfirm({
            title: `unwatch ${mapping.nwo}`,
            danger: true,
            body: summarizeUnwatchPlan(plan),
            onConfirm: () =>
              runLocalAction("unwatch", [mapping.nwo], {
                label: "unwatch",
                onSuccess: () => {
                  // Drop the repo's cached issue/PR state too — the rail badges
                  // and the header pulse must never read ghost data for a repo
                  // that is no longer watched. Synchronous, not a poll round-trip.
                  githubEvictRepo(mapping.nwo);
                  reloadWatchlist();
                },
              }),
          });
        })
        .catch(() => {
          // Belt-and-braces for a destructive flow: a bug in the continuation
          // must surface as a toast, never as an unhandled rejection.
          if (aliveRef.current) showToast("error", "unwatch: plan failed");
        });
    },
    [
      repoMappings,
      watchlistError,
      showToast,
      runCliFn,
      askConfirm,
      runLocalAction,
      githubEvictRepo,
      reloadWatchlist,
    ],
  );

  // A wide terminal that shrinks below 110 cols — or a rail move onto a row
  // with no PR pane (section / RepoDetail body) — while pane 3 is focused
  // would otherwise leave focus on a pane that no longer renders; pull it
  // back onto pane 2 instead of stranding it.
  useEffect(() => {
    if ((layout.mode !== "wide" || body?.kind !== "issues") && pane === 3) setPane(2);
  }, [layout.mode, body?.kind, pane]);

  // Issue/PR/pane-3 movers now live in useGithubData (they close over its
  // internal filteredIssues/issueIdxSafe/prIdxSafe/pane3IdxSafe) — aliased
  // here so the keyboard cascade, mouse handlers, and JSX below (unchanged
  // call sites) keep working without a `github.` prefix at every use.
  const { moveIssue, moveIssueTo, movePr, movePrTo, movePane3, movePane3To } = github;

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
  // `useCallback`'d (empty deps: only the two setState setters, both stable)
  // so the `structuralChipActions` memo below doesn't re-identify every render.
  const openPrDetail = useCallback((pr: DashPr | null, from: "main" | "prs"): void => {
    if (!pr) return;
    setPrDetail({ pr, from });
    setView("prDetail");
  }, []);

  // Rail movement: anchor the KEY of the landed row (never a bare index) so a
  // re-deriving poll keeps the cursor on the same row. Shared by keyboard and
  // mouse (wheel/click), mirroring moveIssue/movePr above. `useCallback`'d
  // (perf #259) so the `onWheel` wrapper passed to `UnifiedRail` below only
  // re-identifies when `railRows` itself changes, not on every App render.
  const moveRail = useCallback(
    (delta: number): void => {
      if (railRows.length === 0) return;
      // Functional update so rapid batched presses compose (two `j`s in one
      // stdin flush share this render's closure — resolving from the PENDING
      // key keeps each step relative to the last, like setRepoIdx((i) => …) did).
      setRailSel((cur) => {
        const idx = resolveRailIndex(railRows, cur, lastRailIdxRef.current);
        const next = Math.max(0, Math.min(idx + delta, railRows.length - 1));
        return rowKey(railRows[next]);
      });
    },
    [railRows],
  );
  const moveRailTo = useCallback(
    (idx: number): void => {
      if (railRows.length === 0) return;
      setRailSel(rowKey(railRows[Math.max(0, Math.min(idx, railRows.length - 1))]));
    },
    [railRows],
  );
  // `UnifiedRail`'s onWheel is gated on `view` (rail wheel only moves the
  // cursor while the main view is focused there) — hoisted so the gate check
  // doesn't itself require a fresh arrow every render (perf #259).
  const railWheel = useCallback(
    (d: 1 | -1): void => {
      if (view === "main") moveRail(d);
    },
    [view, moveRail],
  );
  // Same treatment as railWheel: the `onPanePress` arrow only differs from a
  // bare `() => setPane(1)` in the ternary that decides whether it's mounted
  // at all — hoisting the function itself keeps IT stable across renders.
  const railPanePress = useCallback(() => setPane(1), []);
  // `assessHistory` is a stable `useState` Map (only its OWN poll replaces
  // it), but the inline `(nwo) => assessHistory.get(nwo) ?? null` arrow at the
  // JSX call site was rebuilt every render regardless — hoisted here so its
  // identity tracks `assessHistory` only.
  const railAssess = useCallback((nwo: string) => assessHistory.get(nwo) ?? null, [assessHistory]);
  // Full-width RepoDetail view opener — enter / click-again on a rail repo
  // row; the target is frozen at open (the `detail` snapshot pattern).
  // `useCallback`'d for the same reason as `openPrDetail` above.
  const openRepoDetailView = useCallback((repo: UnifiedRepo): void => {
    setRepoDetailTarget(repo);
    setView("repoDetail");
  }, []);

  // ── Derived-mnemonic bindings (mnemonic spec §2/§4): ONE context table
  // drives the footer chips, the help modal, and the keyboard dispatch tail —
  // render and input consume the same derivation and cannot drift. ──
  const bindingContext: BindingContext = useMemo((): BindingContext => {
    if (logOverlay) return { kind: "logOverlay" };
    if (filtering) return { kind: "structuralOnly", view: "filtering" };
    switch (view) {
      case "help":
      case "palette":
      case "addRepo":
      case "config":
        return { kind: "structuralOnly", view };
      case "detail":
      case "repoDetail":
      case "prs":
      case "prDetail":
      case "review":
      case "cmdOutput":
        return { kind: "view", view };
      case "main":
        return {
          kind: "main",
          body:
            body?.kind === "issues"
              ? "issues"
              : body?.kind === "section"
                ? body.section
                : "repoDetail",
        };
    }
  }, [logOverlay, filtering, view, body]);
  const bindings = useMemo(
    () => buildContextBindings(bindingContext, pane, layout.mode),
    [bindingContext, pane, layout.mode],
  );
  // Help opens over the MAIN view only; the modal lists the bindings of the
  // surface underneath it (the help context itself derives nothing).
  const helpBindings = useMemo(
    () =>
      buildContextBindings(
        {
          kind: "main",
          body:
            body?.kind === "issues"
              ? "issues"
              : body?.kind === "section"
                ? body.section
                : "repoDetail",
        },
        pane,
        layout.mode,
      ),
    [body, pane, layout.mode],
  );

  // ── THE action table: id-keyed handlers shared by the keyboard dispatch
  // tail AND the footer chips — one implementation per verb, guards included.
  // (Replaces the key-keyed footerActions whose entries duplicated every
  // keyboard branch verbatim; that drift class is structurally gone.) ──
  const actionHandlers: Record<string, () => void> = useMemo((): Record<string, () => void> => {
    if (confirm !== null) return {}; // destructive confirm owns input
    const close = (): void => {
      if (logOverlay) {
        setLogOverlay(false);
        setLogSearchMode(false);
        return;
      }
      if (view === "prDetail") return void setView(prDetail?.from ?? "main");
      if (view === "cmdOutput") return void setView("palette");
      setView("main");
    };
    if (logOverlay) {
      return {
        close,
        follow: () => {
          // Pause lands at the tail first (toEnd) so the paused window shows
          // the newest lines, not a jump to the top.
          if (logFollow) {
            setLogFollow(false);
            toEnd();
          } else {
            setLogFollow(true);
          }
        },
        level: () => setLogFilters((f) => ({ ...f, minLevel: cycleLevel(f.minLevel) })),
        ticket: () => {
          // Cycle null (all) → each ticket present in the buffer → back to null.
          const opts: (string | null)[] = [null, ...distinctTickets(logEntries)];
          const idx = opts.indexOf(logFilters.ticket);
          setLogFilters((f) => ({ ...f, ticket: opts[(idx + 1) % opts.length] }));
        },
      };
    }
    switch (view) {
      case "detail":
        return { browser: openDetailIssueInBrowser, close };
      case "prDetail":
        return { browser: openPrDetailInBrowser, close };
      case "repoDetail":
        return {
          close,
          browser: () => {
            const nwo = repoDetailTarget?.nwo;
            if (nwo !== null && nwo !== undefined) openRepoBrowser(nwo);
            else showToast("info", "no GitHub URL");
          },
        };
      case "prs":
        return { browser: openSelectedPr, close };
      case "cmdOutput":
        return {
          close,
          ...(cmd && !cmd.running
            ? { reRun: () => runPaletteCommand(cmd.name, cmd.extraArgs) }
            : {}),
        };
      case "review": {
        // Optimistic removal shared by post and discard: drop the draft, close
        // the preview, clamp the cursor to the (shrunk) combined list.
        const dropDraft = (id: string): void => {
          setReviewState((s) => {
            const drafts = s.drafts.filter((d) => d.id !== id);
            const total = s.batches.length + drafts.length;
            return { ...s, drafts, open: null, cursor: Math.min(s.cursor, Math.max(0, total - 1)) };
          });
        };
        return {
          close,
          all: () =>
            setReviewState((s) => {
              const batch = s.open?.kind === "batch" ? s.batches[s.open.batchIdx] : undefined;
              return s.open && s.open.kind === "batch" && batch
                ? {
                    ...s,
                    open: { ...s.open, checked: new Set(batch.findings.map((f) => f.fingerprint)) },
                  }
                : s;
            }),
          none: () =>
            setReviewState((s) =>
              s.open && s.open.kind === "batch"
                ? { ...s, open: { ...s.open, checked: new Set() } }
                : s,
            ),
          file: () => {
            const rs = reviewState;
            if (rs.open?.kind === "draft") {
              const draft = rs.drafts[rs.open.draftIdx];
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
            if (rs.open?.kind === "batch") {
              const open = rs.open;
              const batch = rs.batches[open.batchIdx];
              if (!batch) return;
              const fps = batch.findings
                .map((f) => f.fingerprint)
                .filter((fp) => open.checked.has(fp));
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
                    const batches = s.batches.map((b) => (b.id === id ? v.batch : b));
                    const nextOpen =
                      s.open && s.open.kind === "batch"
                        ? {
                            ...s.open,
                            checked: new Set(
                              [...s.open.checked].filter((fp) => !v.batch.filed?.[fp]),
                            ),
                          }
                        : s.open;
                    return { ...s, batches, open: nextOpen };
                  });
                } else {
                  showToast("error", res.error);
                }
              });
            }
          },
          discard: () => {
            const rs = reviewState;
            if (rs.open?.kind === "draft") {
              const draft = rs.drafts[rs.open.draftIdx];
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
            if (rs.open?.kind === "batch") {
              const batch = rs.batches[rs.open.batchIdx];
              if (!batch) return;
              const id = batch.id;
              void client.discardReview(id).then((res) => {
                if (!aliveRef.current) return;
                if (res.ok) {
                  showToast("success", "discarded");
                  setReviewState((s) => {
                    const batches = s.batches.filter((b) => b.id !== id);
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
            }
          },
        };
      }
      case "palette":
      case "addRepo":
      case "config":
      case "help":
        return {};
      case "main": {
        const currentExternal = currentRepo?.external === true;
        return {
          quit: () => {
            exit();
            onExit();
          },
          help: () => setView("help"),
          queue: () => {
            setRailSel(sysKey("queue"));
            setPane(2);
          },
          prs: () => {
            setView("prs");
            void githubRefreshAll({ scope: "monitor" });
          },
          review: () => {
            setReviewState((s) => ({ ...s, loading: true, error: null, open: null, cursor: 0 }));
            setView("review");
            void loadReview();
          },
          commands: () => {
            resetPalette();
            setView("palette");
          },
          addRepo: () => {
            if (!props.githubEnabled)
              return void showToast("info", "github mode is off ([github] enabled=false)");
            if (watchlistError)
              return void showToast("error", "watchlist unreadable — fix it before adding");
            setAddRepoError(null);
            setView("addRepo");
          },
          refresh: () => {
            void forceLocalRefresh();
            if (currentNwo) {
              githubSetRefreshing(true);
              void githubRefreshAll().finally(() => githubSetRefreshing(false));
            }
          },
          unwatch: () => {
            if (selectedRow?.kind === "repo" && selectedRow.repo.watched && selectedRow.repo.nwo) {
              return void unwatch(selectedRow.repo.nwo);
            }
            showToast("info", "not in watchlist");
          },
          // Pane-aware: 1 → the selected rail repo, 3 → the selected PR,
          // 2 issues → the selected issue.
          browser: () => {
            if (pane === 1 || body?.kind !== "issues") {
              if (selectedRow?.kind === "repo" && selectedRow.repo.nwo)
                return void openRepoBrowser(selectedRow.repo.nwo);
              return void showToast("info", "no GitHub URL");
            }
            if (pane === 3) {
              if (selectedPane3Pr) {
                const { nwo, number } = selectedPane3Pr;
                void client.openPrInBrowser(nwo, number).then((res) => {
                  if (!aliveRef.current) return;
                  if (!res.ok) showToast("error", res.error);
                });
              }
              return;
            }
            void openBrowser();
          },
          // Pane-aware like the old `s`: issues pane with a selection scopes
          // to the issue; everywhere else repo-scoped.
          assess: () => {
            if (pane === 2 && body?.kind === "issues" && currentNwo && currentIssue) {
              return void runAssess(false, `${currentNwo}#${currentIssue.number}`);
            }
            void runAssess(false);
          },
          assessAutoPlan: () => {
            if (pane === 2 && body?.kind === "issues" && currentNwo && currentIssue) {
              return void runAssess(true, `${currentNwo}#${currentIssue.number}`);
            }
            void runAssess(true);
          },
          dispatch: () => {
            if (body?.kind !== "issues") return;
            if (!currentExternal) return void runAction("dispatch");
            if (!currentNwo || !currentIssue) return;
            const num = currentIssue.number;
            showToast("info", `dispatching ${currentNwo}#${num}…`);
            void client.dispatchTicket(currentNwo, num).then((res) => {
              if (!aliveRef.current) return;
              if (res.ok) showToast("success", `ticket queued: ${res.value.id}`);
              else showToast("error", res.error);
            });
          },
          dispatchAsk: () => {
            if (body?.kind !== "issues") return;
            if (currentExternal) {
              return void showToast(
                "error",
                "not available for external repos — dispatch queues a fork-PR ticket",
              );
            }
            void runAction("dispatchAsk");
          },
          approve: () => {
            if (body?.kind !== "issues") return;
            if (currentExternal) {
              return void showToast(
                "error",
                "not available for external repos — dispatch queues a fork-PR ticket",
              );
            }
            void runAction("approve");
          },
          replan: () => {
            if (body?.kind !== "issues") return;
            if (currentExternal) {
              return void showToast(
                "error",
                "not available for external repos — dispatch queues a fork-PR ticket",
              );
            }
            const st = currentIssue ? deriveState(currentIssue.labels, trigger) : "raw";
            void runAction(st === "plan-ready" || st === "approved" ? "replan" : "recycle");
          },
          analyze: () => {
            if (body?.kind !== "issues") return;
            if (!currentNwo || !currentIssue) return;
            const num = currentIssue.number;
            showToast("info", `drafting analysis for ${currentNwo}#${num}…`);
            void client.analyzeIssue(currentNwo, num).then((res) => {
              if (!aliveRef.current) return;
              if (res.ok)
                showToast("success", `analysis queued: ${res.value.id} · v to review when parked`);
              else showToast("error", res.error);
            });
          },
          // Section-body verbs — the ex-handleSectionBodyInput recipes,
          // localTarget guards included (highlight == target invariant).
          retry: () => {
            if (sysSection !== "queue") return;
            const tgt = localTarget;
            if (tgt?.kind === "recent" && tgt.status === "failed")
              return void runLocalAction("retry", [tgt.id], { label: "requeue" });
            if (tgt?.kind === "recent" && tgt.status === "done")
              return void showToast("info", "done tickets can't be requeued");
          },
          delete: () => {
            if (sysSection !== "queue") return;
            const tgt = localTarget;
            if (tgt?.kind !== "waiting") return;
            askConfirm({
              title: "delete queued ticket",
              danger: true,
              body: `Delete inbox/${tgt.id}.md? (best-effort; the daemon may have claimed it)`,
              onConfirm: () => runLocalAction("rm", [tgt.id]),
            });
          },
          flush: () => {
            if (sysSection === "outbox" || sysSection === "daemon")
              runLocalAction("outbox", ["flush"], { label: "flush" });
          },
          prune: () => {
            if (sysSection !== "worktrees") return;
            const tgt = localTarget;
            if (tgt?.kind !== "worktree") return;
            if (tgt.klass === "live") return void showToast("info", "live worktree — not prunable");
            askConfirm({
              title: "prune worktree",
              danger: true,
              body: `Prune ${tgt.slug} (${tgt.klass})? git worktree remove --force under the daemon lock.`,
              onConfirm: () => runLocalAction("worktree", ["prune", tgt.path], { label: "prune" }),
            });
          },
          restart: () => {
            if (sysSection !== "daemon") return;
            const n = localCheap?.daemon.currentTickets.length ?? 0;
            askConfirm({
              title: "restart daemon",
              danger: true,
              body: `Restart will interrupt ${n} in-flight ticket(s) (soft-abort, committed work salvaged). Continue?`,
              onConfirm: () => runLocalAction("restart", [], { label: "restart" }),
            });
          },
        };
      }
    }
  }, [
    confirm,
    logOverlay,
    logFollow,
    logFilters,
    logEntries,
    toEnd,
    view,
    cmd,
    prDetail,
    reviewState,
    loadReview,
    watchlistError,
    pane,
    currentRepo,
    currentNwo,
    currentIssue,
    selectedPane3Pr,
    selectedRow,
    body,
    sysSection,
    localTarget,
    localCheap,
    repoDetailTarget,
    client,
    trigger,
    exit,
    onExit,
    forceLocalRefresh,
    runLocalAction,
    askConfirm,
    openRepoBrowser,
    openDetailIssueInBrowser,
    openPrDetailInBrowser,
    openSelectedPr,
    runPaletteCommand,
    githubRefreshAll,
    githubSetRefreshing,
    showToast,
    runAction,
    runAssess,
    openBrowser,
    unwatch,
    props.githubEnabled,
    resetPalette,
    setAddRepoError,
    setLogFilters,
    setLogFollow,
    setLogOverlay,
    setLogSearchMode,
    setReviewState,
  ]);

  // Clickable STRUCTURAL chips (key-keyed): the non-derivable siblings of the
  // action table — esc/enter/←/, recipes per context.
  const structuralChipActions: Record<string, () => void> = useMemo((): Record<
    string,
    () => void
  > => {
    if (confirm !== null) return {};
    if (logOverlay)
      return {
        esc: () => {
          setLogOverlay(false);
          setLogSearchMode(false);
        },
      };
    switch (view) {
      case "detail":
      case "repoDetail":
      case "review":
        return { esc: () => setView("main") };
      case "prDetail":
        return { esc: () => setView(prDetail?.from ?? "main") };
      case "prs":
        return {
          "esc/p": () => setView("main"),
          enter: () => openPrDetail(selectedPr, "prs"),
        };
      case "cmdOutput":
        return { esc: () => setView("palette") };
      case "palette":
        return { esc: () => setView("main"), enter: () => paletteEnter() };
      case "addRepo":
      case "config":
        return { esc: () => setView("main") };
      case "help":
        return {};
      case "main":
        return {
          ",": () => setView("config"),
          "←": () => setPane(1),
          "/": () => {
            if (body?.kind !== "issues") return;
            setFiltering(true);
            setPane(2);
          },
          enter: () => {
            if (pane === 3) return void openPrDetail(selectedPane3Pr, "main");
            if (pane === 1 && selectedRow?.kind === "repo")
              return void openRepoDetailView(selectedRow.repo);
            if (sysSection === "logs") return void onLogExpand();
            if (pane === 2 && body?.kind === "issues") void openDetail();
          },
        };
    }
  }, [
    confirm,
    logOverlay,
    view,
    prDetail,
    selectedPr,
    pane,
    body,
    sysSection,
    selectedRow,
    selectedPane3Pr,
    openPrDetail,
    openRepoDetailView,
    onLogExpand,
    openDetail,
    paletteEnter,
    setLogOverlay,
    setLogSearchMode,
  ]);
  // Chip click resolution: mnemonic chips by ID, structural chips by KEY.
  const chipActions = useMemo(
    () => ({ ...structuralChipActions, ...actionHandlers }),
    [structuralChipActions, actionHandlers],
  );

  // A press that hit no region. Modal-ish views read it as esc/cancel; the
  // confirm modal deliberately IGNORES it (destructive confirmation stays
  // keyboard-only). Everything else: no-op.
  const onMouseMiss = useMemo(() => {
    if (confirm !== null) return null;
    if (view === "help") return () => setView("main");
    if (view === "palette") return () => setView("main");
    if (view === "addRepo") return () => setView("main");
    return null;
  }, [confirm, view]);
  useOnMouseMiss(onMouseMiss);

  // Press-dismisses toasts app-wide (parity with the old dismissToast()-on-press;
  // unlike the old path this also covers LOCAL and modal views — deliberate).
  useOnAnyMousePress(dismissToast);

  // App's FIRST input hook: a dedicated Ctrl-C quit for the dashboard surface.
  // The host renders with exitOnCtrlC:false (so the setup walkthrough it also
  // hosts can see Ctrl-C — see dashboardCmd's INK_RENDER_OPTIONS), which means
  // ink no longer quits on Ctrl-C for us. This hook replaces that built-in for
  // the App: every ink input subscriber receives every event, so it fires
  // regardless of which view or text field currently owns focus. Same
  // exit()/onExit() pair the `q` handler uses.
  useGuardedInput((input, key) => {
    if (key.ctrl && input === "c") {
      exit();
      onExit();
    }
  });

  // The full-screen log overlay's input recipes — the overlay owns ALL input
  // while open; its filter/follow/scroll keys never leak to the body
  // underneath. Invoked ahead of every view branch in the cascade below.
  const handleLogOverlayInput = (input: string, key: Key): void => {
    if (logSearchMode) {
      // Live search entry: printable chars extend the term; Enter commits it
      // (keeps the term, exits entry); Esc discards the term AND exits.
      if (key.escape) {
        setLogFilters((f) => ({ ...f, search: "" }));
        setLogSearchMode(false);
        return;
      }
      if (key.return) {
        setLogSearchMode(false);
        return;
      }
      if (key.backspace || key.delete) {
        setLogFilters((f) => ({ ...f, search: f.search.slice(0, -1) }));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setLogFilters((f) => ({ ...f, search: f.search + input }));
        return;
      }
      return;
    }
    if (key.escape) {
      setLogOverlay(false);
      setLogSearchMode(false);
      return;
    }
    if (input === "/") {
      setLogSearchMode(true);
      return;
    }
    if (input === "G" || key.end) {
      setLogFollow(true);
      return;
    }
    if (input === "[" || key.upArrow) {
      // Scrolling up pauses follow, landing at the tail first so the step-up
      // is relative to the bottom rather than a stale offset.
      if (logFollow) {
        setLogFollow(false);
        toEnd();
      }
      scrollBy(-1);
      return;
    }
    if (input === "]" || key.downArrow) {
      scrollBy(1);
      return;
    }
    // Derived-mnemonic tail (follow/level/ticket + the reserved q close) —
    // the overlay owns input, so its dispatch lives here, not the cascade's.
    const actionId = bindings.keymap.get(input);
    if (actionId !== undefined) actionHandlers[actionId]?.();
    return;
  };

  // Section-body key recipes (pane 2 while a system row is selected) — the
  // ex-LOCAL body branches verbatim, keyed off sysSection + localTarget.
  const handleSectionBodyInput = (input: string, key: Key): void => {
    if (key.escape || input === "h" || key.leftArrow) {
      setPane(1);
      return;
    }
    if (sysSection === "daemon") {
      // Scroll-only panel; Restart/flush dispatch at layer 3d.
      if (input === "[" || key.upArrow) return void scrollBy(-1);
      if (input === "]" || key.downArrow) return void scrollBy(1);
      return;
    }
    if (sysSection === "logs") {
      // Row-less viewport: enter/l/→ opens the overlay (parity with the rail
      // enter; both go through onLogExpand so opening always tails live).
      if (input === "l" || key.rightArrow || key.return) return void onLogExpand();
      return;
    }
    if (input === "j" || key.downArrow) return void moveSectionCursor(1);
    if (input === "k" || key.upArrow) return void moveSectionCursor(-1);
    if (input === "g" && sysSection !== null)
      return void setSectionCursor((m) => ({ ...m, [sysSection]: 0 }));
    if (input === "G" && sysSection !== null)
      return void setSectionCursor((m) => ({
        ...m,
        [sysSection]: Math.max(0, localRows.length - 1),
      }));
    // Named section verbs (retry/Delete/flush/Prune) dispatch at layer 3d —
    // their handlers keep the highlight == target guards (localTarget).
  };

  useGuardedInput((input, key) => {
    // Ctrl-C is owned by the dedicated first hook above (quit). Bail before the
    // cascade so it can never be misread as a plain `c` (e.g. the analyze
    // binding) now that exitOnCtrlC:false lets Ctrl-C reach these handlers.
    if (key.ctrl && input === "c") return;
    // layer 2 — the confirm modal owns input while open, ahead of EVERY view
    // branch including the text-owning ones below: the add-repo bot-grant
    // gate opens asynchronously (post-preflight), so it can land while
    // addRepo/config hold the view — and the modal ternary has already
    // replaced (addRepo) or covered (config, its useInput detached via
    // inputActive) that body. Handling confirm first keeps the modal
    // keyboard-operable there instead of dead behind the early returns.
    // Toast is dismissed by the next keystroke, before it is acted on.
    if (confirm) {
      dismissToast();
      if (key.escape || input === "n") {
        const onCancel = confirm.onCancel;
        clearConfirm();
        onCancel?.();
        return;
      }
      // Enter confirms only a NON-danger confirm. A danger confirm demands the
      // literal `y`: the unwatch modal opens from an async continuation (after
      // its `--plan` spawn resolves), so a stray Enter typed during that window
      // must never land on a destructive confirm the operator hasn't read.
      if ((key.return && !confirm.danger) || input === "y") {
        const fn = confirm.onConfirm;
        clearConfirm();
        fn();
        return;
      }
      return;
    }

    // The AddRepoForm (+ its TextFields) own all input while open.
    if (view === "addRepo") return; // layer 2a (text field owns input)

    // ConfigView owns all input while open (own useInput + onExit, mirroring
    // addRepo above) — kept ahead of the mode toggle and LOCAL dispatch so
    // neither `m` nor a LOCAL-mode key ever leaks past it mid-edit.
    if (view === "config") return; // layer 2b

    // layer 3 — toast dismissal for every branch below the modal layers.
    dismissToast();

    // layer 3b — the full-screen log overlay owns ALL input while open; its
    // filter/follow/scroll keys never leak to the view underneath.
    if (logOverlay) {
      handleLogOverlayInput(input, key);
      return;
    }

    // layer 3c — `,` opens the in-dashboard config editor, from the main view
    // only (never stealing the key from help/detail/prs/palette/etc.).
    if (input === "," && view === "main" && !filtering) {
      setView("config");
      return;
    }

    // layer 3d — derived-mnemonic dispatch (mnemonic spec §4). The keymap
    // never contains structural keys, and every text-owning context
    // (filtering/palette/addRepo/config) is structuralOnly with an EMPTY
    // keymap, so this sits safely ahead of the view branches. Help stays
    // any-key-close because its context derives nothing either.
    if (view !== "help") {
      const actionId = bindings.keymap.get(input);
      if (actionId !== undefined) {
        actionHandlers[actionId]?.();
        return;
      }
    }

    // layer 4 ── the view cascade ──

    if (view === "help") {
      setView("main"); // any key closes
      return;
    }

    if (view === "repoDetail") {
      if (key.escape) return void setView("main");
      if (input === "]" || key.downArrow) return void scrollBy(1);
      if (input === "[" || key.upArrow) return void scrollBy(-1);
      return;
    }

    if (view === "detail") {
      if (key.escape) return void setView("main");
      if (input === "]" || key.downArrow) return void scrollBy(1);
      if (input === "[" || key.upArrow) return void scrollBy(-1);
      return;
    }

    if (view === "prDetail") {
      // esc AND q both return — unlike the issue detail view, the overlay has
      // no dedicated re-open key to double as its close key, so q (otherwise
      // the global quit key, unreachable from any sub-view) fills that slot.
      if (key.escape) {
        // `from`'s pane/selection state was never touched while the overlay
        // was open, so returning here restores it for free.
        return void setView(prDetail?.from ?? "main");
      }
      return;
    }

    if (view === "prs") {
      if (key.escape || input === "p") return void setView("main");
      if (input === "j" || key.downArrow) return void movePr(1);
      if (input === "k" || key.upArrow) return void movePr(-1);
      if (input === "g") return void movePrTo(0);
      if (input === "G") return void movePrTo(github.prs.length - 1);
      if (key.return) return void openPrDetail(selectedPr, "prs");
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
      if (key.escape) return void setView("palette");
      if (input === "]" || key.downArrow) return void scrollBy(1);
      if (input === "[" || key.upArrow) return void scrollBy(-1);
      return;
    }

    if (view === "review") {
      const rs = reviewState;
      // Comment-draft preview mode: scroll + post (enter) + back — the named
      // verbs (file/post, Discard, all/none) dispatch via the derived keymap.
      if (rs.open && rs.open.kind === "draft") {
        if (key.escape) return void setReviewState((s) => ({ ...s, open: null }));
        if (input === "k" || key.upArrow) return void scrollBy(-1);
        if (input === "j" || key.downArrow) return void scrollBy(1);
        if (key.return) return void actionHandlers["file"]?.();
        return;
      }
      // Assess checklist mode.
      if (rs.open && rs.open.kind === "batch") {
        const batch = rs.batches[rs.open.batchIdx];
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
        if (key.return) return void actionHandlers["file"]?.();
        return;
      }
      // Combined-list mode: cursor over batches then drafts; enter opens either.
      if (key.escape) return void setView("main");
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
                checked: new Set(
                  batch.findings
                    .filter((f) => !batch.filed?.[f.fingerprint])
                    .map((f) => f.fingerprint),
                ),
              },
            };
          }
          const draftIdx = s.cursor - s.batches.length;
          if (!s.drafts[draftIdx]) return s;
          return { ...s, open: { kind: "draft", draftIdx } };
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

    // Named verbs (quit/help/queue/PRs/review/…) dispatched at layer 3d via
    // the derived keymap; `,` config at layer 3c. `:` stays a structural
    // symbol alias for the palette alongside the derived `c` commands key.
    if (input === ":") {
      resetPalette();
      setView("palette");
      return;
    }

    // Filter / pane routing. The live `/` filter is an ISSUES-body affordance —
    // section and RepoDetail bodies have nothing for it to filter.
    if (input === "/" && body?.kind === "issues") {
      setFiltering(true);
      setPane(2);
      return;
    }
    const maxPane: Pane = layout.mode === "wide" && body?.kind === "issues" ? 3 : 2;
    if (key.tab) {
      return void setPane((p) => (p >= maxPane ? 1 : ((p + 1) as Pane)));
    }
    if (input === "h" || key.leftArrow) return void setPane((p) => (p > 1 ? ((p - 1) as Pane) : p));
    if (input === "l" || key.rightArrow) {
      return void setPane((p) => (p < maxPane ? ((p + 1) as Pane) : p));
    }
    if (input === "i") return void setPane(2);

    if (pane === 1) {
      if (input === "j" || key.downArrow) return void moveRail(1);
      if (input === "k" || key.upArrow) return void moveRail(-1);
      if (input === "g") return void moveRailTo(0);
      if (input === "G") return void moveRailTo(railRows.length - 1);
      // Named verbs (unwatch/browser/assess/…) dispatch at layer 3d.
      if (key.return) {
        // enter: repo rows open the full-width RepoDetail; the logs row opens
        // the overlay directly; other system rows focus the body.
        if (selectedRow?.kind === "repo") return void openRepoDetailView(selectedRow.repo);
        if (selectedRow?.kind === "system" && selectedRow.section === "logs")
          return void onLogExpand();
        return void setPane(2);
      }
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
      if (key.return) return void openPrDetail(selectedPane3Pr, "main");
      return;
    }

    // ── pane 2, dispatched by body kind (spec §3) ──
    if (body?.kind === "section") {
      handleSectionBodyInput(input, key);
      return;
    }
    if (body?.kind === "repoDetail") {
      if (key.escape || input === "h" || key.leftArrow) return void setPane(1);
      if (input === "]" || key.downArrow) return void scrollBy(1);
      if (input === "[" || key.upArrow) return void scrollBy(-1);
      if (input === "o") {
        if (body.repo.nwo !== null) openRepoBrowser(body.repo.nwo);
        else showToast("info", "no GitHub URL");
        return;
      }
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
    // Named issue verbs (dispatch/approve/analyze + shift variants)
    // dispatch at layer 3d via the derived keymap.
  });

  // Review-view mouse handlers — duplicate the key recipes EXACTLY (same
  // setReviewState transitions as key.return, space, and j/k above) so mouse
  // and keyboard can never diverge on what a click/scroll does.
  const reviewRowPress = (idx: number): void => {
    if (confirm !== null) return;
    setReviewState((s) => {
      if (s.open) return s;
      if (idx !== s.cursor) return { ...s, cursor: idx };
      if (idx < s.batches.length) {
        const batch = s.batches[idx];
        if (!batch) return s;
        return {
          ...s,
          open: {
            kind: "batch",
            batchIdx: idx,
            findingCursor: 0,
            checked: new Set(
              batch.findings.filter((f) => !batch.filed?.[f.fingerprint]).map((f) => f.fingerprint),
            ),
          },
        };
      }
      const draftIdx = idx - s.batches.length;
      if (!s.drafts[draftIdx]) return s;
      return { ...s, open: { kind: "draft", draftIdx } };
    });
  };
  const reviewFindingPress = (idx: number): void => {
    if (confirm !== null) return;
    setReviewState((s) => {
      if (!s.open || s.open.kind !== "batch") return s;
      const batch = s.batches[s.open.batchIdx];
      if (!batch) return s;
      const checked = new Set(s.open.checked);
      const fp = batch.findings[idx]?.fingerprint;
      if (fp) {
        if (checked.has(fp)) checked.delete(fp);
        else checked.add(fp);
      }
      return { ...s, open: { ...s.open, findingCursor: idx, checked } };
    });
  };
  const reviewDraftWheel = (d: 1 | -1): void => scrollBy(d);

  // Unified-rail mouse handlers — mirror the rail/body key recipes above
  // (click selects; click-again = the enter key for that row kind).
  // `useCallback`'d (perf #259) so this identity only churns with its real
  // deps — `openRepoDetailView`/`onLogExpand` are themselves stable — instead
  // of every App render, which is what let it defeat `UnifiedRail`'s memo.
  const railRowPress = useCallback(
    (i: number): void => {
      if (confirm !== null || view !== "main") return;
      const row = railRows[i];
      if (!row) return;
      if (i === railIdx) {
        // Click-again = enter: repo rows open the full-width RepoDetail; the
        // logs row opens the overlay; other system rows focus the body.
        if (row.kind === "repo") return void openRepoDetailView(row.repo);
        if (row.section === "logs") return void onLogExpand();
        setPane(2);
        return;
      }
      setPane(1);
      setRailSel(rowKey(row));
    },
    [confirm, view, railRows, railIdx, openRepoDetailView, onLogExpand],
  );
  // Section-body row click: focus the body and move the cursor (a click-again
  // on the already-selected row is a no-op — destructive verbs stay on keys).
  const sectionRowPress = useCallback(
    (idx: number): void => {
      if (confirm !== null || sysSection === null) return;
      setPane(2);
      setSectionCursor((m) => ({ ...m, [sysSection]: idx }));
    },
    [confirm, sysSection],
  );

  // The remaining list-view row/pane press handlers (issues pane, prs view,
  // pane 3's repo-scoped PR list) — same story as railRowPress/sectionRowPress
  // above: these were inline arrows at the JSX call site (below), rebuilt
  // every App render regardless of whether their own deps changed, which
  // defeated IssueList/PrList's memo on every unrelated re-render (perf #259).
  const issueRowPress = useCallback(
    (i: number): void => {
      if (confirm !== null) return;
      if (pane === 2 && i === issueIdxSafe) return void openDetail();
      setPane(2);
      moveIssueTo(i);
    },
    [confirm, pane, issueIdxSafe, openDetail, moveIssueTo],
  );
  const issuePanePress = useCallback(() => setPane(2), []);
  const prsRowPress = useCallback(
    (i: number): void => {
      if (confirm !== null) return;
      if (i === prIdxSafe) return void openPrDetail(selectedPr, "prs");
      movePrTo(i);
    },
    [confirm, prIdxSafe, openPrDetail, selectedPr, movePrTo],
  );
  const pane3RowPress = useCallback(
    (i: number): void => {
      if (confirm !== null) return;
      if (pane === 3 && i === pane3IdxSafe) {
        return void openPrDetail(selectedPane3Pr, "main");
      }
      setPane(3);
      movePane3To(i);
    },
    [confirm, pane, pane3IdxSafe, openPrDetail, selectedPane3Pr, movePane3To],
  );
  const pane3PanePress = useCallback(() => setPane(3), []);

  // `RepoDetail`'s `worktrees` prop was filtered inline at both JSX call
  // sites below (`.filter(...)` always returns a fresh array, every render,
  // defeating the component's memo regardless of its callback props) —
  // hoisted into their own memos (perf #259) so the array reference only
  // changes when `localHeavy` or the target repo actually does. `body.repo`
  // (unlike `body` itself, a fresh `{kind, repo}` wrapper every render) is the
  // SAME reference across renders where `selectedRow` hasn't changed — it
  // traces back through `railRows`/`unifiedRepos`, both `useMemo`'d above.
  const bodyRepoDetailRepo = body?.kind === "repoDetail" ? body.repo : null;
  const bodyRepoWorktrees = useMemo(
    () =>
      bodyRepoDetailRepo
        ? (localHeavy?.worktrees ?? []).filter(
            (w) => w.repoPath !== null && resolve(w.repoPath) === resolve(bodyRepoDetailRepo.path),
          )
        : [],
    [localHeavy, bodyRepoDetailRepo],
  );
  const repoDetailWorktrees = useMemo(
    () =>
      repoDetailTarget
        ? (localHeavy?.worktrees ?? []).filter(
            (w) => w.repoPath !== null && resolve(w.repoPath) === resolve(repoDetailTarget.path),
          )
        : [],
    [localHeavy, repoDetailTarget],
  );

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
    onRowPress: (i: number) => {
      if (i === paletteSel) return void paletteEnter();
      setPaletteSel(i);
    },
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
        <Box gap={2}>
          <Button
            keyHint="y"
            label="confirm"
            tone={confirm.danger ? "danger" : "primary"}
            onPress={() => {
              const fn = confirm.onConfirm;
              clearConfirm();
              fn();
            }}
          />
          <Button
            keyHint="esc"
            label="cancel"
            tone="neutral"
            onPress={() => {
              const onCancel = confirm.onCancel;
              clearConfirm();
              onCancel?.();
            }}
          />
        </Box>
      </Box>
    </Modal>
  ) : view === "help" ? (
    <HelpModal
      pane={pane}
      mode={layout.mode}
      trigger={trigger}
      bindings={helpBindings}
      updateLatest={updateLatest}
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
          crumbs={crumbs}
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
          updateLatest={updateLatest}
          stats={localCheap?.queue.stats ?? queueSnap?.stats ?? null}
          runningIds={(localCheap?.queue ?? queueSnap)?.running.map((r) => r.id) ?? []}
        />
      }
      toast={toast}
      chips={bindings.chips}
      chipActions={chipActions}
      modal={modal}
      modalAlign={view === "help" ? "top" : "center"}
    >
      {view === "config" ? (
        // `,` (layer 3c) can set view="config" over any body — checked ahead
        // of the main fragment below.
        <ConfigView
          configPath={configPath}
          onExit={() => setView("main")}
          inputActive={confirm === null}
        />
      ) : logOverlay ? (
        // The full-screen log overlay replaces the whole body while open; it
        // owns input via handleLogOverlayInput in the cascade above.
        <LogView
          variant="full"
          entries={logEntries}
          filters={logFilters}
          follow={logFollow}
          searchMode={logSearchMode}
          scroll={scroll}
          height={listHeight}
          focused
          hasFile={logHasFile}
          daemonUp={localCheap ? localCheap.daemon.up : undefined}
          onScrollMax={onScrollMax}
          onWheel={(d) => {
            // Wheel-up pauses follow (landing at the tail first), mirroring the
            // `[` key recipe; wheel-down just scrolls.
            if (logFollow && d < 0) {
              setLogFollow(false);
              toEnd();
            }
            scrollBy(d);
          }}
        />
      ) : view === "review" ? (
        <ReviewView
          state={reviewState}
          scroll={scroll}
          height={listHeight}
          focused
          now={queueNow}
          onRowPress={reviewRowPress}
          onFindingPress={reviewFindingPress}
          onDraftWheel={reviewDraftWheel}
          onScrollMax={onScrollMax}
        />
      ) : (
        <>
          <UnifiedRail
            rows={railRows}
            selected={railIdx}
            focused={view === "main" && pane === 1}
            cheap={localCheap}
            heavy={localHeavy}
            issueCounts={issueCounts}
            assess={railAssess}
            width={layout.railWidth}
            height={listHeight}
            now={queueNow}
            window={railWindow}
            onRowPress={railRowPress}
            onPanePress={view === "main" && confirm === null ? railPanePress : undefined}
            onWheel={railWheel}
          />
          {view === "repoDetail" && repoDetailTarget ? (
            <RepoDetail
              repo={repoDetailTarget}
              worktrees={repoDetailWorktrees}
              queue={localCheap?.queue ?? queueSnap}
              scroll={scroll}
              height={listHeight}
              focused
              now={queueNow}
              onWheel={scrollBy}
              onScrollMax={onScrollMax}
            />
          ) : view === "cmdOutput" && cmd ? (
            <ClickableBox flexGrow={1} onWheel={(d) => scrollBy(d)}>
              <CommandOutput
                title={cmd.title}
                running={cmd.running}
                elapsedS={cmdElapsed}
                output={cmd.output}
                scroll={scroll}
                exitCode={cmd.exitCode}
                timedOut={cmd.timedOut}
                height={listHeight}
                onScrollMax={onScrollMax}
              />
            </ClickableBox>
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
              onLinkPress={openDetailIssueInBrowser}
              onWheel={scrollBy}
              onScrollMax={onScrollMax}
            />
          ) : view === "prDetail" && prDetail ? (
            <PrPreview
              pr={prDetail.pr}
              branchPrefix={branchPrefix}
              now={queueNow}
              height={listHeight}
              focused
              titleLabel="pr"
              onLinkPress={openPrDetailInBrowser}
            />
          ) : view === "prs" ? (
            <PrList
              prs={github.prs}
              selected={prIdxSafe}
              focused
              height={listHeight}
              now={queueNow}
              staleAt={prStaleAt}
              window={prWindow}
              botLogin={botLogin}
              onRowPress={prsRowPress}
              onWheel={movePr}
            />
          ) : body?.kind === "repoDetail" ? (
            <RepoDetail
              repo={body.repo}
              worktrees={bodyRepoWorktrees}
              queue={localCheap?.queue ?? queueSnap}
              scroll={scroll}
              height={listHeight}
              focused={pane === 2}
              now={queueNow}
              onWheel={scrollBy}
              onScrollMax={onScrollMax}
            />
          ) : body?.kind === "section" ? (
            // Exhaustive over SystemSection (#238): a switch with a never
            // guard, so adding a section without wiring its body fails to
            // type-check instead of silently rendering the terminal arm.
            ((section: SystemSection): React.JSX.Element => {
              switch (section) {
                case "queue":
                  return (
                    <QueueView
                      snap={localCheap?.queue ?? null}
                      scroll={scroll}
                      now={queueNow}
                      height={listHeight}
                      focused={pane === 2}
                      selectable
                      selectedRow={localCursorSafe}
                      counts={localCheap?.counts ?? null}
                      onRowPress={sectionRowPress}
                      onScrollMax={onScrollMax}
                    />
                  );
                case "outbox":
                  return (
                    <OutboxSection
                      outbox={localCheap?.outbox ?? null}
                      cursor={localCursorSafe}
                      window={sectionWin}
                      height={listHeight}
                      focused={pane === 2}
                      now={queueNow}
                      onRowPress={sectionRowPress}
                    />
                  );
                case "worktrees":
                  return (
                    <WorktreesSection
                      worktrees={localHeavy?.worktrees ?? null}
                      error={localHeavy?.error ?? null}
                      cursor={localCursorSafe}
                      window={sectionWin}
                      height={listHeight}
                      focused={pane === 2}
                      onRowPress={sectionRowPress}
                    />
                  );
                case "daemon":
                  return (
                    <DaemonSection
                      daemon={localCheap?.daemon ?? null}
                      refreshedAt={github.refreshedAt}
                      now={queueNow}
                      scroll={scroll}
                      height={listHeight}
                      focused={pane === 2}
                      onWheel={scrollBy}
                      onScrollMax={onScrollMax}
                    />
                  );
                case "logs":
                  // The section variant reports no scrollable max (its whole
                  // surface is click-to-expand), so no onWheel.
                  return (
                    <LogView
                      variant="section"
                      entries={logEntries}
                      height={listHeight}
                      focused={pane === 2}
                      hasFile={logHasFile}
                      daemonUp={localCheap ? localCheap.daemon.up : undefined}
                      onExpand={onLogExpand}
                    />
                  );
                default:
                  return assertNeverSection(section);
              }
            })(body.section)
          ) : (
            <IssueList
              issues={filteredIssues}
              trigger={trigger}
              selected={issueIdxSafe}
              focused={view === "main" && pane === 2}
              refreshing={github.refreshing}
              filter={filter}
              filtering={filtering}
              height={listHeight}
              now={queueNow}
              staleAt={currentNwo ? (github.staleAt[currentNwo] ?? null) : null}
              window={issueWindow}
              botLogin={botLogin}
              onRowPress={issueRowPress}
              onPanePress={confirm === null ? issuePanePress : undefined}
              onWheel={moveIssue}
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
                onLinkPress={selectedPr ? openSelectedPr : undefined}
              />
            ) : view === "main" && body?.kind === "issues" ? (
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
                  botLogin={botLogin}
                  paneWidth={layout.previewWidth}
                  onRowPress={pane3RowPress}
                  onPanePress={confirm === null ? pane3PanePress : undefined}
                  onWheel={movePane3}
                />
              </Box>
            ) : view === "main" && body?.kind === "section" ? (
              <ActivityCard
                stats={localCheap?.queue.stats ?? queueSnap?.stats ?? null}
                width={layout.previewWidth}
                height={listHeight}
              />
            ) : view === "main" && body?.kind === "repoDetail" ? (
              <ReservedNote
                text="local repo — no linked PRs"
                width={layout.previewWidth}
                height={listHeight}
              />
            ) : null)}
        </>
      )}
    </Workspace>
  );
}
