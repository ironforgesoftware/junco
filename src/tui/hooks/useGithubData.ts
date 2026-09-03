import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { DashboardClient } from "../ghClient.js";
import type { DashIssue } from "../state.js";
import { filterIssues, sortIssues } from "../state.js";
import type { DashPr } from "../prState.js";
import { sortPrs } from "../prState.js";
import { keepIfEqual } from "./keepIfEqual.js";
import type { WatchedMapping } from "../railModel.js";
import type { ToastKind } from "../theme.js";
import type { View } from "../App.js";

/** What a loader actually delivered — the unified cycle aggregates these to
 * stamp refreshedAt (oldest cache staleAt wins; nothing delivered → no stamp). */
export type Delivery = { delivered: boolean; staleAt: string | null };

/** Read-only nav-spine inputs this hook needs (owned by App — never moved
 * here): the selected repo's nwo (undefined off a repo row), the active
 * view (drives the poll's main/monitor scope), and the selected row's body
 * kind (gates loadIssues' error toast so a background poll never flashes red
 * over a section/RepoDetail body). */
export interface GithubDataNav {
  currentNwo: string | undefined;
  view: View;
  bodyKind: "issues" | "repoDetail" | "section" | null;
}

/**
 * Inputs to `useGithubData`. The nav spine (`nav`) and `filter` are read-only
 * reflections of App-owned state; `repoMappings` comes from `useWatchlist` and
 * its identity change is what re-fires the watchlist sweep (see `refreshAll`).
 */
export interface UseGithubDataOpts {
  client: DashboardClient;
  trigger: string;
  /** When false no gh cycle ever fires (unified-view spec §6). */
  githubEnabled: boolean;
  repoMappings: WatchedMapping[];
  showToast: (kind: ToastKind, text: string) => void;
  /** The unified poll's interval (App's `refreshPollMs`, default 30_000). */
  refreshPollMs: number;
  /** The live `/` filter query — `filter`/`setFiltering`/the clear-on-repo-
   * change effect all stay App-owned (domain P, not github), but the current
   * VALUE is a read-only input here: the issue-side selection resolution
   * (`issueIdxSafe`/`currentIssue`/`moveIssue`) needs the filtered view of
   * `issues[currentNwo]`, and that view can only be computed from this hook's
   * OWN `issues` state — accepting the already-filtered array instead would
   * create a circular dependency (the hook consuming its own output). */
  filter: string;
  nav: GithubDataNav;
}

export interface UseGithubDataResult {
  issues: Record<string, DashIssue[]>;
  staleAt: Record<string, string | null>;
  refreshedAt: string | null;
  selectedNum: Record<string, number>;
  prs: DashPr[];
  prStaleByRepo: Record<string, string | null>;
  prSel: { nwo: string; number: number } | null;
  pane3SelNum: number | null;
  refreshing: boolean;
  setRefreshing: Dispatch<SetStateAction<boolean>>;
  refreshAll: (opts?: { isAlive?: () => boolean; scope?: "main" | "monitor" }) => Promise<void>;
  loadIssues: (nwo: string) => Promise<Delivery>;
  loadPrs: (isAlive?: () => boolean) => Promise<Delivery>;
  loadPrsFor: (nwo: string, isAlive?: () => boolean) => Promise<Delivery>;
  setIssueLabels: (nwo: string, num: number, labels: string[]) => void;
  /** Drops `nwo`'s issues/staleAt/prStaleByRepo entries and its PRs from the
   * cross-repo aggregate — the github half of unwatch's cleanup. Synchronous
   * (no poll round-trip): the rail badges and header pulse must never read
   * ghost data for a repo that just left the watchlist. */
  evictRepo: (nwo: string) => void;
  // Selection-resolution (anchored-number/anchored-{nwo,number} → a safe live
  // index) — kept beside the state+refs it resolves against so the fallback
  // refs (below) have exactly one owner shared by both the anchor-validation
  // effects and this render-time resolution.
  /** `issues[currentNwo]`, filtered by the live `/` query — App's IssueList
   * render prop; also what `issueIdxSafe`/`moveIssue` resolve against. */
  filteredIssues: DashIssue[];
  issueIdxSafe: number;
  currentIssue: DashIssue | undefined;
  prIdxSafe: number;
  selectedPr: DashPr | null;
  /** The cross-repo PR aggregate scoped to `nav.currentNwo`, re-sorted
   * attention-first — pane 3's data source. */
  repoPrs: DashPr[];
  pane3IdxSafe: number;
  selectedPane3Pr: DashPr | null;
  moveIssue: (delta: number) => void;
  moveIssueTo: (idx: number) => void;
  movePr: (delta: number) => void;
  movePrTo: (idx: number) => void;
  movePane3: (delta: number) => void;
  movePane3To: (idx: number) => void;
}

/**
 * The fused GitHub-data core: issues + PRs + the unified refresh cycle.
 * `nav` is read-only — App owns the actual view/pane/rail-selection state and
 * passes its derived shape in every render, mirroring the `aliveRef` coupling
 * every other extracted hook already uses for cross-cutting App state.
 *
 * `loadPrs`'s identity tracks `repoMappings` (not just `client`) — that
 * identity chain is load-bearing: `refreshAll` closes over `loadPrs`, so a
 * `repoMappings` change (a repo added/removed) re-identifies `refreshAll`,
 * which re-fires the watchlist-sweep effect that depends on it. Do not
 * stabilize `refreshAll` away (no ref-wrapping it) and do not drop
 * `repoMappings` from `loadPrs`'s deps — that would silently break the
 * "newly-watched repo's PRs appear without a monitor visit" behavior.
 */
export function useGithubData(opts: UseGithubDataOpts): UseGithubDataResult {
  const { client, trigger, githubEnabled, repoMappings, showToast, refreshPollMs, filter, nav } =
    opts;
  const currentNwo = nav.currentNwo;

  const [issues, setIssues] = useState<Record<string, DashIssue[]>>({});
  // Per-repo listIssues staleAt (cache-served while offline); null = fresh.
  const [staleAt, setStaleAt] = useState<Record<string, string | null>>({});
  // When the last unified refresh cycle completed. Cache-served (offline)
  // sources pull it back to the oldest cache staleAt, so data that arrived
  // stale never reads as fresh. Surfaced in the daemon panel's "refreshed"
  // stat row.
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null);
  // Selection is anchored to the issue NUMBER (per repo), NOT a positional
  // index, so a poll that re-sorts the list keeps the cursor on the same issue.
  const [selectedNum, setSelectedNum] = useState<Record<string, number>>({});
  // Cross-repo PR aggregate — one flat, already-sorted list (attention-first).
  const [prs, setPrs] = useState<DashPr[]>([]);
  // Per-repo listPrs staleAt so a SCOPED refresh clears only its own repo's
  // marker; the list-level prStaleAt derives (in App) as the oldest non-null
  // entry among watched repos.
  const [prStaleByRepo, setPrStaleByRepo] = useState<Record<string, string | null>>({});
  // PR selection anchor: {nwo, number} because PR numbers collide across
  // repos — a bare-number anchor would jump on re-sort.
  const [prSel, setPrSel] = useState<{ nwo: string; number: number } | null>(null);
  // Pane-3 selection anchor: a bare PR NUMBER, because every candidate here is
  // already scoped to ONE repo (no {nwo, number} collision risk).
  const [pane3SelNum, setPane3SelNum] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // Live body kind for the poll callbacks: a background issues poll must not
  // flash a github error toast while a section/RepoDetail body owns the
  // screen. Read via a ref so loadIssues' identity — and the intervals keyed
  // on it — don't churn on every rail move.
  const bodyKindRef = useRef<string | null>(nav.bodyKind);
  bodyKindRef.current = nav.bodyKind;
  // Live refs so the unified cycle and its interval never go stale as the
  // operator navigates repos or switches views.
  const nwoRef = useRef<string | undefined>(nav.currentNwo);
  nwoRef.current = nav.currentNwo;
  const viewRef = useRef(nav.view);
  viewRef.current = nav.view;

  const loadIssues = useCallback(
    (nwo: string): Promise<Delivery> => {
      return client.listIssues(nwo).then((res) => {
        if (res.ok) {
          setIssues((prev) =>
            keepIfEqual(prev, { ...prev, [nwo]: sortIssues(res.value.issues, trigger) }),
          );
          setStaleAt((prev) => keepIfEqual(prev, { ...prev, [nwo]: res.value.staleAt }));
          return { delivered: true, staleAt: res.value.staleAt };
        }
        // Only surface the error toast when an issues body is on screen — this
        // same loader fires on the background poll regardless of the selected
        // row, and a failing github probe must never flash a red toast over a
        // section or RepoDetail body.
        if (bodyKindRef.current === "issues" && githubEnabled) showToast("error", res.error);
        return { delivered: false, staleAt: null };
      });
    },
    [client, trigger, showToast, githubEnabled],
  );

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
        setPrs((prev) => keepIfEqual(prev, sortPrs(all)));
        setPrStaleByRepo((prev) => keepIfEqual(prev, staleMap));
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
        setPrs((prev) =>
          keepIfEqual(prev, sortPrs([...prev.filter((p) => p.nwo !== nwo), ...res.value.prs])),
        );
        setPrStaleByRepo((prev) => keepIfEqual(prev, { ...prev, [nwo]: res.value.staleAt }));
        return { delivered: true, staleAt: res.value.staleAt };
      });
    },
    [client],
  );

  // The ONE refresh cycle. Scope follows the view unless overridden (the `p`
  // handler must sweep before the "prs" view state has committed): main →
  // selected repo's issues + PRs; monitor → every watched repo's PRs. Stamps
  // refreshedAt on completion — oldest cache staleAt wins, and a cycle where
  // nothing delivered never advances the stamp.
  const refreshAll = useCallback(
    (refreshOpts: { isAlive?: () => boolean; scope?: "main" | "monitor" } = {}): Promise<void> => {
      // github off → NO gh cycle ever fires (spec §6): issues are unreachable
      // (nwo rows render RepoDetail) and the monitor sweep must stay silent.
      if (!githubEnabled) return Promise.resolve();
      const isAlive = refreshOpts.isAlive ?? ((): boolean => true);
      const inMonitor =
        refreshOpts.scope !== undefined
          ? refreshOpts.scope === "monitor"
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
    [loadIssues, loadPrs, loadPrsFor, githubEnabled],
  );

  const setIssueLabels = useCallback((nwo: string, num: number, labels: string[]) => {
    setIssues((prev) => {
      const arr = prev[nwo];
      if (!arr) return prev;
      return { ...prev, [nwo]: arr.map((i) => (i.number === num ? { ...i, labels } : i)) };
    });
  }, []);

  // Drop a repo's cached issue/PR state — the rail badges and the header
  // pulse must never read ghost data for a repo that is no longer watched.
  // Called synchronously from `unwatch` (never re-derived from a poll), so
  // the eviction is visible in the SAME render pass the watchlist write lands.
  const evictRepo = useCallback((nwo: string) => {
    setIssues((prev) => {
      if (!(nwo in prev)) return prev;
      const rest = { ...prev };
      delete rest[nwo];
      return rest;
    });
    setStaleAt((prev) => {
      if (!(nwo in prev)) return prev;
      const rest = { ...prev };
      delete rest[nwo];
      return rest;
    });
    setPrStaleByRepo((prev) => {
      if (!(nwo in prev)) return prev;
      const rest = { ...prev };
      delete rest[nwo];
      return rest;
    });
    // ...and its PRs from the cross-repo aggregate — the ⚑ attention chip and
    // the PRs view must drop the repo immediately, not on the next poll.
    setPrs((prev) => prev.filter((p) => p.nwo !== nwo));
  }, []);

  // Scoped cycle for the selected repo (initial mount + every selection
  // change): the data under the operator's eyes refreshes immediately.
  useEffect(() => {
    if (!currentNwo) return;
    void refreshAll();
  }, [currentNwo, refreshAll]);

  // Last resolved positional index — the fallback when the selected issue
  // number vanishes from the list (closed/filtered), so the cursor stays near
  // its slot.
  const lastIdxRef = useRef(0);
  // Same fallback, for the PR list: the slot the cursor returns to when the
  // anchored {nwo, number} vanishes (merged/closed and rolled off the limit).
  const lastPrIdxRef = useRef(0);
  // Same fallback, for pane 3's repo-scoped PR list.
  const lastPane3IdxRef = useRef(0);

  // Keep the per-repo anchored selection valid: pick the top row on first
  // load, and when the selected issue disappears fall back to the same slot.
  // A number that is still present is left untouched so re-sorts don't move
  // the cursor. Reads the RAW per-repo list (not `filteredIssues`) — the live
  // `/` filter must never itself evict an anchor, only the render-time
  // resolution below (which DOES read the filtered list) falls back when a
  // number is filtered out.
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

  // Keep the PR anchor valid: top row on first load, and the same slot when
  // the anchored PR disappears. A still-present anchor is left untouched so a
  // re-sorting poll never slides a different PR under the cursor.
  useEffect(() => {
    if (prs.length === 0) return;
    setPrSel((cur) => {
      if (cur && prs.some((p) => p.nwo === cur.nwo && p.number === cur.number)) return cur;
      const idx = Math.max(0, Math.min(lastPrIdxRef.current, prs.length - 1));
      return { nwo: prs[idx].nwo, number: prs[idx].number };
    });
  }, [prs]);

  // Pane-3 data: the cross-repo PR aggregate, scoped to the rail's selected
  // repo and re-sorted the same way the aggregate itself is (attention-first).
  const repoPrs = useMemo(
    () => sortPrs(prs.filter((p) => p.nwo === currentNwo)),
    [prs, currentNwo],
  );

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

  // The live `/` filter is applied before selection resolves; the number
  // anchor survives re-filtering and the issueIdxSafe clamp handles a
  // shrinking list. `currentIssues` is computed INSIDE the memo (rather than
  // as its own variable) because the `?? []` fallback allocates a fresh array
  // literal on every render whenever the repo's issues haven't loaded yet —
  // as an external variable that would make the memo's dependency itself
  // unstable; folded in here, the memo's own deps (`currentNwo`, `issues`)
  // are the primitives/state that actually gate recomputation.
  const filteredIssues = useMemo(() => {
    const currentIssues = currentNwo ? (issues[currentNwo] ?? []) : [];
    return filterIssues(currentIssues, filter, trigger);
  }, [currentNwo, issues, filter, trigger]);

  // Resolve the anchored number to a live index; fall back to the clamped
  // last index only when that issue is gone (closed, or filtered out).
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

  // Resolve the anchored PR to a live index in the sorted aggregate; fall
  // back to the clamped last slot only when that PR is gone (mirrors the
  // issue anchor above — the anchor survives a re-sorting poll).
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

  // Move the anchored NUMBER, not a bare index — a re-sorting poll must keep
  // the cursor on the same issue. Shared by keyboard and mouse (wheel/click).
  // `useCallback`'d (perf pass #259) so App can pass these straight through as
  // memo'd components' `onWheel`/`onRowPress` props instead of wrapping them in
  // a fresh arrow every render — the identity is only as stable as its deps,
  // which is exactly what lets it stay flat across an unrelated App re-render.
  // Resolves the step from the PENDING anchor, not the render's index: a held
  // key's run reaches useGuardedInput as one chunk and replays inside ONE
  // closure, so steps taken from `issueIdxSafe` would all land on the same
  // row. The render's index stays the fallback for an anchor that is gone.
  const moveIssue = useCallback(
    (delta: number): void => {
      if (!currentNwo || filteredIssues.length === 0) return;
      setSelectedNum((m) => {
        const at = filteredIssues.findIndex((i) => i.number === m[currentNwo]);
        const from = at >= 0 ? at : issueIdxSafe;
        const next = Math.max(0, Math.min(from + delta, filteredIssues.length - 1));
        return { ...m, [currentNwo]: filteredIssues[next].number };
      });
    },
    [currentNwo, filteredIssues, issueIdxSafe],
  );
  const moveIssueTo = useCallback(
    (idx: number): void => {
      if (!currentNwo || filteredIssues.length === 0) return;
      const clamped = Math.max(0, Math.min(idx, filteredIssues.length - 1));
      setSelectedNum((m) => ({ ...m, [currentNwo]: filteredIssues[clamped].number }));
    },
    [currentNwo, filteredIssues],
  );

  // Move the anchored {nwo, number}, never a bare index — a re-sorting poll
  // must keep the cursor on the same PR. Hoisted for the same reason as above.
  const movePr = useCallback(
    (delta: number): void => {
      if (prs.length === 0) return;
      setPrSel((sel) => {
        // Pending anchor first (see moveIssue), the render's index as fallback.
        const at = sel ? prs.findIndex((p) => p.nwo === sel.nwo && p.number === sel.number) : -1;
        const from = at >= 0 ? at : prIdxSafe;
        const next = Math.max(0, Math.min(from + delta, prs.length - 1));
        return { nwo: prs[next].nwo, number: prs[next].number };
      });
    },
    [prs, prIdxSafe],
  );
  const movePrTo = useCallback(
    (idx: number): void => {
      if (prs.length === 0) return;
      const clamped = Math.max(0, Math.min(idx, prs.length - 1));
      setPrSel({ nwo: prs[clamped].nwo, number: prs[clamped].number });
    },
    [prs],
  );

  // Pane-3 movers, hoisted (like moveIssue/movePr) so the mouse handler and
  // the keyboard branch share one anchored-NUMBER implementation.
  const movePane3 = useCallback(
    (delta: number): void => {
      if (repoPrs.length === 0) return;
      setPane3SelNum((num) => {
        // Pending anchor first (see moveIssue), the render's index as fallback.
        const at = num === null ? -1 : repoPrs.findIndex((p) => p.number === num);
        const from = at >= 0 ? at : pane3IdxSafe;
        return repoPrs[Math.max(0, Math.min(from + delta, repoPrs.length - 1))].number;
      });
    },
    [repoPrs, pane3IdxSafe],
  );
  const movePane3To = useCallback(
    (idx: number): void => {
      if (repoPrs.length === 0) return;
      const clamped = Math.max(0, Math.min(idx, repoPrs.length - 1));
      setPane3SelNum(repoPrs[clamped].number);
    },
    [repoPrs],
  );

  return {
    issues,
    staleAt,
    refreshedAt,
    selectedNum,
    prs,
    prStaleByRepo,
    prSel,
    pane3SelNum,
    refreshing,
    setRefreshing,
    refreshAll,
    loadIssues,
    loadPrs,
    loadPrsFor,
    setIssueLabels,
    evictRepo,
    filteredIssues,
    issueIdxSafe,
    currentIssue,
    prIdxSafe,
    selectedPr,
    repoPrs,
    pane3IdxSafe,
    selectedPane3Pr,
    moveIssue,
    moveIssueTo,
    movePr,
    movePrTo,
    movePane3,
    movePane3To,
  };
}
