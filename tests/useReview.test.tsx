// tests/useReview.test.tsx
import { describe, it, expect } from "vitest";
import React, { useRef } from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { useReview } from "../src/tui/hooks/useReview.js";
import type { DashboardClient } from "../src/tui/ghClient.js";
import type { PendingAssess } from "../src/assessReview.js";
import type { PendingComment } from "../src/commentReview.js";
import type { PendingDraft } from "../src/chat/draftStore.js";
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

const MARKER_CHAT_DRAFT: PendingDraft = {
  id: "acme__widgets-20260901-1",
  key: "acme/widgets",
  slug: "acme__widgets",
  kind: "ticket",
  files: [{ name: "add-cache.md", content: "body", lint: [], route: null, droppedKeys: [] }],
  cwd: "/repos/acme/widgets",
  nwo: "acme/widgets",
  createdAt: "2026-09-01T00:00:00.000Z",
  lintFailed: false,
  blocked: null,
  routeOverride: "auto",
  commandArgs: null,
};

type FakeResult<T> = { ok: true; value: T } | { ok: false; error: string };

function makeClient(
  reviewResult: FakeResult<PendingAssess[]>,
  draftsResult: FakeResult<PendingComment[]>,
  chatDraftsResult: FakeResult<PendingDraft[]> = { ok: true, value: [] },
): DashboardClient {
  return {
    listReview: async () => reviewResult,
    listCommentDrafts: async () => draftsResult,
    listChatDrafts: async () => chatDraftsResult,
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
      {`loading:${s.loading}:batches:${s.batches.length}:drafts:${s.drafts.length}:chat:${s.chatDrafts.length}:cursor:${s.cursor}:error:${s.error ?? "none"}`}
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
      chatDrafts: [],
      cursor: 0,
      open: null,
    });
    expect(r.lastFrame()).toBe("loading:false:batches:0:drafts:0:chat:0:cursor:0:error:none");
    r.unmount();
  });

  it("loadReview populates batches/drafts/chat drafts and clears loading on success", async () => {
    const client = makeClient(
      { ok: true, value: [MARKER_BATCH] },
      { ok: true, value: [MARKER_DRAFT] },
      { ok: true, value: [MARKER_CHAT_DRAFT] },
    );
    let api!: ReturnType<typeof useReview>;
    const r = render(<Probe client={client} onReady={(a) => (api = a)} />);
    void api.loadReview();
    await until(
      () => r.lastFrame() === "loading:false:batches:1:drafts:1:chat:1:cursor:0:error:none",
    );
    expect(api.reviewState.batches[0]?.id).toBe(MARKER_BATCH.id);
    expect(api.reviewState.drafts[0]?.id).toBe(MARKER_DRAFT.id);
    expect(api.reviewState.chatDrafts[0]?.id).toBe(MARKER_CHAT_DRAFT.id);
    r.unmount();
  });

  it("a reload that loses the OPEN chat draft (submitted/discarded) closes the preview", async () => {
    const client = makeClient({ ok: true, value: [] }, { ok: true, value: [] });
    let api!: ReturnType<typeof useReview>;
    const r = render(<Probe client={client} onReady={(a) => (api = a)} />);
    api.setReviewState((s) => ({
      ...s,
      chatDrafts: [MARKER_CHAT_DRAFT],
      open: { kind: "chatDraft", idx: 0 },
    }));
    await until(() => api.reviewState.open !== null);
    void api.loadReview();
    await until(() => api.reviewState.open === null && api.reviewState.chatDrafts.length === 0);
    r.unmount();
  });

  it("the open chat draft is reconciled by ID, not by index", async () => {
    // [A, B] with A's preview open: submitting A reloads to [B]. An
    // index-based reconcile would keep idx 0 and silently re-aim the preview
    // (and the next s/e/r/D) at B.
    const B: PendingDraft = { ...MARKER_CHAT_DRAFT, id: "other-1" };
    const gone = makeClient(
      { ok: true, value: [] },
      { ok: true, value: [] },
      {
        ok: true,
        value: [B],
      },
    );
    let api!: ReturnType<typeof useReview>;
    const r = render(<Probe client={gone} onReady={(a) => (api = a)} />);
    api.setReviewState((s) => ({
      ...s,
      chatDrafts: [MARKER_CHAT_DRAFT, B],
      open: { kind: "chatDraft", idx: 0 },
    }));
    await until(() => api.reviewState.chatDrafts.length === 2);
    void api.loadReview();
    await until(() => api.reviewState.chatDrafts.length === 1);
    expect(api.reviewState.open).toBeNull();
    r.unmount();

    // Still listed but at a new index (a sibling landed ahead of it): the
    // preview follows the draft, not the slot.
    const moved = makeClient(
      { ok: true, value: [] },
      { ok: true, value: [] },
      {
        ok: true,
        value: [B, MARKER_CHAT_DRAFT],
      },
    );
    let api2!: ReturnType<typeof useReview>;
    const r2 = render(<Probe client={moved} onReady={(a) => (api2 = a)} />);
    api2.setReviewState((s) => ({
      ...s,
      chatDrafts: [MARKER_CHAT_DRAFT],
      open: { kind: "chatDraft", idx: 0 },
    }));
    await until(() => api2.reviewState.chatDrafts.length === 1);
    void api2.loadReview();
    await until(() => api2.reviewState.chatDrafts.length === 2);
    expect(api2.reviewState.open).toEqual({ kind: "chatDraft", idx: 1 });
    r2.unmount();
  });

  it("a reload that KEEPS the open chat draft leaves the preview open", async () => {
    // The reload answers with the SAME id carrying a changed field (what an
    // `r` route cycle produces), so the wait gates on the reloaded value
    // rather than on the seeded one.
    const reloaded: PendingDraft = { ...MARKER_CHAT_DRAFT, routeOverride: "inbox" };
    const client = makeClient(
      { ok: true, value: [] },
      { ok: true, value: [] },
      { ok: true, value: [reloaded] },
    );
    let api!: ReturnType<typeof useReview>;
    const r = render(<Probe client={client} onReady={(a) => (api = a)} />);
    api.setReviewState((s) => ({
      ...s,
      chatDrafts: [MARKER_CHAT_DRAFT],
      open: { kind: "chatDraft", idx: 0 },
    }));
    await until(() => api.reviewState.open !== null);
    void api.loadReview();
    await until(() => api.reviewState.chatDrafts[0]?.routeOverride === "inbox");
    expect(api.reviewState.open).toEqual({ kind: "chatDraft", idx: 0 });
    r.unmount();
  });

  it("loadReview surfaces the error and clears loading on failure", async () => {
    const client = makeClient({ ok: false, error: "boom" }, { ok: true, value: [] });
    let api!: ReturnType<typeof useReview>;
    const r = render(<Probe client={client} onReady={(a) => (api = a)} />);
    void api.loadReview();
    await until(
      () => r.lastFrame() === "loading:false:batches:0:drafts:0:chat:0:cursor:0:error:boom",
    );
    expect(api.reviewState.error).toBe("boom");
    r.unmount();
  });

  it("any one of the three lists failing is the state's error", async () => {
    const cases: Array<[FakeResult<PendingComment[]>, FakeResult<PendingDraft[]>, string]> = [
      [{ ok: false, error: "no drafts" }, { ok: true, value: [] }, "no drafts"],
      [{ ok: true, value: [] }, { ok: false, error: "no chat drafts" }, "no chat drafts"],
    ];
    for (const [drafts, chat, error] of cases) {
      const client = makeClient({ ok: true, value: [] }, drafts, chat);
      let api!: ReturnType<typeof useReview>;
      const r = render(<Probe client={client} onReady={(a) => (api = a)} />);
      void api.loadReview();
      await until(() => api.reviewState.error === error);
      r.unmount();
    }
  });
});
