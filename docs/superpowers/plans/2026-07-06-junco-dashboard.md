# `junco dashboard` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A fullscreen Ink 7 + React 19 dashboard (`junco dashboard`) that manages a hot-reloading repo watchlist and drives the GitHub-mode lifecycle (dispatch / approve / re-plan / re-cycle) as pure label mutations. Spec: `docs/superpowers/specs/2026-07-06-junco-dashboard-design.md`.

**Architecture:** New `src/watchlist.ts` (shared by dashboard + bridge; the sweep resolves watched repos per sweep → hot reload). New `src/tui/` — pure state derivation (`state.ts`), a gh-backed data client behind a seam (`ghClient.ts`), pure components, and an `App.tsx` composition with optimistic mutations. `src/dashboardCmd.ts` + a lazy-loaded CLI case keep React out of every non-dashboard code path. Everything vitest-testable: `ink-testing-library` renders frames to strings, all gh/git calls injected.

**Tech Stack:** TypeScript (Node ≥22.19, ESM/NodeNext, strict), Ink 7.1.0, React 19.2.7, ink-testing-library 4.0.0 (dev), vitest, `gh` CLI via the existing `gh()` wrapper.

## Global Constraints

- **Exact-pinned deps:** `npm install --save-exact ink@7.1.0 react@19.2.7` and `npm install --save-dev --save-exact ink-testing-library@4.0.0 @types/react@19.2.17`. NOTHING else — widgets are hand-rolled.
- **Lazy loading:** no static import chain from `src/cli.ts` (or any daemon path) to `ink`/`react`. The `dashboard` case uses `await import("./dashboardCmd.js")`, and `dashboardCmd.ts` dynamically imports the Ink app module.
- **The dashboard is a GitHub client, not a queue client:** actions are label mutations via the operator's `gh` auth; no queue-dir writes, ever.
- **Vitest exit-code trap:** `npx vitest run <files> > /tmp/out 2>&1; echo "exit: $?"` — never pipe into a filter.
- **Prettier before every commit** on touched files; re-read files the formatter touched.
- **Live-runtime rule:** never `junco start`/`junco dashboard` against the repo-root config; component tests never need a TTY.
- **Stack-agnostic shipped surface** ("inference endpoint", no personal-setup strings).
- No AI attribution in commits. Suite green at every commit; conventional commits on branch `feat/dashboard`.

---

### Task 1: Toolchain — deps, TSX build/lint/format, smoke component

**Files:**

- Modify: `package.json` (deps + `format`/`format:check` globs)
- Modify: `tsconfig.json` (add `"jsx": "react-jsx"`)
- Modify: `eslint.config.js` (add `.tsx` globs)
- Create: `src/tui/Smoke.tsx` (temporary — deleted in Task 6)
- Test: `tests/tuiSmoke.test.tsx` (temporary — deleted in Task 6)

**Interfaces:**

- Produces: a toolchain where `.tsx` under `src/` builds via tsc, lints, formats, and renders in vitest via `ink-testing-library`. All later TUI tasks assume this.

- [ ] **Step 1: Install exact-pinned deps**

```bash
npm install --save-exact ink@7.1.0 react@19.2.7
npm install --save-dev --save-exact ink-testing-library@4.0.0 @types/react@19.2.17
```

- [ ] **Step 2: Toolchain config.** `tsconfig.json` compilerOptions gains `"jsx": "react-jsx"`. `eslint.config.js` files glob becomes `["src/**/*.ts", "src/**/*.tsx", "tests/**/*.ts", "tests/**/*.tsx"]`. `package.json` scripts:

```json
    "format": "prettier --write \"src/**/*.{ts,tsx}\" \"tests/**/*.{ts,tsx}\"",
    "format:check": "prettier --check \"src/**/*.{ts,tsx}\" \"tests/**/*.{ts,tsx}\"",
```

- [ ] **Step 3: Failing smoke test.** Create `tests/tuiSmoke.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { Smoke } from "../src/tui/Smoke.js";

describe("tsx toolchain smoke", () => {
  it("renders an ink component to a string frame", () => {
    const { lastFrame } = render(<Smoke label="junco" />);
    expect(lastFrame()).toContain("junco dashboard smoke");
  });
});
```

Run: `npx vitest run tests/tuiSmoke.test.tsx > /tmp/out 2>&1; echo "exit: $?"` → FAIL (module missing).

- [ ] **Step 4: Implement.** Create `src/tui/Smoke.tsx`:

```tsx
import React from "react";
import { Text } from "ink";

/** Temporary toolchain smoke component — removed once real components land. */
export function Smoke({ label }: { label: string }): React.JSX.Element {
  return <Text>{label} dashboard smoke</Text>;
}
```

- [ ] **Step 5: Full gate** — `npm run lint && npm run format:check && npm run build && npm test > /tmp/out 2>&1; echo "exit: $?"` → 0. Verify `dist/tui/Smoke.js` exists (tsc compiled TSX).

- [ ] **Step 6: Commit**

```bash
npx prettier --write package.json tsconfig.json eslint.config.js src/tui/Smoke.tsx tests/tuiSmoke.test.tsx
git add -A && git commit -m "chore(tui): ink 7 + react 19 toolchain — tsx build/lint/format/test wired"
```

---

### Task 2: `src/watchlist.ts` — dynamic watchlist + resolveWatchedRepos

**Files:**

- Create: `src/watchlist.ts`
- Test: `tests/watchlist.test.ts`

**Interfaces:**

- Consumes: `Config`, `GithubRepoMapping` from `./types.js`; `log` from `./logging.js`.
- Produces (Tasks 3, 5, 8, 9 consume):

```ts
export interface WatchlistEntry {
  nwo: string;
  path: string;
}
export function watchlistPath(cfg: Config): string; // join(cfg.stateDir, "github-watchlist.json")
export function readWatchlist(file: string): { entries: WatchlistEntry[]; error: string | null };
// missing file → { entries: [], error: null }; corrupt/invalid → { entries: [], error: <msg> } (never throws)
export function writeWatchlist(file: string, entries: WatchlistEntry[]): void; // mkdir -p + tmp + rename (atomic)
export function resolveWatchedRepos(cfg: Config): GithubRepoMapping[];
// config repos ∪ watchlist entries, deduped by nwo (case-insensitive), CONFIG WINS; watchlist error → log.warn + config-only
```

- [ ] **Step 1: Failing tests.** Create `tests/watchlist.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  watchlistPath,
  readWatchlist,
  writeWatchlist,
  resolveWatchedRepos,
} from "../src/watchlist.js";
import type { Config } from "../src/types.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "junco-wl-"));
}
function cfgWith(stateDir: string, repos: { nwo: string; path: string }[]): Config {
  return {
    stateDir,
    github: {
      enabled: true,
      triggerLabel: "junco",
      askLabel: "junco:ask",
      pollIntervalSeconds: 60,
      repos,
      requireApproval: true,
      plannerModelId: null,
    },
  } as unknown as Config;
}

describe("watchlistPath", () => {
  it("lives under the state dir", () => {
    expect(watchlistPath(cfgWith("/s", []))).toBe("/s/github-watchlist.json");
  });
});

describe("readWatchlist", () => {
  it("missing file → empty, no error", () => {
    expect(readWatchlist(join(tmp(), "none.json"))).toEqual({ entries: [], error: null });
  });

  it("round-trips writeWatchlist output", () => {
    const f = join(tmp(), "wl.json");
    writeWatchlist(f, [{ nwo: "acme/api", path: "/c/api" }]);
    expect(readWatchlist(f)).toEqual({
      entries: [{ nwo: "acme/api", path: "/c/api" }],
      error: null,
    });
  });

  it("corrupt JSON → empty + error, file untouched", () => {
    const f = join(tmp(), "wl.json");
    writeFileSync(f, "{ not json", "utf8");
    const r = readWatchlist(f);
    expect(r.entries).toEqual([]);
    expect(r.error).toBeTruthy();
    expect(readFileSync(f, "utf8")).toBe("{ not json"); // never clobbered
  });

  it("filters malformed entries (bad nwo, missing path) with an error note", () => {
    const f = join(tmp(), "wl.json");
    writeFileSync(
      f,
      JSON.stringify([
        { nwo: "acme/api", path: "/c" },
        { nwo: "no-slash", path: "/x" },
        { nwo: "a/b" },
      ]),
      "utf8",
    );
    const r = readWatchlist(f);
    expect(r.entries).toEqual([{ nwo: "acme/api", path: "/c" }]);
    expect(r.error).toContain("2 invalid");
  });
});

describe("writeWatchlist", () => {
  it("creates parent dirs and leaves no temp file", () => {
    const dir = tmp();
    const f = join(dir, "deep", "wl.json");
    writeWatchlist(f, []);
    expect(readWatchlist(f)).toEqual({ entries: [], error: null });
    expect(readdirSync(join(dir, "deep")).some((n) => n.includes(".tmp"))).toBe(false);
  });
});

describe("resolveWatchedRepos", () => {
  it("unions config and watchlist, config wins on nwo (case-insensitive)", () => {
    const dir = tmp();
    const cfg = cfgWith(dir, [{ nwo: "acme/api", path: "/config/api" }]);
    writeWatchlist(watchlistPath(cfg), [
      { nwo: "ACME/api", path: "/wl/api" }, // conflict → config wins
      { nwo: "alx/coral", path: "/wl/coral" },
    ]);
    expect(resolveWatchedRepos(cfg)).toEqual([
      { nwo: "acme/api", path: "/config/api" },
      { nwo: "alx/coral", path: "/wl/coral" },
    ]);
  });

  it("watchlist error degrades to config-only", () => {
    const dir = tmp();
    const cfg = cfgWith(dir, [{ nwo: "acme/api", path: "/config/api" }]);
    writeFileSync(watchlistPath(cfg), "boom", "utf8");
    expect(resolveWatchedRepos(cfg)).toEqual([{ nwo: "acme/api", path: "/config/api" }]);
  });
});
```

- [ ] **Step 2: Verify failure** — `npx vitest run tests/watchlist.test.ts > /tmp/out 2>&1; echo "exit: $?"` → FAIL.

- [ ] **Step 3: Implement.** Create `src/watchlist.ts`:

```ts
/**
 * Dynamic repo watchlist — shared by the dashboard (writes) and the bridge
 * sweep (reads via resolveWatchedRepos EVERY sweep → hot reload, no daemon
 * restart). Stored as JSON under the state dir; atomic tmp+rename writes.
 * Config [[github.repos]] entries always win on nwo conflicts.
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { Config, GithubRepoMapping } from "./types.js";
import { log } from "./logging.js";

export interface WatchlistEntry {
  nwo: string;
  path: string;
}

const NWO_RE = /^[\w.-]+\/[\w.-]+$/;

export function watchlistPath(cfg: Config): string {
  return join(cfg.stateDir, "github-watchlist.json");
}

/** Never throws: missing → empty; corrupt/invalid → empty + error message
 * (callers surface it; the corrupt file is never clobbered here). */
export function readWatchlist(file: string): { entries: WatchlistEntry[]; error: string | null } {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return { entries: [], error: null };
    return { entries: [], error: e instanceof Error ? e.message : String(e) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { entries: [], error: `watchlist is not valid JSON: ${(e as Error).message}` };
  }
  if (!Array.isArray(parsed)) return { entries: [], error: "watchlist is not a JSON array" };
  const entries: WatchlistEntry[] = [];
  let invalid = 0;
  for (const it of parsed) {
    const e = it as Record<string, unknown>;
    if (
      e !== null &&
      typeof e === "object" &&
      typeof e.nwo === "string" &&
      NWO_RE.test(e.nwo) &&
      typeof e.path === "string" &&
      e.path.trim() !== ""
    ) {
      entries.push({ nwo: e.nwo, path: e.path });
    } else {
      invalid++;
    }
  }
  return {
    entries,
    error: invalid > 0 ? `${invalid} invalid entr${invalid === 1 ? "y" : "ies"} ignored` : null,
  };
}

/** Atomic write: mkdir -p, sibling tmp, rename. */
export function writeWatchlist(file: string, entries: WatchlistEntry[]): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(entries, null, 2) + "\n", "utf8");
  renameSync(tmp, file);
}

/** Config repos ∪ watchlist entries, deduped by nwo (case-insensitive),
 * config wins. Watchlist trouble degrades to config-only with a warn. */
export function resolveWatchedRepos(cfg: Config): GithubRepoMapping[] {
  const out: GithubRepoMapping[] = [...cfg.github.repos];
  const seen = new Set(out.map((r) => r.nwo.toLowerCase()));
  const { entries, error } = readWatchlist(watchlistPath(cfg));
  if (error) {
    log.warn("github watchlist unreadable; using config repos only", { error });
  }
  for (const e of entries) {
    if (seen.has(e.nwo.toLowerCase())) continue;
    seen.add(e.nwo.toLowerCase());
    out.push({ nwo: e.nwo, path: e.path });
  }
  return out;
}
```

- [ ] **Step 4: Verify pass + full suite** — `npx vitest run > /tmp/out 2>&1; echo "exit: $?"` → 0.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/watchlist.ts tests/watchlist.test.ts
git add -A src tests && git commit -m "feat(watchlist): dynamic github watchlist — atomic file + config-wins merge"
```

---

### Task 3: Bridge hot-reload — sweep iterates resolveWatchedRepos

**Files:**

- Modify: `src/githubInbox.ts` (the `for (const repo of cfg.github.repos)` loop head in `pollGithubInbox`)
- Test: `tests/githubInbox.test.ts`

**Interfaces:**

- Consumes: `resolveWatchedRepos` (Task 2).
- Produces: the sweep picks up watchlist changes between sweeps with no restart.

- [ ] **Step 1: Failing test.** Append to `tests/githubInbox.test.ts` (reuse its `makeFakes`/`bridgeCfg` helpers; `bridgeCfg` has a static `/tmp`-ish stateDir — this test needs a REAL tmp stateDir):

```ts
import { writeWatchlist, watchlistPath } from "../src/watchlist.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";

describe("watchlist hot-reload", () => {
  it("a repo added to the watchlist between sweeps is swept without restart", async () => {
    const stateDir = mkdtempSync(joinPath(tmpdir(), "junco-wl-hot-"));
    const cfg = {
      ...bridgeCfg,
      stateDir,
      github: { ...bridgeCfg.github, repos: [] }, // nothing in config
    } as Config;
    const f = makeFakes({ issues: [] });
    const state = newBridgeState();

    await pollGithubInbox(cfg, state, f as never);
    expect(f.calls.find((c) => c[0] === "issue" && c[1] === "list")).toBeUndefined();

    writeWatchlist(watchlistPath(cfg), [{ nwo: "acme/api", path: "/home/u/code/api" }]);
    await pollGithubInbox(cfg, state, f as never);
    const list = f.calls.find((c) => c[0] === "issue" && c[1] === "list");
    expect(list).toBeDefined();
    expect(list).toContain("acme/api");
  });
});
```

- [ ] **Step 2: Verify failure** — `npx vitest run tests/githubInbox.test.ts > /tmp/out 2>&1; echo "exit: $?"` → FAIL (second sweep still sees no repos).

- [ ] **Step 3: Implement.** In `src/githubInbox.ts`: `import { resolveWatchedRepos } from "./watchlist.js";` and change the sweep's loop head:

```ts
  for (const repo of resolveWatchedRepos(cfg)) {
```

(One line — `resolveWatchedRepos` already degrades to config-only on watchlist trouble, so no other behavior changes; existing tests keep passing because config repos still resolve.)

- [ ] **Step 4: Verify pass + full suite** — `npx vitest run > /tmp/out 2>&1; echo "exit: $?"` → 0.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/githubInbox.ts tests/githubInbox.test.ts
git add -A src tests && git commit -m "feat(github): bridge sweeps resolveWatchedRepos — watchlist hot-reload"
```

---

### Task 4: `src/tui/state.ts` — pure lifecycle derivation

**Files:**

- Create: `src/tui/state.ts`
- Test: `tests/tuiState.test.ts`

**Interfaces:**

- Consumes: `lifecycleLabels` from `../githubInbox.js`.
- Produces (Tasks 5–9 consume):

```ts
export type IssueLifecycle =
  | "raw"
  | "planning"
  | "plan-ready"
  | "approved"
  | "queued"
  | "working"
  | "done"
  | "failed"
  | "denied";
export interface DashIssue {
  number: number;
  title: string;
  labels: string[];
  updatedAt: string;
  url: string;
}
export type DashAction = "dispatch" | "dispatchAsk" | "approve" | "replan" | "recycle";
export function deriveState(labels: string[], trigger: string): IssueLifecycle;
export function stateMeta(s: IssueLifecycle): { glyph: string; color: string; badge: string };
export function allowedActions(s: IssueLifecycle): DashAction[];
export function sortIssues(issues: DashIssue[], trigger: string): DashIssue[];
```

- [ ] **Step 1: Failing tests.** Create `tests/tuiState.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  deriveState,
  stateMeta,
  allowedActions,
  sortIssues,
  type DashIssue,
} from "../src/tui/state.js";

const T = "junco";
const iss = (n: number, labels: string[], updatedAt: string): DashIssue => ({
  number: n,
  title: `t${n}`,
  labels,
  updatedAt,
  url: `https://github.com/a/b/issues/${n}`,
});

describe("deriveState", () => {
  it.each([
    [[], "raw"],
    [["junco"], "raw"],
    [["junco", "junco:planning"], "planning"],
    [["junco", "junco:plan-ready"], "plan-ready"],
    [["junco", "junco:plan-ready", "junco:approved"], "approved"],
    [["junco", "junco:queued"], "queued"],
    [["junco", "junco:working"], "working"],
    [["junco", "junco:done"], "done"],
    [["junco", "junco:failed"], "failed"],
    [["junco", "junco:denied"], "denied"],
  ] as const)("%j → %s", (labels, expected) => {
    expect(deriveState([...labels], T)).toBe(expected);
  });

  it("terminal states win over stale earlier labels", () => {
    expect(deriveState(["junco", "junco:plan-ready", "junco:failed"], T)).toBe("failed");
    expect(deriveState(["junco", "junco:queued", "junco:done"], T)).toBe("done");
  });

  it("approved without plan-ready is NOT the approved state (pre-approval is inert)", () => {
    expect(deriveState(["junco", "junco:approved"], T)).toBe("raw");
  });

  it("custom trigger derives custom lifecycle names", () => {
    expect(deriveState(["bot", "bot:working"], "bot")).toBe("working");
  });
});

describe("allowedActions", () => {
  it.each([
    ["raw", ["dispatch", "dispatchAsk"]],
    ["planning", []],
    ["plan-ready", ["approve", "replan"]],
    ["approved", ["replan"]],
    ["queued", []],
    ["working", []],
    ["done", ["recycle"]],
    ["failed", ["recycle"]],
    ["denied", ["recycle"]],
  ] as const)("%s → %j", (state, actions) => {
    expect(allowedActions(state)).toEqual(actions);
  });
});

describe("stateMeta", () => {
  it("every state has glyph, color, badge", () => {
    for (const s of [
      "raw",
      "planning",
      "plan-ready",
      "approved",
      "queued",
      "working",
      "done",
      "failed",
      "denied",
    ] as const) {
      const m = stateMeta(s);
      expect(m.glyph.length).toBeGreaterThan(0);
      expect(m.color.length).toBeGreaterThan(0);
      expect(m.badge.length).toBeGreaterThan(0);
    }
  });
});

describe("sortIssues", () => {
  it("needs-review first, then raw, then in-flight, then terminal; updatedAt desc within groups", () => {
    const sorted = sortIssues(
      [
        iss(1, ["junco", "junco:done"], "2026-07-06T10:00:00Z"),
        iss(2, ["junco"], "2026-07-06T09:00:00Z"),
        iss(3, ["junco", "junco:plan-ready"], "2026-07-01T00:00:00Z"),
        iss(4, ["junco", "junco:working"], "2026-07-06T11:00:00Z"),
        iss(5, ["junco"], "2026-07-06T12:00:00Z"),
      ],
      T,
    );
    expect(sorted.map((i) => i.number)).toEqual([3, 5, 2, 4, 1]);
  });
});
```

- [ ] **Step 2: Verify failure** — `npx vitest run tests/tuiState.test.ts > /tmp/out 2>&1; echo "exit: $?"` → FAIL.

- [ ] **Step 3: Implement.** Create `src/tui/state.ts`:

```ts
/**
 * Pure lifecycle derivation for the dashboard. An issue's state is a function
 * of its labels ONLY — the dashboard holds no queue state. Precedence mirrors
 * the bridge: terminal states shadow stale earlier labels; `approved` is a
 * distinct state only on top of plan-ready (pre-approval is inert by design).
 */

import { lifecycleLabels } from "../githubInbox.js";

export type IssueLifecycle =
  | "raw"
  | "planning"
  | "plan-ready"
  | "approved"
  | "queued"
  | "working"
  | "done"
  | "failed"
  | "denied";

export interface DashIssue {
  number: number;
  title: string;
  labels: string[];
  updatedAt: string;
  url: string;
}

export type DashAction = "dispatch" | "dispatchAsk" | "approve" | "replan" | "recycle";

export function deriveState(labels: string[], trigger: string): IssueLifecycle {
  const ll = lifecycleLabels(trigger);
  const has = (l: string): boolean => labels.includes(l);
  if (has(ll.denied)) return "denied";
  if (has(ll.failed)) return "failed";
  if (has(ll.done)) return "done";
  if (has(ll.working)) return "working";
  if (has(ll.queued)) return "queued";
  if (has(ll.planReady)) return has(ll.approved) ? "approved" : "plan-ready";
  if (has(ll.planning)) return "planning";
  return "raw";
}

const META: Record<IssueLifecycle, { glyph: string; color: string; badge: string }> = {
  raw: { glyph: "○", color: "gray", badge: "—" },
  planning: { glyph: "◔", color: "cyan", badge: "planning" },
  "plan-ready": { glyph: "●", color: "yellow", badge: "plan-ready" },
  approved: { glyph: "●", color: "blue", badge: "approved" },
  queued: { glyph: "◑", color: "cyan", badge: "queued" },
  working: { glyph: "◐", color: "cyan", badge: "working" },
  done: { glyph: "✓", color: "green", badge: "done" },
  failed: { glyph: "✗", color: "red", badge: "failed" },
  denied: { glyph: "⊘", color: "magenta", badge: "denied" },
};

export function stateMeta(s: IssueLifecycle): { glyph: string; color: string; badge: string } {
  return META[s];
}

const ACTIONS: Record<IssueLifecycle, DashAction[]> = {
  raw: ["dispatch", "dispatchAsk"],
  planning: [],
  "plan-ready": ["approve", "replan"],
  approved: ["replan"],
  queued: [],
  working: [],
  done: ["recycle"],
  failed: ["recycle"],
  denied: ["recycle"],
};

export function allowedActions(s: IssueLifecycle): DashAction[] {
  return ACTIONS[s];
}

// Sort groups: needs-review (plan-ready/approved) → raw → in-flight → terminal.
const GROUP: Record<IssueLifecycle, number> = {
  "plan-ready": 0,
  approved: 0,
  raw: 1,
  planning: 2,
  queued: 2,
  working: 2,
  done: 3,
  failed: 3,
  denied: 3,
};

export function sortIssues(issues: DashIssue[], trigger: string): DashIssue[] {
  return [...issues].sort((a, b) => {
    const ga = GROUP[deriveState(a.labels, trigger)];
    const gb = GROUP[deriveState(b.labels, trigger)];
    if (ga !== gb) return ga - gb;
    return (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0);
  });
}
```

- [ ] **Step 4: Verify pass + full suite** — `npx vitest run > /tmp/out 2>&1; echo "exit: $?"` → 0.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/tui/state.ts tests/tuiState.test.ts
git add -A src tests && git commit -m "feat(tui): pure lifecycle state derivation, action gating, issue ordering"
```

---

### Task 5: `src/tui/ghClient.ts` — the dashboard's data client

**Files:**

- Create: `src/tui/ghClient.ts`
- Test: `tests/tuiGhClient.test.ts`

**Interfaces:**

- Consumes: `gh`, `git` wrappers (`../git.js`); `lifecycleLabels`, `nwoFromRemoteUrl`, `PLAN_COMMENT_MARKER` (`../githubInbox.js`); `DashIssue`, `DashAction` (Task 4); `Config`.
- Produces (Tasks 8, 9 consume):

```ts
export type Result<T> = { ok: true; value: T } | { ok: false; error: string };
export interface HealthInfo {
  up: boolean;
  uptimeSeconds: number | null;
  lastBridgeSweepAt: string | null;
  ticketsBridged: number | null;
}
export interface DashboardClient {
  listIssues(nwo: string): Promise<Result<DashIssue[]>>;
  issueDetail(
    nwo: string,
    num: number,
  ): Promise<Result<{ body: string; planComment: string | null }>>;
  applyAction(
    nwo: string,
    num: number,
    action: DashAction,
    labels: string[],
  ): Promise<Result<void>>;
  validateAndPrepareRepo(nwo: string, path: string): Promise<Result<void>>;
  openInBrowser(nwo: string, num: number): Promise<Result<void>>;
  health(): Promise<HealthInfo>;
}
export interface GhClientDeps {
  ghFn?: typeof gh;
  gitFn?: typeof git;
  fetchFn?: typeof fetch;
}
export function makeGhDashboardClient(cfg: Config, deps?: GhClientDeps): DashboardClient;
```

Action → label mapping (encapsulated here, single source): `dispatch` → add trigger; `dispatchAsk` → add trigger + askLabel (one `gh issue edit`); `approve` → add `<trigger>:approved`; `replan` → remove `plan-ready` (+ `approved` when present in `labels`); `recycle` → remove whichever of `done`/`failed`/`denied` is present in `labels`.

- [ ] **Step 1: Failing tests.** Create `tests/tuiGhClient.test.ts`:

`````ts
import { describe, it, expect } from "vitest";
import { makeGhDashboardClient } from "../src/tui/ghClient.js";
import type { Config } from "../src/types.js";
import type { CmdResult } from "../src/git.js";

const cfg = {
  ghBin: "gh",
  gitBin: "git",
  healthEnabled: true,
  healthHost: "127.0.0.1",
  healthPort: 8787,
  github: {
    enabled: true,
    triggerLabel: "junco",
    askLabel: "junco:ask",
    pollIntervalSeconds: 60,
    repos: [],
    requireApproval: true,
    plannerModelId: null,
  },
} as unknown as Config;

function fakes(
  opts: {
    issues?: unknown[];
    body?: string;
    comments?: { author: string; body: string; created_at: string }[];
    viewer?: string;
    origin?: string;
    failArgs?: string; // any gh argv containing this substring throws
  } = {},
) {
  const calls: string[][] = [];
  const ok = (stdout: string): CmdResult => ({ code: 0, stdout, stderr: "" });
  const ghFn = async (_c: unknown, args: string[]): Promise<CmdResult> => {
    calls.push(args);
    if (opts.failArgs && args.join(" ").includes(opts.failArgs)) throw new Error("gh boom");
    if (args[0] === "issue" && args[1] === "list") return ok(JSON.stringify(opts.issues ?? []));
    if (args[0] === "issue" && args[1] === "view" && args.includes("--json"))
      return ok(JSON.stringify({ body: opts.body ?? "" }));
    if (args[0] === "issue" && (args[1] === "edit" || args[1] === "view")) return ok("");
    if (args[0] === "api" && args[1] === "user") return ok(opts.viewer ?? "junco-bot");
    if (args[0] === "api" && String(args[2] ?? "").includes("/comments"))
      return ok((opts.comments ?? []).map((c) => JSON.stringify(c)).join("\n"));
    if (args[0] === "repo" && args[1] === "view") return ok("");
    if (args[0] === "label" && args[1] === "list") return ok("");
    if (args[0] === "label" && args[1] === "create") return ok("");
    throw new Error(`unhandled gh argv: ${args.join(" ")}`);
  };
  const gitFn = async (_c: unknown, args: string[]): Promise<CmdResult> => {
    calls.push(["git", ...args]);
    return ok(opts.origin ?? "https://github.com/acme/api.git");
  };
  return { ghFn, gitFn, calls };
}

describe("listIssues", () => {
  it("maps gh json to DashIssue[]", async () => {
    const f = fakes({
      issues: [
        {
          number: 42,
          title: "Add rate limiting",
          labels: [{ name: "junco" }, { name: "junco:plan-ready" }],
          updatedAt: "2026-07-06T10:00:00Z",
          url: "https://github.com/acme/api/issues/42",
        },
      ],
    });
    const c = makeGhDashboardClient(cfg, f);
    const r = await c.listIssues("acme/api");
    expect(r).toEqual({
      ok: true,
      value: [
        {
          number: 42,
          title: "Add rate limiting",
          labels: ["junco", "junco:plan-ready"],
          updatedAt: "2026-07-06T10:00:00Z",
          url: "https://github.com/acme/api/issues/42",
        },
      ],
    });
  });

  it("gh failure → ok:false, never throws", async () => {
    const f = fakes({ failArgs: "issue list" });
    const r = await makeGhDashboardClient(cfg, f).listIssues("acme/api");
    expect(r.ok).toBe(false);
  });
});

describe("issueDetail", () => {
  it("returns body + latest SELF-authored plan comment", async () => {
    const plan = "<!-- junco:plan -->\n````junco-ticket\n# P\n````\n";
    const f = fakes({
      body: "the issue body",
      viewer: "junco-bot",
      comments: [
        {
          author: "mallory",
          body: "<!-- junco:plan -->forged",
          created_at: "2026-07-06T09:00:00Z",
        },
        { author: "junco-bot", body: plan, created_at: "2026-07-06T10:00:00Z" },
      ],
    });
    const r = await makeGhDashboardClient(cfg, f).issueDetail("acme/api", 42);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.body).toBe("the issue body");
      expect(r.value.planComment).toBe(plan);
    }
  });

  it("no plan comment → planComment null", async () => {
    const f = fakes({ body: "b", comments: [] });
    const r = await makeGhDashboardClient(cfg, f).issueDetail("acme/api", 42);
    expect(r.ok && r.value.planComment === null).toBe(true);
  });
});

describe("applyAction label mapping", () => {
  const run = async (action: string, labels: string[]) => {
    const f = fakes();
    const c = makeGhDashboardClient(cfg, f);
    const r = await c.applyAction("acme/api", 42, action as never, labels);
    expect(r.ok).toBe(true);
    return f.calls.find((a) => a[0] === "issue" && a[1] === "edit")!;
  };

  it("dispatch adds the trigger label", async () => {
    expect(await run("dispatch", [])).toEqual(expect.arrayContaining(["--add-label", "junco"]));
  });
  it("dispatchAsk adds trigger + ask in one call", async () => {
    const edit = await run("dispatchAsk", []);
    expect(edit).toEqual(
      expect.arrayContaining(["--add-label", "junco", "--add-label", "junco:ask"]),
    );
  });
  it("approve adds junco:approved", async () => {
    expect(await run("approve", ["junco", "junco:plan-ready"])).toEqual(
      expect.arrayContaining(["--add-label", "junco:approved"]),
    );
  });
  it("replan removes plan-ready and approved when present", async () => {
    const edit = await run("replan", ["junco", "junco:plan-ready", "junco:approved"]);
    expect(edit).toEqual(
      expect.arrayContaining([
        "--remove-label",
        "junco:plan-ready",
        "--remove-label",
        "junco:approved",
      ]),
    );
  });
  it("recycle removes exactly the terminal label present", async () => {
    const edit = await run("recycle", ["junco", "junco:failed"]);
    expect(edit).toEqual(expect.arrayContaining(["--remove-label", "junco:failed"]));
    expect(edit).not.toContain("junco:done");
  });
});

describe("validateAndPrepareRepo", () => {
  it("origin mismatch → ok:false with a clear error", async () => {
    const f = fakes({ origin: "https://github.com/other/thing.git" });
    const r = await makeGhDashboardClient(cfg, f).validateAndPrepareRepo("acme/api", "/c/api");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("origin");
  });

  it("valid repo: checks gh reachability and ensures the trigger label", async () => {
    const f = fakes();
    const r = await makeGhDashboardClient(cfg, f).validateAndPrepareRepo("acme/api", "/c/api");
    expect(r.ok).toBe(true);
    expect(f.calls.find((a) => a[0] === "repo" && a[1] === "view")).toBeDefined();
    expect(
      f.calls.find((a) => a[0] === "label" && a[1] === "create" && a.includes("junco")),
    ).toBeDefined();
  });
});

describe("health", () => {
  it("maps /health json; fetch failure → up:false", async () => {
    const fetchOk = (async () => ({
      ok: true,
      json: async () => ({
        ready: true,
        metrics: {
          uptimeSeconds: 120,
          lastBridgeSweepAt: "2026-07-06T10:00:00Z",
          ticketsBridged: 2,
        },
      }),
    })) as unknown as typeof fetch;
    const c1 = makeGhDashboardClient(cfg, { ...fakes(), fetchFn: fetchOk });
    expect(await c1.health()).toEqual({
      up: true,
      uptimeSeconds: 120,
      lastBridgeSweepAt: "2026-07-06T10:00:00Z",
      ticketsBridged: 2,
    });
    const fetchBad = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const c2 = makeGhDashboardClient(cfg, { ...fakes(), fetchFn: fetchBad });
    expect((await c2.health()).up).toBe(false);
  });
});
`````

- [ ] **Step 2: Verify failure** — `npx vitest run tests/tuiGhClient.test.ts > /tmp/out 2>&1; echo "exit: $?"` → FAIL (module missing).

- [ ] **Step 3: Implement.** Create `src/tui/ghClient.ts`:

```ts
/**
 * The dashboard's ONLY GitHub-touching module. Every method returns a Result
 * instead of throwing — failures render as status-bar toasts, never crashes.
 * Actions are pure label mutations under the operator's own gh auth, so the
 * bridge's permission gates apply unchanged.
 */

import type { Config } from "../types.js";
import { gh, git } from "../git.js";
import { lifecycleLabels, nwoFromRemoteUrl, PLAN_COMMENT_MARKER } from "../githubInbox.js";
import type { DashIssue, DashAction } from "./state.js";

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export interface HealthInfo {
  up: boolean;
  uptimeSeconds: number | null;
  lastBridgeSweepAt: string | null;
  ticketsBridged: number | null;
}

export interface DashboardClient {
  listIssues(nwo: string): Promise<Result<DashIssue[]>>;
  issueDetail(
    nwo: string,
    num: number,
  ): Promise<Result<{ body: string; planComment: string | null }>>;
  applyAction(
    nwo: string,
    num: number,
    action: DashAction,
    labels: string[],
  ): Promise<Result<void>>;
  validateAndPrepareRepo(nwo: string, path: string): Promise<Result<void>>;
  openInBrowser(nwo: string, num: number): Promise<Result<void>>;
  health(): Promise<HealthInfo>;
}

export interface GhClientDeps {
  ghFn?: typeof gh;
  gitFn?: typeof git;
  fetchFn?: typeof fetch;
}

const GH_TIMEOUT = 30_000;
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function makeGhDashboardClient(cfg: Config, deps: GhClientDeps = {}): DashboardClient {
  const ghFn = deps.ghFn ?? gh;
  const gitFn = deps.gitFn ?? git;
  const fetchFn = deps.fetchFn ?? fetch;
  const trigger = cfg.github.triggerLabel;
  const ll = lifecycleLabels(trigger);
  let viewer: string | null = null;

  const attempt = async <T>(fn: () => Promise<T>): Promise<Result<T>> => {
    try {
      return { ok: true, value: await fn() };
    } catch (e) {
      return { ok: false, error: errMsg(e) };
    }
  };

  const edit = async (nwo: string, num: number, args: string[]): Promise<void> => {
    await ghFn(cfg, ["issue", "edit", String(num), "--repo", nwo, ...args], {
      timeoutMs: GH_TIMEOUT,
      retryNetwork: true,
    });
  };

  return {
    listIssues(nwo) {
      return attempt(async () => {
        const r = await ghFn(
          cfg,
          [
            "issue",
            "list",
            "--repo",
            nwo,
            "--state",
            "open",
            "--limit",
            "200",
            "--json",
            "number,title,labels,updatedAt,url",
          ],
          { timeoutMs: GH_TIMEOUT, retryNetwork: true },
        );
        const raw = JSON.parse(r.stdout) as {
          number: number;
          title: string;
          labels: { name: string }[];
          updatedAt: string;
          url: string;
        }[];
        return raw.map((i) => ({
          number: i.number,
          title: i.title,
          labels: i.labels.map((l) => l.name),
          updatedAt: i.updatedAt,
          url: i.url,
        }));
      });
    },

    issueDetail(nwo, num) {
      return attempt(async () => {
        const view = await ghFn(
          cfg,
          ["issue", "view", String(num), "--repo", nwo, "--json", "body"],
          { timeoutMs: GH_TIMEOUT, retryNetwork: true },
        );
        const body = (JSON.parse(view.stdout) as { body?: string }).body ?? "";
        if (viewer === null) {
          const u = await ghFn(cfg, ["api", "user", "--jq", ".login"], {
            timeoutMs: GH_TIMEOUT,
            retryNetwork: true,
          });
          viewer = u.stdout.trim();
        }
        const cm = await ghFn(
          cfg,
          [
            "api",
            "--paginate",
            `repos/${nwo}/issues/${num}/comments`,
            "--jq",
            ".[] | {author: .user.login, body: .body, created_at: .created_at}",
          ],
          { timeoutMs: GH_TIMEOUT, retryNetwork: true },
        );
        let planComment: string | null = null;
        for (const line of cm.stdout.trim().split("\n").filter(Boolean)) {
          const c = JSON.parse(line) as { author: string; body: string };
          if (c.author === viewer && c.body.includes(PLAN_COMMENT_MARKER)) planComment = c.body;
        }
        return { body, planComment };
      });
    },

    applyAction(nwo, num, action, labels) {
      return attempt(async () => {
        const has = (l: string): boolean => labels.includes(l);
        switch (action) {
          case "dispatch":
            return edit(nwo, num, ["--add-label", trigger]);
          case "dispatchAsk":
            return edit(nwo, num, ["--add-label", trigger, "--add-label", cfg.github.askLabel]);
          case "approve":
            return edit(nwo, num, ["--add-label", ll.approved]);
          case "replan": {
            const args = ["--remove-label", ll.planReady];
            if (has(ll.approved)) args.push("--remove-label", ll.approved);
            return edit(nwo, num, args);
          }
          case "recycle": {
            const terminal = [ll.done, ll.failed, ll.denied].filter(has);
            const args = terminal.flatMap((l) => ["--remove-label", l]);
            return edit(nwo, num, args);
          }
        }
      });
    },

    validateAndPrepareRepo(nwo, path) {
      return attempt(async () => {
        const origin = await gitFn(cfg, ["-C", path, "remote", "get-url", "origin"], {
          check: false,
        });
        const actual = origin.code === 0 ? nwoFromRemoteUrl(origin.stdout.trim()) : null;
        if (actual === null || actual.toLowerCase() !== nwo.toLowerCase()) {
          throw new Error(
            origin.code !== 0
              ? `${path} is not a git clone (or has no origin)`
              : `clone origin is ${actual}, expected ${nwo}`,
          );
        }
        await ghFn(cfg, ["repo", "view", nwo, "--json", "name"], {
          timeoutMs: GH_TIMEOUT,
          retryNetwork: true,
        });
        // Ensure the trigger label exists so dispatch's --add-label can't fail
        // on a fresh repo. list+grep-free: create is idempotent enough via
        // check-first (create without --force must not clobber a custom color).
        const existing = await ghFn(
          cfg,
          [
            "label",
            "list",
            "--repo",
            nwo,
            "--search",
            trigger,
            "--json",
            "name",
            "--jq",
            ".[].name",
          ],
          { timeoutMs: GH_TIMEOUT, retryNetwork: true },
        );
        const names = existing.stdout.trim().split("\n").filter(Boolean);
        if (!names.includes(trigger)) {
          await ghFn(
            cfg,
            [
              "label",
              "create",
              trigger,
              "--repo",
              nwo,
              "--color",
              "0E8A16",
              "--description",
              "dispatch this issue to junco",
            ],
            { timeoutMs: GH_TIMEOUT, retryNetwork: true },
          );
        }
      });
    },

    openInBrowser(nwo, num) {
      return attempt(async () => {
        await ghFn(cfg, ["issue", "view", String(num), "--repo", nwo, "--web"], {
          timeoutMs: GH_TIMEOUT,
        });
      });
    },

    async health() {
      const down: HealthInfo = {
        up: false,
        uptimeSeconds: null,
        lastBridgeSweepAt: null,
        ticketsBridged: null,
      };
      if (!cfg.healthEnabled) return down;
      try {
        const resp = await fetchFn(`http://${cfg.healthHost}:${cfg.healthPort}/health`);
        if (!resp.ok) return down;
        const j = (await resp.json()) as {
          metrics?: {
            uptimeSeconds?: number;
            lastBridgeSweepAt?: string | null;
            ticketsBridged?: number;
          };
        };
        return {
          up: true,
          uptimeSeconds: j.metrics?.uptimeSeconds ?? null,
          lastBridgeSweepAt: j.metrics?.lastBridgeSweepAt ?? null,
          ticketsBridged: j.metrics?.ticketsBridged ?? null,
        };
      } catch {
        return down;
      }
    },
  };
}
```

- [ ] **Step 4: Verify pass + full suite** — `npx vitest run > /tmp/out 2>&1; echo "exit: $?"` → 0.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/tui/ghClient.ts tests/tuiGhClient.test.ts
git add -A src tests && git commit -m "feat(tui): gh-backed dashboard client — issues, plan comments, label actions, health"
```

---

### Task 6: Pure display components — RepoList, IssueTable, StatusBar, HelpOverlay

**Files:**

- Create: `src/tui/components/RepoList.tsx`, `src/tui/components/IssueTable.tsx`, `src/tui/components/StatusBar.tsx`, `src/tui/components/HelpOverlay.tsx`
- Delete: `src/tui/Smoke.tsx`, `tests/tuiSmoke.test.tsx` (superseded)
- Test: `tests/tuiComponents.test.tsx`

**Interfaces:**

- Consumes: `DashIssue`, `IssueLifecycle`, `deriveState`, `stateMeta` (Task 4); `HealthInfo` (Task 5).
- Produces (Task 8 composes):

```ts
export interface RepoRow {
  nwo: string;
  fromConfig: boolean;
  counts: Partial<Record<IssueLifecycle, number>>;
}
// <RepoList repos={RepoRow[]} selected={number} focused={boolean} />
// <IssueTable issues={DashIssue[]} trigger={string} selected={number} focused={boolean} />
// <StatusBar health={HealthInfo | null} toast={string | null} hints={string} />
// <HelpOverlay trigger={string} />
```

- [ ] **Step 1: Failing tests.** Create `tests/tuiComponents.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { RepoList } from "../src/tui/components/RepoList.js";
import { IssueTable } from "../src/tui/components/IssueTable.js";
import { StatusBar } from "../src/tui/components/StatusBar.js";
import { HelpOverlay } from "../src/tui/components/HelpOverlay.js";

describe("RepoList", () => {
  it("marks the selected repo, config entries, and per-state counts", () => {
    const { lastFrame } = render(
      <RepoList
        repos={[
          { nwo: "acme/api", fromConfig: true, counts: { "plan-ready": 2, working: 1 } },
          { nwo: "alx/coral", fromConfig: false, counts: {} },
        ]}
        selected={1}
        focused={true}
      />,
    );
    const f = lastFrame()!;
    expect(f).toContain("acme/api");
    expect(f).toContain("(cfg)"); // config entries are read-only
    expect(f).toContain("2●"); // plan-ready count
    expect(f).toContain("▸ alx/coral"); // selection cursor
  });
});

describe("IssueTable", () => {
  const issues = [
    {
      number: 42,
      title: "Add rate limiting",
      labels: ["junco", "junco:plan-ready"],
      updatedAt: "2026-07-06T10:00:00Z",
      url: "https://github.com/acme/api/issues/42",
    },
  ];

  it("renders number, title, badge, and glyph", () => {
    const { lastFrame } = render(
      <IssueTable issues={issues} trigger="junco" selected={0} focused={true} />,
    );
    const f = lastFrame()!;
    expect(f).toContain("#42");
    expect(f).toContain("Add rate limiting");
    expect(f).toContain("plan-ready");
    expect(f).toContain("●");
  });

  it("empty repo shows an empty-state hint", () => {
    const { lastFrame } = render(
      <IssueTable issues={[]} trigger="junco" selected={0} focused={true} />,
    );
    expect(lastFrame()).toContain("no open issues");
  });
});

describe("StatusBar", () => {
  it("renders daemon-up state and toast", () => {
    const { lastFrame } = render(
      <StatusBar
        health={{ up: true, uptimeSeconds: 7200, lastBridgeSweepAt: null, ticketsBridged: 2 }}
        toast="dispatched #42"
        hints="d dispatch · ? help"
      />,
    );
    const f = lastFrame()!;
    expect(f).toContain("daemon ●");
    expect(f).toContain("dispatched #42");
    expect(f).toContain("? help");
  });

  it("renders daemon-down state", () => {
    const { lastFrame } = render(
      <StatusBar
        health={{ up: false, uptimeSeconds: null, lastBridgeSweepAt: null, ticketsBridged: null }}
        toast={null}
        hints=""
      />,
    );
    expect(lastFrame()).toContain("daemon ○ not running");
  });
});

describe("HelpOverlay", () => {
  it("documents every key with the configured trigger", () => {
    const { lastFrame } = render(<HelpOverlay trigger="junco" />);
    const f = lastFrame()!;
    for (const k of [
      "dispatch",
      "approve",
      "re-plan",
      "re-cycle",
      "add repo",
      "browser",
      "refresh",
      "quit",
    ]) {
      expect(f.toLowerCase()).toContain(k);
    }
  });
});
```

- [ ] **Step 2: Verify failure** — `npx vitest run tests/tuiComponents.test.tsx > /tmp/out 2>&1; echo "exit: $?"` → FAIL.

- [ ] **Step 3: Implement the four components.**

`src/tui/components/RepoList.tsx`:

```tsx
import React from "react";
import { Box, Text } from "ink";
import type { IssueLifecycle } from "../state.js";
import { stateMeta } from "../state.js";

export interface RepoRow {
  nwo: string;
  fromConfig: boolean;
  counts: Partial<Record<IssueLifecycle, number>>;
}

const COUNT_ORDER: IssueLifecycle[] = ["plan-ready", "working", "failed"];

export function RepoList({
  repos,
  selected,
  focused,
}: {
  repos: RepoRow[];
  selected: number;
  focused: boolean;
}): React.JSX.Element {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderDimColor={!focused}
      paddingX={1}
      minWidth={24}
    >
      <Text bold dimColor={!focused}>
        repos
      </Text>
      {repos.length === 0 && <Text dimColor>none watched — press A</Text>}
      {repos.map((r, i) => {
        const badges = COUNT_ORDER.filter((s) => (r.counts[s] ?? 0) > 0)
          .map((s) => `${r.counts[s]}${stateMeta(s).glyph}`)
          .join(" ");
        return (
          <Text key={r.nwo} color={i === selected ? "cyan" : undefined} wrap="truncate">
            {i === selected ? "▸ " : "  "}
            {r.nwo}
            {r.fromConfig ? " (cfg)" : ""}
            {badges ? `  ${badges}` : ""}
          </Text>
        );
      })}
    </Box>
  );
}
```

`src/tui/components/IssueTable.tsx`:

```tsx
import React from "react";
import { Box, Text } from "ink";
import type { DashIssue } from "../state.js";
import { deriveState, stateMeta } from "../state.js";

function relTime(iso: string): string {
  const ms = Date.now() - (Date.parse(iso) || Date.now());
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function IssueTable({
  issues,
  trigger,
  selected,
  focused,
}: {
  issues: DashIssue[];
  trigger: string;
  selected: number;
  focused: boolean;
}): React.JSX.Element {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderDimColor={!focused}
      paddingX={1}
      flexGrow={1}
    >
      <Text bold dimColor={!focused}>
        issues
      </Text>
      {issues.length === 0 && <Text dimColor>no open issues</Text>}
      {issues.map((iss, i) => {
        const st = deriveState(iss.labels, trigger);
        const meta = stateMeta(st);
        return (
          <Box key={iss.number} gap={1}>
            <Text color={meta.color}>{meta.glyph}</Text>
            <Text color={i === selected ? "cyan" : undefined} wrap="truncate">
              #{iss.number} {iss.title}
            </Text>
            <Box flexGrow={1} />
            <Text color={meta.color}>{meta.badge}</Text>
            <Text dimColor>{relTime(iss.updatedAt)}</Text>
          </Box>
        );
      })}
    </Box>
  );
}
```

`src/tui/components/StatusBar.tsx`:

```tsx
import React from "react";
import { Box, Text } from "ink";
import type { HealthInfo } from "../ghClient.js";

function fmtUp(s: number | null): string {
  if (s === null) return "";
  if (s < 3600) return ` up ${Math.floor(s / 60)}m`;
  return ` up ${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

export function StatusBar({
  health,
  toast,
  hints,
}: {
  health: HealthInfo | null;
  toast: string | null;
  hints: string;
}): React.JSX.Element {
  const daemon =
    health === null
      ? "daemon …"
      : health.up
        ? `daemon ●${fmtUp(health.uptimeSeconds)}${health.ticketsBridged !== null ? ` · ${health.ticketsBridged} bridged` : ""}`
        : "daemon ○ not running";
  return (
    <Box borderStyle="round" paddingX={1} gap={2}>
      <Text color={health?.up ? "green" : "yellow"}>{daemon}</Text>
      {toast && <Text color="magenta">{toast}</Text>}
      <Box flexGrow={1} />
      <Text dimColor>{hints}</Text>
    </Box>
  );
}
```

`src/tui/components/HelpOverlay.tsx`:

```tsx
import React from "react";
import { Box, Text } from "ink";

export function HelpOverlay({ trigger }: { trigger: string }): React.JSX.Element {
  const rows: [string, string][] = [
    ["j/k", "move selection"],
    ["tab · h/l", "switch panes"],
    ["enter", "issue detail (body + plan)"],
    ["d", `dispatch (adds \`${trigger}\`)`],
    ["D", "dispatch as ask (read-only Q&A)"],
    ["a", "approve the posted plan"],
    ["R", "re-plan / re-cycle (by state)"],
    ["o", "open in browser"],
    ["A", "add repo to watchlist"],
    ["x", "unwatch repo"],
    ["r", "refresh now"],
    ["q", "quit"],
  ];
  return (
    <Box flexDirection="column" borderStyle="double" paddingX={2} paddingY={1}>
      <Text bold>junco dashboard — keys</Text>
      {rows.map(([k, d]) => (
        <Box key={k} gap={2}>
          <Box minWidth={10}>
            <Text color="cyan">{k}</Text>
          </Box>
          <Text>{d}</Text>
        </Box>
      ))}
      <Text dimColor>press any key to close</Text>
    </Box>
  );
}
```

Delete `src/tui/Smoke.tsx` and `tests/tuiSmoke.test.tsx`.

- [ ] **Step 4: Verify pass + full suite** — `npx vitest run > /tmp/out 2>&1; echo "exit: $?"` → 0.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/tui/components tests/tuiComponents.test.tsx
git add -A src tests && git commit -m "feat(tui): pure display components — repo list, issue table, status bar, help"
```

---

### Task 7: Interactive components — IssueDetail + AddRepoForm

**Files:**

- Create: `src/tui/components/IssueDetail.tsx`, `src/tui/components/AddRepoForm.tsx`, `src/tui/components/TextField.tsx`
- Test: `tests/tuiInteractive.test.tsx`

**Interfaces:**

- Consumes: Task 4 types.
- Produces (Task 8 composes):

```ts
// <IssueDetail issue={DashIssue} body={string|null} planComment={string|null} loading={boolean} scroll={number} />
// <AddRepoForm error={string|null} busy={boolean} onSubmit={(nwo, path) => void} onCancel={() => void} />
// TextField: minimal hand-rolled single-line input (value/onChange/onSubmit/focus) built on useInput.
```

- [ ] **Step 1: Failing tests.** Create `tests/tuiInteractive.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { IssueDetail } from "../src/tui/components/IssueDetail.js";
import { AddRepoForm } from "../src/tui/components/AddRepoForm.js";

const issue = {
  number: 42,
  title: "Add rate limiting",
  labels: ["junco", "junco:plan-ready"],
  updatedAt: "2026-07-06T10:00:00Z",
  url: "https://github.com/acme/api/issues/42",
};

describe("IssueDetail", () => {
  it("shows body and the plan comment when present", () => {
    const { lastFrame } = render(
      <IssueDetail
        issue={issue}
        trigger="junco"
        body={"Uploads hammer the API."}
        planComment={"<!-- junco:plan -->\nProposed plan…"}
        loading={false}
        scroll={0}
      />,
    );
    const f = lastFrame()!;
    expect(f).toContain("#42 Add rate limiting");
    expect(f).toContain("Uploads hammer the API.");
    expect(f).toContain("Proposed plan…");
  });

  it("shows loading and no-plan states", () => {
    const l = render(
      <IssueDetail
        issue={issue}
        trigger="junco"
        body={null}
        planComment={null}
        loading={true}
        scroll={0}
      />,
    );
    expect(l.lastFrame()).toContain("loading");
    const n = render(
      <IssueDetail
        issue={issue}
        trigger="junco"
        body={"b"}
        planComment={null}
        loading={false}
        scroll={0}
      />,
    );
    expect(n.lastFrame()).toContain("no plan posted yet");
  });
});

describe("AddRepoForm", () => {
  it("captures nwo + path across enter presses and submits", async () => {
    let submitted: [string, string] | null = null;
    const { stdin, lastFrame } = render(
      <AddRepoForm
        error={null}
        busy={false}
        onSubmit={(nwo, path) => {
          submitted = [nwo, path];
        }}
        onCancel={() => {}}
      />,
    );
    await new Promise((r) => setTimeout(r, 10));
    stdin.write("acme/api");
    await new Promise((r) => setTimeout(r, 10));
    stdin.write("\r"); // → path field
    stdin.write("/c/api");
    await new Promise((r) => setTimeout(r, 10));
    stdin.write("\r"); // submit
    await new Promise((r) => setTimeout(r, 10));
    expect(submitted).toEqual(["acme/api", "/c/api"]);
    expect(lastFrame()).toContain("add repo");
  });

  it("renders a validation error and busy state", () => {
    const e = render(
      <AddRepoForm
        error="clone origin is other/thing"
        busy={false}
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(e.lastFrame()).toContain("origin");
    const b = render(
      <AddRepoForm error={null} busy={true} onSubmit={() => {}} onCancel={() => {}} />,
    );
    expect(b.lastFrame()).toContain("validating");
  });
});
```

- [ ] **Step 2: Verify failure** — `npx vitest run tests/tuiInteractive.test.tsx > /tmp/out 2>&1; echo "exit: $?"` → FAIL.

- [ ] **Step 3: Implement.**

`src/tui/components/TextField.tsx` (hand-rolled — keeps the dep tree at ink+react):

```tsx
import React from "react";
import { Text, useInput } from "ink";

/** Minimal single-line input: printable chars append, backspace deletes,
 * enter submits. Only listens while `focus` is true. */
export function TextField({
  value,
  onChange,
  onSubmit,
  focus,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  focus: boolean;
  placeholder: string;
}): React.JSX.Element {
  useInput(
    (input, key) => {
      if (key.return) return onSubmit();
      if (key.backspace || key.delete) return onChange(value.slice(0, -1));
      if (input && !key.ctrl && !key.meta && !key.escape) onChange(value + input);
    },
    { isActive: focus },
  );
  return value === "" ? (
    <Text dimColor>{placeholder}</Text>
  ) : (
    <Text>{value + (focus ? "▏" : "")}</Text>
  );
}
```

`src/tui/components/IssueDetail.tsx`:

```tsx
import React from "react";
import { Box, Text } from "ink";
import type { DashIssue } from "../state.js";
import { deriveState, stateMeta } from "../state.js";

const VISIBLE_LINES = 24;

export function IssueDetail({
  issue,
  trigger,
  body,
  planComment,
  loading,
  scroll,
}: {
  issue: DashIssue;
  trigger: string;
  body: string | null;
  planComment: string | null;
  loading: boolean;
  scroll: number;
}): React.JSX.Element {
  const st = deriveState(issue.labels, trigger);
  const lines: string[] = [];
  if (body !== null) lines.push(...body.split("\n"));
  if (planComment !== null) {
    lines.push("", "── plan comment ──", ...planComment.split("\n"));
  } else if (!loading) {
    lines.push("", "(no plan posted yet)");
  }
  const visible = lines.slice(scroll, scroll + VISIBLE_LINES);
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1} flexGrow={1}>
      <Text bold>
        #{issue.number} {issue.title}{" "}
        <Text color={stateMeta(st).color}>[{stateMeta(st).badge}]</Text>
      </Text>
      {loading && <Text dimColor>loading…</Text>}
      {visible.map((l, i) => (
        <Text key={i} wrap="truncate-end">
          {l || " "}
        </Text>
      ))}
      {lines.length > VISIBLE_LINES && (
        <Text dimColor>
          j/k scroll · {scroll + 1}-{Math.min(scroll + VISIBLE_LINES, lines.length)}/{lines.length}{" "}
          · esc back
        </Text>
      )}
    </Box>
  );
}
```

`src/tui/components/AddRepoForm.tsx`:

```tsx
import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { TextField } from "./TextField.js";

export function AddRepoForm({
  error,
  busy,
  onSubmit,
  onCancel,
}: {
  error: string | null;
  busy: boolean;
  onSubmit: (nwo: string, path: string) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const [nwo, setNwo] = useState("");
  const [path, setPath] = useState("");
  const [field, setField] = useState<"nwo" | "path">("nwo");

  useInput((_i, key) => {
    if (key.escape) onCancel();
  });

  return (
    <Box flexDirection="column" borderStyle="double" paddingX={2} paddingY={1} minWidth={50}>
      <Text bold>add repo to watchlist</Text>
      <Box gap={1}>
        <Text dimColor>owner/repo:</Text>
        <TextField
          value={nwo}
          onChange={setNwo}
          onSubmit={() => setField("path")}
          focus={!busy && field === "nwo"}
          placeholder="acme/api"
        />
      </Box>
      <Box gap={1}>
        <Text dimColor>local clone:</Text>
        <TextField
          value={path}
          onChange={setPath}
          onSubmit={() => nwo.trim() && path.trim() && onSubmit(nwo.trim(), path.trim())}
          focus={!busy && field === "path"}
          placeholder="~/code/api"
        />
      </Box>
      {busy && <Text color="cyan">validating…</Text>}
      {error && <Text color="red">{error}</Text>}
      <Text dimColor>enter next/submit · esc cancel</Text>
    </Box>
  );
}
```

- [ ] **Step 4: Verify pass + full suite** — `npx vitest run > /tmp/out 2>&1; echo "exit: $?"` → 0.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/tui/components tests/tuiInteractive.test.tsx
git add -A src tests && git commit -m "feat(tui): issue detail + add-repo form (hand-rolled text input)"
```

---

### Task 8: `src/tui/App.tsx` — composition, keys, polling, optimistic actions

**Files:**

- Create: `src/tui/App.tsx`
- Test: `tests/tuiApp.test.tsx`

**Interfaces:**

- Consumes: everything above.
- Produces (Task 9 renders):

```ts
export interface AppProps {
  client: DashboardClient;
  trigger: string;
  configRepos: GithubRepoMapping[]; // read-only entries
  watchlistFile: string; // read/write via watchlist.ts
  issuePollMs?: number; // default 30_000; tests pass large values
  healthPollMs?: number; // default 5_000
  onExit: () => void;
}
export function App(props: AppProps): React.JSX.Element;
```

Behavior contract (each item test-asserted): panes focus-cycle with `tab`; `j/k` move within the focused pane; selecting a repo loads its issues (sorted via `sortIssues`); `d`/`D`/`a`/`R` call `client.applyAction` with the derived-state-appropriate action and **optimistically update the issue's labels**, rolling back with a toast on `ok:false`; disabled actions toast the reason without a client call; `enter` fetches `issueDetail`; `A` opens AddRepoForm → `validateAndPrepareRepo` ok → `writeWatchlist` (append) + toast, error → form error; `x` removes a watchlist entry (config entries toast "defined in config.toml"); `r` refires `listIssues`; `q` calls `onExit`; `?` toggles help.

- [ ] **Step 1: Failing tests.** Create `tests/tuiApp.test.tsx` (fake client records calls; `issuePollMs: 999999` so polling never fires mid-test; every `stdin.write` followed by a short `await new Promise((r) => setTimeout(r, 20))` to let Ink flush — the suite-wide macrotask gotcha applies to Ink too):

```tsx
import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { App } from "../src/tui/App.js";
import { readWatchlist, writeWatchlist } from "../src/watchlist.js";
import type { DashboardClient, Result } from "../src/tui/ghClient.js";
import type { DashIssue } from "../src/tui/state.js";

const okv = <T,>(value: T): Result<T> => ({ ok: true, value });

function makeClient(
  issuesByRepo: Record<string, DashIssue[]>,
  opts: { failActions?: boolean } = {},
) {
  const actions: unknown[][] = [];
  const client: DashboardClient = {
    listIssues: async (nwo) => okv(issuesByRepo[nwo] ?? []),
    issueDetail: async () => okv({ body: "the body", planComment: "<!-- junco:plan -->plan!" }),
    applyAction: async (...a) => {
      actions.push(a);
      return opts.failActions ? { ok: false, error: "gh boom" } : okv(undefined);
    },
    validateAndPrepareRepo: async (_n, path) =>
      path === "/bad" ? { ok: false, error: "clone origin is other/thing" } : okv(undefined),
    openInBrowser: async () => okv(undefined),
    health: async () => ({
      up: true,
      uptimeSeconds: 60,
      lastBridgeSweepAt: null,
      ticketsBridged: 0,
    }),
  };
  return { client, actions };
}

const rawIssue: DashIssue = {
  number: 7,
  title: "Fix uploads",
  labels: ["junco"],
  updatedAt: "2026-07-06T10:00:00Z",
  url: "https://github.com/acme/api/issues/7",
};
const readyIssue: DashIssue = { ...rawIssue, number: 9, labels: ["junco", "junco:plan-ready"] };

function renderApp(client: DashboardClient, watchlistFile: string) {
  return render(
    <App
      client={client}
      trigger="junco"
      configRepos={[{ nwo: "acme/api", path: "/c/api" }]}
      watchlistFile={watchlistFile}
      issuePollMs={999999}
      healthPollMs={999999}
      onExit={() => {}}
    />,
  );
}
const tick = () => new Promise((r) => setTimeout(r, 30));

describe("App", () => {
  const wl = () => join(mkdtempSync(join(tmpdir(), "junco-app-")), "wl.json");

  it("loads and renders issues for the selected repo", async () => {
    const { client } = makeClient({ "acme/api": [rawIssue, readyIssue] });
    const r = renderApp(client, wl());
    await tick();
    expect(r.lastFrame()).toContain("#7 Fix uploads");
    expect(r.lastFrame()).toContain("plan-ready"); // sorted: #9 first, but both visible
  });

  it("dispatch on a raw issue applies the action optimistically", async () => {
    const { client, actions } = makeClient({ "acme/api": [rawIssue] });
    const r = renderApp(client, wl());
    await tick();
    r.stdin.write("\t"); // focus issues pane
    await tick();
    r.stdin.write("d");
    await tick();
    expect(actions).toEqual([["acme/api", 7, "dispatch", ["junco"]]]);
    expect(r.lastFrame()).toContain("planning"); // optimistic label applied
  });

  it("approve is refused on a raw issue with a reason toast (no client call)", async () => {
    const { client, actions } = makeClient({ "acme/api": [rawIssue] });
    const r = renderApp(client, wl());
    await tick();
    r.stdin.write("\t");
    await tick();
    r.stdin.write("a");
    await tick();
    expect(actions).toHaveLength(0);
    expect(r.lastFrame()!.toLowerCase()).toContain("not available");
  });

  it("failed action rolls back the optimistic update with a toast", async () => {
    const { client, actions } = makeClient({ "acme/api": [rawIssue] }, { failActions: true });
    const r = renderApp(client, wl());
    await tick();
    r.stdin.write("\t");
    await tick();
    r.stdin.write("d");
    await tick();
    await tick();
    expect(actions).toHaveLength(1);
    const f = r.lastFrame()!;
    expect(f).toContain("gh boom");
    expect(f).not.toContain("planning"); // rolled back
  });

  it("add-repo flow validates then persists to the watchlist", async () => {
    const { client } = makeClient({ "acme/api": [] });
    const file = wl();
    const r = renderApp(client, file);
    await tick();
    r.stdin.write("A");
    await tick();
    r.stdin.write("alx/coral");
    await tick();
    r.stdin.write("\r");
    r.stdin.write("/c/coral");
    await tick();
    r.stdin.write("\r");
    await tick();
    await tick();
    expect(readWatchlist(file).entries).toEqual([{ nwo: "alx/coral", path: "/c/coral" }]);
    expect(r.lastFrame()).toContain("alx/coral");
  });

  it("unwatch removes watchlist entries but refuses config entries", async () => {
    const { client } = makeClient({ "acme/api": [], "alx/coral": [] });
    const file = wl();
    writeWatchlist(file, [{ nwo: "alx/coral", path: "/c/coral" }]);
    const r = renderApp(client, file);
    await tick();
    r.stdin.write("x"); // selected = acme/api (config)
    await tick();
    expect(r.lastFrame()).toContain("config.toml");
    r.stdin.write("j"); // select alx/coral
    await tick();
    r.stdin.write("x");
    await tick();
    expect(readWatchlist(file).entries).toEqual([]);
  });

  it("? toggles the help overlay", async () => {
    const { client } = makeClient({ "acme/api": [] });
    const r = renderApp(client, wl());
    await tick();
    r.stdin.write("?");
    await tick();
    expect(r.lastFrame()).toContain("junco dashboard — keys");
  });
});
```

- [ ] **Step 2: Verify failure** — `npx vitest run tests/tuiApp.test.tsx > /tmp/out 2>&1; echo "exit: $?"` → FAIL.

- [ ] **Step 3: Implement `src/tui/App.tsx`.** Composition rules (write the full component; ~250 lines):

- State: `repos` (config + watchlist, recomputed from `readWatchlist` after every write), `repoIdx`, `issues: Record<nwo, DashIssue[]>`, `issueIdx`, `pane: "repos" | "issues"`, `view: "main" | "detail" | "help" | "addRepo"`, `detail: {body, planComment, loading}`, `toast: string | null`, `health`, `addRepoError/busy`, `scroll`.
- Effects: initial + per-selected-repo `listIssues` (sorted with `sortIssues`); `setInterval` polling with `issuePollMs`/`healthPollMs` (cleared on unmount).
- `useInput` router keyed by `view` then `pane`; `q` → `onExit()` (and `useApp().exit()`); `?` toggles help from main view; `esc` closes overlays.
- Optimistic mutation: `applyOptimistic(action)` computes the label delta locally (dispatch → +trigger +`<trigger>:planning`? NO — the bridge applies `planning`; optimistically add trigger AND show `planning` badge so the user sees motion: add `[trigger, `${trigger}:planning`]`; approve → +`:approved`; replan → −`:plan-ready` −`:approved`; recycle → − terminal labels), stores the previous labels, calls `client.applyAction` with the ORIGINAL labels, restores on `ok:false` + toast, else toast success.
- Add-repo: `validateAndPrepareRepo` → on ok, `writeWatchlist(file, [...existing, {nwo, path}])`, recompute repos, close form; on error set form error.
- Toast auto-clears on the next keypress (not a timer — deterministic for tests).

- [ ] **Step 4: Verify pass + full suite** — `npx vitest run > /tmp/out 2>&1; echo "exit: $?"` → 0. Ink render loops can starve like fake sleeps — if a test hangs, ensure every `stdin.write` is followed by a real `setTimeout` tick, never a microtask.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/tui/App.tsx tests/tuiApp.test.tsx
git add -A src tests && git commit -m "feat(tui): dashboard App — pane focus, key routing, optimistic label actions, watchlist editing"
```

---

### Task 9: `src/dashboardCmd.ts` + lazy CLI wiring

**Files:**

- Create: `src/dashboardCmd.ts`
- Modify: `src/cli.ts` (USAGE + `CliDeps.runDashboardFn` + `dashboard` case)
- Test: `tests/dashboardCmd.test.ts`, `tests/cli.test.ts`

**Interfaces:**

- Consumes: `makeGhDashboardClient`, `App`, `watchlistPath`, `resolveWatchedRepos`.
- Produces:

```ts
// src/dashboardCmd.ts
export interface DashboardDeps {
  isTTY?: boolean; // default process.stdout.isTTY
  renderFn?: (element: React.ReactElement) => { waitUntilExit: () => Promise<void> }; // default ink render (lazy)
  printErr?: (s: string) => void;
}
export async function runDashboard(cfg: Config, deps?: DashboardDeps): Promise<number>;
// non-TTY → printErr guidance, return 1, BEFORE any ink import; github disabled+no repos is fine (empty state)
```

- [ ] **Step 1: Failing tests.** Create `tests/dashboardCmd.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { runDashboard } from "../src/dashboardCmd.js";
import type { Config } from "../src/types.js";

const cfg = {
  stateDir: "/tmp/junco-dash-test",
  healthEnabled: false,
  github: {
    enabled: true,
    triggerLabel: "junco",
    askLabel: "junco:ask",
    pollIntervalSeconds: 60,
    repos: [],
    requireApproval: true,
    plannerModelId: null,
  },
} as unknown as Config;

describe("runDashboard", () => {
  it("non-TTY exits 1 with guidance and never renders", async () => {
    let rendered = false;
    const errs: string[] = [];
    const code = await runDashboard(cfg, {
      isTTY: false,
      renderFn: () => {
        rendered = true;
        return { waitUntilExit: async () => {} };
      },
      printErr: (s) => errs.push(s),
    });
    expect(code).toBe(1);
    expect(rendered).toBe(false);
    expect(errs.join("")).toContain("junco list");
  });

  it("TTY renders and resolves when the app exits", async () => {
    let rendered = false;
    const code = await runDashboard(cfg, {
      isTTY: true,
      renderFn: () => {
        rendered = true;
        return { waitUntilExit: async () => {} };
      },
    });
    expect(code).toBe(0);
    expect(rendered).toBe(true);
  });
});

describe("lazy loading discipline", () => {
  it("cli.ts reaches the dashboard only through a dynamic import", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
    expect(src).toContain('await import("./dashboardCmd.js")');
    expect(src).not.toMatch(/^import .* from "\.\/dashboardCmd\.js"/m);
    expect(src).not.toMatch(/from "ink"/);
  });
});
```

Append to `tests/cli.test.ts` (following its existing routing-test pattern with injected deps):

```ts
it("routes `dashboard` to runDashboardFn with the loaded config", async () => {
  let got: Config | null = null;
  const code = await run(["dashboard", "--config", "/x/config.toml"], {
    loadConfigFn: () => makeCfg(), // the file's existing full-Config helper
    runDashboardFn: async (c) => {
      got = c;
      return 0;
    },
  });
  expect(code).toBe(0);
  expect(got).not.toBeNull();
});
```

- [ ] **Step 2: Verify failure** — `npx vitest run tests/dashboardCmd.test.ts tests/cli.test.ts > /tmp/out 2>&1; echo "exit: $?"` → FAIL.

- [ ] **Step 3: Implement.** `src/dashboardCmd.ts`:

```ts
/**
 * `junco dashboard` — entry point. TTY guard runs BEFORE any Ink import so
 * non-interactive invocations never pay the React cost; the Ink app module
 * is loaded dynamically (the daemon and every other subcommand stay React-free).
 */

import type { Config } from "./types.js";
import type React from "react";

export interface DashboardDeps {
  isTTY?: boolean;
  renderFn?: (element: React.ReactElement) => { waitUntilExit: () => Promise<void> };
  printErr?: (s: string) => void;
}

export async function runDashboard(cfg: Config, deps: DashboardDeps = {}): Promise<number> {
  const isTTY = deps.isTTY ?? Boolean(process.stdout.isTTY && process.stdin.isTTY);
  const printErr = deps.printErr ?? ((s: string) => process.stderr.write(s));
  if (!isTTY) {
    printErr(
      "junco dashboard needs an interactive terminal.\n" +
        "Try `junco list`, `junco status`, or `junco logs -f` instead.\n",
    );
    return 1;
  }

  const [{ App }, { makeGhDashboardClient }, { watchlistPath }, react, ink] = await Promise.all([
    import("./tui/App.js"),
    import("./tui/ghClient.js"),
    import("./watchlist.js"),
    import("react"),
    import("ink"),
  ]);
  const renderFn =
    deps.renderFn ?? ((el: React.ReactElement) => ink.render(el, { exitOnCtrlC: true }));

  const client = makeGhDashboardClient(cfg);
  let exitRequested = false;
  const instance = renderFn(
    react.createElement(App, {
      client,
      trigger: cfg.github.triggerLabel,
      configRepos: cfg.github.repos,
      watchlistFile: watchlistPath(cfg),
      onExit: () => {
        exitRequested = true;
      },
    }),
  );
  await instance.waitUntilExit();
  void exitRequested;
  return 0;
}
```

Note for the implementer: with an injected `renderFn` the dynamic imports of `react`/`ink` still run in the TTY test — that's fine (they're installed); the guard test asserts the non-TTY path returns before them. The `onExit` handler in the real path calls `useApp().exit()` inside App; `waitUntilExit` resolves then.

`src/cli.ts`: add to `CliDeps`:

```ts
  runDashboardFn?: (cfg: Config) => Promise<number>;
```

USAGE gains (after the `logs` line):

```
  dashboard    Interactive GitHub-mode dashboard — watchlist, issues, dispatch/approve
```

Subcommand case (alongside the other cases; lazy import is the default):

```ts
if (subcommand === "dashboard") {
  const cfg = loadConfigFn(configPath);
  setLogLevel(cfg.logLevel);
  const runDashboardFn =
    deps.runDashboardFn ??
    (async (c: Config) => {
      const { runDashboard } = await import("./dashboardCmd.js");
      return runDashboard(c);
    });
  return runDashboardFn(cfg);
}
```

- [ ] **Step 4: Verify pass + full suite + build** — `npx vitest run > /tmp/out 2>&1; echo "exit: $?"` → 0; `npm run build > /tmp/out2 2>&1; echo "exit: $?"` → 0.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/dashboardCmd.ts src/cli.ts tests/dashboardCmd.test.ts tests/cli.test.ts
git add -A src tests && git commit -m "feat(cli): junco dashboard subcommand — TTY guard + lazy ink loading"
```

---

### Task 10: Doctor watchlist checks + docs

**Files:**

- Modify: `src/doctor.ts` (github block: validate watchlist entries; report the watchlist path)
- Modify: `README.md` (dashboard section under GitHub-integrated mode; CLI reference row)
- Modify: `ARCHITECTURE.md` (module map: `watchlist.ts`, `tui/*`, `dashboardCmd.ts`)
- Modify: `CHANGELOG.md` (Unreleased → Added)
- Test: `tests/doctor.test.ts`

- [ ] **Step 1: Failing test.** In `tests/doctor.test.ts` github-checks describe (reuse `githubConfig()`; doctor gains a `watchlistFile` override via the existing `loadConfigFn`-returned cfg's `stateDir`):

```ts
it("validates watchlist entries alongside config mappings", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "junco-doc-wl-"));
  writeWatchlist(join(stateDir, "github-watchlist.json"), [
    { nwo: "alx/coral", path: "/tmp/coral" },
  ]);
  const lines: string[] = [];
  const code = await runDoctor(
    "/x/config.toml",
    deps({
      loadConfigFn: () => ({ ...githubConfig([]), stateDir }) as Config,
      execFn: async (_cmd: string, args: string[]) =>
        args.includes("get-url")
          ? { code: 0, stdout: "https://github.com/alx/coral.git\n", stderr: "" }
          : { code: 0, stdout: "ok", stderr: "" },
      printFn: (s) => lines.push(s),
    }),
  );
  expect(code).toBe(0);
  expect(lines.join("")).toContain("✓ github repo alx/coral");
  expect(lines.join("")).toContain("watchlist");
});
```

(Imports for `writeWatchlist`/`mkdtempSync`/`tmpdir`/`join` added at the top of the file.)

- [ ] **Step 2: Verify failure** — `npx vitest run tests/doctor.test.ts > /tmp/out 2>&1; echo "exit: $?"` → FAIL.

- [ ] **Step 3: Implement doctor.** In `src/doctor.ts`, the github block iterates `resolveWatchedRepos(cfg)` instead of `cfg.github.repos` (import from `./watchlist.js`), keeping the per-repo origin + `gh repo view` checks identical, and after the empty-repos warn adds one informational line:

```ts
report("ok", "github watchlist", watchlistPath(cfg));
```

(The empty-repos warning condition becomes `resolveWatchedRepos(cfg).length === 0`.)

- [ ] **Step 4: Docs.** README: under GitHub-integrated mode add a **Dashboard** subsection — what `junco dashboard` shows (three-zone layout), the key table (from HelpOverlay), that actions are label mutations under your own `gh` auth (same trust model), the watchlist file location and hot-reload (no daemon restart), config-vs-watchlist precedence; add `dashboard` to the CLI reference table. ARCHITECTURE module map gains `watchlist.ts` ("dynamic watchlist; resolveWatchedRepos — config ∪ file, config wins; bridge reads per sweep"), `tui/` ("Ink dashboard: pure state derivation, gh client seam, components, App"), `dashboardCmd.ts` ("TTY guard + lazy Ink load"). CHANGELOG Unreleased → Added: one bullet for `junco dashboard` + the hot-reload watchlist. All stack-agnostic.

- [ ] **Step 5: Full gate + commit**

```bash
npm run lint && npm run format:check && npm run build && npm test > /tmp/out 2>&1; echo "exit: $?"
npx prettier --write src/doctor.ts README.md ARCHITECTURE.md CHANGELOG.md tests/doctor.test.ts
git add -A && git commit -m "feat(doctor)+docs: watchlist validation, dashboard section, module map"
```

---

### Task 11: Final gate + branch review

- [ ] **Step 1: Full gate on a clean tree** — `npm run lint && npm run format:check && npm run build && npm test > /tmp/out 2>&1; echo "exit: $?"` → 0; `git status --short` empty.

- [ ] **Step 2: Branch review** — `git log --oneline feat/github-inbox..HEAD` (~10 commits); `git log feat/github-inbox..HEAD --format=%B | grep -ci "co-authored-by\|generated with"` → 0; `git diff feat/github-inbox -- package.json` shows ONLY the four pinned additions (`ink`, `react` + two dev deps) and the two script-glob changes; `dist/tui/` present after build; no static `ink`/`react` import reachable from `src/daemon.ts` (verify: `grep -rn 'from "ink"\|from "react"' src/ | grep -v "^src/tui/\|^src/dashboardCmd"` → empty).

- [ ] **Step 3: Report** completion with the branch name. Do NOT merge, push, or release — the release HOLD applies; `feat/dashboard` stacks on `feat/github-inbox` (PR #1), so the merge order is PR #1 first.
