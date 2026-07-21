# TUI Unified View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the dashboard's GITHUB/LOCAL two-mode toggle into one view: a single rail listing all repos (github-linked + local-only) with a pinned `system` group (queue/outbox/worktrees/daemon/logs), body follows the cursor.

**Architecture:** Approach A from `docs/superpowers/specs/2026-07-20-tui-unified-view-design.md` — a `RailRow` discriminated union with key-anchored selection; existing section components reused as body arms; one input cascade. Build-new-then-swap-then-delete: new modules (`railModel`, `sections`, `RepoDetail`, `UnifiedRail`, `hintsForUnified`) land green alongside the old ones, App swaps in one task, cleanup deletes the old surface.

**Tech Stack:** TypeScript strict/NodeNext, React 18 + Ink, vitest + ink-testing-library. No new dependencies.

## Global Constraints

- Read the spec first: `docs/superpowers/specs/2026-07-20-tui-unified-view-design.md`.
- Suite green at every commit: `npx vitest run > /tmp/vitest.out 2>&1; echo "exit: $?"` — NEVER pipe vitest through grep/tail directly (exit-code trap, CLAUDE.md).
- `npm run typecheck` after shared-type changes — vitest does not type-check and `tsconfig.json` excludes `tests/`.
- Conventional commits, **no AI attribution trailers ever** (amend them away if a subagent adds one).
- Prettier may reformat between read and edit: re-read before editing, `npx prettier --write` touched files before committing.
- Ink tests: never assert one fixed `setTimeout` tick after a state change — loop-until-condition with bounded retry.
- Never import the Pi SDK at module top level (not applicable here, but binding).
- `src/ticketSchema.ts` is untouched by this plan (public contract).
- Stack-agnostic user-visible strings ("inference endpoint", never a specific server).
- Working branch: `feat/tui-unified-view` (already created at origin/main; the design spec is committed on it).

---

### Task 1: `repoPath` on queue snapshot rows

Additive field so RepoDetail (Task 4) can scope recent queue activity to a repo. `Ticket.frontmatter` retains the raw `repo:` value (`src/ticket.ts:91` computes `hasRepo` from it); the snapshot just surfaces it.

**Files:**

- Modify: `src/tui/queueSnapshot.ts`
- Test: `tests/queueSnapshot.test.ts` (extend the existing suite; reuse its existing cfg/deps fixture helpers)

**Interfaces:**

- Produces: `QueueRunning`/`QueueWaiting`/`QueueRecent` each gain `repoPath: string | null`. Task 4 consumes it; Task 7's fixture updates add the field to every inline queue-row literal.

- [ ] **Step 1: Write the failing test**

Extend `tests/queueSnapshot.test.ts` with a test (reusing the file's existing fixture/dep helpers — read the file first and follow its established pattern for fake queue dirs):

```ts
it("carries the ticket's repo path on waiting/running/recent rows", async () => {
  // Arrange, using this file's existing fake-fs helpers:
  //  - inbox ticket with frontmatter `repo: /tmp/proj-a`
  //  - processing ticket with `repo: /tmp/proj-b` and daemon down (no health)
  //  - done ticket with `repo: /tmp/proj-c`
  //  - one inbox Q&A ticket WITHOUT repo:
  const snap = await fn();
  expect(snap.waiting.find((w) => w.id === "with-repo")?.repoPath).toBe("/tmp/proj-a");
  expect(snap.waiting.find((w) => w.id === "no-repo")?.repoPath).toBeNull();
  expect(snap.running[0]?.repoPath).toBe("/tmp/proj-b");
  expect(snap.recent[0]?.repoPath).toBe("/tmp/proj-c");
});
```

- [ ] **Step 2: Run it, verify it fails** — `npx vitest run tests/queueSnapshot.test.ts > /tmp/vitest.out 2>&1; echo "exit: $?"` → exit 1, TS error / property missing.

- [ ] **Step 3: Implement**

In `src/tui/queueSnapshot.ts`:

```ts
// Add to each of QueueRunning, QueueWaiting, QueueRecent interfaces:
/** Ticket's `repo:` target path (frontmatter, raw); null on Q&A tickets and
 * unparsable rows. Lets the dashboard scope queue activity to a repo. */
repoPath: string | null;
```

Add one helper near `displayId`:

```ts
const ticketRepoPath = (t: Ticket | null | undefined): string | null => {
  const r = t?.frontmatter["repo"];
  return typeof r === "string" && r !== "" ? r : null;
};
```

Wire it: waiting map → `repoPath: ticketRepoPath(t)`; `mkRunning` → `repoPath: ticketRepoPath(procById.get(id))`; the daemon-down `proc.map` fallback → `repoPath: ticketRepoPath(e.ticket)`; recent map → `repoPath: ticketRepoPath(t)`.

- [ ] **Step 4: Suite + typecheck.** `npx vitest run tests/queueSnapshot.test.ts` passes. Then `npm run typecheck` — it will flag every full queue-row literal in tests (`tests/helpers/localFixtures.tsx`, `tests/tuiQueue.test.tsx`, others it names): add `repoPath: null` to each flagged literal. Re-run typecheck to zero NEW errors (~57 pre-existing errors in the eslint tsconfig sweep are known noise — compare against `git stash`-free baseline by counting, or just confirm no error mentions `repoPath`).

- [ ] **Step 5: Full suite green, commit** — `git add -A && git commit -m "feat(tui): carry the ticket repo path on queue snapshot rows"`.

---

### Task 2: `railModel.ts` — the pure row union

**Files:**

- Create: `src/tui/railModel.ts`
- Test: `tests/tuiRailModel.test.ts` (new)

**Interfaces:**

- Consumes: `LocalRepo` from `./localSnapshot.js`.
- Produces (Tasks 5/7 rely on these exact names):

```ts
export type SystemSection = "queue" | "outbox" | "worktrees" | "daemon" | "logs";
export const SYSTEM_SECTIONS: readonly SystemSection[];
export interface WatchedMapping {
  nwo: string;
  path: string;
  fromConfig: boolean;
  external: boolean;
}
export interface UnifiedRepo {
  key: string;
  nwo: string | null;
  path: string;
  fromConfig: boolean;
  external: boolean;
  source: "config" | "watchlist" | "external" | "clone";
  watched: boolean;
  git: {
    branch: string | null;
    headSha: string | null;
    dirty: boolean | null;
    originUrl: string | null;
    error: string | null;
  } | null;
  clones: string[];
}
export type RailRow =
  | { kind: "repo"; repo: UnifiedRepo }
  | { kind: "system"; section: SystemSection };
export type BodyKind =
  | { kind: "issues"; nwo: string }
  | { kind: "repoDetail"; repo: UnifiedRepo }
  | { kind: "section"; section: SystemSection };
export const sysKey: (s: SystemSection) => string; // "sys:queue"
export const rowKey: (row: RailRow) => string;
export function buildUnifiedRepos(
  watched: WatchedMapping[],
  heavy: LocalRepo[] | null,
): UnifiedRepo[];
export function buildRailRows(repos: UnifiedRepo[]): RailRow[]; // repos then 5 system rows
export function resolveRailIndex(rows: RailRow[], sel: string | null, lastIdx: number): number;
export function bodyKindFor(row: RailRow | undefined, githubEnabled: boolean): BodyKind | null;
```

- [ ] **Step 1: Write the failing tests** (`tests/tuiRailModel.test.ts`):

```ts
import { describe, expect, it } from "vitest";
import {
  buildUnifiedRepos,
  buildRailRows,
  resolveRailIndex,
  bodyKindFor,
  rowKey,
  sysKey,
  SYSTEM_SECTIONS,
  type WatchedMapping,
} from "../src/tui/railModel.js";
import type { LocalRepo } from "../src/tui/localSnapshot.js";

const heavyRepo = (over: Partial<LocalRepo>): LocalRepo => ({
  nwo: null,
  path: "/x",
  source: "clone",
  originUrl: null,
  forkUrl: null,
  githubUrl: null,
  branch: null,
  headSha: null,
  dirty: null,
  error: null,
  ...over,
});
const watched = (nwo: string, path: string, fromConfig = false): WatchedMapping => ({
  nwo,
  path,
  fromConfig,
  external: false,
});

describe("buildUnifiedRepos", () => {
  it("watched rows come first with git enrichment matched by path", () => {
    const rows = buildUnifiedRepos(
      [watched("Acme/API", "/w/api", true)],
      [
        heavyRepo({
          nwo: "acme/api",
          path: "/w/api",
          branch: "main",
          dirty: true,
          source: "config",
        }),
      ],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe("acme/api"); // nwo lowercased
    expect(rows[0].watched).toBe(true);
    expect(rows[0].git?.branch).toBe("main");
    expect(rows[0].git?.dirty).toBe(true);
  });
  it("a same-nwo stray clone collapses into the watched row as a clones entry", () => {
    const rows = buildUnifiedRepos(
      [watched("acme/api", "/w/api")],
      [
        heavyRepo({ nwo: "acme/api", path: "/w/api", branch: "main" }),
        heavyRepo({ nwo: "acme/api", path: "/data/clones/acme/api", source: "clone" }),
      ],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].clones).toEqual(["/data/clones/acme/api"]);
  });
  it("unmatched heavy candidates append as unwatched rows keyed by path", () => {
    const rows = buildUnifiedRepos(
      [watched("acme/api", "/w/api")],
      [heavyRepo({ nwo: null, path: "/dev/scratch", source: "clone" })],
    );
    expect(rows).toHaveLength(2);
    expect(rows[1].watched).toBe(false);
    expect(rows[1].key).toBe("/dev/scratch");
  });
  it("null heavy (pre-first-tick) still yields the watched rows, git null", () => {
    const rows = buildUnifiedRepos([watched("acme/api", "/w/api")], null);
    expect(rows).toHaveLength(1);
    expect(rows[0].git).toBeNull();
  });
});

describe("buildRailRows / keys", () => {
  it("appends the five system rows after the repos", () => {
    const rows = buildRailRows(buildUnifiedRepos([watched("a/b", "/p")], null));
    expect(rows).toHaveLength(1 + SYSTEM_SECTIONS.length);
    expect(rows[1]).toEqual({ kind: "system", section: "queue" });
    expect(rowKey(rows[1])).toBe(sysKey("queue"));
  });
});

describe("resolveRailIndex", () => {
  const rows = buildRailRows(buildUnifiedRepos([watched("a/b", "/p"), watched("c/d", "/q")], null));
  it("resolves a live key", () => {
    expect(resolveRailIndex(rows, "c/d", 0)).toBe(1);
    expect(resolveRailIndex(rows, sysKey("daemon"), 0)).toBe(5);
  });
  it("falls back to the clamped last index when the key is gone", () => {
    expect(resolveRailIndex(rows, "gone/gone", 99)).toBe(rows.length - 1);
    expect(resolveRailIndex(rows, null, 1)).toBe(1);
  });
  it("selection survives a repo-list insertion (the key-anchor point)", () => {
    const grown = buildRailRows(
      buildUnifiedRepos(
        [watched("a/b", "/p"), watched("c/d", "/q")],
        [heavyRepo({ nwo: null, path: "/new/clone" })],
      ),
    );
    expect(resolveRailIndex(grown, sysKey("queue"), 2)).toBe(3); // still the queue row
  });
});

describe("bodyKindFor", () => {
  const repos = buildUnifiedRepos(
    [watched("a/b", "/p")],
    [heavyRepo({ nwo: null, path: "/dev/scratch" })],
  );
  const rows = buildRailRows(repos);
  it("watched nwo row + github enabled → issues", () => {
    expect(bodyKindFor(rows[0], true)).toEqual({ kind: "issues", nwo: "a/b" });
  });
  it("watched nwo row + github disabled → repoDetail", () => {
    expect(bodyKindFor(rows[0], false)?.kind).toBe("repoDetail");
  });
  it("unwatched row → repoDetail regardless", () => {
    expect(bodyKindFor(rows[1], true)?.kind).toBe("repoDetail");
  });
  it("system row → section; undefined → null", () => {
    expect(bodyKindFor(rows[2], true)).toEqual({ kind: "section", section: "queue" });
    expect(bodyKindFor(undefined, true)).toBeNull();
  });
});
```

- [ ] **Step 2: Run, verify fail** (module not found).

- [ ] **Step 3: Implement `src/tui/railModel.ts`:**

```ts
/**
 * Pure row model for the unified rail: every repo junco knows about (watched
 * github repos + discovered local checkouts) followed by the five pinned
 * system rows. Selection is KEY-anchored (rowKey), never a bare index — the
 * heavy poll can discover a clone mid-session and shift positions.
 * Spec: docs/superpowers/specs/2026-07-20-tui-unified-view-design.md §1.
 */
import { resolve } from "node:path";
import type { LocalRepo } from "./localSnapshot.js";

export type SystemSection = "queue" | "outbox" | "worktrees" | "daemon" | "logs";
export const SYSTEM_SECTIONS: readonly SystemSection[] = [
  "queue",
  "outbox",
  "worktrees",
  "daemon",
  "logs",
];

export interface WatchedMapping {
  nwo: string;
  path: string;
  fromConfig: boolean;
  external: boolean;
}

export interface UnifiedRepo {
  /** Stable selection key: nwo.toLowerCase() for watched rows, resolved path
   * for discovered rows (paths can never collide with an owner/name). */
  key: string;
  nwo: string | null;
  path: string;
  fromConfig: boolean;
  external: boolean;
  source: "config" | "watchlist" | "external" | "clone";
  /** In config ∪ watchlist — the rows the github bridge/polls act on. */
  watched: boolean;
  /** Heavy-poll git enrichment; null until the first heavy tick delivers. */
  git: {
    branch: string | null;
    headSha: string | null;
    dirty: boolean | null;
    originUrl: string | null;
    error: string | null;
  } | null;
  /** Extra local checkouts of the same nwo, collapsed into this row. */
  clones: string[];
}

export type RailRow =
  | { kind: "repo"; repo: UnifiedRepo }
  | { kind: "system"; section: SystemSection };

export type BodyKind =
  | { kind: "issues"; nwo: string }
  | { kind: "repoDetail"; repo: UnifiedRepo }
  | { kind: "section"; section: SystemSection };

export const sysKey = (s: SystemSection): string => `sys:${s}`;
export const rowKey = (row: RailRow): string =>
  row.kind === "system" ? sysKey(row.section) : row.repo.key;

const gitOf = (r: LocalRepo): NonNullable<UnifiedRepo["git"]> => ({
  branch: r.branch,
  headSha: r.headSha,
  dirty: r.dirty,
  originUrl: r.originUrl,
  error: r.error,
});

/** Watched mappings first (their input order — config then watchlist), each
 * enriched from the heavy candidate matched by resolved path, then by nwo;
 * same-nwo extras collapse into `clones`. Unclaimed heavy candidates append
 * as unwatched rows in their input order. */
export function buildUnifiedRepos(
  watched: WatchedMapping[],
  heavy: LocalRepo[] | null,
): UnifiedRepo[] {
  const candidates = heavy ?? [];
  const byPath = new Map<string, LocalRepo>();
  const byNwo = new Map<string, LocalRepo[]>();
  for (const r of candidates) {
    byPath.set(resolve(r.path), r);
    if (r.nwo !== null) {
      const k = r.nwo.toLowerCase();
      byNwo.set(k, [...(byNwo.get(k) ?? []), r]);
    }
  }
  const claimed = new Set<string>();
  const out: UnifiedRepo[] = [];
  for (const w of watched) {
    const key = w.nwo.toLowerCase();
    const wPath = resolve(w.path);
    const matches: LocalRepo[] = [];
    const seen = new Set<string>();
    for (const m of [byPath.get(wPath), ...(byNwo.get(key) ?? [])]) {
      if (m === undefined) continue;
      const p = resolve(m.path);
      if (seen.has(p)) continue;
      seen.add(p);
      claimed.add(p);
      matches.push(m);
    }
    const primary = matches.find((m) => resolve(m.path) === wPath) ?? matches[0];
    out.push({
      key,
      nwo: w.nwo,
      path: w.path,
      fromConfig: w.fromConfig,
      external: w.external,
      source: w.fromConfig ? "config" : "watchlist",
      watched: true,
      git: primary !== undefined ? gitOf(primary) : null,
      clones: matches.filter((m) => m !== primary).map((m) => m.path),
    });
  }
  for (const r of candidates) {
    const p = resolve(r.path);
    if (claimed.has(p)) continue;
    claimed.add(p);
    out.push({
      key: p,
      nwo: r.nwo,
      path: r.path,
      fromConfig: false,
      external: false,
      source: r.source,
      watched: false,
      git: gitOf(r),
      clones: [],
    });
  }
  return out;
}

export function buildRailRows(repos: UnifiedRepo[]): RailRow[] {
  return [
    ...repos.map((repo): RailRow => ({ kind: "repo", repo })),
    ...SYSTEM_SECTIONS.map((section): RailRow => ({ kind: "system", section })),
  ];
}

/** Key-anchored index resolution with the clamp-to-last-slot fallback
 * (the established lastIdxRef pattern from App's issue/PR anchors). */
export function resolveRailIndex(rows: RailRow[], sel: string | null, lastIdx: number): number {
  if (rows.length === 0) return 0;
  if (sel !== null) {
    const i = rows.findIndex((r) => rowKey(r) === sel);
    if (i >= 0) return i;
  }
  return Math.max(0, Math.min(lastIdx, rows.length - 1));
}

/** Body routing (spec §3): issues only for WATCHED nwo rows with github
 * enabled; every other repo row gets the RepoDetail body. */
export function bodyKindFor(row: RailRow | undefined, githubEnabled: boolean): BodyKind | null {
  if (row === undefined) return null;
  if (row.kind === "system") return { kind: "section", section: row.section };
  if (row.repo.watched && row.repo.nwo !== null && githubEnabled) {
    return { kind: "issues", nwo: row.repo.nwo };
  }
  return { kind: "repoDetail", repo: row.repo };
}
```

- [ ] **Step 4: Run the new file, then full suite + typecheck.** All pass.
- [ ] **Step 5: Commit** — `git commit -m "feat(tui): pure rail row model for the unified view"`.

---

### Task 3: relocate section components to `sections.tsx`

Pure move so Task 7's App can import section bodies without touching `LocalDashboard.tsx` (which dies in Task 9). LocalDashboard re-exports, so nothing else changes.

**Files:**

- Create: `src/tui/components/sections.tsx`
- Modify: `src/tui/components/LocalDashboard.tsx`

**Interfaces:**

- Produces: `sections.tsx` exports `sectionBadge`, `OutboxSection`, `WorktreesSection`, `DaemonSection`, `truncStart`, `fmtDur`, `SOURCE_TAG` — signatures byte-identical to today's `LocalDashboard.tsx` versions (`truncStart`/`fmtDur`/`SOURCE_TAG` become exported).

- [ ] **Step 1:** Cut `sectionBadge`, `OutboxSection`, `WorktreesSection`, `DaemonSection`, plus the private helpers `fmtDur`, `truncStart`, `SOURCE_TAG`, `GATE_RED`, `GATE_YELLOW` out of `LocalDashboard.tsx` into a new `src/tui/components/sections.tsx` (same imports; export `truncStart`, `fmtDur`, `SOURCE_TAG` too — Task 4/5 consume them). Leave `ReposSection`, `SectionRail`, and the default `LocalDashboard` in place, importing what they need from `./sections.js`, and re-export for compatibility:

```ts
export { sectionBadge, OutboxSection, WorktreesSection, DaemonSection } from "./sections.js";
```

(`ReposSection` keeps its own `SOURCE_TAG`/`truncStart` via import from `./sections.js`.)

- [ ] **Step 2:** Full suite + typecheck — green with zero test edits (the move is invisible to importers).
- [ ] **Step 3: Commit** — `git commit -m "refactor(tui): relocate section bodies to sections.tsx"`.

---

### Task 4: `RepoDetail` component

**Files:**

- Create: `src/tui/components/RepoDetail.tsx`
- Test: `tests/tuiRepoDetail.test.tsx` (new)

**Interfaces:**

- Consumes: `UnifiedRepo` (Task 2), `LocalWorktree` (`localSnapshot.js`), `QueueSnapshot` rows with `repoPath` (Task 1), `truncStart`/`fmtDur`/`SOURCE_TAG` (Task 3), `clampScroll`/`maxScroll` (`../window.js`), `fmtAge` (`../queueFmt.js`), theme.
- Produces:

```ts
export function RepoDetail(props: {
  repo: UnifiedRepo;
  worktrees: LocalWorktree[] | null; // caller pre-filters to this repo
  queue: QueueSnapshot | null; // component filters rows by repoPath
  scroll: number;
  height: number;
  focused: boolean;
  now: Date;
  onWheel?: (dir: 1 | -1) => void;
  onScrollMax?: (max: number) => void;
}): React.JSX.Element;
export function repoQueueRows(
  queue: QueueSnapshot | null,
  repoPath: string,
): { running: QueueRunning[]; waiting: QueueWaiting[]; recent: QueueRecent[] };
```

- [ ] **Step 1: Failing tests** (`tests/tuiRepoDetail.test.tsx`) — follow the render pattern of `tests/tuiLocal.test.tsx` (ink-testing-library `render`, `lastFrame()`):

```tsx
import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { RepoDetail, repoQueueRows } from "../src/tui/components/RepoDetail.js";
import type { UnifiedRepo } from "../src/tui/railModel.js";

const repo: UnifiedRepo = {
  key: "/dev/scratch",
  nwo: null,
  path: "/dev/scratch",
  fromConfig: false,
  external: false,
  source: "clone",
  watched: false,
  git: { branch: "main", headSha: "a1b2c3d4e5f6", dirty: true, originUrl: null, error: null },
  clones: ["/data/clones/x"],
};
const NOW = new Date("2026-07-20T12:00:00Z");

it("renders identity, git state, clones, worktrees, and recent tickets", () => {
  const { lastFrame } = render(
    <RepoDetail
      repo={repo}
      worktrees={[
        {
          path: "/wt/s-fix",
          repoPath: "/dev/scratch",
          repoNwo: null,
          slug: "s-fix",
          kind: "stale",
          headSha: "beefcafe0000",
          ageSeconds: 7980,
          error: null,
        },
      ]}
      queue={{
        daemonUp: true,
        maxConcurrent: 1,
        running: [],
        waiting: [],
        error: null,
        outboxDepth: 0,
        stats: null,
        recent: [
          {
            id: "add-readme",
            github: null,
            status: "done",
            repoPath: "/dev/scratch",
            finishedAt: "2026-07-20T11:00:00Z",
            resultStatus: "done",
            durationSeconds: 60,
            prUrl: null,
          },
        ],
      }}
      scroll={0}
      height={20}
      focused
      now={NOW}
    />,
  );
  const f = lastFrame() ?? "";
  expect(f).toContain("/dev/scratch");
  expect(f).toContain("main@a1b2c3d");
  expect(f).toContain("✎");
  expect(f).toContain("s-fix");
  expect(f).toContain("add-readme");
  expect(f).toContain("/data/clones/x"); // extra clone line
});

it("filters queue rows by repoPath", () => {
  const rows = repoQueueRows(
    {
      daemonUp: true,
      maxConcurrent: 1,
      error: null,
      outboxDepth: 0,
      stats: null,
      running: [],
      recent: [],
      waiting: [
        {
          id: "mine",
          github: null,
          kind: "pr",
          priority: "normal",
          retryCount: 0,
          notBefore: null,
          deferred: false,
          queuedAt: null,
          repoPath: "/dev/scratch",
        },
        {
          id: "other",
          github: null,
          kind: "pr",
          priority: "normal",
          retryCount: 0,
          notBefore: null,
          deferred: false,
          queuedAt: null,
          repoPath: "/elsewhere",
        },
      ],
    },
    "/dev/scratch",
  );
  expect(rows.waiting.map((w) => w.id)).toEqual(["mine"]);
});

it("null enrichment renders loading, not a crash", () => {
  const { lastFrame } = render(
    <RepoDetail
      repo={{ ...repo, git: null, clones: [] }}
      worktrees={null}
      queue={null}
      scroll={0}
      height={12}
      focused={false}
      now={NOW}
    />,
  );
  expect(lastFrame()).toContain("loading");
});
```

- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement `src/tui/components/RepoDetail.tsx`** — mirror `DaemonSection`'s scroll posture (build a `lines: JSX.Element[]` array, `onScrollMax?.(maxScroll(lines.length, visible))`, slice by `clampScroll`), inside a `ClickableBox` border with `onWheel`:

```tsx
import React from "react";
import { Text } from "ink";
import { theme } from "../theme.js";
import { ClickableBox } from "../ClickableBox.js";
import { clampScroll, maxScroll } from "../window.js";
import { fmtAge } from "../queueFmt.js";
import { truncStart, fmtDur, SOURCE_TAG } from "./sections.js";
import type { UnifiedRepo } from "../railModel.js";
import type { LocalWorktree } from "../localSnapshot.js";
import type { QueueSnapshot, QueueRunning, QueueWaiting, QueueRecent } from "../queueSnapshot.js";
import { resolve } from "node:path";

/** Queue rows whose ticket targeted this repo (resolved-path match). */
export function repoQueueRows(
  queue: QueueSnapshot | null,
  repoPath: string,
): { running: QueueRunning[]; waiting: QueueWaiting[]; recent: QueueRecent[] } {
  const target = resolve(repoPath);
  const mine = <T extends { repoPath: string | null }>(rows: T[]): T[] =>
    rows.filter((r) => r.repoPath !== null && resolve(r.repoPath) === target);
  return {
    running: mine(queue?.running ?? []),
    waiting: mine(queue?.waiting ?? []),
    recent: mine(queue?.recent ?? []),
  };
}

/** Full local picture of ONE repo: identity, git state, worktrees, recent
 * queue activity. Scroll-only (DaemonSection posture); body arm for
 * local-only/unwatched rows, full-width view for watched ones (spec §3). */
export function RepoDetail({
  repo,
  worktrees,
  queue,
  scroll,
  height,
  focused,
  now,
  onWheel,
  onScrollMax,
}: {
  repo: UnifiedRepo;
  worktrees: LocalWorktree[] | null;
  queue: QueueSnapshot | null;
  scroll: number;
  height: number;
  focused: boolean;
  now: Date;
  onWheel?: (dir: 1 | -1) => void;
  onScrollMax?: (max: number) => void;
}): React.JSX.Element {
  const lines: React.JSX.Element[] = [];
  lines.push(
    <Text key="t" bold color={focused ? theme.accent : undefined} wrap="truncate">
      {repo.nwo ?? truncStart(repo.path, 40)}
      <Text dimColor> {SOURCE_TAG[repo.source]}</Text>
    </Text>,
  );
  lines.push(
    <Text key="p" wrap="truncate">
      path <Text dimColor>{repo.path}</Text>
    </Text>,
  );
  const g = repo.git;
  if (g === null) {
    lines.push(
      <Text key="g" dimColor>
        loading git state…
      </Text>,
    );
  } else if (g.error !== null) {
    lines.push(
      <Text key="ge" color={theme.warn} wrap="truncate-end">
        {g.error}
      </Text>,
    );
  } else {
    lines.push(
      <Text key="g" wrap="truncate">
        branch {g.branch ?? "?"}
        {g.headSha !== null ? `@${g.headSha.slice(0, 7)}` : ""}
        {g.dirty === true && <Text color={theme.warn}> ✎ dirty</Text>}
      </Text>,
    );
    if (g.originUrl !== null) {
      lines.push(
        <Text key="o" dimColor wrap="truncate">
          origin {g.originUrl}
        </Text>,
      );
    }
  }
  for (const c of repo.clones) {
    lines.push(
      <Text key={`c-${c}`} dimColor wrap="truncate">
        clone {truncStart(c, 40)}
      </Text>,
    );
  }

  lines.push(
    <Text key="wh" bold>
      {" "}
      worktrees
    </Text>,
  );
  const wts = worktrees ?? [];
  if (wts.length === 0)
    lines.push(
      <Text key="w0" dimColor>
        {" "}
        none
      </Text>,
    );
  for (const w of wts) {
    lines.push(
      <Text key={`w-${w.path}`} wrap="truncate-end" dimColor={w.kind === "backup"}>
        {"  "}
        {w.slug} <Text dimColor>{w.kind}</Text>
        {w.headSha !== null ? ` ${w.headSha.slice(0, 7)}` : ""}{" "}
        <Text dimColor>{fmtDur(w.ageSeconds)}</Text>
      </Text>,
    );
  }

  lines.push(
    <Text key="qh" bold>
      {" "}
      recent tickets
    </Text>,
  );
  const rows = repoQueueRows(queue, repo.path);
  const activity = [
    ...rows.running.map((r) => ({ id: r.id, glyph: "◐", color: theme.info, at: r.startedAt })),
    ...rows.waiting.map((w) => ({
      id: w.id,
      glyph: "⏳",
      color: undefined as string | undefined,
      at: w.queuedAt,
    })),
    ...rows.recent.map((r) => ({
      id: r.id,
      glyph: r.status === "done" ? "✓" : "✗",
      color: r.status === "done" ? theme.success : theme.error,
      at: r.finishedAt as string | null,
    })),
  ];
  if (activity.length === 0)
    lines.push(
      <Text key="q0" dimColor>
        {" "}
        none
      </Text>,
    );
  for (const a of activity) {
    lines.push(
      <Text key={`q-${a.glyph}-${a.id}`} wrap="truncate-end">
        {"  "}
        <Text color={a.color}>{a.glyph}</Text> {a.id}
        {a.at !== null ? <Text dimColor> {fmtAge(a.at, now)}</Text> : null}
      </Text>,
    );
  }

  const visible = Math.max(1, height - 2);
  onScrollMax?.(maxScroll(lines.length, visible));
  const start = clampScroll(scroll, lines.length, visible);
  return (
    <ClickableBox
      flexDirection="column"
      borderStyle="round"
      borderColor={focused ? theme.accent : theme.border}
      paddingX={1}
      flexGrow={1}
      height={height}
      onWheel={onWheel}
    >
      {lines.slice(start, start + visible)}
    </ClickableBox>
  );
}
```

- [ ] **Step 4: Run tests, adjust until green** (exact glyph/whitespace tolerances via `toContain`). Full suite + typecheck.
- [ ] **Step 5: Commit** — `git commit -m "feat(tui): RepoDetail body component"`.

---

### Task 5: `UnifiedRail` component + geometry

**Files:**

- Create: `src/tui/components/UnifiedRail.tsx`
- Modify: `src/tui/geometry.ts` (add `SYSTEM_BLOCK_ROWS`, switch `railListHeight`; KEEP `QUEUE_CARD_ROWS` + `UiMode` until Task 9)
- Test: `tests/tuiUnifiedRail.test.tsx` (new), `tests/tuiGeometry.test.ts` (update `railListHeight` expectations)

**Interfaces:**

- Consumes: `RailRow`/`UnifiedRepo`/`SYSTEM_SECTIONS` (Task 2), `sectionBadge` + `truncStart` (Task 3), `stateMeta`/`IssueLifecycle` (`../state.js`), `fmtAssessIndicator` (`../queueFmt.js`), `AssessHistory`.
- Produces:

```ts
export function UnifiedRail(props: {
  rows: RailRow[]; // repos then system (buildRailRows)
  selected: number; // absolute index into rows
  focused: boolean;
  cheap: LocalCheap | null; // system badges + gate ⚠
  heavy: LocalHeavy | null; // worktree badge
  issueCounts: (nwo: string) => Partial<Record<IssueLifecycle, number>>;
  assess: (nwo: string) => AssessHistory | null;
  width: number;
  height: number;
  now: Date;
  window: { start: number; end: number }; // over the REPO prefix only
  onRowPress?: (index: number) => void; // absolute rows index
  onPanePress?: () => void;
  onWheel?: (dir: 1 | -1) => void;
}): React.JSX.Element;
```

- [ ] **Step 1: geometry first (failing test).** In `tests/tuiGeometry.test.ts`, update/extend the `railListHeight` cases to the new formula and add:

```ts
it("SYSTEM_BLOCK_ROWS budgets separator + header + five system rows", () => {
  expect(SYSTEM_BLOCK_ROWS).toBe(7);
  expect(railListHeight(30)).toBe(30 - 4 - SYSTEM_BLOCK_ROWS);
  expect(railListHeight(5)).toBe(1); // floor
});
```

Implement in `src/tui/geometry.ts`:

```ts
/** Pinned system block in the unified rail: separator + "system" header +
 * the five section rows (queue/outbox/worktrees/daemon/logs). */
export const SYSTEM_BLOCK_ROWS = 7;

/** Repo rows the rail can show: borders(2) + title(1) + position line(1)
 * + the pinned system block. */
export function railListHeight(bodyRows: number): number {
  return Math.max(1, bodyRows - 4 - SYSTEM_BLOCK_ROWS);
}
```

(The old Rail keeps rendering until Task 7 with a one-row-shorter repo window — harmless; `QUEUE_CARD_ROWS` stays exported for it until Task 9.)

- [ ] **Step 2: failing component tests** (`tests/tuiUnifiedRail.test.tsx`):

```tsx
import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { UnifiedRail } from "../src/tui/components/UnifiedRail.js";
import { buildRailRows, buildUnifiedRepos } from "../src/tui/railModel.js";

const rows = buildRailRows(
  buildUnifiedRepos(
    [{ nwo: "acme/api", path: "/w/api", fromConfig: true, external: false }],
    [
      {
        nwo: null,
        path: "/dev/scratch",
        source: "clone",
        originUrl: null,
        forkUrl: null,
        githubUrl: null,
        branch: null,
        headSha: null,
        dirty: null,
        error: null,
      },
    ],
  ),
);
const NOW = new Date("2026-07-20T12:00:00Z");
const base = {
  rows,
  selected: 0,
  focused: true,
  cheap: null,
  heavy: null,
  issueCounts: () => ({}),
  assess: () => null,
  width: 26,
  height: 24,
  now: NOW,
  window: { start: 0, end: 2 },
};

it("renders repo rows, the system header, and all five system rows", () => {
  const f = render(<UnifiedRail {...base} />).lastFrame() ?? "";
  expect(f).toContain("acme/api");
  expect(f).toContain("(cfg)");
  expect(f).toContain("scratch"); // local row = path tail
  expect(f).toContain("system");
  for (const s of ["queue", "outbox", "worktrees", "daemon", "logs"]) expect(f).toContain(s);
});

it("system badges come from the cheap/heavy snapshots", () => {
  const cheap = {
    queue: {
      daemonUp: true,
      maxConcurrent: 1,
      running: [
        {
          id: "r1",
          github: null,
          turns: 1,
          lastTool: null,
          outputTokens: null,
          startedAt: null,
          updatedAt: null,
          stale: false,
          repoPath: null,
        },
      ],
      waiting: [],
      recent: [],
      error: null,
      outboxDepth: 0,
      stats: null,
    },
    counts: null,
    outbox: { depth: 2, dead: 0, ops: [], deadOps: [], error: null },
    daemon: null,
  } as never; // shape per LocalCheap — fill the real fields when writing the test
  const f = render(<UnifiedRail {...base} cheap={cheap} />).lastFrame() ?? "";
  expect(f).toContain("▸1");
  expect(f).toContain("⇡2");
});

it("marks the selected SYSTEM row with the ▌ cursor", () => {
  const queueIdx = rows.findIndex((r) => r.kind === "system");
  const f = render(<UnifiedRail {...base} selected={queueIdx} />).lastFrame() ?? "";
  const line = f.split("\n").find((l) => l.includes("queue"));
  expect(line).toContain("▌");
});
```

(Write the real `LocalCheap` literal per `src/tui/localSnapshot.ts` — no `as never` in the committed test; copy the shape from `tests/helpers/localFixtures.tsx` `CHEAP`.)

- [ ] **Step 3: Implement `src/tui/components/UnifiedRail.tsx`.** Structure (reuse today's `Rail.tsx` row markup for repo rows — ▌ cursor `flexShrink={0}`, truncating middle, pinned `ASSESS_COL=8` assess slot; those comments and constants move here):

```tsx
// Signature per Interfaces above. Render order:
// <ClickableBox column border ...>
//   <Text bold>1 repos</Text>
//   {repo rows: rows.slice over window (repo prefix only), each exactly the
//    old Rail row markup; local-only rows render truncStart(path, …) + dim
//    SOURCE_TAG and skip badges/assess}
//   {repoCount > window span → <Text dimColor>{selRepoPos}/{repoCount}</Text>}
//   <Box flexGrow={1} />
//   <Text dimColor>{"─".repeat(Math.max(1, width - 4))}</Text>
//   <Text bold>system</Text>
//   {SYSTEM_SECTIONS.map((s, i) => {
//     const idx = repoCount + i;               // absolute rows index
//     const sel = idx === selected;
//     let badge = sectionBadge(s, cheap, heavy);
//     if (s === "queue" && cheap?.queue.stats?.gate != null
//         && cheap.queue.stats.gate.state !== "ok") badge = `${badge} ⚠`.trim();
//     return <ClickableBox key={s} …selection/hover as old SectionRail row…
//       onPress={onRowPress ? () => onRowPress(idx) : undefined}>
//       <Text color={theme.accent}>{sel ? "▌" : " "}</Text>
//       <Text wrap="truncate">{s}{badge ? `  ${badge}` : ""}</Text>
//     </ClickableBox>;
//   })}
// </ClickableBox>
```

Repo-row press handlers pass the ABSOLUTE index (`window.start + i` is already absolute for the repo prefix). `issueCounts(nwo)`/`assess(nwo)` are lookups the App provides (avoids rebuilding RailRepo arrays).

- [ ] **Step 4: Run new tests + full suite + typecheck.** `tests/tuiRail.test.tsx` (old Rail) still passes untouched.
- [ ] **Step 5: Commit** — `git commit -m "feat(tui): UnifiedRail — repos + pinned system group"`.

---

### Task 6: `hintsForUnified` in Chrome

**Files:**

- Modify: `src/tui/components/Chrome.tsx`
- Test: `tests/tuiChrome.test.tsx` (extend)

**Interfaces:**

- Produces:

```ts
export type BodyHintKind =
  | "issues"
  | "repoDetail"
  | "queue"
  | "outbox"
  | "worktrees"
  | "daemon"
  | "logs";
export function hintsForUnified(
  view: HintView,
  bodyKind: BodyHintKind,
  pane: 1 | 2 | 3,
  mode: LayoutMode,
  filtering: boolean,
): [string, string][];
```

Old `hintsFor`/`localHintsFor` stay untouched until Task 9 (App still uses them until Task 7).

- [ ] **Step 1: Failing tests** (extend `tests/tuiChrome.test.tsx`):

```ts
describe("hintsForUnified", () => {
  it("delegates non-main views to the existing sets", () => {
    expect(hintsForUnified("detail", "issues", 2, "wide", false)).toEqual(
      hintsFor("detail", 2, "wide", false),
    );
  });
  it("main + pane 1 has no mode toggle and keeps rail verbs", () => {
    const keys = hintsForUnified("main", "issues", 1, "wide", false).map(([k]) => k);
    expect(keys).not.toContain("m");
    for (const k of ["↑/↓", "enter", "w", "x", "o", "r", "s", ":", "?", "q"]) {
      expect(keys).toContain(k);
    }
  });
  it("main + pane 2 varies by body kind", () => {
    const q = hintsForUnified("main", "queue", 2, "wide", false).map(([k]) => k);
    expect(q).toEqual(expect.arrayContaining(["↑/↓", "R", "x", "←"]));
    const d = hintsForUnified("main", "daemon", 2, "wide", false).map(([k]) => k);
    expect(d).toEqual(expect.arrayContaining(["[/]", "X", "f"]));
    const issue = hintsForUnified("main", "issues", 2, "wide", false).map(([k]) => k);
    expect(issue).toEqual(expect.arrayContaining(["d", "a", "/", "p", "v"]));
    expect(issue).not.toContain("m");
    const r = hintsForUnified("main", "repoDetail", 2, "wide", false).map(([k]) => k);
    expect(r).toEqual(expect.arrayContaining(["[ ]", "←"]));
  });
  it("filtering short-circuits like hintsFor", () => {
    expect(hintsForUnified("main", "issues", 2, "wide", true)).toEqual(
      hintsFor("main", 2, "wide", true),
    );
  });
});
```

- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** in `Chrome.tsx` (after `localHintsFor`):

```ts
export type BodyHintKind =
  | "issues"
  | "repoDetail"
  | "queue"
  | "outbox"
  | "worktrees"
  | "daemon"
  | "logs";

/** Single-surface hint sets for the unified view. Non-main views delegate to
 * hintsFor verbatim; main is pane- and body-kind-aware. Replaces the
 * hintsFor/localHintsFor pair once App swaps over (spec §3). */
export function hintsForUnified(
  view: HintView,
  bodyKind: BodyHintKind,
  pane: 1 | 2 | 3,
  mode: LayoutMode,
  filtering: boolean,
): [string, string][] {
  if (filtering || view !== "main") return hintsFor(view, pane, mode, filtering);
  if (pane === 1) {
    return [
      ["↑/↓", "move"],
      ["enter", "detail"],
      ["→", "open"],
      ["w", "add repo"],
      ["x", "unwatch"],
      ["o", "browser"],
      ["r", "refresh"],
      ["s", "assess"],
      [":", "commands"],
      ["?", "help"],
      ["q", "quit"],
    ];
  }
  if (pane === 3) return hintsFor("main", 3, mode, false);
  switch (bodyKind) {
    case "issues": {
      // Pane-2 issue verbs minus the dead mode toggle.
      return hintsFor("main", 2, mode, false).filter(([k]) => k !== "m" && k !== "t");
    }
    case "repoDetail":
      return [
        ["[ ]", "scroll"],
        ["o", "browser"],
        ["←", "back"],
      ];
    case "queue":
      return [
        ["↑/↓", "move"],
        ["R", "requeue"],
        ["x", "delete"],
        ["←", "back"],
      ];
    case "outbox":
      return [
        ["↑/↓", "move"],
        ["f", "flush"],
        ["←", "back"],
      ];
    case "worktrees":
      return [
        ["↑/↓", "move"],
        ["x", "prune"],
        ["←", "back"],
      ];
    case "daemon":
      return [
        ["[/]", "scroll"],
        ["X", "restart"],
        ["f", "flush"],
        ["←", "back"],
      ];
    case "logs":
      return [
        ["enter", "open log"],
        ["←", "back"],
      ];
  }
}
```

Also update `hintsFor`'s pane-1/pane-2 "m local" entries? **No** — leave `hintsFor` byte-identical until Task 9 (old tests pin it); the `.filter` above strips `m`/`t` for the unified caller.

- [ ] **Step 4: Run + full suite + typecheck.**
- [ ] **Step 5: Commit** — `git commit -m "feat(tui): unified hint sets (hintsForUnified)"`.

---

### Task 7: the App swap

The monster task: `App.tsx` moves to the unified model; `dashboardCmd` drops `initialUiMode`; the LOCAL/mode-toggle test suites are rewritten against the new surface. Everything from Tasks 1–6 gets wired here. Sub-steps are ordered so the file stays coherent while editing; the suite is only expected green at the end of the task.

**Files:**

- Modify: `src/tui/App.tsx`, `src/dashboardCmd.ts`
- Modify (tests): `tests/helpers/localFixtures.tsx`, `tests/tuiLocalApp.test.tsx`, `tests/tuiLocalActions.test.tsx`, `tests/tuiMouseApp.test.tsx`, `tests/tuiApp.test.tsx`, `tests/tuiPalette.test.tsx`, `tests/tuiLogSection.test.tsx`, `tests/tuiLogOverlay.test.tsx`, `tests/dashboardCmd.test.ts`, `tests/tuiInteractive.test.tsx` (and any other suite typecheck flags)

**Interfaces:**

- Consumes: everything produced by Tasks 1–6.
- Produces: `AppProps` WITHOUT `initialUiMode`; App renders `UnifiedRail` always; View union = old minus `"queue"` plus `"repoDetail"`.

- [ ] **Step 1: App state + derivation.** In `src/tui/App.tsx`:

Remove state/props: `initialUiMode` (AppProps + destructure), `uiMode`, `setUiMode`, `uiModeRef`, `localSection`, `localFocus`, `repoIdx`/`setRepoIdx`. Keep `localCheap`/`localHeavy`/`localRefreshedAt`/`confirm`/log-overlay state. Rename `localCursor` → `sectionCursor` typed `Record<SystemSection, number>` (init all five to 0).

Add imports:

```ts
import {
  buildUnifiedRepos,
  buildRailRows,
  resolveRailIndex,
  bodyKindFor,
  rowKey,
  sysKey,
  type RailRow,
  type UnifiedRepo,
  type SystemSection,
} from "./railModel.js";
import { UnifiedRail } from "./components/UnifiedRail.js";
import { RepoDetail } from "./components/RepoDetail.js";
import { OutboxSection, WorktreesSection, DaemonSection } from "./components/sections.js";
import { hintsForUnified, type BodyHintKind } from "./components/Chrome.js";
```

Add derivations after `repoMappings`:

```ts
const [railSel, setRailSel] = useState<string | null>(null);
const lastRailIdxRef = useRef(0);
const unifiedRepos = useMemo(
  () => buildUnifiedRepos(repoMappings, localHeavy?.repos ?? null),
  [repoMappings, localHeavy],
);
const railRows = useMemo(() => buildRailRows(unifiedRepos), [unifiedRepos]);
const railIdx = resolveRailIndex(railRows, railSel, lastRailIdxRef.current);
lastRailIdxRef.current = railIdx;
const selectedRow = railRows[railIdx];
const body = bodyKindFor(selectedRow, props.githubEnabled);
```

`currentNwo` becomes `body?.kind === "issues" ? body.nwo : undefined`; `currentRepo` = `currentNwo ? repoMappings.find((r) => r.nwo.toLowerCase() === currentNwo.toLowerCase()) : undefined` (its consumers — external gate, unwatch, `o` — are unchanged). `repoIdxSafe` deletions ripple: the rail window uses a repo-prefix cursor:

```ts
const repoCount = unifiedRepos.length;
const repoCursor = Math.min(railIdx, Math.max(0, repoCount - 1));
const railWindow = windowSlice(
  repoCount,
  railListHeight(layout.bodyRows),
  repoCursor,
  railPrev.current,
);
```

Movement helper (replaces `setRepoIdx` calls):

```ts
const moveRail = (delta: number): void => {
  if (railRows.length === 0) return;
  const next = Math.max(0, Math.min(railIdx + delta, railRows.length - 1));
  setRailSel(rowKey(railRows[next]));
};
const moveRailTo = (idx: number): void => {
  if (railRows.length === 0) return;
  setRailSel(rowKey(railRows[Math.max(0, Math.min(idx, railRows.length - 1))]));
};
```

View union: `type View = "main" | "detail" | "help" | "addRepo" | "config" | "palette" | "cmdOutput" | "prs" | "prDetail" | "review" | "repoDetail"` (drop `"queue"`). Add `const [repoDetailTarget, setRepoDetailTarget] = useState<UnifiedRepo | null>(null);` (frozen snapshot, `detail` pattern).

`localRowsFor` (now `sectionRowsFor(section: SystemSection)`): drop the `"repos"` case; other cases unchanged; `localRows`/`localCursorSafe`/`localTarget` derive from `body?.kind === "section" ? body.section : null` (empty array when no section selected). `moveLocalCursor` → `moveSectionCursor` (same logic against `sectionCursor`).

`scrollKey`: replace the two `uiMode` arms with:

```ts
if (logOverlay) return "logOverlay";
if (view === "repoDetail" && repoDetailTarget) return `repoView:${repoDetailTarget.key}`;
if (body?.kind === "repoDetail") return `repo:${body.repo.key}`;
if (body?.kind === "section") return `sys:${body.section}`;
```

(keep the review/cmd/detail arms; `logActive` becomes `body?.kind === "section" && body.section === "logs" || logOverlay`).

- [ ] **Step 2: polls.** Cheap effect: delete the `if (uiMode !== "local") return;` guard; its `section` option passes `body?.kind === "section" ? body.section : undefined` — introduce `const sysSection = body?.kind === "section" ? body.section : null;` and use it in both the effect dep array and `forceLocalRefresh` (replacing `localSection`). Heavy effect: delete BOTH guards (`uiMode`, section check) — runs always @15s. `forceLocalRefresh`: heavy part now gated on `sysSection === "worktrees" || body?.kind === "repoDetail"` (repo git state benefits too) — plus always cheap. `loadIssues`' toast gate: replace `uiModeRef.current === "github"` with a `bodyKindRef` (`bodyKindRef.current === "issues"`); set `bodyKindRef.current = body?.kind ?? null` next to the other live refs. `r` key handler: `forceLocalRefresh()` always, plus `refreshAll()` when `currentNwo` is defined.

- [ ] **Step 3: input cascade.** Delete: layer 3 (mode toggle block), `canToggleMode`, `isModeToggle`, `handleModeTab`, the whole `handleLocalInput` function, and layer 4 (`if (uiMode === "local") …`). Restructure the main `useGuardedInput` cascade to:

```
ctrl-c bail → addRepo/config fences (unchanged)
→ CONFIRM MODAL branch (hoisted from handleLocalInput, verbatim: esc/n cancel, y/enter run)
→ LOG OVERLAY branch (hoisted from handleLocalInput, verbatim — un-gated from uiMode)
→ `,` config (drop the uiMode fence; keep !filtering, confirm===null, !logOverlay)
→ view branches: help/detail/prDetail/prs/palette/cmdOutput/review (unchanged);
  NEW "repoDetail" branch:
    if (key.escape || input === "q") return void setView("main");
    if (input === "o") { const nwo = repoDetailTarget?.nwo; if (nwo) openRepoBrowser(nwo); return; }
    if (input === "]" || key.downArrow) return void scrollBy(1);
    if (input === "[" || key.upArrow) return void scrollBy(-1);
    return;
→ main view: filtering block (unchanged) → globals:
    q/?/: v w p r s S (unchanged bodies, but `s` pane-2 issue-scoping now requires
      body?.kind === "issues"); `t` becomes:
      if (input === "t") { setRailSel(sysKey("queue")); setPane(2); return; }
→ pane routing (unchanged: /, 1/2/3, tab, h/l, i)
→ pane === 1 branch:
    j/k/g/G → moveRail(±1) / moveRailTo(0) / moveRailTo(railRows.length - 1)
    x → selectedRow?.kind === "repo" && selectedRow.repo.watched && selectedRow.repo.nwo
          ? unwatch(selectedRow.repo.nwo) : showToast("info", "not in watchlist")
    o → selectedRow?.kind === "repo" && selectedRow.repo.nwo
          ? openRepoBrowser(selectedRow.repo.nwo) : showToast("info", "no GitHub URL")
    enter → if (selectedRow?.kind === "repo") { setRepoDetailTarget(selectedRow.repo); setView("repoDetail"); }
            else if (selectedRow?.section === "logs") onLogExpand();
            else setPane(2);
→ pane === 3 branch (unchanged)
→ pane 2, keyed by body?.kind:
    "issues" → the existing issues-pane block verbatim (esc/j/k/g/G/enter/d/D/a/R/c/o)
    "repoDetail" → esc/h/← → setPane(1); [/]/arrows → scrollBy; o → repo.nwo ? openRepoBrowser : toast
    "section" → esc/h/← → setPane(1); then the ex-handleLocalInput body branches
      verbatim per section (daemon: [/]/X/f; queue: j/k/g/G + R/x with localTarget
      guards; outbox: j/k + f; worktrees: j/k + x guard); logs never reaches here
      (rail enter opens the overlay; body focus for logs falls back to setPane(1))
```

`w` gains a github gate: `if (!props.githubEnabled) return void showToast("info", "github mode is off ([github] enabled=false)");` ahead of the watchlist check.

- [ ] **Step 4: mouse + footer + hints.** Delete `localSectionPress`, `localRowPress`, `handleModeTab` usage in `footerActions` (`m` chips gone). Rail press handlers (passed to UnifiedRail):

```ts
onRowPress={(i) => {
  if (confirm !== null || view !== "main") return;
  const row = railRows[i];
  if (!row) return;
  if (i === railIdx) {
    // click-again = enter: repo rows open RepoDetail; logs opens the overlay;
    // other system rows focus the body.
    if (row.kind === "repo") { setRepoDetailTarget(row.repo); setView("repoDetail"); }
    else if (row.section === "logs") onLogExpand();
    else setPane(2);
    return;
  }
  setPane(1);
  setRailSel(rowKey(row));
}}
onPanePress={view === "main" && confirm === null ? () => setPane(1) : undefined}
onWheel={(d) => (view === "main" ? moveRail(d) : undefined)}
```

`footerActions`: delete the `uiMode === "local"` branch; keep the logOverlay esc branch (un-gated: `if (logOverlay) …`). In the `"main"` case add body-kind-aware chips mirroring the keyboard verbatim: keep existing `q ? t p : , w r enter s d a c o /` entries but: `t` chip → `{ setRailSel(sysKey("queue")); setPane(2); }`; add when `body?.kind === "section"`: `R`/`x`/`f`/`X`/`←` chips duplicating the keyboard guards exactly (same `localTarget` checks). Add `"repoDetail"` view case: `{ esc: () => setView("main"), o: <same guard as keyboard> }`.

`hints` computation: replace the uiMode ternary chain with:

```ts
const bodyHintKind: BodyHintKind =
  body?.kind === "issues" ? "issues" : body?.kind === "section" ? body.section : "repoDetail";
const hints =
  view === "config"
    ? hintsFor("config", pane, layout.mode, filtering)
    : view === "help"
      ? hintsFor("help", pane, layout.mode, filtering)
      : logOverlay
        ? LOG_OVERLAY_HINTS
        : view === "repoDetail"
          ? ([
              ["↑/↓", "scroll"],
              ["o", "browser"],
              ["esc", "back"],
            ] as [string, string][])
          : hintsForUnified(view as HintView, bodyHintKind, pane, layout.mode, filtering);
```

(`HintView` keeps `"queue"` as a dead member until Task 9's cleanup — casting stays legal.)

- [ ] **Step 5: render tree.** Header: drop `uiMode`/`githubEnabled`/`onModeTab` props (tab block auto-hides — `uiMode === undefined`). HelpModal: drop `uiMode`/`localSection` props. Replace `<Rail …>` with `<UnifiedRail rows={railRows} selected={railIdx} focused={view === "main" && pane === 1} cheap={localCheap} heavy={localHeavy} issueCounts={(nwo) => …existing repoRows count logic per nwo…} assess={(nwo) => assessHistory.get(nwo) ?? null} width={layout.railWidth} height={listHeight} now={queueNow} window={railWindow} …handlers above… />` (delete the `repoRows` array build; fold its count derivation into the `issueCounts` lookup memo: `useMemo` returning a `(nwo: string) => counts` closure over `issues`/`trigger`). Body ternary inside the main fragment:

```tsx
{view === "queue" arm → DELETED}
{view === "repoDetail" && repoDetailTarget ? (
  <RepoDetail repo={repoDetailTarget}
    worktrees={(localHeavy?.worktrees ?? []).filter((w) => w.repoPath !== null && resolve(w.repoPath) === resolve(repoDetailTarget.path))}
    queue={localCheap?.queue ?? queueSnap}
    scroll={scroll} height={listHeight} focused now={queueNow}
    onWheel={(d) => scrollBy(d)} onScrollMax={onScrollMax} />
) : … existing detail/cmdOutput/prDetail/prs arms …
 : body?.kind === "repoDetail" ? (
  <RepoDetail repo={body.repo} … same props, focused={pane === 2} …/>
) : body?.kind === "section" ? (
  body.section === "queue" ? <QueueView snap={localCheap?.queue ?? null} … selectable selectedRow={localCursorSafe} counts={localCheap?.counts ?? null} onRowPress={sectionRowPress} onScrollMax={onScrollMax} focused={pane === 2} height={listHeight} now={queueNow} scroll={scroll} />
  : body.section === "outbox" ? <OutboxSection outbox={localCheap?.outbox ?? null} cursor={localCursorSafe} window={sectionWin} height={listHeight} focused={pane === 2} now={queueNow} onRowPress={sectionRowPress} />
  : body.section === "worktrees" ? <WorktreesSection worktrees={localHeavy?.worktrees ?? null} error={localHeavy?.error ?? null} cursor={localCursorSafe} window={sectionWin} height={listHeight} focused={pane === 2} onRowPress={sectionRowPress} />
  : body.section === "daemon" ? <DaemonSection daemon={localCheap?.daemon ?? null} scroll={scroll} height={listHeight} focused={pane === 2} onWheel={(d) => scrollBy(d)} onScrollMax={onScrollMax} />
  : <LogView variant="section" entries={logEntries} height={listHeight} focused={pane === 2} hasFile={logHasFile} onExpand={onLogExpand} />
) : (
  <IssueList … unchanged … />
)}
```

with `sectionWin` computed like LocalDashboard did (a `prevStart` ref keyed by section over `windowSlice(localRows.length, listRowsHeight(layout.bodyRows), localCursorSafe, prev)`) and `sectionRowPress` mirroring the old `localRowPress` minus the repos click-again arm (plain: `setPane(2); setSectionCursor(...)`; click-again on the already-selected row is a no-op except queue/outbox/worktrees keep selection semantics). Pane 3 (wide) renders ONLY when `view === "main" && body?.kind === "issues"` (plus the prs-view arm, unchanged). The `logOverlay` full-screen arm loses its `uiMode === "local" &&` prefix. Delete the `<LocalDashboard …>` arm and its import; delete the `Rail` import.

`dashboardCmd.ts`: delete the `initialUiMode` line (+ its comment).

- [ ] **Step 6: test rewrites.** Mapping, file by file (read each before editing; reuse each file's helpers):

- `tests/helpers/localFixtures.tsx`: `renderApp` drops `initialUiMode`; add `repoPath: null` to any queue-row literals typecheck flags (Task 1 may have done it). The comment about bracketed tabs is obsolete — reword to "wide layout".
- `tests/tuiLocalApp.test.tsx`: mode-tab/`m`-toggle tests become: (a) system rows render in the single rail alongside repos; (b) navigating to `sys:queue` (j/k past the repos) shows QueueView in the body; (c) `t` jumps to the queue row + body focus; (d) **`m` regression** — pressing `m` toggles nothing (frame unchanged / no `[LOCAL]` anywhere); (e) github-disabled (`githubEnabled: false`) renders RepoDetail for an nwo row and never calls `client.listIssues`; (f) heavy-poll discovery mid-session keeps the cursor anchored (drive the fake `localHeavyFn` to add a repo, assert the selected row's key unchanged).
- `tests/tuiLocalActions.test.tsx`: same flows (R requeue, x delete/prune guards, f flush, X restart confirm) reached by rail navigation instead of `m` + section rail. The key sequences change from `m→j…` to `j…` (down past the repo rows); assertions on confirm modals/toasts stay.
- `tests/tuiMouseApp.test.tsx`: mode-tab click tests → system-row click tests (click selects, click-again on repo row opens RepoDetail, click-again on logs opens overlay); rail row click / wheel tests re-anchor to the union indices.
- `tests/tuiApp.test.tsx`: drop `initialUiMode` from props; `t`-opens-queue-view assertions become `t`-selects-queue-row; any `[GITHUB]` header-tab assertions are deleted.
- `tests/tuiPalette.test.tsx`, `tests/tuiLogSection.test.tsx`, `tests/tuiLogOverlay.test.tsx`, `tests/tuiInteractive.test.tsx`: fixture prop removal; logs-section tests navigate via the rail (logs row enter/click) instead of `m`+section; overlay behavior assertions unchanged.
- `tests/dashboardCmd.test.ts`: delete `initialUiMode` expectations.

- [ ] **Step 7: green the world.** `npx vitest run > /tmp/vitest.out 2>&1; echo "exit: $?"` → iterate to exit 0. `npm run typecheck` → no new errors. `npm run lint`.
- [ ] **Step 8: Commit** — `git commit -m "feat(tui)!: unified view — one rail with repos + system group, mode toggle removed"`.

---

### Task 8: unified HelpModal

**Files:**

- Modify: `src/tui/components/HelpModal.tsx`
- Test: `tests/tuiChrome.test.tsx` (or wherever HelpModal is asserted — grep `HelpModal` in tests/ first)

- [ ] **Step 1: Failing test:** help frame contains the system-section verbs and does NOT contain the mode-toggle line:

```ts
it("help renders one unified reference (no mode toggle)", () => {
  const f = render(<HelpModal view="main" pane={1} mode="wide" trigger="junco" />).lastFrame() ?? "";
  expect(f).not.toContain("Shift+Tab");
  expect(f).not.toContain("local mode");
  expect(f).toContain("system rows");
});
```

- [ ] **Step 2: Implement.** Delete the `uiMode === "local"` branch and the `uiMode`/`localSection` props (their `UiMode`/`LocalSection` imports too). In the remaining (github) modal: replace `["t", "queue view"]` with `["t", "jump to the queue row"]`; add a section after "panes & views":

```tsx
<Section
  title="system rows"
  rows={[
    ["queue / outbox / worktrees / daemon / logs", "pinned below the repos — enter opens the body"],
    ["R", "requeue a failed ticket (queue row)"],
    ["x", "delete queued ticket / prune worktree (confirmed)"],
    ["f", "flush the GitHub outbox backlog"],
    ["X", "restart the daemon (confirmed; work salvaged)"],
    ["enter on logs", "full-screen live log (f follow · l level · t ticket · / search)"],
  ]}
/>
```

App already stopped passing the deleted props in Task 7 (they were optional).

- [ ] **Step 3:** suite + typecheck green; commit — `git commit -m "feat(tui): unified help reference"`.

---

### Task 9: cleanup, docs, full gate

**Files:**

- Delete: `src/tui/components/Rail.tsx`, `src/tui/components/LocalDashboard.tsx`
- Modify: `src/tui/components/Chrome.tsx` (delete `localHintsFor`, the Header tab block + `uiMode`/`githubEnabled`/`onModeTab` props, the `"queue"` HintView member and its `hintsFor` arm, the `m local` hint entries), `src/tui/geometry.ts` (delete `UiMode`, `QUEUE_CARD_ROWS`), `src/tui/state.ts`? (no — untouched), tests pinning deleted exports (`tests/tuiRail.test.tsx` → delete; `tests/tuiLocal.test.tsx` → retarget imports to `sections.js`, delete SectionRail/ReposSection cases; `tests/tuiChrome.test.tsx` → drop tab/localHintsFor cases)
- Modify (docs): `ARCHITECTURE.md` (dashboard section: describe the unified rail, remove GITHUB/LOCAL mode language), `CHANGELOG.md` (Unreleased: `**Breaking:** dashboard GITHUB/LOCAL modes merged into one view; \`m\`/Shift+Tab toggle and header tabs removed; \`t\` now jumps to the queue system row`→ slated 0.9.0),`docs/`— grep for stale references:`grep -rn "LOCAL mode\|GITHUB mode\|uiMode\|Shift+Tab" docs/ README.md`and update hits (the superseded spec files under`docs/superpowers/` are historical — leave them).

- [ ] **Step 1:** Delete the files/exports above; chase compile errors (`npm run typecheck`) until zero new; delete/retarget the tests named above. Verify no dangling imports: `grep -rn "LocalDashboard\|localHintsFor\|QUEUE_CARD_ROWS\|UiMode\|initialUiMode" src/ tests/` → only historical docs hits.
- [ ] **Step 2:** Docs edits above. README: grep for mode-toggle mentions (`grep -n "LOCAL\|GITHUB tab\|m key" README.md`) and update.
- [ ] **Step 3: Full gate:** `npm run lint && npm run format:check && npm run typecheck && npm run build && npm test` — all green (use the exit-code-safe vitest invocation).
- [ ] **Step 4: Commit** — `git commit -m "refactor(tui)!: delete the two-mode surface (Rail, LocalDashboard, mode toggle plumbing)"`.

---

## Self-review notes (already applied)

- Spec §1–§7 each map to a task: §1→2, §2→5, §3→4/6/7, §4→7, §5→9, §6→7, §7→1–9 test steps.
- Type names cross-checked: `UnifiedRepo`/`RailRow`/`BodyKind`/`sysKey`/`rowKey`/`SYSTEM_SECTIONS` (Task 2) are the exact spellings Tasks 4–7 import; `repoPath` (Task 1) is what Task 4's `repoQueueRows` filters on; `SYSTEM_BLOCK_ROWS` (Task 5) is what Task 9 leaves as the only rail geometry constant.
- Deliberate sequencing: old Rail renders one row shorter between Tasks 5 and 7 (railListHeight formula change) — accepted, called out in Task 5.
- Task 7 is irreducibly large because the App is one file and its suites pin the old surface; every other task lands green in isolation.
