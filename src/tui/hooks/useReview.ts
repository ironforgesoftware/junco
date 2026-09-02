import { useState, useCallback } from "react";
import type { MutableRefObject, Dispatch, SetStateAction } from "react";
import type { DashboardClient } from "../ghClient.js";
import type { ReviewState } from "../components/ReviewView.js";

const INITIAL_REVIEW_STATE: ReviewState = {
  loading: false,
  error: null,
  batches: [],
  drafts: [],
  chatDrafts: [],
  cursor: 0,
  open: null,
};

/**
 * review-view domain: owns `reviewState` plus the async batches+drafts+chat
 * drafts load (the third list, spec 2026-09-01 §8.6).
 * `setReviewState` is exposed deliberately — the keyboard input cascade and
 * the review mouse handlers stay in App.tsx (woven into key routing that must
 * not move) and legitimately write reviewState directly, same as the nav
 * spine coupling elsewhere. `loadReview` does NOT call setView; the caller
 * (App's `review:` action) drives navigation itself.
 */
export function useReview({
  client,
  aliveRef,
}: {
  client: DashboardClient;
  aliveRef: MutableRefObject<boolean>;
}): {
  reviewState: ReviewState;
  setReviewState: Dispatch<SetStateAction<ReviewState>>;
  loadReview: () => Promise<void>;
} {
  const [reviewState, setReviewState] = useState<ReviewState>(INITIAL_REVIEW_STATE);

  const loadReview = useCallback(async (): Promise<void> => {
    await Promise.all([
      client.listReview(),
      client.listCommentDrafts(),
      client.listChatDrafts(),
    ]).then(([rev, drafts, chat]) => {
      if (!aliveRef.current) return;
      if (rev.ok && drafts.ok && chat.ok) {
        setReviewState((s) => {
          // An open chat-draft preview is reconciled BY ID, never by index: a
          // submit/discard shortens the list, so keeping the old index would
          // silently re-aim the preview (and the next s/e/r/D) at whichever
          // draft slid into that slot. Gone from the reload → close it.
          const openId =
            s.open?.kind === "chatDraft" ? (s.chatDrafts[s.open.idx]?.id ?? null) : null;
          const openIdx =
            s.open?.kind === "chatDraft" ? chat.value.findIndex((d) => d.id === openId) : -1;
          return {
            ...s,
            loading: false,
            error: null,
            batches: rev.value,
            drafts: drafts.value,
            chatDrafts: chat.value,
            cursor: 0,
            open:
              s.open?.kind !== "chatDraft"
                ? s.open
                : openIdx >= 0
                  ? { kind: "chatDraft", idx: openIdx }
                  : null,
          };
        });
      } else {
        const error = !rev.ok
          ? rev.error
          : !drafts.ok
            ? drafts.error
            : !chat.ok
              ? chat.error
              : "unknown error";
        setReviewState((s) => ({ ...s, loading: false, error }));
      }
    });
  }, [client, aliveRef]);

  return { reviewState, setReviewState, loadReview };
}
