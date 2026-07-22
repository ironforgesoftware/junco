// Perf-pass measurement (spec 2026-07-21-tui-app-decomposition task 16):
// the big dashboard components are wrapped in React.memo so that a poll
// which updates ONE domain (e.g. health @5s) does not re-render unrelated
// subtrees. This file drives an UNRELATED App re-render (health-poll-only —
// health is never passed to any of these components) and records, per
// mounted view, whether the target component's render count stays flat.
//
// MEASURED RESULT (see the task-16 commit body for the full before/after
// table): memo only achieves a bail-out for ActivityCard and PrPreview.
// Every other target (IssueList, PrList, UnifiedRail, RepoDetail, Preview,
// QueueView, OutboxSection, WorktreesSection, DaemonSection) still
// re-renders on every unrelated App render, because App hands it at least
// one prop that is a fresh reference every render — an inline arrow at the
// JSX call site (`onWheel={(d) => scrollBy(d)}`, `onRowPress={(i) =>
// onRowPress(idx)}`-style closures inside the row map) or a plain function
// declared in App's body instead of behind useCallback (`railRowPress`,
// `sectionRowPress`). ActivityCard and PrPreview happen to be the two call
// sites where every prop traces back to either a primitive, a useCallback'd
// handler (`openSelectedPr`), or App state untouched by the health poll —
// so they are the only two where React.memo's shallow prop comparison can
// actually bail out. This is documented, not "fixed": the task brief is
// explicit that forcing prop-stability refactors (wrapping every inline
// handler in useCallback) is out of scope for this pass.
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
  tap,
  TO_QUEUE_ROW,
  TO_OUTBOX_ROW,
  TO_WORKTREES_ROW,
  TO_DAEMON_ROW,
} from "./helpers/localFixtures.js";

const ORIGINAL_FLAG = process.env.JUNCO_RENDER_COUNT;

// A small, fast health-poll cadence — every other poll (refresh/queue/local
// cheap/heavy) stays at localFixtures' 999999ms, so this is the ONLY thing
// that can drive a post-mount App re-render in this file. `health` itself is
// never read by any of the target components (it only feeds the Header),
// which is exactly the "unrelated poll" scenario task 16 asks to measure.
const HEALTH_POLL_MS = 15;

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
    const r = renderApp({ healthPollMs: HEALTH_POLL_MS });
    // Mount settle: wait for the three always-on-in-this-view components to
    // have rendered at least once (their first paint, plus whatever the
    // mount-time effects/polls contribute).
    await until(
      () =>
        (renderCounts().IssueList ?? 0) >= 1 &&
        (renderCounts().PrList ?? 0) >= 1 &&
        (renderCounts().UnifiedRail ?? 0) >= 1,
    );
    resetRenderCounts();
    const appBefore = renderCounts().App ?? 0; // 0, just reset
    await waitForNextAppRender(appBefore);
    record("main");

    // App itself MUST have re-rendered (that's the whole premise) — if this
    // fails the test isn't measuring what it claims to.
    expect((renderCounts().App ?? 0) > appBefore).toBe(true);
    // MEASURED: memo does NOT bail out here. IssueList/PrList both take an
    // inline `onRowPress={(i) => {...}}` / `onWheel={(d) => moveIssue(d)}`
    // closure built fresh at the JSX call site every App render; UnifiedRail
    // additionally gets `assess={(nwo) => assessHistory.get(nwo) ?? null}`
    // and `onRowPress={railRowPress}` (a plain function re-declared in App's
    // body, not useCallback). All three re-render on every App render,
    // memoized or not.
    expect(renderCounts().IssueList ?? 0).toBeGreaterThan(0);
    expect(renderCounts().PrList ?? 0).toBeGreaterThan(0);
    expect(renderCounts().UnifiedRail ?? 0).toBeGreaterThan(0);
    void r;
  });

  it("prs view (PrList + PrPreview mounted) — PrPreview is a genuine bail-out", async () => {
    const r = renderApp({ healthPollMs: HEALTH_POLL_MS });
    await until(() => (renderCounts().IssueList ?? 0) >= 1);
    r.stdin.write("p");
    await until(() => (renderCounts().PrPreview ?? 0) >= 1);
    resetRenderCounts();
    const appBefore = renderCounts().App ?? 0;
    await waitForNextAppRender(appBefore);
    record("prs");
    expect(renderCounts().PrList ?? 0).toBeGreaterThan(0); // same story as "main"
    // MEASURED: PrPreview stays FLAT. Its props at this call site
    // (pr/branchPrefix/now/height/width/focused/onLinkPress) are either
    // primitives unaffected by the health poll, or `onLinkPress =
    // selectedPr ? openSelectedPr : undefined` — `openSelectedPr` is itself
    // useCallback'd on [client, selectedPr, showToast], none of which the
    // health poll touches. This is the one target with NO unstable prop at
    // its call site, so memo actually earns its keep here.
    expect(renderCounts().PrPreview ?? 0).toBe(0);
  });

  it("issue detail view (Preview mounted)", async () => {
    const r = renderApp({ healthPollMs: HEALTH_POLL_MS });
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
    // MEASURED: Preview's onWheel (`(d) => scrollBy(d)`) is an inline
    // closure rebuilt at the call site every render, even though scrollBy
    // itself is useCallback-stable — memo cannot see past the wrapper.
    expect(renderCounts().Preview ?? 0).toBeGreaterThan(0);
  });

  it("repoDetail view (RepoDetail mounted)", async () => {
    const r = renderApp({ healthPollMs: HEALTH_POLL_MS });
    await until(() => (renderCounts().UnifiedRail ?? 0) >= 1);
    r.stdin.write("\r"); // pane 1, row 0 is a repo row — enter opens RepoDetail
    await until(() => (renderCounts().RepoDetail ?? 0) >= 1);
    resetRenderCounts();
    const appBefore = renderCounts().App ?? 0;
    await waitForNextAppRender(appBefore);
    record("repoDetail");
    // MEASURED: same inline-onWheel story as Preview.
    expect(renderCounts().RepoDetail ?? 0).toBeGreaterThan(0);
  });

  it("queue section (QueueView + ActivityCard mounted) — ActivityCard is a genuine bail-out", async () => {
    const r = renderApp({ healthPollMs: HEALTH_POLL_MS });
    await until(() => (renderCounts().IssueList ?? 0) >= 1);
    await tap(r, TO_QUEUE_ROW); // acme/api -> beta/two -> queue
    await until(
      () => (renderCounts().QueueView ?? 0) >= 1 && (renderCounts().ActivityCard ?? 0) >= 1,
    );
    resetRenderCounts();
    const appBefore = renderCounts().App ?? 0;
    await waitForNextAppRender(appBefore);
    record("queue");
    // MEASURED: QueueView still bumps — its `onRowPress={sectionRowPress}`
    // closes over a plain function re-declared in App's body every render
    // (not useCallback), so memo cannot bail out despite `onScrollMax` and
    // every other prop being stable.
    expect(renderCounts().QueueView ?? 0).toBeGreaterThan(0);
    // MEASURED: ActivityCard stays FLAT — its only props (stats/width/
    // height) are all App-state/layout values the health poll never
    // touches, and it takes NO callback props at all. The cleanest possible
    // case for memo, and it delivers.
    expect(renderCounts().ActivityCard ?? 0).toBe(0);
  });

  it("outbox section (OutboxSection mounted)", async () => {
    const r = renderApp({ healthPollMs: HEALTH_POLL_MS });
    await until(() => (renderCounts().IssueList ?? 0) >= 1);
    await tap(r, TO_OUTBOX_ROW);
    await until(() => (renderCounts().OutboxSection ?? 0) >= 1);
    resetRenderCounts();
    const appBefore = renderCounts().App ?? 0;
    await waitForNextAppRender(appBefore);
    record("outbox");
    // MEASURED: same `sectionRowPress` story as QueueView.
    expect(renderCounts().OutboxSection ?? 0).toBeGreaterThan(0);
    expect(renderCounts().ActivityCard ?? 0).toBe(0); // still mounted (wide pane 3), still flat
  });

  it("worktrees section (WorktreesSection mounted)", async () => {
    const r = renderApp({ healthPollMs: HEALTH_POLL_MS });
    await until(() => (renderCounts().IssueList ?? 0) >= 1);
    await tap(r, TO_WORKTREES_ROW);
    await until(() => (renderCounts().WorktreesSection ?? 0) >= 1);
    resetRenderCounts();
    const appBefore = renderCounts().App ?? 0;
    await waitForNextAppRender(appBefore);
    record("worktrees");
    expect(renderCounts().WorktreesSection ?? 0).toBeGreaterThan(0);
    expect(renderCounts().ActivityCard ?? 0).toBe(0);
  });

  it("daemon section (DaemonSection mounted)", async () => {
    const r = renderApp({ healthPollMs: HEALTH_POLL_MS });
    await until(() => (renderCounts().IssueList ?? 0) >= 1);
    await tap(r, TO_DAEMON_ROW);
    await until(() => (renderCounts().DaemonSection ?? 0) >= 1);
    resetRenderCounts();
    const appBefore = renderCounts().App ?? 0;
    await waitForNextAppRender(appBefore);
    record("daemon");
    // MEASURED: DaemonSection's onWheel is a fresh closure per App render,
    // same as RepoDetail/Preview above.
    expect(renderCounts().DaemonSection ?? 0).toBeGreaterThan(0);
    expect(renderCounts().ActivityCard ?? 0).toBe(0);
  });
});

// Keep the bumpRender import referenced even though this file never mounts a
// bare component outside App — it documents the seam this suite consumes.
void bumpRender;
