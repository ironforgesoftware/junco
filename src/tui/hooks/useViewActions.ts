import { useMemo } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { DashboardClient } from "../ghClient.js";
import type { UnifiedRepo } from "../railModel.js";
import type { ToastKind } from "../theme.js";
import type { ReviewState } from "../components/ReviewView.js";
import type { View, DetailState, PrDetailState } from "../App.js";
import type { DashPr } from "../prState.js";
import type { CmdState } from "./useCmdOutput.js";
import type { TranscriptState } from "./useTranscript.js";
import type { ChatDraftActions } from "./useChatDrafts.js";
import type { ChatApi } from "./useChat.js";
import type { PendingDraft } from "../../chat/draftStore.js";
import type { DashIssue } from "../state.js";

export interface ViewActionsInput {
  /** The current view — this hook owns every arm EXCEPT `main`. */
  view: View;
  close: () => void;
  client: DashboardClient;
  aliveRef: MutableRefObject<boolean>;
  showToast: (kind: ToastKind, text: string) => void;
  openDetailIssueInBrowser: () => void;
  openPrDetailInBrowser: () => void;
  openRepoBrowser: (nwo: string) => void;
  openSelectedPr: () => void;
  repoDetailTarget: UnifiedRepo | null;
  cmd: CmdState | null;
  runPaletteCommand: (name: string, extraArgs: string[]) => void;
  transcript: TranscriptState | null;
  toggleTranscriptThinking: () => void;
  setTranscriptFollow: (on: boolean) => void;
  /** useScroll's jump-to-tail — pausing a live transcript lands there first. */
  toEnd: () => void;
  reviewState: ReviewState;
  setReviewState: Dispatch<SetStateAction<ReviewState>>;
  /** The four chat-draft verbs (useChatDrafts) — the review row's half of the
   * confirm surface the chat pane's card also drives (spec §6.6). */
  chatDraftActions: ChatDraftActions;
  /** The `chat` view's own arm, built by useChatInput (Ruling R15) — this hook
   * only picks it, the way it picks every other view's. */
  chatHandlers: Record<string, () => void>;
  /** The open issue-detail overlay's frozen snapshot (App.tsx `detail` state)
   * — read-only here; the `detail` case's `transcript` handler reads its
   * nwo/issue, same freshness as the raw `if (input === "t")` key check it
   * replaces (Ruling R1, spec 2026-09-02 footer redesign, Task 1). */
  detail: DetailState | null;
  /** Opens the ticket transcript for an issue (App.tsx `openIssueTranscript`,
   * shared with useMainActions' own `transcript` handler for #330). Ruling R1
   * gives the detail overlay's own `t` this same handler. */
  openIssueTranscript: (
    nwo: string | null | undefined,
    issue: DashIssue | null | undefined,
    from?: "main" | "detail",
  ) => void;
  /** App's help opener (Ruling R5, spec 2026-09-02 §3.2). Every overlay's
   * keymap carries the hidden reserved `?`, so every arm below must dispatch
   * it — otherwise the key and the pinned `? help` chip are inert there. */
  openHelp: () => void;
  /** useTranscript's closer. `c` from the transcript view is a one-way trip
   * (the chat's own close returns to `main`), so the transcript is released on
   * the way out rather than left polling underneath — #462. */
  closeTranscript: () => void;
  /** useChat's opener (spec 2026-09-02 §5): `c` from an overlay attaches the
   * chat to the overlay's OWN repo, with the thread prefilled where one is in
   * view — `chatTargetFor` below decides both. */
  openChat: ChatApi["openChat"];
  /** The chat verb navigates as well as opens: full-screen chat view (App owns
   * the nav spine, so it hands this in; the pane is left where it was). */
  setView: (v: View) => void;
  /** The open PR-detail overlay's frozen PR, and the PRs view's selection —
   * read-only, the same way `detail` is: they name the chat verb's target.
   * (`null` is App's own "nothing selected"; `undefined` is what an index past
   * a shrunk list yields — both mean the same thing here.) */
  prDetail: PrDetailState | null;
  selectedPr: DashPr | null | undefined;
}

/** What `c` chats about from an overlay (spec 2026-09-02 §5, D6/D7): the
 * overlay's repo, with the issue/PR thread prefilled where one is in view.
 * Null → no repo in context → the caller toasts and the pill is absent. */
export function chatTargetFor(
  view: View,
  s: {
    detail: DetailState | null;
    prDetail: PrDetailState | null;
    selectedPr: DashPr | null | undefined;
    transcript: TranscriptState | null;
    reviewState: ReviewState;
    repoDetailTarget: UnifiedRepo | null;
  },
): { key: string; composer?: string } | null {
  switch (view) {
    case "detail":
      return s.detail
        ? { key: s.detail.nwo.toLowerCase(), composer: `/issue ${s.detail.issue.number}` }
        : null;
    case "prDetail":
      return s.prDetail
        ? { key: s.prDetail.pr.nwo.toLowerCase(), composer: `/pr ${s.prDetail.pr.number}` }
        : null;
    // Ruling R8 (spec 2026-09-02 D7): the rail's UnifiedRepo.key IS already
    // the chat key (nwo lowercased or a resolved local path) — no second
    // lowercase pass here.
    case "repoDetail":
      return s.repoDetailTarget ? { key: s.repoDetailTarget.key } : null;
    case "prs":
      return s.selectedPr
        ? { key: s.selectedPr.nwo.toLowerCase(), composer: `/pr ${s.selectedPr.number}` }
        : null;
    case "transcript":
      return s.transcript?.repoKey ? { key: s.transcript.repoKey } : null;
    case "review": {
      // The combined list's cursor walks batches, then comment drafts, then
      // chat drafts (useViewActions' own `selectedChatDraft` order) — each
      // carries the repo it belongs to.
      const { batches, drafts, chatDrafts, cursor } = s.reviewState;
      if (cursor < batches.length) return { key: batches[cursor]!.nwo.toLowerCase() };
      if (cursor < batches.length + drafts.length)
        return { key: drafts[cursor - batches.length]!.nwo.toLowerCase() };
      const d = chatDrafts[cursor - batches.length - drafts.length];
      return d ? { key: d.key } : null;
    }
    default:
      return null;
  }
}

/** The chat draft `submit`/`edit`/`route`/`discard` act on: the open preview's
 * draft, or — in combined-list mode — the one under the cursor (the cursor
 * walks batches, then comment drafts, then chat drafts). null everywhere else,
 * which is what keeps `discard` on its batch/comment-draft meaning. */
function selectedChatDraft(rs: ReviewState): PendingDraft | null {
  if (rs.open?.kind === "chatDraft") return rs.chatDrafts[rs.open.idx] ?? null;
  if (rs.open !== null) return null;
  const idx = rs.cursor - rs.batches.length - rs.drafts.length;
  return idx >= 0 ? (rs.chatDrafts[idx] ?? null) : null;
}

/**
 * The overlay views' slice of the id-keyed action table (#350):
 * detail / prDetail / repoDetail / prs / cmdOutput / transcript / review.
 * The chromeless views (palette, addRepo, config, help) and `main` carry no
 * mnemonic actions here — `main` is `useMainActions`' arm, and App composes
 * the two. Review keeps its own memo below: its handlers close over the whole
 * `reviewState` (which the poll-free review load replaces wholesale), so
 * folding them in with the rest would drag that churn across every other arm.
 *
 * NOT to be confused with `../viewActions.ts`, which derives the per-context
 * KEYMAP; this hook derives the handlers those keys (and the footer chips)
 * dispatch to.
 */
export function useViewActions({
  view,
  close,
  client,
  aliveRef,
  showToast,
  openDetailIssueInBrowser,
  openPrDetailInBrowser,
  openRepoBrowser,
  openSelectedPr,
  repoDetailTarget,
  cmd,
  runPaletteCommand,
  transcript,
  closeTranscript,
  toggleTranscriptThinking,
  setTranscriptFollow,
  toEnd,
  reviewState,
  setReviewState,
  chatDraftActions,
  chatHandlers,
  detail,
  openIssueTranscript,
  openHelp,
  openChat,
  setView,
  prDetail,
  selectedPr,
}: ViewActionsInput): Record<string, () => void> {
  const reviewActions = useMemo((): Record<string, () => void> => {
    // Chat-draft verb dispatch: a no-op unless a chat draft is actually
    // selected, so `s`/`e`/`r` are dead keys on a batch or comment-draft row.
    const onChatDraft = (fn: (d: PendingDraft) => Promise<void>) => (): void => {
      const d = selectedChatDraft(reviewState);
      if (d) void fn(d);
    };
    // Optimistic removal shared by post and discard: drop the draft, close
    // the preview, clamp the cursor to the (shrunk) combined list.
    const dropDraft = (id: string): void => {
      setReviewState((s) => {
        const drafts = s.drafts.filter((d) => d.id !== id);
        const total = s.batches.length + drafts.length + s.chatDrafts.length;
        return { ...s, drafts, open: null, cursor: Math.min(s.cursor, Math.max(0, total - 1)) };
      });
    };
    return {
      close,
      submit: onChatDraft(chatDraftActions.submit),
      edit: onChatDraft(chatDraftActions.edit),
      route: onChatDraft(chatDraftActions.route),
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
          s.open && s.open.kind === "batch" ? { ...s, open: { ...s.open, checked: new Set() } } : s,
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
                const batches = s.batches.map((b) => (b.id === id ? v.batch : b));
                const nextOpen =
                  s.open && s.open.kind === "batch"
                    ? {
                        ...s.open,
                        checked: new Set([...s.open.checked].filter((fp) => !v.batch.filed?.[fp])),
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
        // One `D`, three lists: the chat draft wins when it is the selection.
        const chatDraft = selectedChatDraft(rs);
        if (chatDraft) return void chatDraftActions.discard(chatDraft);
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
                const total = batches.length + s.drafts.length + s.chatDrafts.length;
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
  }, [close, client, aliveRef, showToast, reviewState, setReviewState, chatDraftActions]);

  return useMemo((): Record<string, () => void> => {
    // Spec 2026-09-02 §5 (D6/D7): ONE chat verb for every overlay that has a
    // repo in context — same predicate as Task 2's footer pill, so a rendered
    // pill and a live `c` can never disagree. No target ⇒ toast, never a chat
    // about whatever the rail happens to be parked on.
    const chat = (): boolean => {
      const t = chatTargetFor(view, {
        detail,
        prDetail,
        selectedPr,
        transcript,
        reviewState,
        repoDetailTarget,
      });
      // The hint names the key that gets you somewhere a repo IS selectable
      // FROM HERE: inside an overlay that is `esc` (spec §5's `(←)` is the
      // main view's own wording, which useMainActions keeps — `←` does
      // nothing under an overlay).
      if (t === null) {
        showToast("info", "select a repo first (esc)");
        return false;
      }
      openChat(t.key, t.composer === undefined ? undefined : { composer: t.composer });
      setView("chat"); // the pane stays put — see useMainActions' chat door
      return true;
    };
    switch (view) {
      case "detail":
        return {
          browser: openDetailIssueInBrowser,
          chat,
          close,
          help: openHelp,
          // Ruling R1: `transcript` now derives on `t` here (viewActions.ts's
          // VIEW_OPTIONS.detail), so App's layer-3d dispatch reaches this
          // handler before the view cascade's own key checks ever run — this
          // replaces the raw `if (input === "t")` line that used to live
          // there. Same nwo/issue freshness as that line: read straight off
          // the frozen `detail` snapshot, not a stale closure.
          transcript: () =>
            openIssueTranscript(detail?.nwo ?? null, detail?.issue ?? null, "detail"),
        };
      case "prDetail":
        return { browser: openPrDetailInBrowser, chat, close, help: openHelp };
      case "repoDetail":
        return {
          close,
          help: openHelp,
          chat,
          browser: () => {
            const nwo = repoDetailTarget?.nwo;
            if (nwo !== null && nwo !== undefined) openRepoBrowser(nwo);
            else showToast("info", "no GitHub URL");
          },
        };
      case "prs":
        return { browser: openSelectedPr, chat, close, help: openHelp };
      case "cmdOutput":
        return {
          close,
          help: openHelp,
          ...(cmd && !cmd.running
            ? { reRun: () => runPaletteCommand(cmd.name, cmd.extraArgs) }
            : {}),
        };
      case "transcript":
        return {
          // #462: leaving for the chat must release the transcript — its live
          // poll would otherwise keep reading the file with nothing on screen,
          // and the chat's close lands on `main`, never back here. Only on a
          // chat that actually opened: a target-less `c` just toasts, and the
          // transcript stays exactly as it was.
          chat: () => {
            if (chat()) closeTranscript();
          },
          close,
          help: openHelp,
          thinking: toggleTranscriptThinking,
          ...(transcript?.summary?.live
            ? {
                follow: () => {
                  // Pausing lands at the tail first (log-overlay recipe) so the
                  // paused window shows the newest rows, not a jump to the top.
                  if (transcript.follow) toEnd();
                  setTranscriptFollow(!transcript.follow);
                },
              }
            : {}),
        };
      case "review":
        return { ...reviewActions, chat, help: openHelp };
      case "chat":
        return { ...chatHandlers, help: openHelp };
      case "palette":
      case "addRepo":
      case "config":
      case "help":
      // `main` is useMainActions' arm — App picks between the two.
      case "main":
        // Their contexts are structuralOnly (empty keymap), so `help` here is
        // unreachable by key — it is kept for the uniform arm shape.
        return { help: openHelp };
    }
  }, [
    view,
    close,
    showToast,
    openDetailIssueInBrowser,
    openPrDetailInBrowser,
    openRepoBrowser,
    openSelectedPr,
    repoDetailTarget,
    cmd,
    runPaletteCommand,
    transcript,
    toggleTranscriptThinking,
    setTranscriptFollow,
    toEnd,
    reviewActions,
    reviewState,
    chatHandlers,
    closeTranscript,
    detail,
    openIssueTranscript,
    openHelp,
    openChat,
    setView,
    prDetail,
    selectedPr,
  ]);
}
