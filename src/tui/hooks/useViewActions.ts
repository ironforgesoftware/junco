import { useMemo } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { DashboardClient } from "../ghClient.js";
import type { UnifiedRepo } from "../railModel.js";
import type { ToastKind } from "../theme.js";
import type { ReviewState } from "../components/ReviewView.js";
import type { View } from "../App.js";
import type { CmdState } from "./useCmdOutput.js";
import type { TranscriptState } from "./useTranscript.js";
import type { ChatDraftActions } from "./useChatDrafts.js";
import type { PendingDraft } from "../../chat/draftStore.js";

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
  toggleTranscriptThinking,
  setTranscriptFollow,
  toEnd,
  reviewState,
  setReviewState,
  chatDraftActions,
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
      case "transcript":
        return {
          close,
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
        return reviewActions;
      case "palette":
      case "addRepo":
      case "config":
      case "help":
      // `main` is useMainActions' arm — App picks between the two.
      case "main":
        return {};
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
  ]);
}
