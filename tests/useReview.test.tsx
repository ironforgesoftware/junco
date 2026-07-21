// tests/useReview.test.tsx
import { describe, it, expect } from "vitest";
import React, { useRef } from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { useReview } from "../src/tui/hooks/useReview.js";
import type { DashboardClient } from "../src/tui/ghClient.js";
import type { PendingAssess } from "../src/assessReview.js";
import type { PendingComment } from "../src/commentReview.js";
import { until } from "./helpers/until.js";

const MARKER_BATCH: PendingAssess = {
  id: "assess-acme-widgets-1",
  nwo: "acme/widgets",
  external: false,
  autoPlan: false,
  repoPath: "/repos/acme/widgets",
  createdAt: "2026-07-20T00:00:00.000Z",
  findings: [
    {
      fingerprint: "fp1",
      kind: "code",
      severity: "high",
      ruleId: "rule1",
      title: "finding one",
      description: "a finding",
      references: [],
    },
  ],
};

const MARKER_DRAFT: PendingComment = {
  id: "analyze-acme-widgets-1",
  nwo: "acme/widgets",
  issue: 1,
  issueTitle: "some issue",
  external: false,
  repoPath: "/repos/acme/widgets",
  createdAt: "2026-07-20T00:00:00.000Z",
  draft: "draft body",
  footer: true,
};

type FakeResult<T> = { ok: true; value: T } | { ok: false; error: string };

function makeClient(
  reviewResult: FakeResult<PendingAssess[]>,
  draftsResult: FakeResult<PendingComment[]>,
): DashboardClient {
  return {
    listReview: async () => reviewResult,
    listCommentDrafts: async () => draftsResult,
  } as unknown as DashboardClient;
}

function Probe({
  client,
  onReady,
}: {
  client: DashboardClient;
  onReady: (api: ReturnType<typeof useReview>) => void;
}) {
  const aliveRef = useRef(true);
  const api = useReview({ client, aliveRef });
  onReady(api);
  const s = api.reviewState;
  return (
    <Text>
      {`loading:${s.loading}:batches:${s.batches.length}:drafts:${s.drafts.length}:cursor:${s.cursor}:error:${s.error ?? "none"}`}
    </Text>
  );
}

describe("useReview", () => {
  it("starts with the exact initial ReviewState", () => {
    const client = makeClient({ ok: true, value: [] }, { ok: true, value: [] });
    let api!: ReturnType<typeof useReview>;
    const r = render(<Probe client={client} onReady={(a) => (api = a)} />);
    expect(api.reviewState).toEqual({
      loading: false,
      error: null,
      batches: [],
      drafts: [],
      cursor: 0,
      open: null,
    });
    expect(r.lastFrame()).toBe("loading:false:batches:0:drafts:0:cursor:0:error:none");
    r.unmount();
  });

  it("loadReview populates batches/drafts and clears loading on success", async () => {
    const client = makeClient(
      { ok: true, value: [MARKER_BATCH] },
      { ok: true, value: [MARKER_DRAFT] },
    );
    let api!: ReturnType<typeof useReview>;
    const r = render(<Probe client={client} onReady={(a) => (api = a)} />);
    void api.loadReview();
    await until(() => r.lastFrame() === "loading:false:batches:1:drafts:1:cursor:0:error:none");
    expect(api.reviewState.batches[0]?.id).toBe(MARKER_BATCH.id);
    expect(api.reviewState.drafts[0]?.id).toBe(MARKER_DRAFT.id);
    r.unmount();
  });

  it("loadReview surfaces the error and clears loading on failure", async () => {
    const client = makeClient({ ok: false, error: "boom" }, { ok: true, value: [] });
    let api!: ReturnType<typeof useReview>;
    const r = render(<Probe client={client} onReady={(a) => (api = a)} />);
    void api.loadReview();
    await until(() => r.lastFrame() === "loading:false:batches:0:drafts:0:cursor:0:error:boom");
    expect(api.reviewState.error).toBe("boom");
    r.unmount();
  });
});
