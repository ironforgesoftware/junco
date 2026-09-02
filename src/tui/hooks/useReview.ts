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
        setReviewState((s) => ({
          ...s,
          loading: false,
          error: null,
          batches: rev.value,
          drafts: drafts.value,
          chatDrafts: chat.value,
          cursor: 0,
          // A chat draft the reload no longer lists was just submitted or
          // discarded (the verbs reload through here): its preview would
          // otherwise linger on a row that is gone.
          open:
            s.open?.kind === "chatDraft" && chat.value[s.open.idx] === undefined ? null : s.open,
        }));
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
