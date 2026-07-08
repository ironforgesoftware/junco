/**
 * Dashboard composition root: wires the fullscreen workspace, routes keystrokes
 * by view then pane, polls issues + health + queue on intervals, and applies
 * actions optimistically (local label delta shown immediately, rolled back with
 * a toast if gh fails). Holds NO queue state — every issue's lifecycle is
 * derived from its labels.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, useApp, useInput } from "ink";
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
import { Workspace } from "./components/Workspace.js";
import { Header, hintsFor, type HintView } from "./components/Chrome.js";
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
import { PALETTE_COMMANDS, runCliCommand, type CliRunResult } from "./cliRunner.js";
import type { QueueSnapshot } from "./queueSnapshot.js";
import type { ToastKind } from "./theme.js";

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
  issuePollMs?: number; // default 30_000; tests pass large values
  healthPollMs?: number; // default 5_000
  prPollMs?: number; // default 60_000 — statusCheckRollup is a heavier call
  /** Local queue snapshot source (dashboardCmd wires makeQueueSnapshotFn). */
  queueFn: () => Promise<QueueSnapshot>;
  queuePollMs?: number; // default 2_000
  /** Palette command runner override (tests). Defaults to the real subprocess. */
  runCliFn?: (name: string, extraArgs: string[]) => Promise<CliRunResult>;
  /** Fixed terminal size (tests) — ink-testing-library has no resizable stdout. */
  sizeOverride?: TerminalSize;
  onExit: () => void;
}

// Panes: 1 repos (rail), 2 issues (list), 3 PRs for the selected repo (wide
// terminals only).
type Pane = 1 | 2 | 3;
type View =
  | "main"
  | "detail"
  | "help"
  | "addRepo"
  | "palette"
  | "cmdOutput"
  | "queue"
  | "prs"
  | "prDetail";

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
  const issuePollMs = props.issuePollMs ?? 30_000;
  const healthPollMs = props.healthPollMs ?? 5_000;
  const queuePollMs = props.queuePollMs ?? 2_000;
  const prPollMs = props.prPollMs ?? 60_000;
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
  // Selection is anchored to the issue NUMBER (per repo), NOT a positional index,
  // so a poll that re-sorts the list keeps the cursor on the same issue.
  const [selectedNum, setSelectedNum] = useState<Record<string, number>>({});
  // Cross-repo PR aggregate — one flat, already-sorted list (attention-first).
  const [prs, setPrs] = useState<DashPr[]>([]);
  // Oldest non-null per-repo staleAt across the aggregate (any offline repo → a
  // stale marker); null when every repo served fresh.
  const [prStaleAt, setPrStaleAt] = useState<string | null>(null);
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
    const out = configRepos.map((r) => ({ nwo: r.nwo, path: r.path, fromConfig: true }));
    const seen = new Set(out.map((r) => r.nwo.toLowerCase()));
    for (const e of watchlistEntries) {
      if (seen.has(e.nwo.toLowerCase())) continue;
      seen.add(e.nwo.toLowerCase());
      out.push({ nwo: e.nwo, path: e.path, fromConfig: false });
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
    (nwo: string): Promise<void> => {
      return client.listIssues(nwo).then((res) => {
        if (res.ok) {
          setIssues((prev) => ({ ...prev, [nwo]: sortIssues(res.value.issues, trigger) }));
          setStaleAt((prev) => ({ ...prev, [nwo]: res.value.staleAt }));
        } else {
          showToast("error", res.error);
        }
      });
    },
    [client, trigger, showToast],
  );

  // Cross-repo PR aggregate: fetch every watched repo independently (a failed
  // repo contributes nothing and never blocks the others — and is NOT toasted
  // on the poll path), flatten, sort attention-first, and surface the OLDEST
  // non-null staleAt so the list shows a stale marker when any repo is offline.
  const loadPrs = useCallback(
    (isAlive: () => boolean = () => true): Promise<void> => {
      const targets = repoMappings.map((r) => r.nwo);
      return Promise.all(targets.map((nwo) => client.listPrs(nwo))).then((results) => {
        if (!isAlive()) return;
        const all: DashPr[] = [];
        let oldestStale: string | null = null;
        for (const res of results) {
          if (!res.ok) continue; // one repo down: skip it, never block the rest
          all.push(...res.value.prs);
          const s = res.value.staleAt;
          if (s !== null && (oldestStale === null || Date.parse(s) < Date.parse(oldestStale))) {
            oldestStale = s;
          }
        }
        setPrs(sortPrs(all));
        setPrStaleAt(oldestStale);
      });
    },
    [client, repoMappings],
  );

  // Load issues for the selected repo (initial mount + every selection change).
  useEffect(() => {
    if (!currentNwo) return;
    void loadIssues(currentNwo);
  }, [currentNwo, loadIssues]);

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

  // Issue polling — reads the live selection from a ref so the interval never
  // goes stale as the operator navigates.
  const nwoRef = useRef<string | undefined>(currentNwo);
  nwoRef.current = currentNwo;
  useEffect(() => {
    const id = setInterval(() => {
      const nwo = nwoRef.current;
      if (nwo) void loadIssues(nwo);
    }, issuePollMs);
    return () => clearInterval(id);
  }, [issuePollMs, loadIssues]);

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

  // Cross-repo PR polling (fires once on mount, then on the interval). Re-runs
  // when repoMappings changes (a watch/unwatch) so a newly-watched repo's PRs
  // appear on the next tick. The alive guard threads through loadPrs so a poll
  // in flight when the app unmounts never sets state.
  useEffect(() => {
    let alive = true;
    void loadPrs(() => alive);
    const id = setInterval(() => void loadPrs(() => alive), prPollMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [loadPrs, prPollMs]);

  const setIssueLabels = useCallback((nwo: string, num: number, labels: string[]) => {
    setIssues((prev) => {
      const arr = prev[nwo];
      if (!arr) return prev;
      return { ...prev, [nwo]: arr.map((i) => (i.number === num ? { ...i, labels } : i)) };
    });
  }, []);

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
    setDetail({ issue: snapshot, body: null, planComment: null, loading: true });
    setView("detail");
    void client.issueDetail(nwo, num).then((res) => {
      if (res.ok) {
        setDetail({
          issue: snapshot,
          body: res.value.body,
          planComment: res.value.planComment,
          loading: false,
        });
      } else {
        setDetail({ issue: snapshot, body: null, planComment: null, loading: false });
        showToast("error", res.error);
      }
    });
  }, [client, currentNwo, currentIssue, showToast]);

  const openBrowser = useCallback(() => {
    if (!currentNwo || !currentIssue) return;
    void client.openInBrowser(currentNwo, currentIssue.number).then((res) => {
      if (!res.ok) showToast("error", res.error);
    });
  }, [client, currentNwo, currentIssue, showToast]);

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

  const unwatch = useCallback(() => {
    if (!currentRepo) return;
    if (currentRepo.fromConfig) {
      showToast("info", `${currentRepo.nwo} is defined in config.toml`);
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
    const next = cur.filter((e) => e.nwo.toLowerCase() !== currentRepo.nwo.toLowerCase());
    writeWatchlist(watchlistFile, next);
    setWatchlistEntries(next);
    // Drop the repo's cached issue state too — the rail badges and the header
    // pulse must never read ghost data for a repo that is no longer watched.
    const gone = currentRepo.nwo;
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
    // ...and its PRs from the cross-repo aggregate — the ⚑ attention chip and
    // the PRs view must drop the repo immediately, not on the next poll.
    setPrs((prev) => prev.filter((p) => p.nwo !== gone));
    showToast("success", `unwatched ${currentRepo.nwo}`);
  }, [currentRepo, watchlistFile, watchlistError, showToast]);

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
      // Empty path = clone into the managed directory for the operator.
      let expanded: string;
      setAddRepoError(null);
      if (path.trim() === "") {
        const [owner, repo] = nwo.split("/");
        expanded = join(clonesDir, owner ?? nwo, repo ?? "repo");
        setAddRepoBusy("cloning repository…");
        const cloned = await client.cloneRepo(nwo, expanded);
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

  useInput((input, key) => {
    // The AddRepoForm (+ its TextFields) own all input while open.
    if (view === "addRepo") return;

    // Toast is dismissed by the next keystroke, before it is acted on.
    if (toast) {
      setToast(null);
      if (toastTimer.current) {
        clearTimeout(toastTimer.current);
        toastTimer.current = null;
      }
    }

    if (view === "help") {
      setView("main"); // any key closes
      return;
    }

    if (view === "detail") {
      if (key.escape) {
        setScroll(0); // shared offset — don't bleed it into the next view that reads it
        return void setView("main");
      }
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
      if (input === "o") {
        if (prDetail) {
          const { nwo, number } = prDetail.pr;
          void client.openPrInBrowser(nwo, number).then((res) => {
            if (!res.ok) showToast("error", res.error);
          });
        }
        return;
      }
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
      // Move the anchored {nwo, number}, never a bare index — a re-sorting poll
      // must keep the cursor on the same PR.
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
      if (input === "j" || key.downArrow) return void movePr(1);
      if (input === "k" || key.upArrow) return void movePr(-1);
      if (input === "g") return void movePrTo(0);
      if (input === "G") return void movePrTo(prs.length - 1);
      if (input === "o") {
        if (selectedPr) {
          const { nwo, number } = selectedPr;
          void client.openPrInBrowser(nwo, number).then((res) => {
            if (!res.ok) showToast("error", res.error);
          });
        }
        return;
      }
      if (key.return) {
        if (selectedPr) {
          setPrDetail({ pr: selectedPr, from: "prs" });
          setView("prDetail");
        }
        return;
      }
      if (input === "r") return void loadPrs();
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
    if (input === "p") {
      setScroll(0);
      setView("prs");
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
      if (currentNwo) {
        setRefreshing(true);
        void loadIssues(currentNwo).finally(() => setRefreshing(false));
      }
      return;
    }

    if (pane === 1) {
      if (input === "j" || key.downArrow) {
        return void setRepoIdx((i) => Math.min(i + 1, repoMappings.length - 1));
      }
      if (input === "k" || key.upArrow) return void setRepoIdx((i) => Math.max(0, i - 1));
      if (input === "g") return void setRepoIdx(0);
      if (input === "G") return void setRepoIdx(repoMappings.length - 1);
      if (input === "x") return void unwatch();
      return;
    }

    if (pane === 3) {
      if (key.escape) return void setPane(2);
      // Move the anchored PR NUMBER, never a bare index — mirrors the prs-view
      // anchor so a re-sorting poll keeps the cursor on the same PR.
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
      if (input === "j" || key.downArrow) return void movePane3(1);
      if (input === "k" || key.upArrow) return void movePane3(-1);
      if (input === "g") return void movePane3To(0);
      if (input === "G") return void movePane3To(repoPrs.length - 1);
      if (input === "o") {
        if (selectedPane3Pr) {
          const { nwo, number } = selectedPane3Pr;
          void client.openPrInBrowser(nwo, number).then((res) => {
            if (!res.ok) showToast("error", res.error);
          });
        }
        return;
      }
      if (key.return) {
        if (selectedPane3Pr) {
          setPrDetail({ pr: selectedPane3Pr, from: "main" });
          setView("prDetail");
        }
        return;
      }
      return;
    }

    // ── issues pane (2) — move the anchored NUMBER, not a bare index. ──
    if (key.escape) {
      if (filter !== "") setFilter("");
      return;
    }
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
    if (input === "j" || key.downArrow) return void moveIssue(1);
    if (input === "k" || key.upArrow) return void moveIssue(-1);
    if (input === "g") return void moveIssueTo(0);
    if (input === "G") return void moveIssueTo(filteredIssues.length - 1);
    if (key.return) return void openDetail();
    if (input === "d") return void runAction("dispatch");
    if (input === "D") return void runAction("dispatchAsk");
    if (input === "a") return void runAction("approve");
    if (input === "R") {
      const st = currentIssue ? deriveState(currentIssue.labels, trigger) : "raw";
      return void runAction(st === "plan-ready" || st === "approved" ? "replan" : "recycle");
    }
    if (input === "o") return void openBrowser();
  });

  const hints = hintsFor(view as HintView, pane, layout.mode, filtering);
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
  const modal =
    view === "help" ? (
      <HelpModal view="main" pane={pane} mode={layout.mode} trigger={trigger} />
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
        />
      }
      toast={toast}
      hints={hints}
      modal={modal}
      modalAlign={view === "help" ? "top" : "center"}
    >
      <Rail
        repos={repoRows}
        selected={repoIdxSafe}
        focused={view === "main" && pane === 1}
        queue={queueSnap}
        width={layout.railWidth}
        height={listHeight}
      />
      {view === "queue" ? (
        <QueueView snap={queueSnap} scroll={scroll} now={queueNow} height={listHeight} focused />
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
              title={pane3Title}
              emptyText="no junco PRs for this repo"
            />
          </Box>
        ) : null)}
    </Workspace>
  );
}
