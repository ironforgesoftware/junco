// Perf-pass measurement (spec 2026-07-21-tui-app-decomposition task 16):
// the big dashboard components are wrapped in React.memo so that a poll
// which updates ONE domain (e.g. health @5s) does not re-render unrelated
// subtrees. This file drives an UNRELATED App re-render (health-poll-only —
// health is never passed to any of these components) and records, per
// mounted view, whether the target component's render count stays flat.
//
// MEASURED RESULT, task 16 (see its commit body for the full before/after
// table): memo only achieved a bail-out for ActivityCard and PrPreview. Every
// other target (IssueList, PrList, UnifiedRail, RepoDetail, Preview,
// QueueView, OutboxSection, WorktreesSection, DaemonSection) re-rendered on
// every unrelated App render, because App handed it at least one prop that
// was a fresh reference every render: an inline arrow at the JSX call site
// (`onWheel={(d) => scrollBy(d)}`, `onRowPress={(i) => {...}}`), a plain
// function re-declared in App's body instead of behind useCallback
// (`railRowPress`, `sectionRowPress`, the github-hook movers), a `windowSlice`
// window object recomputed unconditionally every render, or (RepoDetail) an
// inline `.filter()` on `localHeavy.worktrees` run fresh every render. That
// was documented, not fixed — task 16's brief was explicit that the
// prop-stability refactor was out of scope for that pass.
//
// MEASURED RESULT, perf pass #259 (this file's current state): the follow-up
// pass stabilized every one of those props — see App.tsx/useGithubData.ts for
// the sites (useMemo'd window/worktrees values, useCallback'd movers and row-
// press handlers, hoisted JSX arrows) — and ALL ELEVEN targets now stay FLAT
// across an unrelated (health-only) App re-render. Every assertion below was
// flipped from `toBeGreaterThan(0)` to `toBe(0)` to match.
//
// The measurement seam (src/tui/renderCount.ts) is a no-op unless
// JUNCO_RENDER_COUNT=1, so it costs nothing in prod or the other ~3000
// tests. We flip it on for this file only and restore it afterward.
import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { cleanup } from "ink-testing-library";
import { writeFileSync } from "node:fs";
import { bumpRender, renderCounts, resetRenderCounts } from "../src/tui/renderCount.js";
import { until } from "./helpers/until.js";
import {
  renderApp,
  stubClient,
  tap,
  TO_QUEUE_ROW,
  TO_OUTBOX_ROW,
  TO_WORKTREES_ROW,
  TO_DAEMON_ROW,
} from "./helpers/localFixtures.js";
import type { DashboardClient } from "../src/tui/ghClient.js";

const ORIGINAL_FLAG = process.env.JUNCO_RENDER_COUNT;

// A small, fast health-poll cadence — every other poll (refresh/queue/local
// cheap/heavy) stays at localFixtures' 999999ms, so this is the ONLY thing
// that can drive a post-mount App re-render in this file. `health` itself is
// never read by any of the target components (it only feeds the Header),
// which is exactly the "unrelated poll" scenario task 16 asks to measure.
const HEALTH_POLL_MS = 15;

/** A health probe whose answer CHANGES on every poll (tasksProcessed ticks up,
 * a Header-only field): since the poll sinks became change-gated (spec
 * 2026-09-01-ink-render-perf-design.md, tier 1) an unchanged health answer no
 * longer re-renders App at all — which is the point of that work, but this
 * file needs an UNRELATED App re-render to measure the memo bail-outs against,
 * so the fixture must deliver a genuine, targets-irrelevant change each tick. */
function tickingHealthClient(): DashboardClient {
  let n = 0;
  return {
    ...stubClient,
    health: async () => ({ ...(await stubClient.health()), tasksProcessed: ++n }),
  };
}

beforeEach(() => {
  process.env.JUNCO_RENDER_COUNT = "1";
  resetRenderCounts();
});

afterEach(cleanup);

afterAll(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.JUNCO_RENDER_COUNT;
  else process.env.JUNCO_RENDER_COUNT = ORIGINAL_FLAG;
});

/** Wait for App to have re-rendered at least once beyond `baseline` — the
 * signature of a completed health-poll tick (the only live timer in this
 * fixture set). Bounded by `until`'s own retry budget. */
async function waitForNextAppRender(baseline: number): Promise<void> {
  await until(() => (renderCounts().App ?? 0) > baseline);
}

/** Every component this task wraps in React.memo, by the name it passes to
 * bumpRender — used to snapshot the full picture at each waypoint even
 * though only a subset is mounted in any one view. Written to disk (not
 * asserted directly) so the before/after tables in the task report and
 * commit body are reproducible, not hand-typed. */
const ALL_TARGETS = [
  "IssueList",
  "PrList",
  "UnifiedRail",
  "RepoDetail",
  "Preview",
  "PrPreview",
  "QueueView",
  "ActivityCard",
  "OutboxSection",
  "WorktreesSection",
  "DaemonSection",
] as const;

interface Waypoint {
  name: string;
  counts: Record<string, number>;
}

const waypoints: Waypoint[] = [];

function record(name: string): void {
  const counts: Record<string, number> = {};
  for (const t of ALL_TARGETS) counts[t] = renderCounts()[t] ?? 0;
  waypoints.push({ name, counts });
}

afterAll(() => {
  const outPath = process.env.JUNCO_PERF_OUT ?? "/tmp/perf-after.json";
  writeFileSync(outPath, JSON.stringify(waypoints, null, 2));
});

describe("React.memo perf pass — unrelated (health-only) App re-render", () => {
  it("main view (IssueList + PrList + UnifiedRail mounted)", async () => {
    const r = renderApp({ healthPollMs: HEALTH_POLL_MS, client: tickingHealthClient() });
    // Mount settle: wait for the three always-on-in-this-view components to
    // have rendered at least once (their first paint, plus whatever the
    // mount-time effects/polls contribute).
    await until(
      () =>
        (renderCounts().IssueList ?? 0) >= 1 &&
        (renderCounts().PrList ?? 0) >= 1 &&
        (renderCounts().UnifiedRail ?? 0) >= 1,
    );
    // Let mount-time effects settle before the measurement window starts: the
    // initial github fetch (client.listIssues/listPrs, kicked off by the
    // "scoped cycle on mount" effect) resolves on its own microtask shortly
    // after mount, which is a GENUINE data-arrival re-render, not an
    // unrelated one. Without this, that render can land inside the very
    // first `waitForNextAppRender` window below and read as a false bump —
    // every target still shows a clean, permanent 0 on every render after it.
    await new Promise((res) => setTimeout(res, 20));
    resetRenderCounts();
    const appBefore = renderCounts().App ?? 0; // 0, just reset
    await waitForNextAppRender(appBefore);
    record("main");

    // App itself MUST have re-rendered (that's the whole premise) — if this
    // fails the test isn't measuring what it claims to.
    expect((renderCounts().App ?? 0) > appBefore).toBe(true);
    // MEASURED (perf #259): all three now stay FLAT. IssueList/PrList's
    // onRowPress/onWheel are useCallback'd (issueRowPress/moveIssue,
    // pane3RowPress/movePane3); UnifiedRail's assess/onPanePress/onWheel are
    // hoisted (railAssess/railPanePress/railWheel) and its onRowPress
    // (railRowPress) is useCallback'd over stable deps (openRepoDetailView,
    // onLogExpand — both now useCallback'd at their own source). The
    // `window`/`issueCounts` props were already memo-safe; `railWindow`/
    // `issueWindow`/`pane3Window` are now useMemo'd too (a fresh
    // `windowSlice()` object every render was defeating every one of these
    // regardless of their callback props).
    expect(renderCounts().IssueList ?? 0).toBe(0);
    expect(renderCounts().PrList ?? 0).toBe(0);
    expect(renderCounts().UnifiedRail ?? 0).toBe(0);
    void r;
  });

  it("prs view (PrList + PrPreview mounted) — both are now bail-outs", async () => {
    const r = renderApp({ healthPollMs: HEALTH_POLL_MS, client: tickingHealthClient() });
    await until(() => (renderCounts().IssueList ?? 0) >= 1);
    r.stdin.write("p");
    await until(() => (renderCounts().PrPreview ?? 0) >= 1);
    resetRenderCounts();
    const appBefore = renderCounts().App ?? 0;
    await waitForNextAppRender(appBefore);
    record("prs");
    // MEASURED (perf #259): PrList's onRowPress/onWheel are hoisted
    // (prsRowPress/movePr, the latter useCallback'd in useGithubData.ts) —
    // stays FLAT, same story as "main".
    expect(renderCounts().PrList ?? 0).toBe(0);
    // MEASURED: PrPreview stays FLAT. Its props at this call site
    // (pr/branchPrefix/now/height/width/focused/onLinkPress) are either
    // primitives unaffected by the health poll, or `onLinkPress =
    // selectedPr ? openSelectedPr : undefined` — `openSelectedPr` is itself
    // useCallback'd on [client, selectedPr, showToast], none of which the
    // health poll touches. This is the one target that was ALREADY flat
    // before #259 — no unstable prop at its call site to begin with.
    expect(renderCounts().PrPreview ?? 0).toBe(0);
  });

  it("issue detail view (Preview mounted)", async () => {
    const r = renderApp({ healthPollMs: HEALTH_POLL_MS, client: tickingHealthClient() });
    await until(() => (renderCounts().IssueList ?? 0) >= 1);
    // tap (not two bare writes): "i" must commit its setPane(2) before "\r"
    // is read, or the App closure still sees pane===1 and "\r" opens
    // RepoDetail instead (pane 1's enter recipe) — a real ink race, not a
    // memo concern (until.ts documents the same class of hazard).
    await tap(r, "i\r");
    await until(() => (renderCounts().Preview ?? 0) >= 1);
    resetRenderCounts();
    const appBefore = renderCounts().App ?? 0;
    await waitForNextAppRender(appBefore);
    record("detail");
    // MEASURED (perf #259): `onWheel={scrollBy}` now passes the already-
    // useCallback'd scrollBy straight through instead of wrapping it in a
    // fresh `(d) => scrollBy(d)` arrow every render — stays FLAT.
    expect(renderCounts().Preview ?? 0).toBe(0);
  });

  it("repoDetail view (RepoDetail mounted)", async () => {
    const r = renderApp({ healthPollMs: HEALTH_POLL_MS, client: tickingHealthClient() });
    await until(() => (renderCounts().UnifiedRail ?? 0) >= 1);
    r.stdin.write("\r"); // pane 1, row 0 is a repo row — enter opens RepoDetail
    await until(() => (renderCounts().RepoDetail ?? 0) >= 1);
    resetRenderCounts();
    const appBefore = renderCounts().App ?? 0;
    await waitForNextAppRender(appBefore);
    record("repoDetail");
    // MEASURED (perf #259): same onWheel fix as Preview, PLUS `worktrees` —
    // an inline `.filter()` over `localHeavy.worktrees` that allocated a
    // fresh array every render regardless of onWheel — is now `useMemo`'d
    // (`repoDetailWorktrees`, keyed on `[localHeavy, repoDetailTarget]`).
    // Stays FLAT.
    expect(renderCounts().RepoDetail ?? 0).toBe(0);
  });

  it("queue section (QueueView + ActivityCard mounted) — both are now bail-outs", async () => {
    const r = renderApp({ healthPollMs: HEALTH_POLL_MS, client: tickingHealthClient() });
    await until(() => (renderCounts().IssueList ?? 0) >= 1);
    await tap(r, TO_QUEUE_ROW); // acme/api -> beta/two -> queue
    await until(
      () => (renderCounts().QueueView ?? 0) >= 1 && (renderCounts().ActivityCard ?? 0) >= 1,
    );
    resetRenderCounts();
    const appBefore = renderCounts().App ?? 0;
    await waitForNextAppRender(appBefore);
    record("queue");
    // MEASURED (perf #259): `onRowPress={sectionRowPress}`, now useCallback'd
    // over `[confirm, sysSection]` instead of a plain function re-declared in
    // App's body every render — stays FLAT.
    expect(renderCounts().QueueView ?? 0).toBe(0);
    // MEASURED: ActivityCard stays FLAT — its only props (stats/width/
    // height) are all App-state/layout values the health poll never
    // touches, and it takes NO callback props at all. The cleanest possible
    // case for memo, and it delivered even before #259.
    expect(renderCounts().ActivityCard ?? 0).toBe(0);
  });

  it("outbox section (OutboxSection mounted)", async () => {
    const r = renderApp({ healthPollMs: HEALTH_POLL_MS, client: tickingHealthClient() });
    await until(() => (renderCounts().IssueList ?? 0) >= 1);
    await tap(r, TO_OUTBOX_ROW);
    await until(() => (renderCounts().OutboxSection ?? 0) >= 1);
    resetRenderCounts();
    const appBefore = renderCounts().App ?? 0;
    await waitForNextAppRender(appBefore);
    record("outbox");
    // MEASURED (perf #259): same `sectionRowPress` fix as QueueView, plus
    // `window={sectionWin}` — now `useMemo`'d — stays FLAT.
    expect(renderCounts().OutboxSection ?? 0).toBe(0);
    expect(renderCounts().ActivityCard ?? 0).toBe(0); // still mounted (wide pane 3), still flat
  });

  it("worktrees section (WorktreesSection mounted)", async () => {
    const r = renderApp({ healthPollMs: HEALTH_POLL_MS, client: tickingHealthClient() });
    await until(() => (renderCounts().IssueList ?? 0) >= 1);
    await tap(r, TO_WORKTREES_ROW);
    await until(() => (renderCounts().WorktreesSection ?? 0) >= 1);
    resetRenderCounts();
    const appBefore = renderCounts().App ?? 0;
    await waitForNextAppRender(appBefore);
    record("worktrees");
    // MEASURED (perf #259): same fix as OutboxSection — stays FLAT.
    expect(renderCounts().WorktreesSection ?? 0).toBe(0);
    expect(renderCounts().ActivityCard ?? 0).toBe(0);
  });

  it("daemon section (DaemonSection mounted)", async () => {
    const r = renderApp({ healthPollMs: HEALTH_POLL_MS, client: tickingHealthClient() });
    await until(() => (renderCounts().IssueList ?? 0) >= 1);
    await tap(r, TO_DAEMON_ROW);
    await until(() => (renderCounts().DaemonSection ?? 0) >= 1);
    resetRenderCounts();
    const appBefore = renderCounts().App ?? 0;
    await waitForNextAppRender(appBefore);
    record("daemon");
    // MEASURED (perf #259): `onWheel={scrollBy}`, same fix as Preview/
    // RepoDetail — stays FLAT.
    expect(renderCounts().DaemonSection ?? 0).toBe(0);
    expect(renderCounts().ActivityCard ?? 0).toBe(0);
  });
});

// Keep the bumpRender import referenced even though this file never mounts a
// bare component outside App — it documents the seam this suite consumes.
void bumpRender;
