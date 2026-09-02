// tests/useMainActions.test.tsx
import { describe, it, expect, vi } from "vitest";
import React, { useRef } from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { useMainActions, type MainActionsInput } from "../src/tui/hooks/useMainActions.js";
import type { DashboardClient } from "../src/tui/ghClient.js";
import type { DashIssue } from "../src/tui/state.js";
import type { DashPr } from "../src/tui/prState.js";
import type { UnifiedRepo } from "../src/tui/railModel.js";
import type { ReviewState } from "../src/tui/components/ReviewView.js";
import type { LocalCheap } from "../src/tui/localSnapshot.js";
import { until } from "./helpers/until.js";

const TRIGGER = "junco";

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

const ISSUE: DashIssue = {
  number: 42,
  title: "an issue",
  labels: [],
  updatedAt: "2026-07-20T00:00:00.000Z",
  url: "https://github.com/acme/widgets/issues/42",
  author: null,
};

const PR = { nwo: "acme/widgets", number: 9 } as unknown as DashPr;

const MAPPING = {
  nwo: "acme/widgets",
  path: "/repos/acme/widgets",
  fromConfig: false,
  external: false,
};

function makeSpies() {
  return {
    exit: vi.fn(),
    onExit: vi.fn(),
    setView: vi.fn(),
    setRailSel: vi.fn(),
    setPane: vi.fn(),
    githubRefreshAll: vi.fn(async () => undefined),
    githubSetRefreshing: vi.fn(),
    setReviewState: vi.fn(),
    loadReview: vi.fn(async () => undefined),
    resetPalette: vi.fn(),
    setAddRepoError: vi.fn(),
    showToast: vi.fn(),
    forceLocalRefresh: vi.fn(async () => undefined),
    unwatch: vi.fn(),
    openRepoBrowser: vi.fn(),
    openBrowser: vi.fn(),
    runAssess: vi.fn(),
    runAction: vi.fn(),
    runLocalAction: vi.fn(),
    askConfirm: vi.fn(),
  };
}

function Probe({
  input,
  onReady,
}: {
  input: Omit<MainActionsInput, "aliveRef">;
  onReady: (a: Record<string, () => void>) => void;
}) {
  const aliveRef = useRef(true);
  onReady(useMainActions({ ...input, aliveRef }));
  return <Text>probe</Text>;
}

function mount(
  overrides: Partial<Omit<MainActionsInput, "aliveRef" | "client">> & {
    client?: Partial<DashboardClient>;
  } = {},
) {
  const spies = makeSpies();
  const { client, ...rest } = overrides;
  const input: Omit<MainActionsInput, "aliveRef"> = {
    client: (client ?? {}) as unknown as DashboardClient,
    trigger: TRIGGER,
    githubEnabled: true,
    watchlistError: null,
    pane: 1,
    body: { kind: "issues", nwo: "acme/widgets" },
    sysSection: null,
    selectedRow: { kind: "repo", repo: REPO },
    currentNwo: "acme/widgets",
    currentIssue: ISSUE,
    currentRepo: MAPPING,
    selectedPane3Pr: null,
    localTarget: undefined,
    localCheap: null,
    exit: spies.exit,
    onExit: spies.onExit,
    setView: spies.setView,
    setRailSel: spies.setRailSel,
    setPane: spies.setPane,
    githubRefreshAll: spies.githubRefreshAll,
    githubSetRefreshing: spies.githubSetRefreshing,
    setReviewState: spies.setReviewState,
    loadReview: spies.loadReview,
    resetPalette: spies.resetPalette,
    setAddRepoError: spies.setAddRepoError,
    showToast: spies.showToast,
    forceLocalRefresh: spies.forceLocalRefresh,
    unwatch: spies.unwatch,
    openRepoBrowser: spies.openRepoBrowser,
    openBrowser: spies.openBrowser,
    runAssess: spies.runAssess,
    runAction: spies.runAction,
    runLocalAction: spies.runLocalAction,
    askConfirm: spies.askConfirm,
    ...rest,
  };
  let api!: Record<string, () => void>;
  const r = render(<Probe input={input} onReady={(a) => (api = a)} />);
  return { api, spies, unmount: r.unmount };
}

const ALL_IDS = [
  "addRepo",
  "analyze",
  "approve",
  "assess",
  "assessAutoPlan",
  "browser",
  "commands",
  "delete",
  "dispatch",
  "dispatchAsk",
  "flush",
  "help",
  "prs",
  "prune",
  "queue",
  "quit",
  "refresh",
  "replan",
  "restart",
  "retry",
  "review",
  "unwatch",
];

describe("useMainActions — the main view's action table", () => {
  it("exposes exactly the main-view action ids (the refactor's invariant)", () => {
    const { api, unmount } = mount();
    expect(Object.keys(api).sort()).toEqual(ALL_IDS);
    unmount();
  });

  it("quit exits ink then the host", () => {
    const { api, spies, unmount } = mount();
    api["quit"]?.();
    expect(spies.exit).toHaveBeenCalledTimes(1);
    expect(spies.onExit).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("queue selects the queue rail row and focuses pane 2", () => {
    const { api, spies, unmount } = mount();
    api["queue"]?.();
    expect(spies.setRailSel).toHaveBeenCalledWith("sys:queue");
    expect(spies.setPane).toHaveBeenCalledWith(2);
    unmount();
  });

  it("prs opens the PR view and kicks a monitor-scoped refresh", () => {
    const { api, spies, unmount } = mount();
    api["prs"]?.();
    expect(spies.setView).toHaveBeenCalledWith("prs");
    expect(spies.githubRefreshAll).toHaveBeenCalledWith({ scope: "monitor" });
    unmount();
  });

  it("review resets the review state, navigates, then loads", () => {
    const { api, spies, unmount } = mount();
    api["review"]?.();
    const updater = spies.setReviewState.mock.calls[0]?.[0] as (s: ReviewState) => ReviewState;
    expect(
      updater({
        loading: false,
        error: "old",
        batches: [],
        drafts: [],
        cursor: 5,
        open: { kind: "draft", draftIdx: 1 },
      }),
    ).toMatchObject({ loading: true, error: null, open: null, cursor: 0 });
    expect(spies.setView).toHaveBeenCalledWith("review");
    expect(spies.loadReview).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("commands resets the palette before showing it", () => {
    const { api, spies, unmount } = mount();
    api["commands"]?.();
    expect(spies.resetPalette).toHaveBeenCalledTimes(1);
    expect(spies.setView).toHaveBeenCalledWith("palette");
    unmount();
  });

  it("addRepo is gated on github mode and a readable watchlist", () => {
    const off = mount({ githubEnabled: false });
    off.api["addRepo"]?.();
    expect(off.spies.showToast).toHaveBeenCalledWith(
      "info",
      "github mode is off ([github] enabled=false)",
    );
    expect(off.spies.setView).not.toHaveBeenCalled();
    off.unmount();

    const broken = mount({ watchlistError: "bad yaml" });
    broken.api["addRepo"]?.();
    expect(broken.spies.showToast).toHaveBeenCalledWith(
      "error",
      "watchlist unreadable — fix it before adding",
    );
    expect(broken.spies.setView).not.toHaveBeenCalled();
    broken.unmount();

    const ok = mount();
    ok.api["addRepo"]?.();
    expect(ok.spies.setAddRepoError).toHaveBeenCalledWith(null);
    expect(ok.spies.setView).toHaveBeenCalledWith("addRepo");
    ok.unmount();
  });

  it("refresh always re-polls LOCAL and only re-polls github with a repo scope", () => {
    const withRepo = mount();
    withRepo.api["refresh"]?.();
    expect(withRepo.spies.forceLocalRefresh).toHaveBeenCalledTimes(1);
    expect(withRepo.spies.githubSetRefreshing).toHaveBeenCalledWith(true);
    withRepo.unmount();

    const noRepo = mount({ currentNwo: undefined });
    noRepo.api["refresh"]?.();
    expect(noRepo.spies.forceLocalRefresh).toHaveBeenCalledTimes(1);
    expect(noRepo.spies.githubSetRefreshing).not.toHaveBeenCalled();
    noRepo.unmount();
  });

  it("unwatch acts on the selected rail repo, or toasts", () => {
    const hit = mount();
    hit.api["unwatch"]?.();
    expect(hit.spies.unwatch).toHaveBeenCalledWith("acme/widgets");
    hit.unmount();

    const unwatched = mount({ selectedRow: { kind: "repo", repo: { ...REPO, watched: false } } });
    unwatched.api["unwatch"]?.();
    expect(unwatched.spies.unwatch).not.toHaveBeenCalled();
    expect(unwatched.spies.showToast).toHaveBeenCalledWith("info", "not in watchlist");
    unwatched.unmount();

    const sys = mount({ selectedRow: { kind: "system", section: "queue" } });
    sys.api["unwatch"]?.();
    expect(sys.spies.showToast).toHaveBeenCalledWith("info", "not in watchlist");
    sys.unmount();
  });

  it("browser is pane-aware: rail repo, pane-3 PR, or the selected issue", async () => {
    const rail = mount({ pane: 1 });
    rail.api["browser"]?.();
    expect(rail.spies.openRepoBrowser).toHaveBeenCalledWith("acme/widgets");
    rail.unmount();

    const openPrInBrowser = vi.fn(async () => ({ ok: true as const, value: undefined }));
    const pane3 = mount({
      pane: 3,
      selectedPane3Pr: PR,
      client: { openPrInBrowser } as unknown as Partial<DashboardClient>,
    });
    pane3.api["browser"]?.();
    await until(() => openPrInBrowser.mock.calls.length === 1);
    expect(openPrInBrowser).toHaveBeenCalledWith("acme/widgets", 9);
    pane3.unmount();

    const issues = mount({ pane: 2 });
    issues.api["browser"]?.();
    expect(issues.spies.openBrowser).toHaveBeenCalledTimes(1);
    issues.unmount();

    // A section row has no repo behind it — the rail arm toasts instead.
    const section = mount({
      pane: 2,
      body: { kind: "section", section: "queue" },
      selectedRow: { kind: "system", section: "queue" },
    });
    section.api["browser"]?.();
    expect(section.spies.openRepoBrowser).not.toHaveBeenCalled();
    expect(section.spies.showToast).toHaveBeenCalledWith("info", "no GitHub URL");
    section.unmount();
  });

  it("assess scopes to the selected issue only from the issues pane", () => {
    const scoped = mount({ pane: 2 });
    scoped.api["assess"]?.();
    expect(scoped.spies.runAssess).toHaveBeenCalledWith(false, "acme/widgets#42");
    scoped.api["assessAutoPlan"]?.();
    expect(scoped.spies.runAssess).toHaveBeenCalledWith(true, "acme/widgets#42");
    scoped.unmount();

    const repoWide = mount({ pane: 1 });
    repoWide.api["assess"]?.();
    expect(repoWide.spies.runAssess).toHaveBeenCalledWith(false);
    repoWide.unmount();
  });

  it("dispatch imports for an external repo and runs the label action otherwise", async () => {
    const internal = mount();
    internal.api["dispatch"]?.();
    expect(internal.spies.runAction).toHaveBeenCalledWith("dispatch");
    internal.unmount();

    const dispatchTicket = vi.fn(async () => ({
      ok: true as const,
      value: { id: "gh-acme-widgets-1", destPath: "/x" },
    }));
    const external = mount({
      currentRepo: { ...MAPPING, external: true },
      client: { dispatchTicket } as unknown as Partial<DashboardClient>,
    });
    external.api["dispatch"]?.();
    expect(dispatchTicket).toHaveBeenCalledWith("acme/widgets", 42);
    await until(() =>
      external.spies.showToast.mock.calls.some(
        (c) => c[0] === "success" && c[1] === "ticket queued: gh-acme-widgets-1",
      ),
    );
    expect(external.spies.runAction).not.toHaveBeenCalled();
    external.unmount();

    const notIssues = mount({ body: { kind: "section", section: "daemon" } });
    notIssues.api["dispatch"]?.();
    expect(notIssues.spies.runAction).not.toHaveBeenCalled();
    notIssues.unmount();
  });

  it("dispatchAsk / approve refuse external repos", () => {
    for (const id of ["dispatchAsk", "approve"] as const) {
      const ext = mount({ currentRepo: { ...MAPPING, external: true } });
      ext.api[id]?.();
      expect(ext.spies.runAction).not.toHaveBeenCalled();
      expect(ext.spies.showToast).toHaveBeenCalledWith(
        "error",
        "not available for external repos — import queues a fork-PR ticket",
      );
      ext.unmount();

      const own = mount();
      own.api[id]?.();
      expect(own.spies.runAction).toHaveBeenCalledWith(id);
      own.unmount();
    }
  });

  it("replan re-plans a planned issue and recycles anything else", () => {
    const planned = mount({
      currentIssue: { ...ISSUE, labels: [`${TRIGGER}:plan-ready`] },
    });
    planned.api["replan"]?.();
    expect(planned.spies.runAction).toHaveBeenCalledWith("replan");
    planned.unmount();

    const raw = mount();
    raw.api["replan"]?.();
    expect(raw.spies.runAction).toHaveBeenCalledWith("recycle");
    raw.unmount();
  });

  it("analyze drafts an investigation for the selected issue", async () => {
    const analyzeIssue = vi.fn(async () => ({ ok: true as const, value: { id: "an-1" } }));
    const { api, spies, unmount } = mount({
      client: { analyzeIssue } as unknown as Partial<DashboardClient>,
    });
    api["analyze"]?.();
    expect(analyzeIssue).toHaveBeenCalledWith("acme/widgets", 42);
    await until(() =>
      spies.showToast.mock.calls.some(
        (c) => c[0] === "success" && String(c[1]).startsWith("investigation queued: an-1"),
      ),
    );
    unmount();
  });
});

describe("useMainActions — the section-body verbs", () => {
  it("retry requeues a failed ticket and guards every other row kind", () => {
    const failed = mount({
      sysSection: "queue",
      localTarget: { kind: "recent", id: "t-1", status: "failed" },
    });
    failed.api["retry"]?.();
    expect(failed.spies.runLocalAction).toHaveBeenCalledWith("retry", ["t-1"], {
      label: "requeue",
    });
    failed.unmount();

    const done = mount({
      sysSection: "queue",
      localTarget: { kind: "recent", id: "t-2", status: "done" },
    });
    done.api["retry"]?.();
    expect(done.spies.runLocalAction).not.toHaveBeenCalled();
    expect(done.spies.showToast).toHaveBeenCalledWith("info", "done tickets can't be requeued");
    done.unmount();

    const running = mount({ sysSection: "queue", localTarget: { kind: "running", id: "t-3" } });
    running.api["retry"]?.();
    expect(running.spies.showToast).toHaveBeenCalledWith(
      "info",
      "running — enter opens its transcript",
    );
    running.unmount();

    const elsewhere = mount({
      sysSection: "daemon",
      localTarget: { kind: "recent", id: "t-1", status: "failed" },
    });
    elsewhere.api["retry"]?.();
    expect(elsewhere.spies.runLocalAction).not.toHaveBeenCalled();
    elsewhere.unmount();
  });

  it("delete confirms before removing a queued ticket", () => {
    const waiting = mount({ sysSection: "queue", localTarget: { kind: "waiting", id: "t-9" } });
    waiting.api["delete"]?.();
    const state = waiting.spies.askConfirm.mock.calls[0]?.[0] as {
      danger: boolean;
      body: string;
      onConfirm: () => void;
    };
    expect(state.danger).toBe(true);
    expect(state.body).toContain("inbox/t-9.md");
    state.onConfirm();
    expect(waiting.spies.runLocalAction).toHaveBeenCalledWith("rm", ["t-9"]);
    waiting.unmount();

    const running = mount({ sysSection: "queue", localTarget: { kind: "running", id: "t-9" } });
    running.api["delete"]?.();
    expect(running.spies.askConfirm).not.toHaveBeenCalled();
    running.unmount();
  });

  it("flush drains the outbox from the outbox and daemon sections only", () => {
    for (const section of ["outbox", "daemon"] as const) {
      const m = mount({ sysSection: section });
      m.api["flush"]?.();
      expect(m.spies.runLocalAction).toHaveBeenCalledWith("outbox", ["flush"], { label: "flush" });
      m.unmount();
    }
    const wt = mount({ sysSection: "worktrees" });
    wt.api["flush"]?.();
    expect(wt.spies.runLocalAction).not.toHaveBeenCalled();
    wt.unmount();
  });

  it("prune confirms for a stale worktree and refuses a live one", () => {
    const stale = mount({
      sysSection: "worktrees",
      localTarget: { kind: "worktree", path: "/wt/a", slug: "a", klass: "stale" },
    });
    stale.api["prune"]?.();
    const state = stale.spies.askConfirm.mock.calls[0]?.[0] as { onConfirm: () => void };
    state.onConfirm();
    expect(stale.spies.runLocalAction).toHaveBeenCalledWith("worktree", ["prune", "/wt/a"], {
      label: "prune",
    });
    stale.unmount();

    const live = mount({
      sysSection: "worktrees",
      localTarget: { kind: "worktree", path: "/wt/b", slug: "b", klass: "live" },
    });
    live.api["prune"]?.();
    expect(live.spies.askConfirm).not.toHaveBeenCalled();
    expect(live.spies.showToast).toHaveBeenCalledWith("info", "live worktree — not prunable");
    live.unmount();
  });

  it("restart names the in-flight ticket count in its confirm body", () => {
    const localCheap = {
      daemon: { currentTickets: ["a", "b"] },
    } as unknown as LocalCheap;
    const { api, spies, unmount } = mount({ sysSection: "daemon", localCheap });
    api["restart"]?.();
    const state = spies.askConfirm.mock.calls[0]?.[0] as { body: string; onConfirm: () => void };
    expect(state.body).toContain("interrupt 2 in-flight ticket(s)");
    state.onConfirm();
    expect(spies.runLocalAction).toHaveBeenCalledWith("restart", [], { label: "restart" });
    unmount();
  });
});
