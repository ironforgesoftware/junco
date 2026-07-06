/**
 * Dashboard composition root: wires the panes, routes keystrokes by view then
 * pane, polls issues + health on intervals, and applies actions optimistically
 * (local label delta shown immediately, rolled back with a toast if gh fails).
 * Holds NO queue state — every issue's lifecycle is derived from its labels.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, useApp, useInput } from "ink";
import type { DashboardClient, HealthInfo } from "./ghClient.js";
import type { DashAction, DashIssue } from "./state.js";
import { allowedActions, deriveState, sortIssues } from "./state.js";
import { lifecycleLabels } from "../githubInbox.js";
import type { WatchlistEntry } from "../watchlist.js";
import { readWatchlist, writeWatchlist } from "../watchlist.js";
import type { GithubRepoMapping } from "../types.js";
import { RepoList } from "./components/RepoList.js";
import type { RepoRow } from "./components/RepoList.js";
import { IssueTable } from "./components/IssueTable.js";
import { IssueDetail } from "./components/IssueDetail.js";
import { StatusBar } from "./components/StatusBar.js";
import { HelpOverlay } from "./components/HelpOverlay.js";
import { AddRepoForm } from "./components/AddRepoForm.js";

export interface AppProps {
  client: DashboardClient;
  trigger: string;
  configRepos: GithubRepoMapping[]; // read-only entries
  watchlistFile: string; // read/write via watchlist.ts
  issuePollMs?: number; // default 30_000; tests pass large values
  healthPollMs?: number; // default 5_000
  onExit: () => void;
}

type Pane = "repos" | "issues";
type View = "main" | "detail" | "help" | "addRepo";
interface DetailState {
  body: string | null;
  planComment: string | null;
  loading: boolean;
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
  const { client, trigger, configRepos, watchlistFile, onExit } = props;
  const issuePollMs = props.issuePollMs ?? 30_000;
  const healthPollMs = props.healthPollMs ?? 5_000;
  const { exit } = useApp();

  const [watchlistEntries, setWatchlistEntries] = useState<WatchlistEntry[]>(
    () => readWatchlist(watchlistFile).entries,
  );
  const [repoIdx, setRepoIdx] = useState(0);
  const [issues, setIssues] = useState<Record<string, DashIssue[]>>({});
  const [issueIdx, setIssueIdx] = useState(0);
  const [pane, setPane] = useState<Pane>("repos");
  const [view, setView] = useState<View>("main");
  const [detail, setDetail] = useState<DetailState>({
    body: null,
    planComment: null,
    loading: false,
  });
  const [scroll, setScroll] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [addRepoError, setAddRepoError] = useState<string | null>(null);
  const [addRepoBusy, setAddRepoBusy] = useState(false);

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
  const issueIdxSafe = Math.max(0, Math.min(issueIdx, currentIssues.length - 1));
  const currentIssue = currentIssues[issueIdxSafe];

  // Per-repo issue counts for the RepoList badges, derived from loaded issues.
  const repoRows: RepoRow[] = repoMappings.map((r) => {
    const counts: RepoRow["counts"] = {};
    for (const iss of issues[r.nwo] ?? []) {
      const st = deriveState(iss.labels, trigger);
      counts[st] = (counts[st] ?? 0) + 1;
    }
    return { nwo: r.nwo, fromConfig: r.fromConfig, counts };
  });

  const loadIssues = useCallback(
    (nwo: string) => {
      void client.listIssues(nwo).then((res) => {
        if (res.ok) {
          setIssues((prev) => ({ ...prev, [nwo]: sortIssues(res.value, trigger) }));
        } else {
          setToast(res.error);
        }
      });
    },
    [client, trigger],
  );

  // Load issues for the selected repo (initial mount + every selection change).
  useEffect(() => {
    if (!currentNwo) return;
    setIssueIdx(0);
    loadIssues(currentNwo);
  }, [currentNwo, loadIssues]);

  // Issue polling — reads the live selection from a ref so the interval never
  // goes stale as the operator navigates.
  const nwoRef = useRef<string | undefined>(currentNwo);
  nwoRef.current = currentNwo;
  useEffect(() => {
    const id = setInterval(() => {
      const nwo = nwoRef.current;
      if (nwo) loadIssues(nwo);
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
        setToast(`${action} not available in state ${st}`);
        return;
      }
      const nwo = currentNwo;
      const num = currentIssue.number;
      const prevLabels = currentIssue.labels;
      setIssueLabels(nwo, num, optimisticLabels(action, prevLabels, trigger));
      void client.applyAction(nwo, num, action, prevLabels).then((res) => {
        if (!res.ok) {
          setIssueLabels(nwo, num, prevLabels);
          setToast(res.error);
        } else {
          setToast(`${action} applied`);
        }
      });
    },
    [client, currentNwo, currentIssue, trigger, setIssueLabels],
  );

  const openDetail = useCallback(() => {
    if (!currentNwo || !currentIssue) return;
    const nwo = currentNwo;
    const num = currentIssue.number;
    setScroll(0);
    setDetail({ body: null, planComment: null, loading: true });
    setView("detail");
    void client.issueDetail(nwo, num).then((res) => {
      if (res.ok) {
        setDetail({ body: res.value.body, planComment: res.value.planComment, loading: false });
      } else {
        setDetail({ body: null, planComment: null, loading: false });
        setToast(res.error);
      }
    });
  }, [client, currentNwo, currentIssue]);

  const openBrowser = useCallback(() => {
    if (!currentNwo || !currentIssue) return;
    void client.openInBrowser(currentNwo, currentIssue.number).then((res) => {
      if (!res.ok) setToast(res.error);
    });
  }, [client, currentNwo, currentIssue]);

  const unwatch = useCallback(() => {
    if (!currentRepo) return;
    if (currentRepo.fromConfig) {
      setToast(`${currentRepo.nwo} is defined in config.toml`);
      return;
    }
    const cur = readWatchlist(watchlistFile).entries;
    const next = cur.filter((e) => e.nwo.toLowerCase() !== currentRepo.nwo.toLowerCase());
    writeWatchlist(watchlistFile, next);
    setWatchlistEntries(next);
    setToast(`unwatched ${currentRepo.nwo}`);
  }, [currentRepo, watchlistFile]);

  const handleAddRepo = useCallback(
    async (nwo: string, path: string): Promise<void> => {
      setAddRepoBusy(true);
      setAddRepoError(null);
      const res = await client.validateAndPrepareRepo(nwo, path);
      setAddRepoBusy(false);
      if (!res.ok) {
        setAddRepoError(res.error);
        return;
      }
      const cur = readWatchlist(watchlistFile).entries;
      const next = [...cur, { nwo, path }];
      writeWatchlist(watchlistFile, next);
      setWatchlistEntries(next);
      setView("main");
      setToast(`watching ${nwo}`);
    },
    [client, watchlistFile],
  );

  useInput((input, key) => {
    // The AddRepoForm (+ its TextFields) own all input while open.
    if (view === "addRepo") return;

    // Toast is dismissed by the next keystroke, before it is acted on.
    if (toast) setToast(null);

    if (view === "help") {
      setView("main"); // any key closes
      return;
    }

    if (view === "detail") {
      if (key.escape) return void setView("main");
      if (input === "j" || key.downArrow) return void setScroll((s) => s + 1);
      if (input === "k" || key.upArrow) return void setScroll((s) => Math.max(0, s - 1));
      return;
    }

    // main view
    if (input === "q") {
      exit();
      onExit();
      return;
    }
    if (input === "?") return void setView("help");
    if (key.tab) return void setPane((p) => (p === "repos" ? "issues" : "repos"));
    if (input === "h") return void setPane("repos");
    if (input === "l") return void setPane("issues");
    if (input === "A") {
      setAddRepoError(null);
      setView("addRepo");
      return;
    }
    if (input === "r") {
      if (currentNwo) loadIssues(currentNwo);
      return;
    }

    if (pane === "repos") {
      if (input === "j" || key.downArrow) {
        return void setRepoIdx((i) => Math.min(i + 1, repoMappings.length - 1));
      }
      if (input === "k" || key.upArrow) return void setRepoIdx((i) => Math.max(0, i - 1));
      if (input === "x") return void unwatch();
      return;
    }

    // issues pane
    if (input === "j" || key.downArrow) {
      return void setIssueIdx((i) => Math.min(i + 1, currentIssues.length - 1));
    }
    if (input === "k" || key.upArrow) return void setIssueIdx((i) => Math.max(0, i - 1));
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

  const hints = "? keys · q quit";

  return (
    <Box flexDirection="column">
      <Box>
        <RepoList
          repos={repoRows}
          selected={repoIdxSafe}
          focused={view === "main" && pane === "repos"}
        />
        {view === "detail" && currentIssue ? (
          <IssueDetail
            issue={currentIssue}
            trigger={trigger}
            body={detail.body}
            planComment={detail.planComment}
            loading={detail.loading}
            scroll={scroll}
          />
        ) : (
          <IssueTable
            issues={currentIssues}
            trigger={trigger}
            selected={issueIdxSafe}
            focused={view === "main" && pane === "issues"}
          />
        )}
      </Box>
      <StatusBar health={health} toast={toast} hints={hints} />
      {view === "help" && <HelpOverlay trigger={trigger} />}
      {view === "addRepo" && (
        <AddRepoForm
          error={addRepoError}
          busy={addRepoBusy}
          onSubmit={(nwo, path) => void handleAddRepo(nwo, path)}
          onCancel={() => setView("main")}
        />
      )}
    </Box>
  );
}
