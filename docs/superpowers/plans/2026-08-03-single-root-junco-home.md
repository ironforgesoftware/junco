# Single-Root `~/.junco/` Home — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After an npm install, every asset junco writes lives under one root — `~/.junco/` — instead of today's three (`~/.junco/config.json` after the config plan, the data tree at `~/.local/state/junco/`, bot gh credentials at `~/.config/junco/gh`).

**Architecture:** The `dataDir` default moves to `~/.junco` with a **layout switch**: the tree is restructured into user-content-at-root (`queue/`, `review/`, `watchlist.json`) + `data/` (unrecoverable machine state) + `cache/` (regenerable — safe to `rm -rf`) + `logs/`. A `dataLayout: "flat" | "v2"` field on `Config`, derived by probing the resolved root, keeps pre-existing flat trees working untouched (never silently relocate live data): upgraded installs keep using their legacy root/shape with a deprecation nag until the operator runs `junco data migrate`, which does one journaled move+restructure. Fresh installs materialize the v2 shape at `~/.junco` immediately. The bot gh config default moves to `~/.junco/gh` with the same probe-fallback pattern.

**Tech Stack:** TypeScript (Node ≥ 22.19, ESM/NodeNext, strict), vitest, no new dependencies.

**Depends on:** `docs/superpowers/plans/2026-08-02-config-resolution-env-only.md` (plan 1) being implemented first on the same branch — this plan consumes `juncoHome(env)` from `src/config.ts` and assumes config already resolves to `~/.junco/config.json`. Both plans ship in the same release (0.10.0) so a fresh install is single-root on day one.

**Maintainer decisions (settled 2026-08-03, do not re-litigate):** move + restructure in ONE migration; legacy installs transition via fallback + explicit `junco data migrate` (never auto-migrate at startup); taxonomy per the maintainer's tree (queue/review/watchlist at root; data/cache/logs split; `rm -rf ~/.junco/cache` must always be safe).

## Target layout (v2)

```
~/.junco/
  config.json      worker.lock      migrate.lock     .gitignore    migrated.json
  queue/{inbox,processing,done,failed}
  review/{assess,comments}         # + filed/, posted/, discarded/ archives
  watchlist.json
  gh/                              # bot-account gh config (GH_CONFIG_DIR)
  data/
    outbox/{,dead}                 # un-pushed GitHub ops — real data
    assess-history/  history/  transcripts/
    spend.json                     # billing accounting — not regenerable
    metrics.json                   # declared; still writer-less
  cache/                           # ENTIRELY regenerable — rm -rf safe
    clones/{watched,external}   worktrees/   github-cache/   mirror/
    update-check.json
  logs/
    worker.log                     # + launchd.out / launchd.err via service logDir
```

Classification rule used throughout: regenerable from origin/GitHub/npm → `cache/`; reflects local state that cannot be recomputed → `data/` or root. `mirror/` is a mirror OF GitHub → cache. `outbox/` is un-pushed writes → data. When unsure, `data/` (misclassifying into `data/` wastes bytes; into `cache/` loses data).

## Global Constraints

- All of plan 1's Global Constraints apply verbatim (no release actions, no version bump, no AI attribution, exit-code capture, prettier re-reads, react-hooks at error, live-runtime untouched by the PR).
- **Never silently relocate live data.** No code path may move, rename, or delete an existing tree outside `junco data migrate`. A resolved-but-unmigrated install must behave byte-identically to 0.9 (legacy root, flat layout, legacy gh dir).
- **New `Config` fields go in `tests/helpers/config.ts` and nowhere else.** This plan adds `dataLayout` and `legacy.dataRoot`/`legacy.ghConfigDir` — ballast values (`"v2"`, `false`, `false`), NOT seams (only migration tests override them, via `overrides`).
- **No new `ConfigSchema` leaves** — only two zod defaults change (`dataDir` stays optional-with-assembly-default; `botAccount.configDir` default string changes). The `configLevers.test.ts` bijection is therefore untouched except the `botAccount.configDir` lever's `default` literal, which must change in lockstep with the schema (`tests/configLevers.test.ts:130-137` asserts it).
- Sandbox invariant (`src/agent/sandbox/backend.ts:42-53`): the deny list must never contain an ancestor of a writable root. `cache/` holds the agent's cwd (`cache/worktrees`) and clone gitdirs (`cache/clones`), so `cache/` and the `~/.junco` root itself are NEVER denied — deny entries stay enumerated per-subtree.
- Sandbox tests use synthetic `/sbxroot/...` paths (canonicalize() realpaths real ones — macOS `/tmp`→`/private` trap).
- Scheduler/daemon tests: yield a real tick (`await new Promise((r) => setTimeout(r, 1))`) — instant-resolve fake sleeps starve the macrotask queue.

## File Structure

| File | Responsibility after this plan |
| --- | --- |
| `src/dataTree.ts` | Single source of truth for BOTH layouts: `dataTreePaths(cfg)` switches on `cfg.dataLayout`; gains `githubCache`, `logsDir`; `sandboxDenyPaths` gains the config-file deny |
| `src/config.ts` | `homeOf(env)` helper; dataDir default `~/.junco` + legacy-root fallback probe; `layoutOf`; `dataLayout` + `legacy.dataRoot`/`legacy.ghConfigDir` derivation; gh configDir fallback; deprecation lines |
| `src/dataMigrate.ts` | `flatToV2Pairs(fromRoot, toRoot)` mapping (identity pairs skipped for in-place) |
| `src/dataMigrateCmd.ts` | Root move + in-place restructure + gh-creds move phases; target-root aware (canonical, not `cfg.dataDir`, when legacy); `DEFAULT_DATA_DIR` → `~/.junco` |
| `src/slug.ts`, `src/spendLedger.ts`, `src/tui/ghClient.ts`, `src/cli.ts`, `src/logsCmd.ts`, `src/dashboardCmd.ts`, store modules | All path construction routed through `dataTreePaths()` (Task 1 refactor) |
| `src/ghAuth.ts`, `src/configLevers.ts` | Bot gh dir default `~/.junco/gh` |
| `src/wizard/flow.ts`, `src/tui/wizard/chapters/Workspace.tsx` | Wizard default/placeholder `~/.junco` |
| `src/service.ts` | `logDir` default `<home>/.junco/logs` |
| `scripts/package-smoke.sh` | Asserts single-root containment (no `.local/state/junco`, no `.config/junco`) |

---

### Task 1: Route every path straggler through `dataTreePaths()` (pure refactor, zero behavior change)

Today ~15 modules re-derive paths from `cfg.dataDir` + literals/constants. The layout flip (Task 2) must change paths in exactly ONE place, so first make `dataTreePaths()` the only join site. Every path value is identical before/after this task — the suite proves it by staying green with no expectation changes.

**Files:**
- Modify: `src/dataTree.ts` (add `githubCache` + `logsDir` to `DataTreePaths` + `dataTreePaths`; use them in `sandboxDenyPaths` — replacing the hardcoded `join(p.root, "github-cache")` at line 94)
- Modify: `src/slug.ts:34-35` (`transcriptPathFor` takes the transcripts DIR, not the data root), callers `src/runOnce.ts:423`, `src/assessFlow.ts:293`, `src/prFlow.ts:485`, `src/analyzeFlow.ts:223`
- Modify: `src/cli.ts:281-282` (worker.log via `dataTreePaths(cfg).logFile`, mkdir its `dirname`), `src/logsCmd.ts:43`, `src/dashboardCmd.ts:110-112`, `src/spendLedger.ts:49-55` (+ call sites `src/daemon.ts:520`, `src/dataCmd.ts:228`), `src/tui/ghClient.ts:40-51`, `src/watchlist.ts:23-25`, `src/taskHistory.ts:41`, `src/githubOutbox.ts:96-99`, `src/updateCheck.ts:97`, `src/reviewStore.ts:64-66` + its three constructors (`src/assessReview.ts:41`, `src/commentReview.ts:33`, `src/assessHistory.ts:53`), `src/tui/localSnapshot.ts:143`
- Test: `tests/localSnapshotRepos.test.ts:63,142`, `tests/localSnapshotCheap.test.ts:88` (swap constant-joins for `dataTreePaths`), plus one new equivalence test in `tests/dataTree.test.ts`

**Interfaces:**
- Consumes: existing `dataTreePaths(cfg)`.
- Produces: `DataTreePaths` gains `githubCache: string` (= `join(r, "github-cache")` for now) and `logsDir: string` (= `r` for now — worker.log stays at the root until Task 2). `transcriptPathFor(transcriptsDir: string, id: string): string` (callers pass `dataTreePaths(cfg).transcripts`). `makeSpendLedger` takes the spend FILE path (`dataTreePaths(cfg).spendFile`) instead of a state dir. `makeReviewStore` takes an absolute dir (callers pass `dataTreePaths(cfg).reviewAssess` / `.reviewComments` / `.assessHistory`) instead of `(cfg, subdir)` joining internally — adapt to its actual current signature when editing.

- [ ] **Step 1: Write the failing equivalence test**

Add to `tests/dataTree.test.ts`:

```ts
it("exposes githubCache and logsDir (flat: logs at the root)", () => {
  const cfg = makeConfig({ ...seams, dataDir: "/sbxroot/state" });
  const p = dataTreePaths(cfg);
  expect(p.githubCache).toBe("/sbxroot/state/github-cache");
  expect(p.logsDir).toBe("/sbxroot/state");
  expect(p.logFile).toBe(join(p.logsDir, "worker.log"));
});
```

(Adapt `seams` spelling to the file's existing `makeConfig` usage.)

- [ ] **Step 2: Run to verify it fails** — `npx vitest run tests/dataTree.test.ts > /tmp/s1a 2>&1; echo "exit: $?"` (missing fields).

- [ ] **Step 3: Implement the two new fields, then sweep the stragglers**

`src/dataTree.ts` — in `DataTreePaths` add `githubCache: string;` and `logsDir: string;`; in `dataTreePaths()` add `githubCache: join(r, "github-cache")`, `logsDir: r`, and change `logFile` to `join(r, "worker.log")` → keep identical value but derive as `join()` off `r` (no change needed — it already is). In `sandboxDenyPaths` replace `join(p.root, "github-cache")` with `p.githubCache`.

Then convert each straggler to consume `dataTreePaths(cfg)` (or a threaded path) instead of joining `cfg.dataDir` itself. Every conversion preserves the exact same string today. Representative shapes:

```ts
// src/slug.ts — BEFORE: transcriptPathFor(stateDir, id) joins "transcripts" itself
export function transcriptPathFor(transcriptsDir: string, id: string): string {
  return join(transcriptsDir, `${slugifyId(id)}.jsonl`);
}
// callers: transcriptPathFor(dataTreePaths(cfg).transcripts, ticket.id)
```

```ts
// src/cli.ts:281-282 (setupLogOutputs) — BEFORE joins cfg.dataDir directly
const logPath = dataTreePaths(cfg).logFile;
mkdirSync(dirname(logPath), { recursive: true });
```

`src/tui/ghClient.ts:40-51`: both cache-path helpers derive from `dataTreePaths(cfg).githubCache`. `src/spendLedger.ts`: the factory takes the file path; `src/daemon.ts:520` and `src/dataCmd.ts:228` pass `dataTreePaths(cfg).spendFile`. `src/watchlist.ts:24`, `src/taskHistory.ts:41`, `src/githubOutbox.ts:97`, `src/updateCheck.ts:97`, `src/dashboardCmd.ts:110-112`, `src/tui/localSnapshot.ts:143` likewise read their path off `dataTreePaths(cfg)`. `src/reviewStore.ts` receives the absolute dir from its three constructors. Where a module previously imported a `*_SUBDIR` constant only for this join, drop the import; the constants remain exported (Task 6's flat-side mapping and existing tests still use them).

- [ ] **Step 4: Full suite green with NO expectation changes** (that is the proof of behavior preservation): `npx vitest run > /tmp/s1b 2>&1; echo "exit: $?"` — the only test-file edits allowed are the two localSnapshot constant-join swaps and the new dataTree test. Also `npx tsc --noEmit -p tsconfig.eslint.json` — no NEW errors.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src tests
git add -A src tests
git commit -m "refactor(data): route all data-tree path construction through dataTreePaths

No path value changes — this makes dataTreePaths the single join site so the
upcoming layout switch happens in exactly one place."
```

---

### Task 2: The layout flip — dataDir default `~/.junco`, legacy-root fallback, `dataLayout` switch

**Files:**
- Modify: `src/config.ts` (`homeOf` helper next to `juncoHome`; `layoutOf`; `dataRootHasTree`; `assembleConfig` at lines 353-366 + 427 + 454; `configDeprecations` at 509; `assembleConfig` gains a `deps` param)
- Modify: `src/types.ts` (`Config` gains `dataLayout: "flat" | "v2"`; `legacy` gains `dataRoot: boolean`)
- Modify: `src/dataTree.ts` (layout-switching subpath table; `ensureDataTree` materializes v2)
- Modify: `src/configWatcher.ts` + any `assembleConfig` caller (thread the optional deps; default keeps `existsSync`)
- Modify: `tests/helpers/config.ts` (ballast: `dataLayout: "v2"`, `legacy: { …, dataRoot: false }`)
- Test: `tests/config.test.ts` (defaults at 287, 385, 697, 700 + new fallback/layout tests), `tests/dataTree.test.ts` (v2 paths, flat paths, v2 ensure)

**Interfaces:**
- Consumes: `juncoHome(env)` (plan 1), Task 1's single-join-site guarantee.
- Produces:
  - `homeOf(env?): string` — `env.HOME` (trimmed, non-empty) else `os.homedir()`; `juncoHome` refactors onto it.
  - `layoutOf(root: string, existsFn?: (p: string) => boolean): "flat" | "v2"`
  - `dataRootHasTree(root: string, existsFn?): boolean`
  - `Config.dataLayout: "flat" | "v2"`, `Config.legacy.dataRoot: boolean`
  - `assembleConfig(d, env?, deps?: { existsFn?: (p: string) => boolean })` — additive третий param
  - `dataTreePaths(cfg)` values under v2: see the target-layout tree (e.g. `outbox` → `<r>/data/outbox`, `clonesWatched` → `<r>/cache/clones/watched`, `logsDir` → `<r>/logs`, `logFile` → `<r>/logs/worker.log`, `updateCheckFile` → `<r>/cache/update-check.json`, `spendFile` → `<r>/data/spend.json`; `queue`/`review*`/`watchlistFile`/`migratedFile` unchanged relative to root)
  - Default `worktreeRoot` = `<dataDir>/cache/worktrees` (v2) / `<dataDir>/worktrees` (flat); default `externalReposRoot` = `<dataDir>/cache/clones/external` (v2) / `<dataDir>/clones/external` (flat)

- [ ] **Step 1: Write the failing tests**

`tests/config.test.ts` (new block; place near the existing default-derivation tests around line 287):

```ts
describe("dataDir default + legacy-root fallback (single-root ~/.junco)", () => {
  const env = { HOME: "/h" };

  it("defaults dataDir to ~/.junco with a v2 layout on a fresh machine", () => {
    const cfg = assembleConfig(parseConfigObject({}), env, { existsFn: () => false });
    expect(cfg.dataDir).toBe("/h/.junco");
    expect(cfg.dataLayout).toBe("v2");
    expect(cfg.legacy.dataRoot).toBe(false);
    expect(cfg.queueRoot).toBe("/h/.junco/queue");
    expect(cfg.worktreeRoot).toBe("/h/.junco/cache/worktrees");
  });

  it("falls back to ~/.local/state/junco while it exists and ~/.junco has no tree", () => {
    const existsFn = (p: string) => p === "/h/.local/state/junco" || p.endsWith("/transcripts");
    const cfg = assembleConfig(parseConfigObject({}), env, { existsFn });
    expect(cfg.dataDir).toBe("/h/.local/state/junco");
    expect(cfg.dataLayout).toBe("flat");
    expect(cfg.legacy.dataRoot).toBe(true);
    expect(cfg.worktreeRoot).toBe("/h/.local/state/junco/worktrees");
  });

  it("prefers ~/.junco once it holds a tree, even while the legacy root lingers", () => {
    const existsFn = (p: string) =>
      p === "/h/.junco/queue" || p === "/h/.junco/data" || p === "/h/.local/state/junco";
    const cfg = assembleConfig(parseConfigObject({}), env, { existsFn });
    expect(cfg.dataDir).toBe("/h/.junco");
    expect(cfg.dataLayout).toBe("v2");
    expect(cfg.legacy.dataRoot).toBe(false);
  });

  it("an explicit dataDir is honored with its detected layout, no fallback probing", () => {
    const existsFn = (p: string) => p === "/custom/history"; // flat marker
    const cfg = assembleConfig(parseConfigObject({ dataDir: "/custom" }), env, { existsFn });
    expect(cfg.dataDir).toBe("/custom");
    expect(cfg.dataLayout).toBe("flat");
    expect(cfg.legacy.dataRoot).toBe(false);
  });
});
```

(`parseConfigObject` — use whatever helper the file already uses to produce `ConfigParsed` from a raw object; grep its existing assembleConfig tests at line ~287.)

`tests/dataTree.test.ts`:

```ts
it("v2 layout: data/cache/logs subtrees", () => {
  const cfg = makeConfig({ ...seams, dataDir: "/sbxroot/home/.junco" }, { dataLayout: "v2" });
  const p = dataTreePaths(cfg);
  expect(p.outbox).toBe("/sbxroot/home/.junco/data/outbox");
  expect(p.transcripts).toBe("/sbxroot/home/.junco/data/transcripts");
  expect(p.spendFile).toBe("/sbxroot/home/.junco/data/spend.json");
  expect(p.clonesWatched).toBe("/sbxroot/home/.junco/cache/clones/watched");
  expect(p.githubCache).toBe("/sbxroot/home/.junco/cache/github-cache");
  expect(p.updateCheckFile).toBe("/sbxroot/home/.junco/cache/update-check.json");
  expect(p.mirror).toBe("/sbxroot/home/.junco/cache/mirror");
  expect(p.logFile).toBe("/sbxroot/home/.junco/logs/worker.log");
  expect(p.queue.inbox).toBe("/sbxroot/home/.junco/queue/inbox"); // unchanged at root
  expect(p.watchlistFile).toBe("/sbxroot/home/.junco/watchlist.json");
});

it("flat layout keeps every 0.9 path byte-identical", () => {
  const cfg = makeConfig({ ...seams, dataDir: "/sbxroot/state" }, { dataLayout: "flat" });
  const p = dataTreePaths(cfg);
  expect(p.outbox).toBe("/sbxroot/state/outbox");
  expect(p.logFile).toBe("/sbxroot/state/worker.log");
  expect(p.updateCheckFile).toBe("/sbxroot/state/update-check.json");
});
```

Plus a `layoutOf` unit block: `data/` or `cache/` present → `"v2"`; any of `transcripts|history|clones|worktrees|assess-history|github-cache` present → `"flat"`; nothing → `"v2"`; `queue`/`review`/`watchlist.json` are NOT markers (identical in both layouts).

- [ ] **Step 2: Run to verify failures** — `npx vitest run tests/config.test.ts tests/dataTree.test.ts > /tmp/s2a 2>&1; echo "exit: $?"`.

- [ ] **Step 3: Implement**

`src/config.ts` — extract the HOME logic plan 1 put inside `juncoHome` into a shared helper and add the probes:

```ts
/** env.HOME (tests/sandboxes) wins over os.homedir(). */
export function homeOf(env: Record<string, string | undefined> = process.env): string {
  return env.HOME && env.HOME.trim() !== "" ? env.HOME : homedir();
}

export function juncoHome(env: Record<string, string | undefined> = process.env): string {
  return join(homeOf(env), ".junco");
}

/** True when `root` holds a junco data tree (either layout). config.json/gh
 * alone do NOT count — the config plan puts those at ~/.junco before any
 * data lives there. */
export function dataRootHasTree(
  root: string,
  existsFn: (p: string) => boolean = existsSync,
): boolean {
  return ["queue", "data", "cache", "transcripts", "history"].some((m) =>
    existsFn(join(root, m)),
  );
}

/** Which internal shape an existing tree uses. Fresh (marker-less) roots get
 * the final shape. queue/review/watchlist sit at the root in BOTH layouts and
 * are deliberately not markers. */
export function layoutOf(
  root: string,
  existsFn: (p: string) => boolean = existsSync,
): "flat" | "v2" {
  if (existsFn(join(root, "data")) || existsFn(join(root, "cache"))) return "v2";
  const flatMarkers = [
    "transcripts",
    "history",
    "clones",
    "worktrees",
    "assess-history",
    "github-cache",
  ];
  if (flatMarkers.some((m) => existsFn(join(root, m)))) return "flat";
  return "v2";
}
```

`assembleConfig` — new signature `assembleConfig(d, env = process.env, deps: { existsFn?: (p: string) => boolean } = {})`, and the data-root section (currently lines 365-366) becomes:

```ts
const existsFn = deps.existsFn ?? existsSync;
// Single-root ~/.junco: explicit dataDir/stateDir always wins, probe-free.
// A defaulted root prefers ~/.junco, but while ~/.junco holds no data tree
// and the pre-0.10 root exists, keep using the legacy root UNTOUCHED —
// `junco data migrate` is the only thing that relocates live data.
const explicitRoot = nStateDir ?? d.dataDir;
let dataDir: string;
let legacyDataRoot = false;
if (explicitRoot !== undefined) {
  dataDir = expandHome(explicitRoot);
} else {
  const canonical = juncoHome(env);
  const legacyRoot = join(homeOf(env), ".local", "state", "junco");
  if (!dataRootHasTree(canonical, existsFn) && existsFn(legacyRoot)) {
    dataDir = legacyRoot;
    legacyDataRoot = true;
  } else {
    dataDir = canonical;
  }
}
const dataLayout = layoutOf(dataDir, existsFn);
const queueRoot = nVault ? join(expandHome(nVault), d.juncoSubdir) : join(dataDir, "queue");
const legacy = {
  vaultRoot: nVault !== undefined,
  stateDir: nStateDir !== undefined,
  worktreeRoot: nWorktree !== undefined,
  externalReposRoot: nExternal !== undefined,
  dataRoot: legacyDataRoot,
};
```

The returned object adds `dataLayout` and derives the two layout-aware defaults (lines 427/454):

```ts
worktreeRoot: nWorktree
  ? expandHome(nWorktree)
  : join(dataDir, dataLayout === "v2" ? "cache/worktrees" : "worktrees"),
// … github.externalReposRoot:
externalReposRoot: nExternal
  ? expandHome(nExternal)
  : join(dataDir, dataLayout === "v2" ? "cache/clones/external" : "clones/external"),
```

`configDeprecations` (line 509) gains:

```ts
if (cfg.legacy.dataRoot)
  out.push(
    "config: data lives at the legacy ~/.local/state/junco root — " +
      "run 'junco data migrate' to move it under ~/.junco (docs/configuration.md)",
  );
```

`src/types.ts`: `dataLayout: "flat" | "v2";` on `Config`; `dataRoot: boolean;` on the `legacy` object.

`src/dataTree.ts` — the subpath table switches on `cfg.dataLayout`:

```ts
/** Per-layout subpaths. "flat" is the 0.9 shape, byte-identical forever —
 * an unmigrated tree must never see a moved path. "v2" is the single-root
 * shape: data/ (unrecoverable), cache/ (rm -rf-safe), logs/. */
const LAYOUTS = {
  flat: {
    outbox: OUTBOX_SUBDIR,
    mirror: MIRROR_SUBDIR,
    clonesWatched: CLONES_WATCHED_SUBDIR,
    assessHistory: ASSESS_HISTORY_SUBDIR,
    history: HISTORY_SUBDIR,
    transcripts: "transcripts",
    githubCache: "github-cache",
    updateCheck: UPDATE_CHECK_FILENAME,
    spend: "spend.json",
    metrics: "metrics.json",
    logs: ".",
  },
  v2: {
    outbox: "data/outbox",
    mirror: "cache/mirror",
    clonesWatched: "cache/clones/watched",
    assessHistory: "data/assess-history",
    history: "data/history",
    transcripts: "data/transcripts",
    githubCache: "cache/github-cache",
    updateCheck: "cache/update-check.json",
    spend: "data/spend.json",
    metrics: "data/metrics.json",
    logs: "logs",
  },
} as const;
```

`dataTreePaths` reads `const L = LAYOUTS[cfg.dataLayout];` and joins every field off `L` (`logsDir: join(r, L.logs)` — `join(r, ".")` normalizes back to `r`, keeping Task 1's flat value; `logFile: join(r, L.logs, "worker.log")`). `queue`, `reviewAssess`, `reviewComments`, `watchlistFile`, `migratedFile`, `root` stay layout-independent. `ensureDataTree` needs no list change — its dirs come from `dataTreePaths`, and recursive mkdir materializes the `data/`/`cache/`/`logs/` parents; verify the dirs list uses only `p.*` fields (it does) and add `join(r, L.logs)` … concretely: append `p.logsDir` to the `dirs` array so `logs/` exists even before the first log write.

`tests/helpers/config.ts`: add `dataLayout: "v2",` to the literal and `dataRoot: false,` inside `legacy` (line 62).

`src/configWatcher.ts` / other `assembleConfig` callers: pass nothing extra (the optional deps default covers them); fix any arity type errors.

- [ ] **Step 4: Full suite + typecheck** — `npx vitest run > /tmp/s2b 2>&1; echo "exit: $?"`. Update the four default assertions at `tests/config.test.ts:287,385,697,700` to the new `~/.junco`-derived values (with `existsFn: () => false` injected where those tests build configs). `npx tsc --noEmit -p tsconfig.eslint.json` — no NEW errors.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src tests
git add -A src tests
git commit -m "feat(data): single-root ~/.junco data home with v2 layout

dataDir defaults to ~/.junco (data/, cache/, logs/ substructure; queue,
review, watchlist at the root). Pre-existing trees keep their legacy root
and flat shape untouched via probe-based fallback until 'junco data
migrate' relocates them."
```

---

### Task 3: Bot gh credentials move home — default `~/.junco/gh` with legacy fallback

**Files:**
- Modify: `src/ghAuth.ts:15` (`DEFAULT_GH_CONFIG_DIR = "~/.junco/gh"`), `src/config.ts:302` (zod default) + configDir resolution in `assembleConfig`, `src/configLevers.ts:723` (lever `default`), `src/types.ts` (`legacy.ghConfigDir: boolean`)
- Test: `tests/config.test.ts:503`, `tests/configLevers.test.ts:130-137`, `tests/wizard.test.ts:163`, new fallback tests
- Modify: `tests/helpers/config.ts` (`legacy: { …, ghConfigDir: false }`)

**Interfaces:**
- Consumes: `homeOf(env)`, `assembleConfig` deps.existsFn (Task 2).
- Produces: `Config.legacy.ghConfigDir: boolean`; resolution rule: an explicitly configured `botAccount.configDir` is used verbatim; a defaulted one resolves to `~/.junco/gh`, EXCEPT when `~/.junco/gh/hosts.yml` is absent and `~/.config/junco/gh/hosts.yml` exists — then the legacy dir is used and the flag set (an upgrade must never orphan a working bot login).

- [ ] **Step 1: Failing tests** — in `tests/config.test.ts`, next to the existing configDir assertion (line 503):

```ts
it("bot gh configDir defaults to ~/.junco/gh on a fresh machine", () => {
  const cfg = assembleConfig(parseConfigObject({}), { HOME: "/h" }, { existsFn: () => false });
  expect(cfg.botAccount.configDir).toBe("/h/.junco/gh");
  expect(cfg.legacy.ghConfigDir).toBe(false);
});

it("keeps a live legacy gh login until migrated", () => {
  const existsFn = (p: string) => p === "/h/.config/junco/gh/hosts.yml";
  const cfg = assembleConfig(parseConfigObject({}), { HOME: "/h" }, { existsFn });
  expect(cfg.botAccount.configDir).toBe("/h/.config/junco/gh");
  expect(cfg.legacy.ghConfigDir).toBe(true);
});
```

Update `tests/config.test.ts:503` and `tests/configLevers.test.ts:130-137` expectations to `~/.junco/gh`; `tests/wizard.test.ts:163`'s `endsWith(".config/junco/gh")` becomes `endsWith(".junco/gh")`.

- [ ] **Step 2: Verify failures** — targeted vitest run, expect FAIL.

- [ ] **Step 3: Implement** — `src/config.ts:302` default becomes `"~/.junco/gh"`; in `assembleConfig`, where `botAccount` is assembled, replace the plain `expandHome(d.botAccount.configDir)` with:

```ts
// Defaulted configDir: prefer ~/.junco/gh, but never orphan an existing
// legacy login — gh's hosts.yml is the liveness marker. Explicit values
// pass through untouched.
const ghDefault = join(juncoHome(env), "gh");
const ghLegacy = join(homeOf(env), ".config", "junco", "gh");
const ghConfigured = expandHome(d.botAccount.configDir);
let ghConfigDir = ghConfigured === expandHome("~/.junco/gh") ? ghDefault : ghConfigured;
let legacyGhDir = false;
if (
  ghConfigDir === ghDefault &&
  !existsFn(join(ghDefault, "hosts.yml")) &&
  existsFn(join(ghLegacy, "hosts.yml"))
) {
  ghConfigDir = ghLegacy;
  legacyGhDir = true;
}
```

(The `expandHome` comparison detects "still the schema default" — zod has already filled it. `expandHome` is homedir-based while `ghDefault` is env-based; when they disagree under an injected test env, an explicitly-set `~/.junco/gh` and the default are indistinguishable — acceptable, they mean the same place.) Set `legacy.ghConfigDir: legacyGhDir` and use `ghConfigDir` in the returned `botAccount`. Add the deprecation line in `configDeprecations`:

```ts
if (cfg.legacy.ghConfigDir)
  out.push(
    "config: bot gh credentials live at the legacy ~/.config/junco/gh — " +
      "run 'junco data migrate' to move them to ~/.junco/gh",
  );
```

`src/ghAuth.ts:15`: `export const DEFAULT_GH_CONFIG_DIR = "~/.junco/gh";` (its consumer `src/authCmd.ts:93` follows automatically). `src/configLevers.ts:723`: lever `default: "~/.junco/gh"`. `tests/helpers/config.ts`: `ghConfigDir: false` in `legacy` (the ballast `configDir: "/sbxroot/junco-gh"` at line 129 stays — explicit, so untouched by the fallback).

- [ ] **Step 4: Full suite + typecheck green.**

- [ ] **Step 5: Commit** — `feat(auth): bot gh config home moves to ~/.junco/gh (legacy login kept until migrated)`.

---### Task 4: Wizard + service render + sandbox follow the new home

**Files:**
- Modify: `src/wizard/flow.ts:15-17,51` (`DEFAULT_DATA_DIR = "~/.junco"`), `src/tui/wizard/chapters/Workspace.tsx:30` (placeholder `~/.junco`)
- Modify: `src/service.ts` (logDir default → `<home>/.junco/logs`), `src/cli.ts:400` (`logDir = dataTreePaths(cfg).logsDir`)
- Modify: `src/dataTree.ts` `sandboxDenyPaths` (+ `src/agent/session.ts:487` threading if a signature changes)
- Test: `tests/wizardFlow.test.ts:18`, `tests/wizardApp.test.tsx:267`, `tests/service.test.ts` (logDir default), `tests/dataTree.test.ts` (deny sets per layout)

**Interfaces:**
- Consumes: `dataTreePaths(cfg).logsDir` (Task 2), plan 1's `ServiceOpts` (no `configPath`).
- Produces: `sandboxDenyPaths(cfg, env?: Record<string, string | undefined>): { dirs: string[]; files: string[] }` — adds the canonical config file (`defaultUserConfigPath(env)`) to `files`, and `logsDir` to `dirs`; `session.ts` passes nothing new (default `process.env`).

- [ ] **Step 1: Failing tests.** Wizard: update the two literal expectations (`tests/wizardFlow.test.ts:18` → `"~/.junco"`, `tests/wizardApp.test.tsx:267` placeholder-typing frame → `~/.juncoq`). Service (plan 1 made the default `<home>/.junco`): update to `<home>/.junco/logs` — `home: "/x"` → `<string>/x/.junco/logs/launchd.out</string>`. Sandbox, in `tests/dataTree.test.ts`:

```ts
it("denies the daemon-private subtrees, the config file, and logs — never cache/ or the root", () => {
  const cfg = makeConfig({ ...seams, dataDir: "/sbxroot/home/.junco" }, { dataLayout: "v2" });
  const deny = sandboxDenyPaths(cfg, { HOME: "/sbxroot/home" });
  expect(deny.dirs).toEqual(expect.arrayContaining([
    "/sbxroot/home/.junco/queue",
    "/sbxroot/home/.junco/review",
    "/sbxroot/home/.junco/data/outbox",
    "/sbxroot/home/.junco/data/transcripts",
    "/sbxroot/home/.junco/cache/github-cache",
    "/sbxroot/home/.junco/cache/mirror",
    "/sbxroot/home/.junco/logs",
  ]));
  expect(deny.files).toContain("/sbxroot/home/.junco/config.json");
  // never an ancestor of the agent's writable roots (backend.ts:42-53 invariant):
  for (const d of deny.dirs) {
    expect("/sbxroot/home/.junco/cache/worktrees".startsWith(d + "/")).toBe(false);
    expect("/sbxroot/home/.junco/cache/clones".startsWith(d + "/")).toBe(false);
  }
  expect(deny.dirs).not.toContain("/sbxroot/home/.junco");
  expect(deny.dirs).not.toContain("/sbxroot/home/.junco/cache");
});
```

(Adjust the queue expectation if the existing deny uses `cfg.queueRoot` — it does; keep that, it covers legacy vault queues.)

- [ ] **Step 2: Verify failures.**

- [ ] **Step 3: Implement.** Wizard/service literals per above (`src/service.ts` logDir default: `join(home !== "" ? home : homedir(), ".junco", "logs")`). `sandboxDenyPaths(cfg, env = process.env)`: keep the existing dirs (all now layout-aware via `dataTreePaths`), add `p.logsDir`, and add to `files`: `defaultUserConfigPath(env)` (import exists in dataTree already? no — import it from `./config.js`; dataTree already imports `queuePaths` from there, no cycle). The config file may hold `model.apiKey` — today it escapes the deny list entirely because it lived outside the data root; moving into `~/.junco` is the moment to close that. Note in the function comment. `cli.ts:400`: `logDir = dataTreePaths(cfg).logsDir;`.

- [ ] **Step 4: Full suite + `npm run lint` green** (wizard chapter is under `src/tui/**`).

- [ ] **Step 5: Commit** — `feat(home): wizard/service/sandbox follow the single ~/.junco root (config file now sandbox-denied)`.

---

### Task 5: Migration — one journaled move+restructure in `junco data migrate`

**Files:**
- Modify: `src/dataMigrate.ts` (add `flatToV2Pairs`), `src/dataMigrateCmd.ts` (target-root awareness at lines 54-55, 104-113, 309-318, 363-385; new phases; receipt rows)
- Test: `tests/dataMigrate.test.ts`, `tests/dataMigrateCmd.test.ts` (adapt to actual test-file names — grep `dataMigrate` under tests/)

**Interfaces:**
- Consumes: `layoutOf`, `juncoHome`, `homeOf`, `Config.dataLayout`, `legacy.dataRoot`, `legacy.ghConfigDir`.
- Produces:
  - `flatToV2Pairs(fromRoot: string, toRoot: string): Array<{ from: string; to: string }>` — the full mapping; identity pairs (`from === to`) filtered out so the same function serves the cross-root move (`fromRoot ≠ toRoot`) and the in-place restructure (`fromRoot === toRoot`).
  - `junco data migrate` semantics: target root = `juncoHome(env)` when `legacy.dataRoot`, else `cfg.dataDir`. Phases append to the existing ones: (a) existing queue move now targets `join(targetRoot, "queue")`; (b) root move / restructure via `flatToV2Pairs` with the existing rename→EXDEV-copy machinery and journal; (c) gh creds move `~/.config/junco/gh` → `~/.junco/gh` when `legacy.ghConfigDir`; (d) legacy root dir removed when empty after the move; (e) receipt gains `data root:` and `gh config:` sections. `--dry-run` prints all of it read-only. `DEFAULT_DATA_DIR` comparator (line 54-55) becomes `"~/.junco"` so the config rewrite keeps omitting a default `dataDir`.

- [ ] **Step 1: Failing tests.** Mapping unit test in `tests/dataMigrate.test.ts`:

```ts
it("flatToV2Pairs maps the whole flat tree; in-place skips identity pairs", () => {
  const cross = flatToV2Pairs("/old", "/new");
  expect(cross).toContainEqual({ from: "/old/queue", to: "/new/queue" });
  expect(cross).toContainEqual({ from: "/old/outbox", to: "/new/data/outbox" });
  expect(cross).toContainEqual({ from: "/old/clones", to: "/new/cache/clones" });
  expect(cross).toContainEqual({ from: "/old/worker.log", to: "/new/logs/worker.log" });
  expect(cross).toContainEqual({ from: "/old/update-check.json", to: "/new/cache/update-check.json" });
  const inPlace = flatToV2Pairs("/r", "/r");
  expect(inPlace.map((p) => p.from)).not.toContain("/r/queue"); // identity — already home
  expect(inPlace).toContainEqual({ from: "/r/outbox", to: "/r/data/outbox" });
});
```

Command-level test (in the dataMigrateCmd test file, using its existing tmp-dir harness): a flat tree at `<tmp>/.local/state/junco` + config resolving with the legacy fallback → run migrate → assets exist under `<tmp>/.junco/{queue,data,cache,logs}`, journal written to `<tmp>/.junco/migrated.json`, legacy root gone, receipt mentions `data root:`; a second run is a no-op. And: `--dry-run` moves nothing.

- [ ] **Step 2: Verify failures.**

- [ ] **Step 3: Implement.**

`src/dataMigrate.ts`:

```ts
/** Flat→v2 mapping for the single-root move (2026-08-03 plan). Serves both
 * the cross-root move (fromRoot ≠ toRoot: legacy ~/.local/state/junco →
 * ~/.junco) and the in-place restructure (fromRoot === toRoot: an explicit
 * dataDir keeping its location but adopting the v2 shape). `clones` moves as
 * ONE rename (covers watched/ + external/); identity pairs are skipped. */
export function flatToV2Pairs(
  fromRoot: string,
  toRoot: string,
): Array<{ from: string; to: string }> {
  const pairs: Array<[string, string]> = [
    ["queue", "queue"],
    ["review", "review"],
    ["watchlist.json", "watchlist.json"],
    ["migrated.json", "migrated.json"],
    ["outbox", "data/outbox"],
    ["assess-history", "data/assess-history"],
    ["history", "data/history"],
    ["transcripts", "data/transcripts"],
    ["spend.json", "data/spend.json"],
    ["metrics.json", "data/metrics.json"],
    ["clones", "cache/clones"],
    ["worktrees", "cache/worktrees"],
    ["github-cache", "cache/github-cache"],
    ["mirror", "cache/mirror"],
    ["update-check.json", "cache/update-check.json"],
    ["worker.log", "logs/worker.log"],
  ];
  return pairs
    .map(([f, t]) => ({ from: join(fromRoot, f), to: join(toRoot, t) }))
    .filter((p) => p.from !== p.to);
}
```

`src/dataMigrateCmd.ts`: compute `targetRoot` once (`legacy.dataRoot ? juncoHome(env) : cfg.dataDir`); the plan/dry-run/receipt sections list `flatToV2Pairs(cfg.dataDir, targetRoot)` pairs whose source exists (only when `cfg.dataLayout === "flat" || legacy.dataRoot`); the queue phase's target becomes `join(targetRoot, "queue")`; the move phase reuses the existing per-pair rename with `EXDEV` copy+verify+fsync fallback and mkdirs each `dirname(to)`; skip a pair whose destination exists non-empty (record `skipped-conflict`, reusing `isRecursivelyEmptyDir` semantics from `migrateStateTree`); when `legacy.ghConfigDir`, add the pair `{ from: <legacy gh dir>, to: join(juncoHome(env), "gh") }`; after all pairs, `rmdir` the legacy root if empty (plain `rmdirSync`, non-recursive — refuses silently via try/catch if anything is left, and the receipt lists what stayed). The journal continues to append to `dataTreePaths`-resolved `migratedFile` — compute it against the TARGET root so the receipt lands where the daemon will look next. The existing refusal gate (daemon up / lock held / `--force`) and the `migrate.lock` stay as-is, except the lock file is taken under `targetRoot`. Update `DEFAULT_DATA_DIR` (lines 54-55) to `"~/.junco"`. Note: the pre-existing NAME migrations (`stateTreeMigrations` — `assess-review`→`review/assess` etc.) run BEFORE the layout pairs so a very old tree normalizes names first, then relocates.

- [ ] **Step 4: Full suite + typecheck green.** Pay attention to the daemon-startup path: `src/daemon.ts` calls `migrateStateTree` + `ensureDataTree` at startup — verify (test exists in `tests/daemon.test.ts:547` area) that startup does NOT trigger the root move (it must remain migrate-command-only; `migrateStateTree`'s pair list is unchanged by this task).

- [ ] **Step 5: Commit** — `feat(data): junco data migrate relocates the tree to ~/.junco (move + v2 restructure + gh creds, journaled)`.

---

### Task 6: `junco data` / doctor visibility for the pending move

**Files:**
- Modify: `src/dataCmd.ts` (`:328` root line gains a `(legacy — run 'junco data migrate')` suffix when `legacy.dataRoot`; JSON output at `:454-475` gains `layout: cfg.dataLayout`), `src/dataMigrateCmd.ts`/`src/dataMigrate.ts` `pendingMigrations` surface (extend to include layout pairs so `junco data` and doctor report them), `src/doctor.ts:198-210` (the pending-migration rows pick the new pairs up automatically once `pendingMigrations` includes them — verify, don't duplicate)
- Test: the dataCmd + doctor test files (grep for `pendingMigrations` / `junco data` under tests/)

**Interfaces:**
- Consumes: `flatToV2Pairs`, `legacy.dataRoot`, `dataLayout`.
- Produces: `pendingMigrations(cfg, existsFn?)` additionally returns the existing-source layout pairs (`flatToV2Pairs(cfg.dataDir, targetRoot)` filtered by `existsFn`) when a move/restructure is pending. `junco data --json` gains `layout`.

- [ ] **Step 1: Failing test** — a flat/legacy config's `pendingMigrations` includes `{from: <legacy>/outbox, to: <canonical>/data/outbox}`; a v2 config returns no layout pairs; `junco data` text output contains `legacy — run 'junco data migrate'`; `--json` contains `"layout": "v2"`.
- [ ] **Step 2: Verify failures.**
- [ ] **Step 3: Implement** (keep `pendingMigrations`'s signature; it can compute the target root the same way dataMigrateCmd does — factor a tiny `migrationTargetRoot(cfg, env?)` helper in `dataMigrate.ts` shared by both).
- [ ] **Step 4: Full suite green.**
- [ ] **Step 5: Commit** — `feat(data): report pending single-root migration in junco data + doctor`.

---

### Task 7: Docs, examples, smoke containment assert

**Files:**
- Modify: `docs/configuration.md` (`:3` if plan 1's text needs the data sentence, `:33,39,73,80` path mentions, `:95-125` full `junco data` sample tree → v2 shape, `:160-163,171`), `docs/operations.md:9,72`, `docs/bot-account.md:53,58` (gh dir), `ARCHITECTURE.md:208` (worker.lock/dataMigrate rows mentioning paths), `CLAUDE.md:68` (transcripts default → `~/.junco/data/transcripts`), `examples/config.json:77` + `examples/config.hosted.json:66` (drop the legacy `"stateDir"` sample lines — deprecated keys don't belong in examples), `src/tui/App.tsx:95,97` (prop-doc path comments)
- Modify: `scripts/package-smoke.sh:28` (`CONFIG="$SB/.junco/config.json"` — REQUIRED for CI even before this plan if plan 1 merged alone; see plan 1 amendment) + add the containment assertion
- Test: none (docs); smoke runs in CI

**Interfaces:** none.

- [ ] **Step 1: Sweep the doc/example literals** listed above; regenerate the `docs/configuration.md` sample tree from a real sandboxed `junco data` run if the doc claims to mirror output.
- [ ] **Step 2: Harden the smoke test.** In `scripts/package-smoke.sh`, after the existing smoke steps (which run with `HOME="$SB"`), add:

```bash
# Single-root containment: nothing may sprawl outside ~/.junco (plan 2026-08-03)
if [ -e "$SB/.local/state/junco" ] || [ -e "$SB/.config/junco" ]; then
  echo "FAIL: junco wrote outside \$HOME/.junco" >&2
  ls -la "$SB/.local/state" "$SB/.config" 2>/dev/null >&2 || true
  exit 1
fi
```

- [ ] **Step 3: Run the smoke locally** (sandboxed per CLAUDE.md — `SB=$(mktemp -d)`, never from the repo root against the live config): expect pass, with `$SB/.junco` the only junco artifact.
- [ ] **Step 4: `grep -rn '\.local/state/junco\|\.config/junco' src/ docs/ examples/ scripts/ README.md ARCHITECTURE.md CLAUDE.md`** — remaining hits must be: legacy-fallback/migration code and its docs (intentional), and historical `docs/superpowers/{plans,specs}` (never edited).
- [ ] **Step 5: Commit** — `docs: single-root ~/.junco layout; smoke test asserts containment`.

---

### Task 8: Full gate, PR, live-install runbook

- [ ] **Step 1: Full gate** — `npm run lint && npm run format:check && npm run typecheck && npm run build && npm test`; capture the exit code explicitly.
- [ ] **Step 2: Attribution sweep** — `git log --format='%B' origin/main..HEAD | grep -in "claude\|generated with"` → empty.
- [ ] **Step 3: Push + PR (do NOT merge).** If plan 1 shipped as its own PR, stack this branch on it and note the dependency; otherwise one branch, one PR, two plan docs referenced. PR body: the target-layout tree, the fallback/migrate contract, breaking note (0.10.0), and the runbook below. Merging is maintainer-gated (auto-promote).
- [ ] **Step 4: Live-install runbook (maintainer executes; extends plan 1's).** After both plans are merged+promoted, the daemon still runs entirely on legacy paths (root fallback + vaultRoot queue + legacy gh dir) — zero behavior change until:
  1. Confirm idle (`/health` → `currentTicket: null`), then `junco data migrate --dry-run` and review the plan: queue `~/junco/tickets` → `~/.junco/queue`, root `~/.local/state/junco` → `~/.junco` (restructured), gh `~/.config/junco/gh` → `~/.junco/gh`, config rewrite dropping `vaultRoot`/`juncoSubdir`.
  2. `junco data migrate` (it self-refuses if the daemon is up — stop it first with `junco restart` timing or launchctl bootout, per its gate), then restart the daemon.
  3. Verify: `junco status`, `junco data` (root `~/.junco`, layout v2, no pending migrations), dashboard queue intact, bot login intact (`junco doctor`), a test ticket round-trip.
  4. Cleanup, maintainer's call: the now-empty `~/.local/state/junco` (migrate removes it when empty), `~/.config/junco/` remnants, the dormant `~/junco/config.json` + stale `~/junco/worker.lock` from plan 1, and the `~/junco/tickets` directory once confirmed empty.
- [ ] **Step 5: File the follow-up issues** deferred from this work: (a) backend allow-over-deny support so the sandbox can deny the `~/.junco` root wholesale instead of enumerating (today's enumeration is equivalent but must be maintained); (b) remove the legacy XDG config fallback + legacy data-root fallback in a future major once migration adoption is assumed; (c) `metrics.json` writer (PR 3 of the old unified-data-root series) now targeting `data/metrics.json`.

---

## Self-Review (performed at authoring time)

- **Requirement coverage:** "all assets in one central place after npm installation" — config (plan 1), data tree root+shape (Tasks 1-2), bot gh creds (Task 3), wizard/service/launchd logs (Task 4), migration for existing installs (Task 5), visibility (Task 6), docs + a CI containment assert that PROVES the fresh-install property (Task 7). Worker.lock/migrate.lock land under `~/.junco` via plan 1's config-adjacent derivation and the target-root lock change.
- **Inventory coverage:** every §1 straggler from the 2026-08-03 inventory is enumerated in Task 1; every literal-default site (§3, §6, §7) is assigned to Tasks 2/3/4/7; sandbox threading (§8) in Task 4 respects the no-ancestor-of-writable-root invariant (root and `cache/` never denied); display surfaces (§9) in Tasks 4/6/7.
- **Safety invariants:** flat layout is byte-identical to 0.9 (Task 2 test); no relocation outside `junco data migrate` (Task 5 Step 4 verifies startup doesn't move roots); gh fallback keeps a working bot login; `rm -rf cache/` never loses data by construction of the classification table.
- **Type consistency:** `dataLayout`/`legacy.dataRoot`/`legacy.ghConfigDir` introduced in Tasks 2-3 and consumed with the same names in Tasks 4-6; `flatToV2Pairs(fromRoot, toRoot)` defined in Task 5 and reused in Task 6 via `pendingMigrations`; `homeOf`/`juncoHome`/`defaultUserConfigPath` shapes match plan 1.
- **Known open point for the executor:** exact current signatures of `makeReviewStore`/`makeSpendLedger` and the dataMigrateCmd test-file names were not re-verified line-by-line — adapt the refactors to what's on disk; the contracts above (absolute paths in, no `cfg.dataDir` joins inside stores) are the requirement.
