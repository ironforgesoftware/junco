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
import { lifecycleLabels, parseRepoInput } from "../githubInbox.js";
import type { WatchlistEntry } from "../watchlist.js";
import { readWatchlist, writeWatchlist } from "../watchlist.js";
import { expandHome } from "../config.js";
import { join } from "node:path";
import type { GithubRepoMapping } from "../types.js";
import { RepoList } from "./components/RepoList.js";
import type { RepoRow } from "./components/RepoList.js";
import { IssueTable } from "./components/IssueTable.js";
import { IssueDetail } from "./components/IssueDetail.js";
import { StatusBar } from "./components/StatusBar.js";
import { HelpOverlay } from "./components/HelpOverlay.js";
import { AddRepoForm } from "./components/AddRepoForm.js";
import { CommandPalette, filterCommands } from "./components/CommandPalette.js";
import { CommandOutput } from "./components/CommandOutput.js";
import { ShortcutBar } from "./components/ShortcutBar.js";
import { PALETTE_COMMANDS, runCliCommand, type CliRunResult } from "./cliRunner.js";
import { QueueStrip } from "./components/QueueStrip.js";
import { QueueView } from "./components/QueueView.js";
import type { QueueSnapshot } from "./queueSnapshot.js";

export interface AppProps {
  client: DashboardClient;
  trigger: string;
  configRepos: GithubRepoMapping[]; // read-only entries
  watchlistFile: string; // read/write via watchlist.ts
  /** Resolved config path — spawned palette commands target the same config. */
  configPath: string;
  /** Managed clones root (<state_dir>/repos) — auto-clone destination. */
  clonesDir: string;
  issuePollMs?: number; // default 30_000; tests pass large values
  healthPollMs?: number; // default 5_000
  /** Local queue snapshot source (dashboardCmd wires makeQueueSnapshotFn). */
  queueFn: () => Promise<QueueSnapshot>;
  queuePollMs?: number; // default 2_000
  /** Palette command runner override (tests). Defaults to the real subprocess. */
  runCliFn?: (name: string, extraArgs: string[]) => Promise<CliRunResult>;
  onExit: () => void;
}

type Pane = "repos" | "issues";
type View = "main" | "detail" | "help" | "addRepo" | "palette" | "cmdOutput" | "queue";

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
  const { client, trigger, configRepos, watchlistFile, configPath, clonesDir, queueFn, onExit } =
    props;
  const issuePollMs = props.issuePollMs ?? 30_000;
  const healthPollMs = props.healthPollMs ?? 5_000;
  const queuePollMs = props.queuePollMs ?? 2_000;
  const runCliFn =
    props.runCliFn ??
    ((name: string, extraArgs: string[]) => runCliCommand(configPath, name, extraArgs));
  const { exit } = useApp();

  const initialWatchlist = readWatchlist(watchlistFile);
  const [watchlistEntries, setWatchlistEntries] = useState<WatchlistEntry[]>(
    initialWatchlist.entries,
  );
  const [watchlistError, setWatchlistError] = useState<string | null>(initialWatchlist.error);
  const [repoIdx, setRepoIdx] = useState(0);
  const [issues, setIssues] = useState<Record<string, DashIssue[]>>({});
  // Selection is anchored to the issue NUMBER (per repo), NOT a positional index,
  // so a poll that re-sorts the list keeps the cursor on the same issue.
  const [selectedNum, setSelectedNum] = useState<Record<string, number>>({});
  const [pane, setPane] = useState<Pane>("repos");
  const [view, setView] = useState<View>("main");
  const [detail, setDetail] = useState<DetailState | null>(null);
  const [scroll, setScroll] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
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
  // Resolve the anchored number to a live index; fall back to the clamped last
  // index only when that issue is gone.
  const selNum = currentNwo ? selectedNum[currentNwo] : undefined;
  const byNum = selNum !== undefined ? currentIssues.findIndex((i) => i.number === selNum) : -1;
  const issueIdxSafe =
    currentIssues.length === 0
      ? 0
      : byNum >= 0
        ? byNum
        : Math.min(lastIdxRef.current, currentIssues.length - 1);
  lastIdxRef.current = issueIdxSafe;
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
    (nwo: string): Promise<void> => {
      return client.listIssues(nwo).then((res) => {
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
    void loadIssues(currentNwo);
  }, [currentNwo, loadIssues]);

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
      setToast(`${current.name}: ${current.excluded}`);
      return;
    }
    if (current.argsHint && !paletteArgsMode) {
      setPaletteArgsMode(true);
      return;
    }
    const typed = paletteArgs.split(/\s+/).filter(Boolean);
    const extraArgs = typed.length > 0 ? typed : current.defaultArgs;
    runPaletteCommand(current.name, extraArgs);
  }, [paletteFilter, paletteSel, paletteArgsMode, paletteArgs, runPaletteCommand]);

  const unwatch = useCallback(() => {
    if (!currentRepo) return;
    if (currentRepo.fromConfig) {
      setToast(`${currentRepo.nwo} is defined in config.toml`);
      return;
    }
    if (watchlistError) {
      setToast("watchlist unreadable — fix it before writing");
      return;
    }
    // Re-read at write time: never clobber a file that went corrupt since mount.
    const { entries: cur, error } = readWatchlist(watchlistFile);
    if (error) {
      setWatchlistError(error);
      setToast("watchlist unreadable — not written");
      return;
    }
    const next = cur.filter((e) => e.nwo.toLowerCase() !== currentRepo.nwo.toLowerCase());
    writeWatchlist(watchlistFile, next);
    setWatchlistEntries(next);
    setToast(`unwatched ${currentRepo.nwo}`);
  }, [currentRepo, watchlistFile, watchlistError]);

  const handleAddRepo = useCallback(
    async (rawNwo: string, path: string): Promise<void> => {
      let nwo = rawNwo;
      if (watchlistError) {
        setToast("watchlist unreadable — fix it before writing");
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
        setToast("watchlist unreadable — not written");
        return;
      }
      const next = [...cur, { nwo, path: expanded }];
      writeWatchlist(watchlistFile, next);
      setWatchlistEntries(next);
      setView("main");
      setToast(`watching ${nwo}`);
    },
    [client, watchlistFile, watchlistError],
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
      if (input === "]" || key.downArrow) return void setScroll((s) => s + 1);
      if (input === "[" || key.upArrow) return void setScroll((s) => Math.max(0, s - 1));
      return;
    }

    if (view === "queue") {
      if (key.escape || input === "t") return void setView("main");
      if (input === "]" || key.downArrow) return void setScroll((s) => s + 1);
      if (input === "[" || key.upArrow) return void setScroll((s) => Math.max(0, s - 1));
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
      if (input === "]" || key.downArrow) return void setScroll((s) => s + 1);
      if (input === "[" || key.upArrow) return void setScroll((s) => Math.max(0, s - 1));
      if (input === "r" && cmd && !cmd.running) {
        return void runPaletteCommand(cmd.name, cmd.extraArgs);
      }
      return;
    }

    // main view
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
    if (input === ":") {
      setPaletteFilter("");
      setPaletteSel(0);
      setPaletteArgsMode(false);
      setPaletteArgs("");
      setView("palette");
      return;
    }
    if (key.tab) return void setPane((p) => (p === "repos" ? "issues" : "repos"));
    if (input === "h") return void setPane("repos");
    if (input === "l" || input === "i") return void setPane("issues");
    // `w` is the watchlist key (opens add-repo).
    if (input === "w") {
      if (watchlistError) {
        setToast("watchlist unreadable — fix it before adding");
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

    if (pane === "repos") {
      if (input === "j" || key.downArrow) {
        return void setRepoIdx((i) => Math.min(i + 1, repoMappings.length - 1));
      }
      if (input === "k" || key.upArrow) return void setRepoIdx((i) => Math.max(0, i - 1));
      if (input === "x") return void unwatch();
      return;
    }

    // issues pane — move the anchored NUMBER, not a bare index.
    const moveIssue = (delta: number): void => {
      if (!currentNwo || currentIssues.length === 0) return;
      const next = Math.max(0, Math.min(issueIdxSafe + delta, currentIssues.length - 1));
      const num = currentIssues[next].number;
      setSelectedNum((m) => ({ ...m, [currentNwo]: num }));
    };
    if (input === "j" || key.downArrow) return void moveIssue(1);
    if (input === "k" || key.upArrow) return void moveIssue(-1);
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

  return (
    <Box flexDirection="column">
      <Box>
        <RepoList
          repos={repoRows}
          selected={repoIdxSafe}
          focused={view === "main" && pane === "repos"}
        />
        {view === "detail" && detail ? (
          <IssueDetail
            issue={detail.issue}
            trigger={trigger}
            body={detail.body}
            planComment={detail.planComment}
            loading={detail.loading}
            scroll={scroll}
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
          />
        ) : view === "queue" ? (
          <QueueView snap={queueSnap} scroll={scroll} now={queueNow} />
        ) : (
          <IssueTable
            issues={currentIssues}
            trigger={trigger}
            selected={issueIdxSafe}
            focused={view === "main" && pane === "issues"}
            refreshing={refreshing}
          />
        )}
      </Box>
      <QueueStrip snap={queueSnap} now={queueNow} />
      <StatusBar health={health} toast={toast} hints="" watchlistError={watchlistError} />
      <ShortcutBar view={view} pane={pane} />
      {view === "help" && <HelpOverlay trigger={trigger} />}
      {view === "palette" && (
        <CommandPalette
          commands={PALETTE_COMMANDS}
          filter={paletteFilter}
          selected={paletteSel}
          argsMode={paletteArgsMode}
          argsValue={paletteArgs}
          onFilter={(v) => {
            setPaletteFilter(v);
            setPaletteSel(0);
          }}
          onArgs={setPaletteArgs}
          onCancel={() => setView("main")}
        />
      )}
      {view === "addRepo" && (
        <AddRepoForm
          error={addRepoError}
          busyText={addRepoBusy}
          onSubmit={(nwo, path) => void handleAddRepo(nwo, path)}
          onCancel={() => setView("main")}
        />
      )}
    </Box>
  );
}
