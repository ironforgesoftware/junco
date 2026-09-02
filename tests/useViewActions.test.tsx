// tests/useViewActions.test.tsx
import { describe, it, expect, vi } from "vitest";
import React, { useRef } from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { useViewActions, type ViewActionsInput } from "../src/tui/hooks/useViewActions.js";
import type { DashboardClient } from "../src/tui/ghClient.js";
import type { ReviewState } from "../src/tui/components/ReviewView.js";
import type { TranscriptState } from "../src/tui/hooks/useTranscript.js";
import type { CmdState } from "../src/tui/hooks/useCmdOutput.js";
import type { UnifiedRepo } from "../src/tui/railModel.js";
import type { PendingAssess } from "../src/assessReview.js";
import type { PendingComment } from "../src/commentReview.js";
import type { PendingDraft } from "../src/chat/draftStore.js";
import type { DashIssue } from "../src/tui/state.js";
import { makeDashIssue } from "./helpers/dashFixtures.js";
import { until } from "./helpers/until.js";

const BATCH: PendingAssess = {
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
      title: "one",
      description: "d",
      references: [],
    },
    {
      fingerprint: "fp2",
      kind: "code",
      severity: "low",
      ruleId: "rule2",
      title: "two",
      description: "d",
      references: [],
    },
  ],
};

const DRAFT: PendingComment = {
  id: "analyze-acme-widgets-1",
  nwo: "acme/widgets",
  issue: 7,
  issueTitle: "some issue",
  external: false,
  repoPath: "/repos/acme/widgets",
  createdAt: "2026-07-20T00:00:00.000Z",
  draft: "draft body",
  footer: true,
};

const CHAT_DRAFT: PendingDraft = {
  id: "acme__widgets-20260901-1",
  key: "acme/widgets",
  slug: "acme__widgets",
  kind: "ticket",
  files: [{ name: "add-cache.md", content: "", lint: [], route: null, droppedKeys: [] }],
  cwd: "/repos/acme/widgets",
  nwo: "acme/widgets",
  createdAt: "2026-09-01T00:00:00.000Z",
  lintFailed: false,
  blocked: null,
  routeOverride: "auto",
  commandArgs: null,
};

const EMPTY_REVIEW: ReviewState = {
  loading: false,
  error: null,
  batches: [],
  drafts: [],
  chatDrafts: [],
  cursor: 0,
  open: null,
};

const REPO: UnifiedRepo = {
  key: "acme/widgets",
  nwo: "acme/widgets",
  path: "/repos/acme/widgets",
  fromConfig: false,
  external: false,
  source: "watchlist",
  watched: true,
  git: null,
  clones: [],
};

const CMD: CmdState = {
  title: "junco status",
  running: false,
  output: "ok",
  exitCode: 0,
  timedOut: false,
  name: "status",
  extraArgs: [],
  token: 1,
};

const TRANSCRIPT = (live: boolean | null, follow = true): TranscriptState =>
  ({
    id: "t-1",
    path: null,
    expectLive: true,
    loading: false,
    error: null,
    size: null,
    summary: live === null ? null : { live },
    showThinking: false,
    follow,
    cursor: 0,
    expanded: new Set(),
  }) as unknown as TranscriptState;

function makeSpies() {
  return {
    close: vi.fn(),
    showToast: vi.fn(),
    openDetailIssueInBrowser: vi.fn(),
    openPrDetailInBrowser: vi.fn(),
    openRepoBrowser: vi.fn(),
    openSelectedPr: vi.fn(),
    runPaletteCommand: vi.fn(),
    toggleTranscriptThinking: vi.fn(),
    setTranscriptFollow: vi.fn(),
    toEnd: vi.fn(),
    setReviewState: vi.fn(),
    openIssueTranscript: vi.fn(),
    chatSubmit: vi.fn(async () => {}),
    chatEdit: vi.fn(async () => {}),
    chatRoute: vi.fn(async () => {}),
    chatDiscard: vi.fn(async () => {}),
    chatClose: vi.fn(),
  };
}

function Probe({
  input,
  onReady,
}: {
  input: Omit<ViewActionsInput, "aliveRef">;
  onReady: (a: Record<string, () => void>) => void;
}) {
  const aliveRef = useRef(true);
  onReady(useViewActions({ ...input, aliveRef }));
  return <Text>probe</Text>;
}

function mount(
  overrides: Partial<Omit<ViewActionsInput, "aliveRef" | "client">> & {
    client?: Partial<DashboardClient>;
  },
) {
  const spies = makeSpies();
  const { client, ...rest } = overrides;
  const input: Omit<ViewActionsInput, "aliveRef"> = {
    view: "main",
    close: spies.close,
    client: (client ?? {}) as unknown as DashboardClient,
    showToast: spies.showToast,
    openDetailIssueInBrowser: spies.openDetailIssueInBrowser,
    openPrDetailInBrowser: spies.openPrDetailInBrowser,
    openRepoBrowser: spies.openRepoBrowser,
    openSelectedPr: spies.openSelectedPr,
    repoDetailTarget: null,
    cmd: null,
    runPaletteCommand: spies.runPaletteCommand,
    transcript: null,
    toggleTranscriptThinking: spies.toggleTranscriptThinking,
    setTranscriptFollow: spies.setTranscriptFollow,
    toEnd: spies.toEnd,
    reviewState: EMPTY_REVIEW,
    setReviewState: spies.setReviewState,
    detail: null,
    openIssueTranscript: spies.openIssueTranscript,
    chatDraftActions: {
      submit: spies.chatSubmit,
      edit: spies.chatEdit,
      route: spies.chatRoute,
      discard: spies.chatDiscard,
    },
    chatHandlers: { close: spies.chatClose },
    ...rest,
  };
  let api!: Record<string, () => void>;
  const r = render(<Probe input={input} onReady={(a) => (api = a)} />);
  return { api, spies, unmount: r.unmount };
}

const ids = (a: Record<string, () => void>): string[] => Object.keys(a).sort();

describe("useViewActions — per-view action id sets (the refactor's invariant)", () => {
  it("prDetail / prs expose browser+close, each wired to its own opener", () => {
    for (const [view, spy] of [
      ["prDetail", "openPrDetailInBrowser"],
      ["prs", "openSelectedPr"],
    ] as const) {
      const { api, spies, unmount } = mount({ view });
      expect(ids(api)).toEqual(["browser", "close"]);
      api["browser"]?.();
      expect(spies[spy]).toHaveBeenCalledTimes(1);
      api["close"]?.();
      expect(spies.close).toHaveBeenCalledTimes(1);
      unmount();
    }
  });

  // Ruling R1 (2026-09-02 footer redesign, Task 1): the brief adds a
  // `transcript` chip/keymap entry to the detail overlay, so App's layer-3d
  // dispatch (which returns on ANY keymap hit) would otherwise swallow `t`
  // before the raw cascade's own check ever ran — this handler is the one
  // true path, replacing that raw `if (input === "t")` line in App.tsx.
  it("detail exposes browser+close+transcript; transcript opens the frozen issue's ticket transcript", () => {
    const DETAIL_ISSUE: DashIssue = makeDashIssue({ number: 46 });
    const { api, spies, unmount } = mount({
      view: "detail",
      detail: {
        issue: DETAIL_ISSUE,
        nwo: "acme/widgets",
        body: null,
        planComment: null,
        loading: false,
      },
    });
    expect(ids(api)).toEqual(["browser", "close", "transcript"]);
    api["browser"]?.();
    expect(spies.openDetailIssueInBrowser).toHaveBeenCalledTimes(1);
    api["close"]?.();
    expect(spies.close).toHaveBeenCalledTimes(1);
    api["transcript"]?.();
    expect(spies.openIssueTranscript).toHaveBeenCalledWith("acme/widgets", DETAIL_ISSUE, "detail");
    unmount();
  });

  it("repoDetail's browser opens the frozen target, and toasts when it has no nwo", () => {
    const hit = mount({ view: "repoDetail", repoDetailTarget: REPO });
    expect(ids(hit.api)).toEqual(["browser", "close"]);
    hit.api["browser"]?.();
    expect(hit.spies.openRepoBrowser).toHaveBeenCalledWith("acme/widgets");
    hit.unmount();

    const miss = mount({ view: "repoDetail", repoDetailTarget: { ...REPO, nwo: null } });
    miss.api["browser"]?.();
    expect(miss.spies.openRepoBrowser).not.toHaveBeenCalled();
    expect(miss.spies.showToast).toHaveBeenCalledWith("info", "no GitHub URL");
    miss.unmount();
  });

  it("cmdOutput offers reRun only for a finished command", () => {
    const running = mount({ view: "cmdOutput", cmd: { ...CMD, running: true } });
    expect(ids(running.api)).toEqual(["close"]);
    running.unmount();

    const none = mount({ view: "cmdOutput", cmd: null });
    expect(ids(none.api)).toEqual(["close"]);
    none.unmount();

    const done = mount({ view: "cmdOutput", cmd: { ...CMD, extraArgs: ["--json"] } });
    expect(ids(done.api)).toEqual(["close", "reRun"]);
    done.api["reRun"]?.();
    expect(done.spies.runPaletteCommand).toHaveBeenCalledWith("status", ["--json"]);
    done.unmount();
  });

  it("transcript offers follow only while the file is live, pausing at the tail", () => {
    const dead = mount({ view: "transcript", transcript: TRANSCRIPT(false) });
    expect(ids(dead.api)).toEqual(["close", "thinking"]);
    dead.api["thinking"]?.();
    expect(dead.spies.toggleTranscriptThinking).toHaveBeenCalledTimes(1);
    dead.unmount();

    const live = mount({ view: "transcript", transcript: TRANSCRIPT(true, true) });
    expect(ids(live.api)).toEqual(["close", "follow", "thinking"]);
    live.api["follow"]?.();
    expect(live.spies.toEnd).toHaveBeenCalledTimes(1);
    expect(live.spies.setTranscriptFollow).toHaveBeenCalledWith(false);
    live.unmount();

    const paused = mount({ view: "transcript", transcript: TRANSCRIPT(true, false) });
    paused.api["follow"]?.();
    expect(paused.spies.toEnd).not.toHaveBeenCalled();
    expect(paused.spies.setTranscriptFollow).toHaveBeenCalledWith(true);
    paused.unmount();
  });

  it("the chat view hands through useChatInput's own arm (Ruling R15)", () => {
    const { api, spies, unmount } = mount({ view: "chat" });
    expect(ids(api)).toEqual(["close"]);
    api["close"]!();
    expect(spies.chatClose).toHaveBeenCalledTimes(1);
    expect(spies.close).not.toHaveBeenCalled(); // NOT the shared close recipe
    unmount();
  });

  it("the chromeless views expose no mnemonic actions", () => {
    for (const view of ["palette", "addRepo", "config", "help", "main"] as const) {
      const { api, unmount } = mount({ view });
      expect(ids(api)).toEqual([]);
      unmount();
    }
  });
});

describe("useViewActions — review", () => {
  const openBatch: ReviewState = {
    ...EMPTY_REVIEW,
    batches: [BATCH],
    open: { kind: "batch", batchIdx: 0, findingCursor: 0, checked: new Set(["fp1"]) },
  };
  const openDraft: ReviewState = {
    ...EMPTY_REVIEW,
    drafts: [DRAFT],
    open: { kind: "draft", draftIdx: 0 },
  };

  const openChatDraft: ReviewState = {
    ...EMPTY_REVIEW,
    chatDrafts: [CHAT_DRAFT],
    open: { kind: "chatDraft", idx: 0 },
  };

  it("exposes the eight review ids", () => {
    const { api, unmount } = mount({ view: "review", reviewState: openBatch });
    expect(ids(api)).toEqual([
      "all",
      "close",
      "discard",
      "edit",
      "file",
      "none",
      "route",
      "submit",
    ]);
    unmount();
  });

  it("all / none set the open batch's checked set", () => {
    const { api, spies, unmount } = mount({ view: "review", reviewState: openBatch });
    api["all"]?.();
    const allUpdater = spies.setReviewState.mock.calls[0]?.[0] as (s: ReviewState) => ReviewState;
    const afterAll = allUpdater(openBatch);
    expect([...((afterAll.open as { checked: Set<string> }).checked ?? [])].sort()).toEqual([
      "fp1",
      "fp2",
    ]);
    api["none"]?.();
    const noneUpdater = spies.setReviewState.mock.calls[1]?.[0] as (s: ReviewState) => ReviewState;
    expect((noneUpdater(openBatch).open as { checked: Set<string> }).checked.size).toBe(0);
    unmount();
  });

  it("file posts the open draft and drops it from the list", async () => {
    const postCommentDraft = vi.fn(async () => ({
      ok: true as const,
      value: { outcome: "sent" as const, url: "https://x/1" },
    }));
    const { api, spies, unmount } = mount({
      view: "review",
      reviewState: openDraft,
      client: { postCommentDraft } as unknown as Partial<DashboardClient>,
    });
    api["file"]?.();
    expect(postCommentDraft).toHaveBeenCalledWith(DRAFT.id);
    await until(() =>
      spies.showToast.mock.calls.some((c) => c[0] === "success" && c[1] === "posted https://x/1"),
    );
    const drop = spies.setReviewState.mock.calls.at(-1)?.[0] as (s: ReviewState) => ReviewState;
    expect(drop(openDraft)).toMatchObject({ drafts: [], open: null, cursor: 0 });
    unmount();
  });

  it("file on a batch sends only the checked fingerprints", async () => {
    const fileReview = vi.fn(async () => ({
      ok: true as const,
      value: { created: 1, queuedOffline: 0, deduped: 0, failed: 0, batch: BATCH },
    }));
    const { api, spies, unmount } = mount({
      view: "review",
      reviewState: openBatch,
      client: { fileReview } as unknown as Partial<DashboardClient>,
    });
    api["file"]?.();
    expect(fileReview).toHaveBeenCalledWith(BATCH.id, ["fp1"]);
    await until(() => spies.showToast.mock.calls.some((c) => c[0] === "success"));
    unmount();
  });

  it("file on a batch with nothing checked toasts instead of calling gh", () => {
    const fileReview = vi.fn();
    const { api, spies, unmount } = mount({
      view: "review",
      reviewState: {
        ...openBatch,
        open: { kind: "batch", batchIdx: 0, findingCursor: 0, checked: new Set() },
      },
      client: { fileReview } as unknown as Partial<DashboardClient>,
    });
    api["file"]?.();
    expect(fileReview).not.toHaveBeenCalled();
    expect(spies.showToast).toHaveBeenCalledWith("info", "nothing selected");
    unmount();
  });

  it("discard removes the open batch optimistically", async () => {
    const discardReview = vi.fn(async () => ({ ok: true as const, value: null }));
    const { api, spies, unmount } = mount({
      view: "review",
      reviewState: openBatch,
      client: { discardReview } as unknown as Partial<DashboardClient>,
    });
    api["discard"]?.();
    expect(discardReview).toHaveBeenCalledWith(BATCH.id);
    await until(() =>
      spies.showToast.mock.calls.some((c) => c[0] === "success" && c[1] === "discarded"),
    );
    const drop = spies.setReviewState.mock.calls.at(-1)?.[0] as (s: ReviewState) => ReviewState;
    expect(drop(openBatch)).toMatchObject({ batches: [], open: null, cursor: 0 });
    unmount();
  });

  it("a failed post surfaces the error and keeps the draft", async () => {
    const postCommentDraft = vi.fn(async () => ({ ok: false as const, error: "boom" }));
    const { api, spies, unmount } = mount({
      view: "review",
      reviewState: openDraft,
      client: { postCommentDraft } as unknown as Partial<DashboardClient>,
    });
    api["file"]?.();
    await until(() => spies.showToast.mock.calls.some((c) => c[0] === "error" && c[1] === "boom"));
    expect(spies.setReviewState).not.toHaveBeenCalled();
    unmount();
  });

  it("submit / edit / route act on the OPEN chat draft", () => {
    const { api, spies, unmount } = mount({ view: "review", reviewState: openChatDraft });
    api["submit"]?.();
    api["edit"]?.();
    api["route"]?.();
    expect(spies.chatSubmit).toHaveBeenCalledWith(CHAT_DRAFT);
    expect(spies.chatEdit).toHaveBeenCalledWith(CHAT_DRAFT);
    expect(spies.chatRoute).toHaveBeenCalledWith(CHAT_DRAFT);
    unmount();
  });

  it("submit / edit / route act on the chat draft under the CURSOR in list mode", () => {
    const listMode: ReviewState = {
      ...EMPTY_REVIEW,
      batches: [BATCH],
      drafts: [DRAFT],
      chatDrafts: [CHAT_DRAFT],
      cursor: 2, // past the batch and the comment draft
    };
    const { api, spies, unmount } = mount({ view: "review", reviewState: listMode });
    api["submit"]?.();
    expect(spies.chatSubmit).toHaveBeenCalledWith(CHAT_DRAFT);
    unmount();
  });

  it("discard routes to the chat verb when a chat draft is selected, and to the batch/draft verb otherwise", () => {
    const chat = mount({ view: "review", reviewState: openChatDraft });
    chat.api["discard"]?.();
    expect(chat.spies.chatDiscard).toHaveBeenCalledWith(CHAT_DRAFT);
    chat.unmount();

    const discardReview = vi.fn(async () => ({ ok: true as const, value: null }));
    const batch = mount({
      view: "review",
      reviewState: openBatch,
      client: { discardReview } as unknown as Partial<DashboardClient>,
    });
    batch.api["discard"]?.();
    expect(batch.spies.chatDiscard).not.toHaveBeenCalled();
    expect(discardReview).toHaveBeenCalledWith(BATCH.id);
    batch.unmount();
  });

  it("submit / edit / route are inert when the cursor is not on a chat draft", () => {
    const { api, spies, unmount } = mount({
      view: "review",
      reviewState: { ...EMPTY_REVIEW, batches: [BATCH], chatDrafts: [CHAT_DRAFT], cursor: 0 },
    });
    api["submit"]?.();
    api["edit"]?.();
    api["route"]?.();
    expect(spies.chatSubmit).not.toHaveBeenCalled();
    expect(spies.chatEdit).not.toHaveBeenCalled();
    expect(spies.chatRoute).not.toHaveBeenCalled();
    unmount();
  });
});
