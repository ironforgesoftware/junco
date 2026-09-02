import { useMemo } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { DashboardClient } from "../ghClient.js";
import type { BodyKind, RailRow, SystemSection, WatchedMapping } from "../railModel.js";
import { sysKey } from "../railModel.js";
import { deriveState, type DashAction, type DashIssue } from "../state.js";
import type { DashPr } from "../prState.js";
import type { LocalCheap } from "../localSnapshot.js";
import type { ToastKind } from "../theme.js";
import type { ReviewState } from "../components/ReviewView.js";
import type { ConfirmState } from "./useConfirm.js";
import type { Pane, View } from "../App.js";

/**
 * A selectable row of the current system section — the EXACT list the section
 * component highlights, 1:1 by index, so the `▌` cursor and this hook's action
 * target are always the same row (App's `sectionRowsFor` builds it).
 */
export type LocalRow =
  | { kind: "running"; id: string }
  | { kind: "waiting"; id: string }
  | { kind: "recent"; id: string; status: "done" | "failed" }
  | { kind: "outboxOp"; id: string }
  | { kind: "worktree"; path: string; slug: string; klass: "live" | "stale" | "backup" };

export interface MainActionsInput {
  client: DashboardClient;
  aliveRef: MutableRefObject<boolean>;
  trigger: string;
  githubEnabled: boolean;
  watchlistError: string | null;
  // Nav spine (App-owned, read-only here).
  pane: Pane;
  body: BodyKind | null;
  sysSection: SystemSection | null;
  selectedRow: RailRow | undefined;
  currentNwo: string | undefined;
  /** The selected row's chat session key (chatKey.ts); null on a system row. */
  currentRepoKey: string | null;
  /** useChat's opener — `t` on a repo row starts/attaches its session. */
  openChat: (key: string) => void;
  /** `t` on an ISSUE row (#330) — the other half of the shared key. */
  openIssueTranscript: (
    nwo: string | null | undefined,
    issue: DashIssue | null | undefined,
  ) => void;
  currentIssue: DashIssue | undefined;
  /** The watched mapping behind the selected issues row — the external gate. */
  currentRepo: WatchedMapping | undefined;
  selectedPane3Pr: DashPr | null;
  localTarget: LocalRow | undefined;
  localCheap: LocalCheap | null;
  exit: () => void;
  onExit: () => void;
  setView: (v: View) => void;
  setRailSel: (key: string | null) => void;
  setPane: (p: Pane) => void;
  githubRefreshAll: (opts?: {
    isAlive?: () => boolean;
    scope?: "main" | "monitor";
  }) => Promise<void>;
  githubSetRefreshing: Dispatch<SetStateAction<boolean>>;
  setReviewState: Dispatch<SetStateAction<ReviewState>>;
  loadReview: () => Promise<void>;
  resetPalette: () => void;
  setAddRepoError: (e: string | null) => void;
  showToast: (kind: ToastKind, text: string) => void;
  forceLocalRefresh: () => Promise<void>;
  unwatch: (nwo: string) => void;
  openRepoBrowser: (nwo: string) => void;
  openBrowser: () => void;
  runAssess: (autoPlan: boolean, targetOverride?: string) => void;
  runAction: (action: DashAction) => void;
  runLocalAction: (
    name: string,
    args: string[],
    opts?: { key?: string; label?: string; onSuccess?: () => void },
  ) => void;
  askConfirm: (state: ConfirmState) => void;
}

/**
 * The main view's slice of the id-keyed action table (#350). Four internal
 * memos, one per family, so a new handler edits one short dep list instead of
 * the single 56-entry one this replaced:
 *   nav     — the always-available globals that only navigate,
 *   repo    — the repo/PR-scoped verbs (refresh/unwatch/browser),
 *   issue   — the issues-body verbs (audit/import/approve/…),
 *   section — the system-section verbs (the ex-handleSectionBodyInput recipes,
 *             localTarget guards included: highlight == target invariant).
 */
export function useMainActions({
  client,
  aliveRef,
  trigger,
  githubEnabled,
  watchlistError,
  pane,
  body,
  sysSection,
  selectedRow,
  currentNwo,
  currentRepoKey,
  openChat,
  openIssueTranscript,
  currentIssue,
  currentRepo,
  selectedPane3Pr,
  localTarget,
  localCheap,
  exit,
  onExit,
  setView,
  setRailSel,
  setPane,
  githubRefreshAll,
  githubSetRefreshing,
  setReviewState,
  loadReview,
  resetPalette,
  setAddRepoError,
  showToast,
  forceLocalRefresh,
  unwatch,
  openRepoBrowser,
  openBrowser,
  runAssess,
  runAction,
  runLocalAction,
  askConfirm,
}: MainActionsInput): Record<string, () => void> {
  const navActions = useMemo(
    (): Record<string, () => void> => ({
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
        if (!githubEnabled)
          return void showToast("info", "github mode is off ([github] enabled=false)");
        if (watchlistError)
          return void showToast("error", "watchlist unreadable — fix it before adding");
        setAddRepoError(null);
        setView("addRepo");
      },
    }),
    [
      exit,
      onExit,
      setView,
      setRailSel,
      setPane,
      githubRefreshAll,
      setReviewState,
      loadReview,
      resetPalette,
      githubEnabled,
      watchlistError,
      setAddRepoError,
      showToast,
    ],
  );

  const repoActions = useMemo(
    (): Record<string, () => void> => ({
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
      // `t` on a repo row (spec 2026-09-01 §8.1): attach the chat to the
      // selected row's key and hand it the focus — the composer is focused
      // from mount, so the chat pane must be the focused pane. Its twin is
      // `transcript` below: the two share the derived `t`, and viewActions'
      // `bodyVerbs` is what decides which of them the pane offers (R27), so
      // neither handler needs a pane branch of its own.
      chat: () => {
        if (currentRepoKey === null) return void showToast("info", "no repo selected");
        openChat(currentRepoKey);
        setView("chat");
        setPane(2);
      },
      // `t` on an ISSUE row (#330): the transcript of the ticket the bridge
      // built for it. Only the issues LIST derives this verb.
      transcript: () => openIssueTranscript(currentNwo, currentIssue),
    }),
    [
      forceLocalRefresh,
      currentNwo,
      currentIssue,
      currentRepoKey,
      openChat,
      openIssueTranscript,
      setView,
      setPane,
      githubSetRefreshing,
      githubRefreshAll,
      selectedRow,
      unwatch,
      showToast,
      pane,
      body,
      selectedPane3Pr,
      client,
      aliveRef,
      openRepoBrowser,
      openBrowser,
    ],
  );

  const issueActions = useMemo((): Record<string, () => void> => {
    const currentExternal = currentRepo?.external === true;
    // The three label verbs share one refusal: an external repo has no
    // junco-owned labels to move, so `import` (dispatch) is the only path in.
    const refuseExternal = (): boolean => {
      if (!currentExternal) return false;
      showToast("error", "not available for external repos — import queues a fork-PR ticket");
      return true;
    };
    return {
      // Pane-aware like the old `u`: issues pane with a selection scopes
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
        showToast("info", `importing ${currentNwo}#${num}…`);
        void client.dispatchTicket(currentNwo, num).then((res) => {
          if (!aliveRef.current) return;
          if (res.ok) showToast("success", `ticket queued: ${res.value.id}`);
          else showToast("error", res.error);
        });
      },
      dispatchAsk: () => {
        if (body?.kind !== "issues") return;
        if (refuseExternal()) return;
        void runAction("dispatchAsk");
      },
      approve: () => {
        if (body?.kind !== "issues") return;
        if (refuseExternal()) return;
        void runAction("approve");
      },
      replan: () => {
        if (body?.kind !== "issues") return;
        if (refuseExternal()) return;
        const st = currentIssue ? deriveState(currentIssue.labels, trigger) : "raw";
        void runAction(st === "plan-ready" || st === "approved" ? "replan" : "recycle");
      },
      analyze: () => {
        if (body?.kind !== "issues") return;
        if (!currentNwo || !currentIssue) return;
        const num = currentIssue.number;
        showToast("info", `drafting investigation for ${currentNwo}#${num}…`);
        void client.analyzeIssue(currentNwo, num).then((res) => {
          if (!aliveRef.current) return;
          if (res.ok)
            showToast("success", `investigation queued: ${res.value.id} · v to review when parked`);
          else showToast("error", res.error);
        });
      },
    };
  }, [
    currentRepo,
    pane,
    body,
    currentNwo,
    currentIssue,
    trigger,
    runAssess,
    runAction,
    showToast,
    client,
    aliveRef,
  ]);

  const sectionActions = useMemo(
    (): Record<string, () => void> => ({
      retry: () => {
        if (sysSection !== "queue") return;
        const tgt = localTarget;
        if (tgt?.kind === "recent" && tgt.status === "failed")
          return void runLocalAction("retry", [tgt.id], { label: "requeue" });
        if (tgt?.kind === "recent" && tgt.status === "done")
          return void showToast("info", "done tickets can't be requeued");
        if (tgt?.kind === "running")
          return void showToast("info", "running — enter opens its transcript");
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
    }),
    [sysSection, localTarget, localCheap, runLocalAction, showToast, askConfirm],
  );

  return useMemo(
    () => ({ ...navActions, ...repoActions, ...issueActions, ...sectionActions }),
    [navActions, repoActions, issueActions, sectionActions],
  );
}
