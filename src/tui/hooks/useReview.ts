import { useState, useCallback } from "react";
import type { MutableRefObject, Dispatch, SetStateAction } from "react";
import type { DashboardClient } from "../ghClient.js";
import type { ReviewState } from "../components/ReviewView.js";

const INITIAL_REVIEW_STATE: ReviewState = {
  loading: false,
  error: null,
  batches: [],
  drafts: [],
  cursor: 0,
  open: null,
};

/**
 * review-view domain: owns `reviewState` plus the async batches+drafts load.
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
    await Promise.all([client.listReview(), client.listCommentDrafts()]).then(([rev, drafts]) => {
      if (!aliveRef.current) return;
      if (rev.ok && drafts.ok) {
        setReviewState((s) => ({
          ...s,
          loading: false,
          error: null,
          batches: rev.value,
          drafts: drafts.value,
          cursor: 0,
        }));
      } else {
        const error = !rev.ok ? rev.error : !drafts.ok ? drafts.error : "unknown error";
        setReviewState((s) => ({ ...s, loading: false, error }));
      }
    });
  }, [client, aliveRef]);

  return { reviewState, setReviewState, loadReview };
}
