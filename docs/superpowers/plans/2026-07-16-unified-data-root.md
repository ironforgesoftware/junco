# Unified Data Root (PR 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One configurable data root (`dataDir`) under which every junco path resolves, with legacy config keys as always-win overrides, lock-guarded in-place migration, an eagerly-materialized self-gitignoring tree, and a `junco data` visibility command.

**Architecture:** All consumers already read resolved `Config` fields (`stateDir`, `vaultRoot`+`queuePaths`, `worktreeRoot`, `github.externalReposRoot`), so the pivot happens in `assembleConfig`: a new resolved `dataDir` + `queueRoot` replace `stateDir`/`vaultRoot`/`juncoSubdir`, and path constants move to a new `dataTree.ts` that is the single source of truth for subdir names. Migration (`dataMigrate.ts`) renames old-name subdirs in place before the tree is materialized.

**Tech Stack:** TypeScript strict ESM (NodeNext, Node ≥ 22.19), zod config schema, vitest.

**Spec:** `docs/superpowers/specs/2026-07-16-unified-data-root-design.md`

## Global Constraints

- Full gate green at every commit: `npm run lint && npm run format:check && npm run typecheck && npm run build && npm test`.
- Vitest exit-code trap: never pipe vitest into a filter; run `npx vitest run <file> > /tmp/out 2>&1; echo "exit: $?"` and read the file.
- No AI attribution in commits, ever. Conventional commits (`feat:`, `fix:`, `docs:`, scope optional).
- Every side effect behind an injectable `*Deps` seam; tests never touch network or a real model.
- Never import the Pi SDK at module top level in `src/` (not relevant to these files, but absolute).
- `src/ticketSchema.ts` is untouched by this plan.
- Prettier may reformat between read and edit; re-read before editing, run `npx prettier --write` on touched files before committing.
- `tests/` are type-checked only by `npx tsc --noEmit -p tsconfig.eslint.json` (vitest does not type-check). There are pre-existing errors in that sweep (~57 as of an earlier session): capture the baseline count on the commit BEFORE your change (`git stash`-free: just run it on HEAD before editing, save the output), and after your change ensure no NEW errors beyond the baseline.
- `config.json`, `tickets/`, `worktrees/` at the ORIGINAL repo root are live daemon runtime — never touch them. All work happens in this worktree.
- Migration semantics (spec §7): the queue NEVER moves implicitly; state-subtree renames are same-directory and atomic; `github-cache/` is NOT deleted in PR 1 (deviation from spec §7's list, deliberate: `tui/ghClient.ts` still reads/writes it until PR 2 replaces it with `mirror/` — deleting it here would just make the dashboard rebuild it).

---

### Task 1: Config schema + resolution (additive)

Add `dataDir` to the schema, make legacy keys optional, compute resolved `dataDir`/`queueRoot`/`legacy` flags in `assembleConfig` — while KEEPING the old resolved fields (`vaultRoot`, `juncoSubdir`, `stateDir`) populated and consumed, so this task compiles and lands green without touching any consumer.

**Files:**

- Modify: `src/config.ts` (schema lines 123-125, 205, 249-267, 276; `assembleConfig` lines 338-447; `queuePaths` lines 464-472)
- Modify: `src/types.ts` (Config interface, lines 95-168)
- Modify: `src/configLevers.ts` (LEVERS registry)
- Test: `tests/config.test.ts` (extend), `tests/configLevers.test.ts` (bijection auto-covers)

**Interfaces:**

- Consumes: existing `ConfigSchema`, `assembleConfig`, `expandHome`.
- Produces (later tasks rely on these exact names):
  - `Config.dataDir: string` — resolved absolute data root.
  - `Config.queueRoot: string` — resolved queue root (legacy `<vaultRoot>/<juncoSubdir>` or `<dataDir>/queue`).
  - `Config.legacy: LegacyPathFlags` where `interface LegacyPathFlags { vaultRoot: boolean; stateDir: boolean; worktreeRoot: boolean; externalReposRoot: boolean }` (exported from `src/types.ts`).
  - `configDeprecations(cfg: Config): string[]` (exported from `src/config.ts`) — one human-readable warning per set legacy key.
  - Schema: top-level `dataDir` optional string; `vaultRoot` optional; `observability.stateDir` optional (no default); `git.worktreeRoot` optional (no default).

- [ ] **Step 1: Write the failing tests**

Append to `tests/config.test.ts` (match the file's existing helper style — it builds raw objects and calls `assembleConfig(ConfigSchema.parse(raw))`; reuse its minimal-raw helper if one exists, otherwise the literal below). The precedence matrix from spec §5:

```ts
import { homedir } from "node:os";
import { join } from "node:path";

describe("dataDir resolution (unified data root)", () => {
  const XDG_DEFAULT = join(homedir(), ".local/state/junco");
  const parse = (raw: object) => assembleConfig(ConfigSchema.parse(raw), {});

  it("defaults dataDir to ~/.local/state/junco and derives every root", () => {
    const cfg = parse({});
    expect(cfg.dataDir).toBe(XDG_DEFAULT);
    expect(cfg.queueRoot).toBe(join(XDG_DEFAULT, "queue"));
    expect(cfg.worktreeRoot).toBe(join(XDG_DEFAULT, "worktrees"));
    expect(cfg.github.externalReposRoot).toBe(join(XDG_DEFAULT, "clones", "external"));
    expect(cfg.legacy).toEqual({
      vaultRoot: false,
      stateDir: false,
      worktreeRoot: false,
      externalReposRoot: false,
    });
  });

  it("explicit dataDir moves every derived root", () => {
    const cfg = parse({ dataDir: "~/jdata" });
    const root = join(homedir(), "jdata");
    expect(cfg.dataDir).toBe(root);
    expect(cfg.queueRoot).toBe(join(root, "queue"));
    expect(cfg.worktreeRoot).toBe(join(root, "worktrees"));
    expect(cfg.github.externalReposRoot).toBe(join(root, "clones", "external"));
  });

  it("legacy vaultRoot/juncoSubdir wins the queue root only", () => {
    const cfg = parse({ dataDir: "~/jdata", vaultRoot: "~/vault", juncoSubdir: "Junco" });
    expect(cfg.queueRoot).toBe(join(homedir(), "vault", "Junco"));
    expect(cfg.dataDir).toBe(join(homedir(), "jdata")); // untouched
    expect(cfg.legacy.vaultRoot).toBe(true);
  });

  it("legacy observability.stateDir wins over dataDir for the whole root", () => {
    const cfg = parse({ dataDir: "~/jdata", observability: { stateDir: "~/state" } });
    expect(cfg.dataDir).toBe(join(homedir(), "state"));
    expect(cfg.legacy.stateDir).toBe(true);
  });

  it("legacy git.worktreeRoot and github.externalReposRoot win their subtrees", () => {
    const cfg = parse({
      git: { worktreeRoot: "~/wt" },
      github: { externalReposRoot: "~/ext" },
    });
    expect(cfg.worktreeRoot).toBe(join(homedir(), "wt"));
    expect(cfg.github.externalReposRoot).toBe(join(homedir(), "ext"));
    expect(cfg.legacy.worktreeRoot).toBe(true);
    expect(cfg.legacy.externalReposRoot).toBe(true);
  });

  it("configDeprecations names each set legacy key and is empty when clean", () => {
    expect(configDeprecations(parse({}))).toEqual([]);
    const warns = configDeprecations(
      parse({ vaultRoot: "~/vault", observability: { stateDir: "~/state" } }),
    );
    expect(warns).toHaveLength(2);
    expect(warns[0]).toContain("vaultRoot");
    expect(warns[1]).toContain("stateDir");
    for (const w of warns) expect(w).toContain("junco data migrate");
  });

  it("a config with no keys at all is valid (vaultRoot no longer required)", () => {
    expect(() => ConfigSchema.parse({})).not.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/config.test.ts > /tmp/t1 2>&1; echo "exit: $?"` — expect FAIL (`dataDir`/`queueRoot`/`legacy`/`configDeprecations` do not exist; `ConfigSchema.parse({})` throws on missing vaultRoot).

- [ ] **Step 3: Implement**

`src/config.ts`:

```ts
// schema — replace line 124 and add dataDir above it:
  dataDir: z.string().optional(),          // unified data root; default applied at assembly
  vaultRoot: z.string().optional(),        // DEPRECATED: legacy queue-root override
// line 205:
      worktreeRoot: z.string().optional(), // DEPRECATED: legacy override; default <dataDir>/worktrees
// line 263:
      stateDir: z.string().optional(),     // DEPRECATED: legacy alias for dataDir
```

In `assembleConfig`, before the return:

```ts
const dataDir = expandHome(d.observability.stateDir ?? d.dataDir ?? "~/.local/state/junco");
const queueRoot = d.vaultRoot
  ? join(expandHome(d.vaultRoot), d.juncoSubdir)
  : join(dataDir, "queue");
const legacy = {
  vaultRoot: d.vaultRoot !== undefined,
  stateDir: d.observability.stateDir !== undefined,
  worktreeRoot: d.git.worktreeRoot !== undefined,
  externalReposRoot: d.github.externalReposRoot !== undefined,
};
```

and in the returned object:

```ts
    dataDir,
    queueRoot,
    legacy,
    vaultRoot: d.vaultRoot ? expandHome(d.vaultRoot) : dataDir, // kept until Task 2 removes it
    juncoSubdir: d.vaultRoot ? d.juncoSubdir : "queue",         // kept until Task 2 removes it
    stateDir: dataDir,                                          // kept until Task 2 removes it
    worktreeRoot: d.git.worktreeRoot
      ? expandHome(d.git.worktreeRoot)
      : join(dataDir, "worktrees"),
    github: { /* ...existing..., replace externalReposRoot line: */
      externalReposRoot: d.github.externalReposRoot
        ? expandHome(d.github.externalReposRoot)
        : join(dataDir, "clones", "external"),
    },
```

(The `vaultRoot: dataDir` + `juncoSubdir: "queue"` interim shim keeps `queuePaths` correct for BOTH shapes: legacy configs get `<vaultRoot>/<juncoSubdir>`, new configs get `<dataDir>/queue`. Assert: `join(cfg.vaultRoot, cfg.juncoSubdir) === cfg.queueRoot` in both branches.)

Add at the bottom of `src/config.ts`:

```ts
/** One human-readable deprecation per legacy path key set in config.json.
 * Surfaced by daemon startup, `junco doctor`, and `junco data` (spec §5). */
export function configDeprecations(cfg: Config): string[] {
  const out: string[] = [];
  const hint = "run 'junco data migrate' to unify (docs/configuration.md)";
  if (cfg.legacy.vaultRoot)
    out.push(
      `config: vaultRoot/juncoSubdir are deprecated — the queue lives at <dataDir>/queue; ${hint}`,
    );
  if (cfg.legacy.stateDir)
    out.push(`config: observability.stateDir is deprecated — use top-level dataDir; ${hint}`);
  if (cfg.legacy.worktreeRoot)
    out.push(
      `config: git.worktreeRoot is deprecated — worktrees live at <dataDir>/worktrees; ${hint}`,
    );
  if (cfg.legacy.externalReposRoot)
    out.push(
      `config: github.externalReposRoot is deprecated — external clones live at <dataDir>/clones/external; ${hint}`,
    );
  return out;
}
```

`src/types.ts` — add to `Config` (keep `vaultRoot`/`juncoSubdir`/`stateDir` for now):

```ts
export interface LegacyPathFlags {
  vaultRoot: boolean;
  stateDir: boolean;
  worktreeRoot: boolean;
  externalReposRoot: boolean;
}
// in Config:
/** Unified data root (spec 2026-07-16). Every junco path resolves under here
 * unless a legacy key overrides its subtree. */
dataDir: string;
/** Resolved queue root: <vaultRoot>/<juncoSubdir> when legacy, else <dataDir>/queue. */
queueRoot: string;
/** Which deprecated path keys are explicitly set (drives warnings + provenance). */
legacy: LegacyPathFlags;
```

`src/configLevers.ts` — add a `dataDir` lever (top, next to vaultRoot) and fix defaults to match the schema verbatim (`tests/configLevers.test.ts` enforces bijection):

```ts
  {
    path: "dataDir",
    type: "string",
    default: undefined,
    editable: true,
    reload: "restart",
    description: "Unified data root — queue, reviews, outbox, mirror, clones, worktrees, transcripts.",
  },
```

and change the `observability.stateDir` and `git.worktreeRoot` lever `default:` values to `undefined` (schema no longer defaults them). Update their descriptions to say "Deprecated: overrides dataDir…".

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/config.test.ts tests/configLevers.test.ts > /tmp/t1 2>&1; echo "exit: $?"` — expect PASS. Then the full suite: `npx vitest run > /tmp/t1f 2>&1; echo "exit: $?"` — expect PASS (nothing consumed the removed defaults directly; if a test constructed `ConfigSchema.parse` output expecting `stateDir` string, fix it to the new optional shape).

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/config.ts src/types.ts src/configLevers.ts tests/config.test.ts
git add -A && git commit -m "feat(config): dataDir unified data root with legacy per-subtree overrides"
```

---

### Task 2: Repoint every consumer; remove legacy resolved fields

Replace `cfg.stateDir` with `cfg.dataDir` everywhere, make `queuePaths` read `cfg.queueRoot`, delete `vaultRoot`/`juncoSubdir`/`stateDir` from the resolved `Config`, and pin the new fields in `overlayFrozenRestartFields`.

**Files:**

- Modify: `src/config.ts` (`queuePaths`, `assembleConfig` — drop interim shim), `src/types.ts` (drop 3 fields)
- Modify (mechanical `cfg.stateDir` → `cfg.dataDir`, ~20 files): `src/cli.ts:263-366`, `src/daemon.ts`, `src/reviewStore.ts:66`, `src/githubOutbox.ts:95`, `src/watchlist.ts:23`, `src/logsCmd.ts:42`, `src/tui/localSnapshot.ts:142`, `src/tui/ghClient.ts:43,51`, `src/dashboardCmd.ts:105`, `src/doctor.ts:394`, `src/wizard/detect.ts:148`, `src/statusCmd.ts`, `src/assessFlow.ts`, `src/analyzeFlow.ts`, `src/prFlow.ts`, `src/runOnce.ts`, `src/agent/session.ts`, `src/spendLedger.ts` call sites, `src/slug.ts` transcriptPath call sites
- Modify: `src/daemon.ts:170-200` (`overlayFrozenRestartFields`)
- Test: existing suite + fixture sweep in `tests/{runOnce,prFlow,orphans,repo,worktree,daemon}.test.ts` and any other `Config` literal

**Interfaces:**

- Consumes: `Config.dataDir`, `Config.queueRoot`, `Config.legacy` (Task 1).
- Produces: resolved `Config` WITHOUT `vaultRoot`/`juncoSubdir`/`stateDir`; `queuePaths(cfg)` = `{inbox,processing,done,failed}` under `cfg.queueRoot`. All later tasks assume `cfg.dataDir` is the only state root.

- [ ] **Step 1: Capture the tests-typecheck baseline**

Run: `npx tsc --noEmit -p tsconfig.eslint.json > /tmp/tsc-baseline 2>&1; grep -c "error TS" /tmp/tsc-baseline` — record the count.

- [ ] **Step 2: Make the edits**

`src/config.ts`:

```ts
export function queuePaths(cfg: Config): Paths {
  const root = cfg.queueRoot;
  return {
    inbox: join(root, "inbox"),
    processing: join(root, "processing"),
    done: join(root, "done"),
    failed: join(root, "failed"),
  };
}
```

Delete the three interim shim lines from `assembleConfig` (`vaultRoot:`, `juncoSubdir:`, `stateDir:`) and the three fields from `types.ts` `Config`.

Mechanical sweep — for each file above replace `cfg.stateDir`/`c.stateDir`/`config.stateDir` with the `dataDir` equivalent. Verify completion:

```bash
grep -rn "\.stateDir\b" src/ --include="*.ts" | grep -v "observability.stateDir\|d\.observability"   # → empty
grep -rn "\.vaultRoot\b\|\.juncoSubdir\b" src/ --include="*.ts" | grep -v "d\.vaultRoot\|d\.juncoSubdir\|legacy"   # → empty
```

(`d.observability.stateDir` / `d.vaultRoot` inside `assembleConfig` and the wizard's raw-object lever paths — `flow.ts` `"vaultRoot"` strings, Task 8's problem — are the only legitimate survivors.)

`src/daemon.ts` `overlayFrozenRestartFields` — replace the `vaultRoot`/`juncoSubdir`/`stateDir` pins:

```ts
    dataDir: frozen.dataDir,
    queueRoot: frozen.queueRoot,
    legacy: frozen.legacy,
```

(keep every other pin exactly as-is; the comment at line 165-169 stays true — update its wording from "queue/state dir" to "dataDir/queueRoot").

- [ ] **Step 3: Fix the test fixtures**

Run: `npx tsc --noEmit -p tsconfig.eslint.json > /tmp/tsc-after 2>&1; grep -c "error TS" /tmp/tsc-after` — fix every NEW error vs the baseline: each `makeConfig`/`cfg()` helper in `tests/{runOnce,prFlow,orphans,repo,worktree,daemon}.test.ts` (and any other full-`Config` literal the sweep flags) drops `vaultRoot`/`juncoSubdir`/`stateDir` and gains `dataDir`, `queueRoot`, `legacy: { vaultRoot: false, stateDir: false, worktreeRoot: false, externalReposRoot: false }`. Where a fixture pointed `vaultRoot` at a tmp dir, point `queueRoot` at `join(tmp, "queue")` (or keep the old dir string — tests only need internal consistency).

- [ ] **Step 4: Run the full gate**

Run: `npm run lint && npm run format:check && npm run typecheck && npm run build && npx vitest run > /tmp/t2 2>&1; echo "exit: $?"` — expect exit 0. Behavioral watch-outs: `spendLedger` (`makeSpendLedger(cfg.stateDir)` call sites), `slug.ts` `transcriptPath(stateDir, id)` callers, `agent/session.ts` — all become `cfg.dataDir`.

- [ ] **Step 5: Commit**

```bash
npx prettier --write $(git diff --name-only)
git add -A && git commit -m "refactor: resolve every path from dataDir/queueRoot; drop legacy resolved fields"
```

---

### Task 3: dataTree.ts — subdir constants, eager tree, self-gitignore

Single source of truth for the tree shape; stores switch to the new subdir names; the daemon materializes everything eagerly.

**Files:**

- Create: `src/dataTree.ts`
- Modify: `src/assessReview.ts:31` (`"assess-review"` → constant), `src/commentReview.ts:32`, `src/githubOutbox.ts:95`, `src/watchlist.ts:23`, `src/dashboardCmd.ts:105`, `src/tui/localSnapshot.ts:142`, `src/daemon.ts:277-282` (`defaultMkdirs`)
- Test: `tests/dataTree.test.ts` (create)

**Interfaces:**

- Consumes: `Config.dataDir`, `Config.queueRoot`, `queuePaths` (Task 2).
- Produces (exact exports of `src/dataTree.ts`):

```ts
export const REVIEW_ASSESS_SUBDIR = "review/assess";
export const REVIEW_COMMENTS_SUBDIR = "review/comments";
export const OUTBOX_SUBDIR = "outbox";
export const MIRROR_SUBDIR = "mirror";
export const CLONES_WATCHED_SUBDIR = "clones/watched";
export const CLONES_EXTERNAL_SUBDIR = "clones/external";
export const WATCHLIST_FILENAME = "watchlist.json";
export interface DataTreePaths {
  root: string;
  queue: Paths; // from queuePaths(cfg)
  reviewAssess: string; // + "/filed" archive
  reviewComments: string; // + "/posted", "/discarded" archives
  outbox: string; // + "/dead"
  mirror: string;
  clonesWatched: string;
  clonesExternal: string; // NOTE: cfg.github.externalReposRoot (legacy-overridable)
  worktrees: string; // NOTE: cfg.worktreeRoot (legacy-overridable)
  transcripts: string;
  watchlistFile: string;
  spendFile: string;
  metricsFile: string; // PR 3 writes it; listed now
  logFile: string;
  migratedFile: string; // dataMigrate journal (Task 4)
}
export function dataTreePaths(cfg: Config): DataTreePaths;
export interface EnsureDataTreeDeps {
  mkdirFn?: (d: string) => void;
  existsFn?: (p: string) => boolean;
  writeFn?: (p: string, s: string) => void;
}
export function ensureDataTree(cfg: Config, deps?: EnsureDataTreeDeps): void;
```

- [ ] **Step 1: Write the failing test**

`tests/dataTree.test.ts` (use a full-`Config` fixture copied from `tests/daemon.test.ts`'s `makeConfig` after Task 2; only `dataDir`/`queueRoot`/`worktreeRoot`/`github.externalReposRoot` matter):

```ts
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { dataTreePaths, ensureDataTree } from "../src/dataTree.js";

describe("dataTreePaths", () => {
  it("derives every path from dataDir and honors legacy-overridable roots", () => {
    const cfg = makeConfig({
      dataDir: "/sbxroot/data",
      queueRoot: "/sbxroot/data/queue",
      worktreeRoot: "/sbxroot/wt-legacy",
    });
    const p = dataTreePaths(cfg);
    expect(p.root).toBe("/sbxroot/data");
    expect(p.queue.inbox).toBe("/sbxroot/data/queue/inbox");
    expect(p.reviewAssess).toBe("/sbxroot/data/review/assess");
    expect(p.reviewComments).toBe("/sbxroot/data/review/comments");
    expect(p.outbox).toBe("/sbxroot/data/outbox");
    expect(p.mirror).toBe("/sbxroot/data/mirror");
    expect(p.clonesWatched).toBe("/sbxroot/data/clones/watched");
    expect(p.worktrees).toBe("/sbxroot/wt-legacy"); // legacy override respected
    expect(p.transcripts).toBe("/sbxroot/data/transcripts");
    expect(p.watchlistFile).toBe("/sbxroot/data/watchlist.json");
    expect(p.migratedFile).toBe("/sbxroot/data/migrated.json");
  });
});

describe("ensureDataTree", () => {
  it("mkdirs the full tree incl. archives/dead and writes the * gitignore once", () => {
    const made: string[] = [];
    const writes: Record<string, string> = {};
    const existing = new Set<string>();
    const deps = {
      mkdirFn: (d: string) => made.push(d),
      existsFn: (p: string) => existing.has(p),
      writeFn: (p: string, s: string) => {
        writes[p] = s;
      },
    };
    const cfg = makeConfig({ dataDir: "/sbxroot/data", queueRoot: "/sbxroot/data/queue" });
    ensureDataTree(cfg, deps);
    for (const d of [
      "/sbxroot/data/queue/inbox",
      "/sbxroot/data/queue/processing",
      "/sbxroot/data/queue/done",
      "/sbxroot/data/queue/failed",
      "/sbxroot/data/review/assess/filed",
      "/sbxroot/data/review/comments/posted",
      "/sbxroot/data/review/comments/discarded",
      "/sbxroot/data/outbox/dead",
      "/sbxroot/data/mirror",
      "/sbxroot/data/clones/watched",
      "/sbxroot/data/transcripts",
    ])
      expect(made).toContain(d);
    expect(writes["/sbxroot/data/.gitignore"]).toBe("*\n");
    // second run with the gitignore present: no rewrite
    existing.add("/sbxroot/data/.gitignore");
    const before = Object.keys(writes).length;
    ensureDataTree(cfg, deps);
    expect(Object.keys(writes).length).toBe(before);
  });

  it("does NOT create legacy-overridden roots outside dataDir", () => {
    const made: string[] = [];
    const cfg = makeConfig({
      dataDir: "/sbxroot/data",
      queueRoot: "/sbxroot/elsewhere/Junco",
      legacy: { vaultRoot: true, stateDir: false, worktreeRoot: false, externalReposRoot: false },
    });
    ensureDataTree(cfg, { mkdirFn: (d) => made.push(d), existsFn: () => false, writeFn: () => {} });
    expect(made).toContain("/sbxroot/elsewhere/Junco/inbox"); // queue is still ensured (daemon needs it)
    expect(made.some((d) => d.startsWith("/sbxroot/data/queue"))).toBe(false); // but not a phantom default queue
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/dataTree.test.ts > /tmp/t3 2>&1; echo "exit: $?"` → FAIL (module missing).

- [ ] **Step 3: Implement `src/dataTree.ts`**

```ts
/**
 * The single source of truth for the unified data tree's shape (spec
 * 2026-07-16 §4). Subdir constants are imported by the stores
 * (assessReview/commentReview/githubOutbox/watchlist/dashboard) so the tree
 * and its writers can never drift; ensureDataTree materializes everything
 * eagerly at daemon startup so no directory is invisible-until-first-use.
 */
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config, Paths } from "./types.js";
import { queuePaths } from "./config.js";

export const REVIEW_ASSESS_SUBDIR = "review/assess";
export const REVIEW_COMMENTS_SUBDIR = "review/comments";
export const OUTBOX_SUBDIR = "outbox";
export const MIRROR_SUBDIR = "mirror";
export const CLONES_WATCHED_SUBDIR = "clones/watched";
export const CLONES_EXTERNAL_SUBDIR = "clones/external";
export const WATCHLIST_FILENAME = "watchlist.json";

export interface DataTreePaths {
  /* …exactly the Interfaces block above… */
}

export function dataTreePaths(cfg: Config): DataTreePaths {
  const r = cfg.dataDir;
  return {
    root: r,
    queue: queuePaths(cfg),
    reviewAssess: join(r, REVIEW_ASSESS_SUBDIR),
    reviewComments: join(r, REVIEW_COMMENTS_SUBDIR),
    outbox: join(r, OUTBOX_SUBDIR),
    mirror: join(r, MIRROR_SUBDIR),
    clonesWatched: join(r, CLONES_WATCHED_SUBDIR),
    clonesExternal: cfg.github.externalReposRoot,
    worktrees: cfg.worktreeRoot,
    transcripts: join(r, "transcripts"),
    watchlistFile: join(r, WATCHLIST_FILENAME),
    spendFile: join(r, "spend.json"),
    metricsFile: join(r, "metrics.json"),
    logFile: join(r, "worker.log"),
    migratedFile: join(r, "migrated.json"),
  };
}

export interface EnsureDataTreeDeps {
  mkdirFn?: (d: string) => void;
  existsFn?: (p: string) => boolean;
  writeFn?: (p: string, s: string) => void;
}

export function ensureDataTree(cfg: Config, deps: EnsureDataTreeDeps = {}): void {
  const mkdirFn = deps.mkdirFn ?? ((d: string) => mkdirSync(d, { recursive: true }));
  const existsFn = deps.existsFn ?? existsSync;
  const writeFn = deps.writeFn ?? ((p: string, s: string) => writeFileSync(p, s, "utf8"));
  const p = dataTreePaths(cfg);
  const dirs = [
    p.queue.inbox,
    p.queue.processing,
    p.queue.done,
    p.queue.failed,
    join(p.reviewAssess, "filed"),
    join(p.reviewComments, "posted"),
    join(p.reviewComments, "discarded"),
    join(p.outbox, "dead"),
    p.mirror,
    p.clonesWatched,
    p.transcripts,
  ];
  for (const d of dirs) mkdirFn(d);
  const gi = join(p.root, ".gitignore");
  if (!existsFn(gi)) writeFn(gi, "*\n"); // self-ignoring root; an operator-customized file is respected
}
```

(Note `ensureDataTree` does not mkdir `clonesExternal`/`worktrees` — `externalRepo.ts`/`worktree.ts` create those on demand and they may be legacy-overridden outside the root; and when `legacy.vaultRoot` is set, the queue dirs it creates are the legacy ones via `queuePaths` — exactly what the daemon needs.)

Store switches (import the constants):

- `src/assessReview.ts:31` → `makeReviewStore<PendingAssess>(REVIEW_ASSESS_SUBDIR, [...unchanged archives...])`
- `src/commentReview.ts:32` → `makeReviewStore<PendingComment>(REVIEW_COMMENTS_SUBDIR)`
- `src/githubOutbox.ts:95` → `const dir = join(cfg.dataDir, OUTBOX_SUBDIR);`
- `src/watchlist.ts:23` → `return join(cfg.dataDir, WATCHLIST_FILENAME);`
- `src/dashboardCmd.ts:105` → `clonesDir: join(c.dataDir, CLONES_WATCHED_SUBDIR),`
- `src/tui/localSnapshot.ts:142` → `walkOwnerName(join(cfg.dataDir, CLONES_WATCHED_SUBDIR), "clone", readdirFn)`
- `src/daemon.ts` `defaultMkdirs` body → `ensureDataTree(cfg);` (keep the `mkdirs` deps seam name).

Also update the stores' header comments (`<state_dir>/assess-review/` → `<dataDir>/review/assess/` etc.) — the Hard Rules say comments must stay true.

- [ ] **Step 4: Run** — `npx vitest run tests/dataTree.test.ts > /tmp/t3 2>&1; echo "exit: $?"` → PASS, then full suite + typecheck sweep (fixtures may reference `"assess-review"` paths — update to the constants). Expect existing reviewStore/outbox tests that pass explicit dirs to be unaffected (they inject `cfg`).

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(dataTree): canonical tree shape, eager materialization, self-gitignoring root"`

---

### Task 4: dataMigrate.ts — in-place state-tree migration

**Files:**

- Create: `src/dataMigrate.ts`
- Modify: `src/daemon.ts` (mainLoop startup: migrate BEFORE `mkdirs(cfg)`; new `migrateFn` deps seam defaulting to `migrateStateTree`)
- Test: `tests/dataMigrate.test.ts` (create; real tmp dirs — same pattern as repo tests)

**Interfaces:**

- Consumes: `dataTreePaths`, `Config.legacy` (Tasks 1-3).
- Produces:

```ts
export interface MigrationStep {
  from: string;
  to: string;
  action: "renamed" | "skipped-conflict" | "noop";
}
export interface MigrateResult {
  steps: MigrationStep[];
  conflicts: string[];
}
export interface MigrateDeps {
  existsFn?;
  renameFn?;
  readdirFn?;
  rmdirFn?;
  readFileFn?;
  writeFileFn?;
}
export function stateTreeMigrations(cfg: Config): Array<{ from: string; to: string }>;
export function migrateStateTree(cfg: Config, deps?: MigrateDeps): MigrateResult;
export function pendingMigrations(cfg: Config, existsFn?): Array<{ from: string; to: string }>; // for doctor/data
```

- [ ] **Step 1: Write the failing tests**

`tests/dataMigrate.test.ts` — real `mkdtempSync` tmp roots:

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateStateTree, pendingMigrations } from "../src/dataMigrate.js";

function freshRoot(): string {
  return mkdtempSync(join(tmpdir(), "junco-dm-"));
}
// makeConfig fixture with dataDir pointed at the tmp root, legacy flags all false

it("renames every old-name subdir into the new tree and journals", () => {
  const root = freshRoot();
  mkdirSync(join(root, "assess-review", "filed"), { recursive: true });
  writeFileSync(join(root, "assess-review", "a.json"), "{}");
  mkdirSync(join(root, "github-outbox", "dead"), { recursive: true });
  mkdirSync(join(root, "repos", "o", "r"), { recursive: true });
  mkdirSync(join(root, "external", "o2"), { recursive: true });
  mkdirSync(join(root, "comment-review"), { recursive: true });
  writeFileSync(join(root, "github-watchlist.json"), "[]");
  const res = migrateStateTree(makeConfig({ dataDir: root, queueRoot: join(root, "queue") }));
  expect(existsSync(join(root, "review/assess/a.json"))).toBe(true);
  expect(existsSync(join(root, "review/assess/filed"))).toBe(true);
  expect(existsSync(join(root, "outbox/dead"))).toBe(true);
  expect(existsSync(join(root, "clones/watched/o/r"))).toBe(true);
  expect(existsSync(join(root, "clones/external/o2"))).toBe(true);
  expect(existsSync(join(root, "review/comments"))).toBe(true);
  expect(existsSync(join(root, "watchlist.json"))).toBe(true);
  expect(existsSync(join(root, "assess-review"))).toBe(false);
  expect(res.conflicts).toEqual([]);
  const journal = JSON.parse(readFileSync(join(root, "migrated.json"), "utf8"));
  expect(journal.steps.filter((s: { action: string }) => s.action === "renamed").length).toBe(6);
});

it("is idempotent — a second run is all noops", () => {
  const root = freshRoot();
  mkdirSync(join(root, "github-outbox"), { recursive: true });
  const cfg = makeConfig({ dataDir: root, queueRoot: join(root, "queue") });
  migrateStateTree(cfg);
  const res2 = migrateStateTree(cfg);
  expect(res2.steps.every((s) => s.action === "noop")).toBe(true);
});

it("empty destination is removed and the rename proceeds (crash-after-mkdir)", () => {
  const root = freshRoot();
  mkdirSync(join(root, "assess-review"), { recursive: true });
  writeFileSync(join(root, "assess-review", "a.json"), "{}");
  mkdirSync(join(root, "review", "assess"), { recursive: true }); // empty dst
  const res = migrateStateTree(makeConfig({ dataDir: root, queueRoot: join(root, "queue") }));
  expect(existsSync(join(root, "review/assess/a.json"))).toBe(true);
  expect(res.conflicts).toEqual([]);
});

it("non-empty both sides → skipped-conflict, nothing destroyed", () => {
  const root = freshRoot();
  mkdirSync(join(root, "assess-review"), { recursive: true });
  writeFileSync(join(root, "assess-review", "old.json"), "{}");
  mkdirSync(join(root, "review", "assess"), { recursive: true });
  writeFileSync(join(root, "review", "assess", "new.json"), "{}");
  const res = migrateStateTree(makeConfig({ dataDir: root, queueRoot: join(root, "queue") }));
  expect(res.conflicts).toHaveLength(1);
  expect(existsSync(join(root, "assess-review/old.json"))).toBe(true);
  expect(existsSync(join(root, "review/assess/new.json"))).toBe(true);
});

it("legacy-overridden subtrees are excluded from the migration list", () => {
  const root = freshRoot();
  const cfg = makeConfig({
    dataDir: root,
    queueRoot: join(root, "queue"),
    github: { ...base.github, externalReposRoot: "/sbxroot/custom-ext" },
    legacy: { vaultRoot: false, stateDir: false, worktreeRoot: false, externalReposRoot: true },
  });
  expect(pendingMigrations(cfg).some((m) => m.from.endsWith("/external"))).toBe(false);
});
```

- [ ] **Step 2: Run to verify failure** — module missing.

- [ ] **Step 3: Implement `src/dataMigrate.ts`**

```ts
/**
 * In-place state-tree migration (spec 2026-07-16 §7): same-directory renames
 * from the pre-unification names to the dataTree.ts names, journaled to
 * <dataDir>/migrated.json. Runs at daemon startup (before ensureDataTree —
 * eager mkdir would otherwise fabricate empty destinations) and from
 * `junco data migrate` (`junco data` only REPORTS pending migrations).
 * github-cache/ is deliberately NOT touched until PR 2 (tui/ghClient.ts
 * still owns it).
 */
import {
  existsSync,
  renameSync,
  readdirSync,
  rmdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { mkdirSync } from "node:fs";
import type { Config } from "./types.js";
import { dataTreePaths } from "./dataTree.js";

export function stateTreeMigrations(cfg: Config): Array<{ from: string; to: string }> {
  const r = cfg.dataDir;
  const p = dataTreePaths(cfg);
  const list = [
    { from: join(r, "assess-review"), to: p.reviewAssess },
    { from: join(r, "comment-review"), to: p.reviewComments },
    { from: join(r, "github-outbox"), to: p.outbox },
    { from: join(r, "repos"), to: p.clonesWatched },
    { from: join(r, "github-watchlist.json"), to: p.watchlistFile },
  ];
  // external/ only migrates when the external root is NOT legacy-overridden
  // (an explicit externalReposRoot keeps clones wherever the operator put them).
  if (!cfg.legacy.externalReposRoot) list.push({ from: join(r, "external"), to: p.clonesExternal });
  return list;
}

export function pendingMigrations(
  cfg: Config,
  existsFn: (p: string) => boolean = existsSync,
): Array<{ from: string; to: string }> {
  return stateTreeMigrations(cfg).filter((m) => existsFn(m.from));
}

// migrateStateTree(cfg, deps): for each pending {from,to}:
//   - dst missing            → mkdir(dirname(to)), rename, journal "renamed"
//   - dst exists and EMPTY   → rmdir(dst), rename, journal "renamed"   (crash-after-mkdir repair)
//   - dst exists non-empty AND src non-empty → journal "skipped-conflict", push to conflicts
//   - src missing            → journal "noop"
// Journal: read migrated.json if present ({version:1, steps:[...]}), append this
// run's steps, atomic tmp+rename write. Never throws on a conflict — reports it.
```

Implement exactly those rules (files count as "non-empty src" always; for the watchlist FILE pair, "dst exists" alone → skipped-conflict). Wire into `src/daemon.ts` `mainLoop`: add `migrateFn?: (cfg: Config) => MigrateResult` to `MainLoopDeps`; call `const mig = (deps.migrateFn ?? migrateStateTree)(cfg);` immediately BEFORE `mkdirs(cfg)` (daemon.ts:548-551) and `log.warn` each conflict.

- [ ] **Step 4: Run** — new tests PASS; `npx vitest run tests/daemon.test.ts` PASS (fixture gains no-op migrateFn if the real one touches tmp dirs unhelpfully — inject `migrateFn: () => ({ steps: [], conflicts: [] })` in daemon fixtures). Full suite + typecheck sweep.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(dataMigrate): journaled in-place state-tree migration at daemon startup"`

---

### Task 5: `junco data migrate` — explicit full unification

**Files:**

- Create: `src/dataMigrateCmd.ts`
- Modify: `src/cli.ts` (route `data migrate` before the plain `data` route Task 6 adds; help text)
- Test: `tests/dataMigrateCmd.test.ts` (create)

**Interfaces:**

- Consumes: `migrateStateTree`, `pendingMigrations`, `dataTreePaths`, `queuePaths`, `configDeprecations`, `validateConfigObject`, `HEALTH_TIMEOUT_MS`.
- Produces: `runDataMigrate(cfg, configPath, opts: { dryRun: boolean; force: boolean }, deps): Promise<number>` (exit code), exported from `src/dataMigrateCmd.ts`. Deps seam: `{ fetchFn?, existsFn?, renameFn?, readFileFn?, writeFileFn?, printFn?, migrateFn?, copyDirFn? }`.

Behavior (spec §7 "Explicit"):

1. **Daemon-up refusal:** probe `http://<healthHost>:<healthPort>/health` with an AbortController timeout of `HEALTH_TIMEOUT_MS` (copy the `fetchCurrentTickets` pattern from `src/worktreePruneCmd.ts:198-210`). Respond 200 → print refusal, exit 1. Unreachable → proceed. `--force` skips the probe (documented for health-disabled setups). Then take the migration lock: `acquirePidfileLock(join(cfg.dataDir, "migrate.lock"))` (`src/pidfileLock.ts`) — held for the whole run, released in a `finally`; a held lock → print "another migrate is running", exit 1.
2. **Plan:** queue move steps (when `cfg.legacy.vaultRoot`: for each of inbox/processing/done/failed, `<legacy queue>/<dir>` → `<dataDir>/queue/<dir>`) + `pendingMigrations(cfg)` + config rewrite summary. `--dry-run` prints the plan and exits 0 without acting.
3. **Queue move:** per dir, try `renameFn`; on `EXDEV` fall back to recursive copy + per-file size verify + delete source (`copyDirFn` seam).
4. **State tree:** `migrateFn(cfg)` (default `migrateStateTree`); conflicts print and exit 1 AFTER completing the non-conflicted steps.
5. **Config rewrite:** read `configPath` raw JSON; delete `vaultRoot`, `juncoSubdir`, `observability.stateDir` (delete an emptied `observability` object too); set top-level `dataDir` only when the resolved `cfg.dataDir` differs from the expanded default `~/.local/state/junco`; `validateConfigObject(obj)`; atomic tmp+rename write.
6. Print a receipt of every action taken.

- [ ] **Step 1: Write failing tests** — cover: dry-run acts on nothing (inject spies, assert zero renames/writes); daemon-up refusal (fake `fetchFn` returning `{ok:true}` → exit 1, no actions); happy path on real tmp dirs (legacy vaultRoot queue with one ticket file in `inbox/` moves; config.json on disk loses `vaultRoot`/`juncoSubdir`/`observability.stateDir` and gains nothing when dataDir is default; result validates via `loadConfig`); non-default dataDir gets written explicitly.
- [ ] **Step 2: Verify failure.**
- [ ] **Step 3: Implement** `src/dataMigrateCmd.ts` per the behavior list; wire in `src/cli.ts` (add to the Usage block at cli.ts:170-190: `  data         Print the data tree; 'data migrate' unifies legacy roots`).
- [ ] **Step 4: Run** new tests + full gate.
- [ ] **Step 5: Commit** — `feat(cli): junco data migrate — explicit queue+state unification with config rewrite`

---

### Task 6: `junco data` — the visibility command

**Files:**

- Create: `src/dataCmd.ts`
- Modify: `src/cli.ts` (route `data` after `data migrate`; keep `inbox-path` untouched)
- Test: `tests/dataCmd.test.ts` (create)

**Interfaces:**

- Consumes: `dataTreePaths`, `pendingMigrations`, `configDeprecations`, `pendingCount` (`src/assessReview.ts`), `draftCount` (`src/commentReview.ts`), `queuePaths`.
- Produces: `runData(cfg, opts: { json: boolean }, deps): number`, deps seam `{ readdirFn?, statFn?, existsFn?, readFileFn?, printFn? }`.

Output contract (human mode) — one line per tree node: resolved path, counts, provenance. Counts: queue = `.md` files per state dir; review = pending JSON count + archive counts; outbox = op files (excluding `dead/` and lock files) + dead count; mirror = repo dirs + summed issue/pr files (0 until PR 2); clones = owner/repo dir count per side; worktrees = subdir count; transcripts = file count + total bytes; root files = exists/size (spend.json also prints the summed USD if parseable). Legacy-overridden roots get a ` ← legacy override: <key>  [deprecated]` suffix. Pending migrations print a final `⚠ unmigrated: <from> → <to> (run 'junco data migrate')` block. Every directory is listed even when absent (`(absent)` marker). `--json` emits `{ root, paths: {...}, counts: {...}, legacy: {...}, pendingMigrations: [...], deprecations: [...] }`.

- [ ] **Step 1: Write failing tests** — build a real tmp tree (2 inbox tickets, 1 pending assess JSON + 1 filed, 1 dead outbox op, absent mirror), assert: printed lines contain `inbox 2`, `assess    1 pending · 1 filed`, `dead 1`, `mirror` with `(absent)`, the legacy suffix when `legacy.vaultRoot` is true, and the unmigrated warning when an `assess-review/` dir exists. `--json` parses and matches the same numbers.
- [ ] **Step 2: Verify failure.**
- [ ] **Step 3: Implement** `src/dataCmd.ts` + cli routing (`if (subcommand === "data")` → dispatch `argv[1] === "migrate"` to Task 5's `runDataMigrate`, else `runData`; `--json` flag).
- [ ] **Step 4: Run** new tests + full gate.
- [ ] **Step 5: Commit** — `feat(cli): junco data — resolved tree, counts, provenance, --json`

---

### Task 7: Surfacing — startup warnings, doctor checks

**Files:**

- Modify: `src/cli.ts` (start path: after `loadConfig`, `log.warn` each `configDeprecations(cfg)` line once)
- Modify: `src/doctor.ts` (new section: deprecations as warn-level findings; `pendingMigrations` non-empty → warn with the migrate hint; legacy `worktreeRoot` dir non-empty → info hint per spec §7)
- Test: `tests/doctor.test.ts` (extend — the file's existing fake-deps pattern)

**Interfaces:** consumes `configDeprecations`, `pendingMigrations` only.

- [ ] **Step 1: Failing tests** — doctor run with a legacy-keyed cfg reports a `deprecated config keys` warning listing `vaultRoot`; with a fake `existsFn` making `<dataDir>/assess-review` exist, reports `unmigrated data dirs`; clean cfg reports neither.
- [ ] **Step 2: Verify failure.** **Step 3: Implement.** **Step 4: Full gate.**
- [ ] **Step 5: Commit** — `feat(doctor): deprecation + pending-migration findings; startup deprecation warnings`

---

### Task 8: Wizard scaffolds dataDir (fresh configs are never born deprecated)

**Files:**

- Modify: `src/wizard/flow.ts` (`WizardAnswers.vaultRoot` → `dataDir`; `defaultAnswers` → `dataDir: "~/.local/state/junco"`; `buildConfigObject:85` → omit the key entirely when the answer equals the default, else `{ dataDir: a.dataDir }` — never write `vaultRoot`/`juncoSubdir`; `coveredPaths:143` → `{ path: "dataDir", value: a.dataDir === "~/.local/state/junco" ? undefined : a.dataDir }`; `answersFromConfig:183` → prefill from `g("dataDir")`, falling back to the default — a legacy config's `vaultRoot` is deliberately NOT prefilled into the dataDir answer)
- Modify: the Workspace chapter copy (find it: `grep -rn "Workspace\|vaultRoot" src/wizard/ src/tui/` — the chapter UI component) — question becomes "Where should junco keep its data (queue, reviews, transcripts)?" with the XDG default shown
- Modify: `src/wizard.ts` / `src/wizard/detect.ts` label `"state dir"` → `"data dir"`
- Test: `tests/wizardFlow.test.ts` (the round-trip pin: `renderConfigJson` output must `loadConfig` cleanly AND `configDeprecations` of the result must be `[]`), plus whatever FTUE test pins `"~/Junco"` (find: `grep -rn '~/Junco' tests/ scripts/` — update pins; the packaged-CLI smoke test in CI may pin the scaffold shape too: check `scripts/` and `.github/workflows/quality-gate.yml`)

**Interfaces:** consumes schema `dataDir` (Task 1). Produces: `WizardAnswers.dataDir: string` (renamed field — update every wizard test fixture).

- [ ] **Step 1: Failing tests** — extend `tests/wizardFlow.test.ts`: default answers render a config JSON with NO `vaultRoot`, NO `juncoSubdir`, NO `dataDir` key (all defaults); a custom data root renders `{ "dataDir": "~/custom" }`; both round-trip through `loadConfig` with zero `configDeprecations`; re-run `answersFromConfig` on a legacy `{ vaultRoot: "~/V" }` config prefils `dataDir` with the DEFAULT (not `~/V`) and an untouched rerun diff is a no-op (never deletes the user's vaultRoot behind their back).
- [ ] **Step 2: Verify failure.** **Step 3: Implement** (mechanical rename + the four functions; chapter copy). **Step 4: Full gate** + `grep -rn '~/Junco' src/ tests/ scripts/` → only historical docs/comments remain.
- [ ] **Step 5: Commit** — `feat(wizard): scaffold dataDir; fresh configs carry no deprecated keys`

---

### Task 9: Docs + CHANGELOG + ARCHITECTURE

**Files:**

- Modify: `docs/configuration.md` (new `dataDir` section: the tree from spec §4, resolution/precedence, deprecation table, `junco data` + `junco data migrate` usage), `docs/operations.md:72-74` (worker.log/transcripts paths → `<dataDir>/…`), `docs/github-mode.md:79,91` (`<stateDir>/github-outbox/` → `<dataDir>/outbox/`), `docs/assess.md:156` + `docs/analyze.md:148` (outbox + review paths), `docs/dashboard.md:42,68` (clones path `<dataDir>/clones/watched/…`, watchlist `<dataDir>/watchlist.json`), `docs/bot-account.md:164` (watchlist path), `ARCHITECTURE.md` (module table rows for `dataTree.ts`, `dataMigrate.ts`, `dataCmd.ts`, `dataMigrateCmd.ts`; update `config.ts`/`reviewStore.ts`/`githubOutbox.ts` row path mentions), `CHANGELOG.md` (Unreleased → Added: dataDir/junco data/junco data migrate; Changed: default locations table old→new; Deprecated: the four keys), `README.md` (only if it names any old path — grep first)
- Test: none (docs) — but `npm run format:check` covers them

**Steps:**

- [ ] **Step 1: Sweep for stale paths** — `grep -rn "state_dir\|stateDir\|github-outbox\|assess-review\|comment-review\|~/junco/worktrees" docs/ README.md ARCHITECTURE.md` and fix every hit to the new canonical paths (keeping "legacy override" notes where the docs explain deprecation).
- [ ] **Step 2: Write the configuration.md section + CHANGELOG entries** (copy the tree diagram verbatim from the spec).
- [ ] **Step 3: `npm run format:check`** (run `npx prettier --write` on touched md files if needed).
- [ ] **Step 4: Commit** — `docs: unified data root — configuration, paths, migration guide, changelog`

---

### Task 10: Full gate, branch PR

- [ ] **Step 1:** `npm run lint && npm run format:check && npm run typecheck && npm run build && npx vitest run > /tmp/gate 2>&1; echo "exit: $?"` — exit 0 required; also re-run the tests-typecheck sweep vs the Task 2 baseline.
- [ ] **Step 2:** Verify no attribution trailers slipped in: `git log origin/main..HEAD --format='%b' | grep -i "claude\|generated" ` → empty; amend/reword if not.
- [ ] **Step 3:** Push `feat/unified-data-root`, open the PR against `main` titled `feat: unified data root (dataDir) — one tree, legacy overrides, migration, junco data`, body: summary, the tree, precedence rules, migration semantics, test evidence, spec/plan links, follow-up note ("PR 2: mirror/ replaces github-cache; PR 3: metrics.json").
- [ ] **Step 4:** Confirm the `quality-gate` check goes green.

---

## Self-review notes (already applied)

- Spec §7 lists `github-cache → deleted`; this plan defers that deletion to PR 2 because `tui/ghClient.ts` still owns the cache until the mirror exists — deleting in PR 1 would only force a rebuild. Global Constraints records the deviation.
- Spec §7's "daemon-up refusal via pidfile": there is no daemon pidfile today; the plan uses the established `/health` probe pattern (`worktreePruneCmd.ts`) with `--force` as the health-disabled escape hatch.
- `ensureDataTree` runs AFTER `migrateStateTree` in daemon startup — ordering is load-bearing (eager mkdir would fabricate empty destinations; the empty-dst repair rule exists for the crash window, not for routine use).
- The wizard rerun on a legacy config deliberately does NOT auto-drop `vaultRoot` — that is `junco data migrate`'s job (explicit, daemon-down, with the queue move). Doctor nudges.
