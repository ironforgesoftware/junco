# Unwatch Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `junco unwatch <nwo>` deletes a repo's junco-owned operational state (plan/confirm/execute), and the dashboard's unwatch verb becomes a guarded, itemized-confirm flow driving that command.

**Architecture:** A new pure module `src/unwatchCmd.ts` (injectable deps, no SDK) exposes `planUnwatch` (read-only enumeration across watchlist/queue/worktrees/outbox/reviews/history/mirror/cache, with a processing-ticket blocker), `runUnwatch` (ordered deletion, watchlist entry first, clone last, per-item failure isolation, residue mode for idempotent re-runs), and `runUnwatchCommand` (print/exit-code layer). `src/cli.ts` wires the subcommand (`--plan` flag prints single-line JSON); the TUI turns `unwatch` into a guarded mnemonic that spawns `--plan`, shows an itemized `useConfirm` modal, and spawns the execute on `y`.

**Tech Stack:** TypeScript strict ESM (NodeNext), vitest, ink-testing-library. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-19-unwatch-cleanup-design.md` — read it first; every task below implements a spec section.

## Global Constraints

- Node ≥ 22.19, ESM/NodeNext, strict TS. No new npm dependencies.
- Never import the Pi SDK at module top level (this feature never needs it at all).
- Every side effect behind an injectable `deps` seam; tests never touch network or a real model.
- `src/ticketSchema.ts` is untouched (no schema change in this feature).
- Conventional commits (`feat:`/`test:`/`docs:` + optional scope); suite green at every commit; **no AI-attribution trailers** — if a commit gains a `Co-Authored-By: Claude` or "Generated with" line, amend it away.
- Run `npx prettier --write` on touched files before every commit; re-read files before editing if prettier may have reformatted them.
- Vitest exit-code trap: never pipe vitest into a filter; use `npx vitest run <file> > /tmp/out 2>&1; echo "exit: $?"`.
- Tests use tmpdir trees (`mkdtempSync`) or synthetic `/sbxroot/...` paths — never the repo's live `config.json`/`tickets/`/`worktrees/`.
- Ink tests: never assert one fixed tick after a state change — loop `until(...)` with bounded retry (`tests/helpers/until.ts`).
- Full gate before claiming done: `npm run lint && npm run format:check && npm run typecheck && npm run build && npm test`.

---

## Shared interfaces (defined in Task 1, consumed everywhere)

All in `src/unwatchCmd.ts`:

```ts
export type UnwatchRefusal = "config-defined" | "watchlist-unreadable";

export type PlanItemKind =
  | "clone"
  | "inbox-ticket"
  | "worktrees"
  | "outbox-op"
  | "assess-review"
  | "comment-review"
  | "assess-history"
  | "mirror"
  | "github-cache";

export interface PlanItem {
  kind: PlanItemKind;
  path: string; // absolute path affected
  detail?: string; // ticket id, op issueKey/kind, review id …
}

export interface UnwatchPlan {
  nwo: string; // watchlist casing when watched; input casing in residue mode
  mode: "watched" | "residue";
  external: boolean; // fork-PR entry (always false in residue mode)
  clone: { path: string; managed: boolean } | null; // managed:false ⇒ kept
  items: PlanItem[]; // everything that WILL be deleted
  kept: string[]; // human lines, e.g. "clone (user-owned): /home/me/api"
  blocked: { ticketId: string } | null;
}

export type PlanOutcome =
  | { ok: false; reason: UnwatchRefusal }
  | { ok: true; plan: UnwatchPlan };

export interface SummaryRow {
  kind: PlanItemKind | "watchlist-entry";
  path: string;
  outcome: "deleted" | "kept" | "failed";
  detail?: string;
  reason?: string; // failure reason
}

export interface UnwatchResult {
  ok: boolean; // false when refused, blocked, or any row failed
  refused: UnwatchRefusal | "blocked" | null;
  blockedTicketId: string | null;
  watchlistRemoved: boolean;
  summary: SummaryRow[];
}

export interface UnwatchDeps {
  readdirFn?: (d: string) => string[];
  readFileFn?: (p: string) => string;
  existsFn?: (p: string) => boolean;
  /** Single-file removal (tickets, outbox ops, cache files, history file). Default fs.unlinkSync. */
  unlinkFn?: (p: string) => void;
  /** Recursive removal (worktree namespace, managed clone). Default rmSync(p, {recursive:true, force:true}). */
  rmFn?: (p: string) => void;
  /** Review-store archive pass-through. Defaults inside reviewStore. */
  renameFn?: (a: string, b: string) => void;
  mkdirFn?: (d: string) => void;
  /** Non-throwing git runner, worktreePruneCmd shape. Default: git(cfg, args, {cwd, check:false}). */
  gitFn?: (args: string[], cwd: string) => Promise<{ code: number; stdout: string }>;
  /** Default: () => acquirePidfileLock(worktreesLockPath(cfg)). */
  acquireLockFn?: () => PidfileLock | null;
}

export function canonPath(p: string): string; // realpathSync if it exists, else resolve
export function isUnder(child: string, root: string): boolean; // canon both; child !== root && startsWith(root + sep)
export function planUnwatch(cfg: Config, nwo: string, deps?: UnwatchDeps): PlanOutcome; // sync
export function runUnwatch(cfg: Config, nwo: string, deps?: UnwatchDeps): Promise<UnwatchResult>;
export function runUnwatchCommand(
  cfg: Config,
  args: string[],
  values: { plan: boolean },
  deps?: UnwatchDeps & { printFn?: (s: string) => void },
): Promise<number>;
```

## Shared test fixture (created in Task 1, reused by Tasks 2–5)

Top of `tests/unwatchCmd.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeConfig } from "./helpers/config.js";
import { writeWatchlist, readWatchlist, type WatchlistEntry } from "../src/watchlist.js";
import { dataTreePaths } from "../src/dataTree.js";
import type { Config } from "../src/types.js";

/** Tmpdir data tree + full Config. `configRepos` populates cfg.github.repos. */
function makeTree(opts: { configRepos?: { nwo: string; path: string }[] } = {}): {
  root: string;
  cfg: Config;
} {
  const root = mkdtempSync(join(tmpdir(), "junco-unwatch-"));
  const cfg = makeConfig(
    {
      dataDir: join(root, "data"),
      queueRoot: join(root, "queue"),
      worktreeRoot: join(root, "worktrees"),
      tools: [],
      criticEnabled: false,
      planLintEnabled: false,
      verifyEnabled: false,
      supervisorEnabled: false,
      healthEnabled: false,
      removeWorktreeOnSuccess: false,
    },
    {
      github: {
        enabled: true,
        triggerLabel: "junco",
        askLabel: "junco:ask",
        pollIntervalSeconds: 60,
        repos: opts.configRepos ?? [],
        requireApproval: true,
        plannerModelId: null,
        externalReposRoot: join(root, "data", "cache", "clones", "external"),
      },
    },
  );
  mkdirSync(dataTreePaths(cfg).queue.inbox, { recursive: true });
  mkdirSync(dataTreePaths(cfg).queue.processing, { recursive: true });
  mkdirSync(cfg.worktreeRoot, { recursive: true });
  return { root, cfg };
}

/** Register `nwo` in the watchlist pointing at `path` (created on disk unless absent:true). */
function watch(cfg: Config, nwo: string, path: string, o: { external?: boolean; absent?: boolean } = {}): void {
  if (!o.absent) mkdirSync(path, { recursive: true });
  const entry: WatchlistEntry = { nwo, path, ...(o.external ? { external: true } : {}) };
  const file = dataTreePaths(cfg).watchlistFile;
  writeWatchlist(file, [...readWatchlist(file).entries, entry]);
}

/** Minimal PR-flow ticket file. */
function writeTicket(dir: string, id: string, repoPath: string): string {
  const p = join(dir, `${id}.md`);
  writeFileSync(p, `---\nid: ${id}\nrepo: ${repoPath}\n---\n\nDo the thing.\n`, "utf8");
  return p;
}
```

`makeConfig`'s `github` override replaces the whole ballast `github` object — the literal above restates every field (`tests/helpers/config.ts:119-128` is the source of truth; keep them in sync by eye).

---

### Task 1: `unwatchCmd` skeleton — refusals, entry resolution, clone classification

**Files:**
- Create: `src/unwatchCmd.ts`
- Create: `tests/unwatchCmd.test.ts`

**Interfaces:**
- Consumes: `readWatchlist`/`watchlistPath` (`src/watchlist.ts`), `dataTreePaths` (`src/dataTree.ts`), `Config` (`src/types.ts`).
- Produces: every type and the `canonPath`/`isUnder`/`planUnwatch` signatures from **Shared interfaces** above — later tasks extend `planUnwatch`'s body but its signature and the types are FINAL here.

- [ ] **Step 1: Write the failing tests** (fixture block above + these):

```ts
describe("planUnwatch — refusals and clone classification", () => {
  it("refuses a config-defined repo", () => {
    const { root, cfg } = makeTree({ configRepos: [{ nwo: "acme/api", path: join(root, "api") }] });
    expect(planUnwatch(cfg, "acme/api")).toEqual({ ok: false, reason: "config-defined" });
    expect(planUnwatch(cfg, "ACME/API")).toEqual({ ok: false, reason: "config-defined" }); // ci
  });

  it("refuses when the watchlist is unreadable", () => {
    const { cfg } = makeTree();
    const file = dataTreePaths(cfg).watchlistFile;
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, "{ not json", "utf8");
    expect(planUnwatch(cfg, "acme/api")).toEqual({ ok: false, reason: "watchlist-unreadable" });
  });

  it("classifies a clone under clones/watched as managed (deleted)", () => {
    const { cfg } = makeTree();
    const clone = join(dataTreePaths(cfg).clonesWatched, "acme", "api");
    watch(cfg, "acme/api", clone);
    const out = planUnwatch(cfg, "acme/api");
    if (!out.ok) throw new Error(out.reason);
    expect(out.plan.mode).toBe("watched");
    expect(out.plan.clone).toEqual({ path: clone, managed: true });
    expect(out.plan.items).toContainEqual({ kind: "clone", path: clone });
    expect(out.plan.kept).toEqual([]);
    expect(out.plan.blocked).toBeNull();
  });

  it("classifies a clone under externalReposRoot as managed, external flows through", () => {
    const { cfg } = makeTree();
    const clone = join(cfg.github.externalReposRoot, "acme", "api");
    watch(cfg, "acme/api", clone, { external: true });
    const out = planUnwatch(cfg, "acme/api");
    if (!out.ok) throw new Error(out.reason);
    expect(out.plan.external).toBe(true);
    expect(out.plan.clone).toEqual({ path: clone, managed: true });
  });

  it("keeps a user-supplied path — never a clone item", () => {
    const { root, cfg } = makeTree();
    const mine = join(root, "my-checkout");
    watch(cfg, "acme/api", mine);
    const out = planUnwatch(cfg, "acme/api");
    if (!out.ok) throw new Error(out.reason);
    expect(out.plan.clone).toEqual({ path: mine, managed: false });
    expect(out.plan.items.filter((i) => i.kind === "clone")).toEqual([]);
    expect(out.plan.kept).toEqual([`clone (user-owned): ${mine}`]);
  });
});

describe("isUnder", () => {
  it("prefix-compares with a separator guard on synthetic paths", () => {
    expect(isUnder("/sbxroot/clones/watched/a/b", "/sbxroot/clones/watched")).toBe(true);
    expect(isUnder("/sbxroot/clones/watched", "/sbxroot/clones/watched")).toBe(false);
    expect(isUnder("/sbxroot/clones/watched-evil/x", "/sbxroot/clones/watched")).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unwatchCmd.test.ts > /tmp/out 2>&1; echo "exit: $?"; tail -20 /tmp/out`
Expected: FAIL — `src/unwatchCmd.ts` does not exist.

- [ ] **Step 3: Implement** `src/unwatchCmd.ts`:

```ts
/**
 * `junco unwatch <nwo>` — plan/execute deletion of a repo's junco-owned
 * operational state when it leaves the watchlist. Spec:
 * docs/superpowers/specs/2026-08-19-unwatch-cleanup-design.md. Audit state
 * (done/failed, transcripts, history shards, outbox dead/, review archives)
 * is deliberately out of scope — see the spec's non-goals.
 */
import { realpathSync, unlinkSync, rmSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { Config } from "./types.js";
import { dataTreePaths } from "./dataTree.js";
import { readWatchlist, watchlistPath, type WatchlistEntry } from "./watchlist.js";
import type { PidfileLock } from "./pidfileLock.js";

// … the Shared-interfaces block from the plan header, verbatim …

export function canonPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

export function isUnder(child: string, root: string): boolean {
  const c = canonPath(child);
  const r = canonPath(root);
  return c !== r && c.startsWith(r + sep);
}

/** Managed ⇔ the path lives under a junco-owned clone root. */
function classifyClone(cfg: Config, path: string): { path: string; managed: boolean } {
  const p = dataTreePaths(cfg);
  const managed = isUnder(path, p.clonesWatched) || isUnder(path, p.clonesExternal);
  return { path, managed };
}

export function planUnwatch(cfg: Config, nwo: string, deps: UnwatchDeps = {}): PlanOutcome {
  const lower = nwo.toLowerCase();
  if (cfg.github.repos.some((r) => r.nwo.toLowerCase() === lower))
    return { ok: false, reason: "config-defined" };
  const { entries, error } = readWatchlist(watchlistPath(cfg));
  if (error) return { ok: false, reason: "watchlist-unreadable" };
  const entry = entries.find((e) => e.nwo.toLowerCase() === lower);
  if (!entry) return { ok: true, plan: residuePlan(cfg, nwo, deps) }; // Task 4
  return { ok: true, plan: watchedPlan(cfg, entry, deps) };
}

function watchedPlan(cfg: Config, entry: WatchlistEntry, deps: UnwatchDeps): UnwatchPlan {
  const clone = classifyClone(cfg, entry.path);
  const items: PlanItem[] = [];
  const kept: string[] = [];
  if (clone.managed) items.push({ kind: "clone", path: clone.path });
  else kept.push(`clone (user-owned): ${clone.path}`);
  // Tasks 2–3 splice queue/worktrees/outbox/reviews/history/mirror/cache items
  // and the blocker in here.
  return {
    nwo: entry.nwo,
    mode: "watched",
    external: entry.external === true,
    clone,
    items,
    kept,
    blocked: null,
  };
}

// Task 4 replaces this stub with the real residue enumeration.
function residuePlan(cfg: Config, nwo: string, deps: UnwatchDeps): UnwatchPlan {
  return { nwo, mode: "residue", external: false, clone: null, items: [], kept: [], blocked: null };
}
```

(The clone item is deliberately pushed FIRST here and reordered by `runUnwatch` at delete time — plan order is display order, delete order is Task 5's.)

- [ ] **Step 4: Run to verify pass** — same command as Step 2, expected exit 0.
- [ ] **Step 5: Prettier + commit**

```bash
npx prettier --write src/unwatchCmd.ts tests/unwatchCmd.test.ts
git add src/unwatchCmd.ts tests/unwatchCmd.test.ts
git commit -m "feat(unwatch): planUnwatch skeleton — refusals + clone classification"
```

---

### Task 2: plan enumeration — inbox tickets, worktree namespace, processing blocker

**Files:**
- Modify: `src/unwatchCmd.ts` (inside `watchedPlan`)
- Test: `tests/unwatchCmd.test.ts`

**Interfaces:**
- Consumes: `parseTicket` (`src/ticket.ts` — `parseTicket(path, raw, cfg.defaultTimeoutMinutes)` → `{ id, frontmatter }`; the raw repo path is `frontmatter["repo"]`, same read as `src/tui/queueSnapshot.ts:162-165`), `repoDiscriminator` (`src/worktree.ts:80`), `queuePaths` via `dataTreePaths(cfg).queue`.
- Produces: `PlanItem`s of kind `inbox-ticket` (path = ticket file, detail = ticket id), `worktrees` (path = namespace dir), and `plan.blocked`.

- [ ] **Step 1: Write the failing tests**

```ts
describe("planUnwatch — queue and worktrees", () => {
  it("enumerates inbox tickets targeting the repo and skips others", () => {
    const { root, cfg } = makeTree();
    const clone = join(dataTreePaths(cfg).clonesWatched, "acme", "api");
    watch(cfg, "acme/api", clone);
    const inbox = dataTreePaths(cfg).queue.inbox;
    const mine = writeTicket(inbox, "fix-1", clone);
    writeTicket(inbox, "other-1", join(root, "elsewhere"));
    writeFileSync(join(inbox, "qa-1.md"), "---\nid: qa-1\n---\n\nQ&A, no repo.\n", "utf8");
    const out = planUnwatch(cfg, "acme/api");
    if (!out.ok) throw new Error(out.reason);
    expect(out.plan.items.filter((i) => i.kind === "inbox-ticket")).toEqual([
      { kind: "inbox-ticket", path: mine, detail: "fix-1" },
    ]);
  });

  it("includes the worktree namespace dir when present", () => {
    const { cfg } = makeTree();
    const clone = join(dataTreePaths(cfg).clonesWatched, "acme", "api");
    watch(cfg, "acme/api", clone);
    const { repoDiscriminator } = await import("../src/worktree.js"); // top-of-file import in real code
    const ns = join(cfg.worktreeRoot, repoDiscriminator(clone));
    mkdirSync(ns, { recursive: true });
    const out = planUnwatch(cfg, "acme/api");
    if (!out.ok) throw new Error(out.reason);
    expect(out.plan.items).toContainEqual({ kind: "worktrees", path: ns });
  });

  it("a processing/ ticket for the repo blocks; other repos' don't", () => {
    const { root, cfg } = makeTree();
    const clone = join(dataTreePaths(cfg).clonesWatched, "acme", "api");
    watch(cfg, "acme/api", clone);
    const processing = dataTreePaths(cfg).queue.processing;
    writeTicket(processing, "other-live", join(root, "elsewhere"));
    expect((planUnwatch(cfg, "acme/api") as { ok: true; plan: UnwatchPlan }).plan.blocked).toBeNull();
    writeTicket(processing, "live-1", clone);
    const out = planUnwatch(cfg, "acme/api");
    if (!out.ok) throw new Error(out.reason);
    expect(out.plan.blocked).toEqual({ ticketId: "live-1" });
  });
});
```

(Use a plain `import { repoDiscriminator } from "../src/worktree.js"` at the top of the test file — the inline `await import` above is illustrative only.)

- [ ] **Step 2: Run to verify failure** (missing items/blocked).
- [ ] **Step 3: Implement** — add to `watchedPlan` (helpers shared with Task 4):

```ts
/** *.md tickets in `dir` whose frontmatter repo: resolves to `repoPath`. Unparsable → skipped. */
function ticketsTargeting(
  cfg: Config,
  dir: string,
  repoPath: string,
  deps: UnwatchDeps,
): { path: string; id: string }[] {
  const readdirFn = deps.readdirFn ?? readdirSync;
  const readFileFn = deps.readFileFn ?? ((p: string) => readFileSync(p, "utf8"));
  const target = canonPath(repoPath);
  let names: string[] = [];
  try {
    names = readdirFn(dir).filter((n) => n.endsWith(".md"));
  } catch {
    return []; // no dir yet
  }
  const out: { path: string; id: string }[] = [];
  for (const n of names) {
    const p = join(dir, n);
    try {
      const t = parseTicket(p, readFileFn(p), cfg.defaultTimeoutMinutes);
      const repo = t.frontmatter["repo"];
      if (typeof repo === "string" && canonPath(repo) === target) out.push({ path: p, id: t.id });
    } catch {
      /* unparsable — cannot name this repo; skip */
    }
  }
  return out;
}
```

In `watchedPlan`, after the clone classification:

```ts
const q = dataTreePaths(cfg).queue;
for (const t of ticketsTargeting(cfg, q.inbox, entry.path, deps))
  items.push({ kind: "inbox-ticket", path: t.path, detail: t.id });
const ns = join(cfg.worktreeRoot, repoDiscriminator(entry.path));
if ((deps.existsFn ?? existsSync)(ns)) items.push({ kind: "worktrees", path: ns });
const live = ticketsTargeting(cfg, q.processing, entry.path, deps);
const blocked = live.length > 0 ? { ticketId: live[0].id } : null;
```

- [ ] **Step 4: Run to verify pass.**
- [ ] **Step 5: Prettier + commit** — `git commit -m "feat(unwatch): enumerate inbox tickets + worktree namespace, processing blocker"`

---

### Task 3: plan enumeration — outbox, reviews, assess history, mirror, github-cache

**Files:**
- Modify: `src/unwatchCmd.ts` (inside `watchedPlan`, via an nwo-keyed helper Task 4 reuses)
- Modify: `src/assessHistory.ts` (export `historyFilePath`)
- Modify: `src/assessReview.ts` (export `purgePending`)
- Modify: `src/tui/ghClient.ts` (export `prCachePathFor`, update its "Not exported" comment)
- Test: `tests/unwatchCmd.test.ts`

**Interfaces:**
- Consumes: `listOps(cfg, deps)` → `StoredOp[]` with `.path`, `.issueKey`, `.op` (`src/githubOutbox.ts:162`; ops carry `nwo` or, for `push`, `repoPath`); `listPending(cfg, deps)` → `PendingAssess[]` (`.id`, `.nwo`); `listDrafts(cfg, deps)` → `PendingComment[]` (`.id`, `.nwo`); `slugifyId` (`src/slug.ts`) — pending-entry file = `<dir>/<slugifyId(id)>.json` (reviewStore.ts:66); `cachePathFor(cfg, nwo)` (`src/tui/ghClient.ts:43`).
- Produces:
  - `src/assessHistory.ts`: `export function historyFilePath(cfg: Config, nwo: string): string` — `join(dataTreePaths(cfg).assessHistory, historyKey(nwo) + ".json")`.
  - `src/assessReview.ts`: `export function purgePending(cfg: Config, id: string, deps: AssessReviewDeps = {}): boolean` — `store.remove(dataTreePaths(cfg).reviewAssess, id, "discarded", deps)` (NOT `"filed"` — an unwatch-purged batch was never filed; `discardPending`'s `"filed"` archive is that verb's pre-existing behavior, leave it alone).
  - `src/tui/ghClient.ts`: `export function prCachePathFor(cfg, nwo)` (same body, now exported; update the doc comment to say it is exported for the unwatch drift-pin test, still not for general use).
  - `src/unwatchCmd.ts`: `function nwoKeyedItems(cfg, nwo, repoPathOrNull, deps): PlanItem[]` — the shared enumerator both modes call, plus a local `githubCacheFilesFor(cfg, nwo): string[]` that mirrors ghClient's naming (`issues-`/`prs-` + `nwo.replace(/\//g, "__")` + `.json`) with a provenance comment citing `tui/ghClient.ts cachePathFor/prCachePathFor` — duplicated so the CLI graph never imports the heavy `tui/ghClient.ts` module; the drift-pin test below keeps it honest.

- [ ] **Step 1: Write the failing tests**

```ts
import { enqueueOp } from "../src/githubOutbox.js";
import { writePending } from "../src/assessReview.js";
import { writeDraft } from "../src/commentReview.js";
import { recordRun, historyFilePath } from "../src/assessHistory.js";
import { cachePathFor, prCachePathFor } from "../src/tui/ghClient.js";

describe("planUnwatch — nwo-keyed stores", () => {
  it("enumerates outbox ops by nwo and by push repoPath; dead/ untouched", () => {
    const { root, cfg } = makeTree();
    const clone = join(dataTreePaths(cfg).clonesWatched, "acme", "api");
    watch(cfg, "acme/api", clone);
    enqueueOp(cfg, "dashboard", { kind: "comment", nwo: "ACME/api", issue: 7, body: "hi" });
    enqueueOp(cfg, "prflow", { kind: "push", repoPath: clone, branch: "feat/x" });
    enqueueOp(cfg, "dashboard", { kind: "comment", nwo: "other/repo", issue: 1, body: "no" });
    const out = planUnwatch(cfg, "acme/api");
    if (!out.ok) throw new Error(out.reason);
    expect(out.plan.items.filter((i) => i.kind === "outbox-op")).toHaveLength(2);
  });

  it("enumerates pending reviews, assess history, mirror, github-cache", () => {
    const { cfg } = makeTree();
    const clone = join(dataTreePaths(cfg).clonesWatched, "acme", "api");
    watch(cfg, "acme/api", clone);
    writePending(cfg, {
      id: "assess-acme-api", nwo: "acme/api", external: false, autoPlan: false,
      repoPath: clone, createdAt: "2026-08-19T00:00:00Z", findings: [],
    });
    // one comment draft for acme/api via commentReview's writer (mirror PendingComment's required fields)
    recordRun(cfg, "acme/api", { ok: true, at: "2026-08-19T00:00:00Z", found: 0, parked: 0 });
    mkdirSync(join(dataTreePaths(cfg).mirror, "acme", "api"), { recursive: true });
    mkdirSync(dataTreePaths(cfg).githubCache, { recursive: true });
    writeFileSync(cachePathFor(cfg, "acme/api"), "{}", "utf8");
    writeFileSync(prCachePathFor(cfg, "acme/api"), "{}", "utf8");
    const out = planUnwatch(cfg, "acme/api");
    if (!out.ok) throw new Error(out.reason);
    const kinds = out.plan.items.map((i) => i.kind);
    for (const k of ["assess-review", "comment-review", "assess-history", "mirror", "github-cache"])
      expect(kinds).toContain(k);
    expect(out.plan.items.filter((i) => i.kind === "github-cache")).toHaveLength(2);
  });

  it("github-cache naming never drifts from ghClient (pin)", () => {
    const { cfg } = makeTree();
    const out = planUnwatchCacheProbe(cfg, "acme/api"); // expose githubCacheFilesFor for tests, or assert via a plan with only cache files present
    expect(out).toEqual([cachePathFor(cfg, "acme/api"), prCachePathFor(cfg, "acme/api")]);
  });
});
```

For the pin: export `githubCacheFilesFor(cfg, nwo): string[]` from `unwatchCmd.ts` (it is small and the pin is the point) and assert equality directly — drop the `planUnwatchCacheProbe` indirection. The comment-draft fixture calls `writeDraft(cfg, d)` with every `PendingComment` field: `id`, `nwo`, `issue`, `issueTitle`, `external`, `repoPath`, `createdAt`, `draft`, `footer` (`src/commentReview.ts:20-30`).

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** — the three small exports listed under Produces, then in `unwatchCmd.ts`:

```ts
export function githubCacheFilesFor(cfg: Config, nwo: string): string[] {
  // Mirrors tui/ghClient.ts cachePathFor/prCachePathFor byte-for-byte (pinned by
  // tests/unwatchCmd.test.ts) — duplicated so the CLI never imports that module's
  // heavy graph.
  const dir = dataTreePaths(cfg).githubCache;
  const key = nwo.replace(/\//g, "__");
  return [join(dir, `issues-${key}.json`), join(dir, `prs-${key}.json`)];
}

function nwoKeyedItems(
  cfg: Config,
  nwo: string,
  repoPath: string | null,
  deps: UnwatchDeps,
): PlanItem[] {
  const existsFn = deps.existsFn ?? existsSync;
  const lower = nwo.toLowerCase();
  const canonRepo = repoPath === null ? null : canonPath(repoPath);
  const p = dataTreePaths(cfg);
  const items: PlanItem[] = [];
  for (const sop of listOps(cfg, deps)) {
    const matchNwo = "nwo" in sop.op && sop.op.nwo.toLowerCase() === lower;
    const matchPath =
      canonRepo !== null && "repoPath" in sop.op && canonPath(sop.op.repoPath) === canonRepo;
    if (matchNwo || matchPath)
      items.push({ kind: "outbox-op", path: sop.path, detail: sop.issueKey ?? sop.op.kind });
  }
  for (const b of listPending(cfg, deps))
    if (b.nwo.toLowerCase() === lower)
      items.push({ kind: "assess-review", path: join(p.reviewAssess, `${slugifyId(b.id)}.json`), detail: b.id });
  for (const d of listDrafts(cfg, deps))
    if (d.nwo.toLowerCase() === lower)
      items.push({ kind: "comment-review", path: join(p.reviewComments, `${slugifyId(d.id)}.json`), detail: d.id });
  const hist = historyFilePath(cfg, nwo);
  if (existsFn(hist)) items.push({ kind: "assess-history", path: hist });
  const [owner, repo] = nwo.split("/");
  const mirror = join(p.mirror, owner ?? nwo, repo ?? "repo");
  if (existsFn(mirror)) items.push({ kind: "mirror", path: mirror });
  for (const f of githubCacheFilesFor(cfg, nwo)) if (existsFn(f)) items.push({ kind: "github-cache", path: f });
  return items;
}
```

`watchedPlan` calls `items.push(...nwoKeyedItems(cfg, entry.nwo, entry.path, deps))`. `historyFilePath` matching is exact-key (not case-insensitive) — `historyKey` hashes the full nwo, and the watchlist's stored casing is what every writer used; watched mode passes `entry.nwo`, which is that casing.

- [ ] **Step 4: Run to verify pass.**
- [ ] **Step 5: Prettier + commit** — `git commit -m "feat(unwatch): enumerate outbox/review/history/mirror/cache traces"`

---

### Task 4: residue mode

**Files:**
- Modify: `src/unwatchCmd.ts` (replace the `residuePlan` stub)
- Test: `tests/unwatchCmd.test.ts`

**Interfaces:**
- Consumes: `nwoKeyedItems`, `ticketsTargeting`, `classifyClone`, `repoDiscriminator` — all from earlier tasks.
- Produces: real `residuePlan(cfg, nwo, deps): UnwatchPlan` — `mode: "residue"`, probes `clonesWatched/<owner>/<repo>` then `clonesExternal/<owner>/<repo>`; a found clone contributes the clone item, its worktree namespace, inbox items, and the processing blocker; nwo-keyed items always included.

- [ ] **Step 1: Write the failing tests**

```ts
describe("planUnwatch — residue mode (nwo not in watchlist)", () => {
  it("sweeps nwo-keyed traces and a leftover managed clone + its worktrees", () => {
    const { cfg } = makeTree();
    const clone = join(dataTreePaths(cfg).clonesWatched, "acme", "api");
    mkdirSync(clone, { recursive: true });
    const ns = join(cfg.worktreeRoot, repoDiscriminator(clone));
    mkdirSync(ns, { recursive: true });
    enqueueOp(cfg, "dashboard", { kind: "comment", nwo: "acme/api", issue: 7, body: "hi" });
    const out = planUnwatch(cfg, "acme/api");
    if (!out.ok) throw new Error(out.reason);
    expect(out.plan.mode).toBe("residue");
    expect(out.plan.clone).toEqual({ path: clone, managed: true });
    const kinds = out.plan.items.map((i) => i.kind);
    expect(kinds).toEqual(expect.arrayContaining(["clone", "worktrees", "outbox-op"]));
  });

  it("no clone, no traces → empty plan (nothing to clean)", () => {
    const { cfg } = makeTree();
    const out = planUnwatch(cfg, "ghost/repo");
    if (!out.ok) throw new Error(out.reason);
    expect(out.plan.mode).toBe("residue");
    expect(out.plan.items).toEqual([]);
    expect(out.plan.clone).toBeNull();
  });

  it("a processing ticket targeting the residue clone blocks", () => {
    const { cfg } = makeTree();
    const clone = join(dataTreePaths(cfg).clonesWatched, "acme", "api");
    mkdirSync(clone, { recursive: true });
    writeTicket(dataTreePaths(cfg).queue.processing, "live-9", clone);
    const out = planUnwatch(cfg, "acme/api");
    if (!out.ok) throw new Error(out.reason);
    expect(out.plan.blocked).toEqual({ ticketId: "live-9" });
  });
});
```

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** `residuePlan`: probe the two candidate roots with `existsFn`; when found, build items exactly as `watchedPlan` does for a managed clone (clone item + inbox tickets + namespace + blocker via the clone path); always append `nwoKeyedItems(cfg, nwo, clonePathOrNull, deps)`; `external: false`, `kept: []`.
- [ ] **Step 4: Run to verify pass.**
- [ ] **Step 5: Prettier + commit** — `git commit -m "feat(unwatch): residue mode — idempotent re-run sweep"`

---

### Task 5: `runUnwatch` — ordered deletion with per-item isolation

**Files:**
- Modify: `src/unwatchCmd.ts`
- Test: `tests/unwatchCmd.test.ts`

**Interfaces:**
- Consumes: `writeWatchlist` (`src/watchlist.ts:73`), `purgePending` (Task 3), `removeDraft(cfg, id, "discarded", deps)` (`src/commentReview.ts:73`), `acquirePidfileLock`/`worktreesLockPath` (`src/pidfileLock.ts`, `src/worktree.ts:48`), `git` (`src/git.ts`) for the default `gitFn`.
- Produces: `runUnwatch(cfg, nwo, deps): Promise<UnwatchResult>` per **Shared interfaces**.

- [ ] **Step 1: Write the failing tests**

```ts
describe("runUnwatch", () => {
  it("refuses blocked without deleting anything", async () => {
    const { cfg } = makeTree();
    const clone = join(dataTreePaths(cfg).clonesWatched, "acme", "api");
    watch(cfg, "acme/api", clone);
    writeTicket(dataTreePaths(cfg).queue.processing, "live-1", clone);
    const res = await runUnwatch(cfg, "acme/api");
    expect(res).toMatchObject({ ok: false, refused: "blocked", blockedTicketId: "live-1", watchlistRemoved: false });
    expect(readWatchlist(dataTreePaths(cfg).watchlistFile).entries).toHaveLength(1);
    expect(existsSync(clone)).toBe(true);
  });

  it("deletes watchlist entry first, clone last; user clone kept + git worktree prune", async () => {
    const { root, cfg } = makeTree();
    const mine = join(root, "my-checkout");
    watch(cfg, "acme/api", mine);
    const ns = join(cfg.worktreeRoot, repoDiscriminator(mine));
    mkdirSync(ns, { recursive: true });
    const gitCalls: [string[], string][] = [];
    const res = await runUnwatch(cfg, "acme/api", {
      gitFn: async (args, cwd) => (gitCalls.push([args, cwd]), { code: 0, stdout: "" }),
    });
    expect(res.ok).toBe(true);
    expect(res.watchlistRemoved).toBe(true);
    expect(readWatchlist(dataTreePaths(cfg).watchlistFile).entries).toEqual([]);
    expect(existsSync(ns)).toBe(false);
    expect(existsSync(mine)).toBe(true); // user clone survives
    expect(gitCalls).toEqual([[["worktree", "prune"], mine]]);
    expect(res.summary.find((s) => s.kind === "clone")?.outcome).toBe("kept");
  });

  it("one failing deletion doesn't strand the rest; ok:false with the failure row", async () => {
    const { cfg } = makeTree();
    const clone = join(dataTreePaths(cfg).clonesWatched, "acme", "api");
    watch(cfg, "acme/api", clone);
    const t = writeTicket(dataTreePaths(cfg).queue.inbox, "fix-1", clone);
    enqueueOp(cfg, "dashboard", { kind: "comment", nwo: "acme/api", issue: 7, body: "hi" });
    const res = await runUnwatch(cfg, "acme/api", {
      unlinkFn: (p) => {
        if (p === t) throw new Error("EACCES boom");
        unlinkSync(p);
      },
    });
    expect(res.ok).toBe(false);
    expect(res.summary.find((s) => s.kind === "inbox-ticket")).toMatchObject({ outcome: "failed" });
    expect(res.summary.filter((s) => s.outcome === "deleted").map((s) => s.kind)).toEqual(
      expect.arrayContaining(["watchlist-entry", "outbox-op", "clone"]),
    );
    expect(existsSync(clone)).toBe(false);
  });

  it("worktree namespace removal happens under the advisory lock; a held lock fails only that row", async () => {
    const { cfg } = makeTree();
    const clone = join(dataTreePaths(cfg).clonesWatched, "acme", "api");
    watch(cfg, "acme/api", clone);
    const ns = join(cfg.worktreeRoot, repoDiscriminator(clone));
    mkdirSync(ns, { recursive: true });
    const res = await runUnwatch(cfg, "acme/api", { acquireLockFn: () => null });
    expect(res.ok).toBe(false);
    expect(res.summary.find((s) => s.kind === "worktrees")).toMatchObject({ outcome: "failed" });
    expect(existsSync(ns)).toBe(true);
    expect(existsSync(clone)).toBe(false); // the rest still ran
  });

  it("residue run with nothing to clean succeeds with an empty summary", async () => {
    const { cfg } = makeTree();
    const res = await runUnwatch(cfg, "ghost/repo");
    expect(res).toMatchObject({ ok: true, refused: null, watchlistRemoved: false, summary: [] });
  });
});
```

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement**

```ts
export async function runUnwatch(
  cfg: Config,
  nwo: string,
  deps: UnwatchDeps = {},
): Promise<UnwatchResult> {
  const unlinkFn = deps.unlinkFn ?? unlinkSync;
  const rmFn = deps.rmFn ?? ((p: string) => rmSync(p, { recursive: true, force: true }));
  const gitFn =
    deps.gitFn ??
    (async (a: string[], cwd: string) => {
      const r = await git(cfg, a, { cwd, check: false });
      return { code: r.code, stdout: r.stdout };
    });
  const acquireLockFn = deps.acquireLockFn ?? (() => acquirePidfileLock(worktreesLockPath(cfg)));

  const outcome = planUnwatch(cfg, nwo, deps); // fresh plan closes the confirm→execute race
  if (!outcome.ok)
    return { ok: false, refused: outcome.reason, blockedTicketId: null, watchlistRemoved: false, summary: [] };
  const plan = outcome.plan;
  if (plan.blocked)
    return { ok: false, refused: "blocked", blockedTicketId: plan.blocked.ticketId, watchlistRemoved: false, summary: [] };

  const summary: SummaryRow[] = [];
  const attempt = (row: Omit<SummaryRow, "outcome">, fn: () => void): void => {
    try {
      fn();
      summary.push({ ...row, outcome: "deleted" });
    } catch (e) {
      summary.push({ ...row, outcome: "failed", reason: e instanceof Error ? e.message : String(e) });
    }
  };
  const byKind = (k: PlanItemKind): PlanItem[] => plan.items.filter((i) => i.kind === k);

  // 1. Watchlist entry first — the bridge's next sweep stops polling.
  let watchlistRemoved = false;
  if (plan.mode === "watched") {
    const file = watchlistPath(cfg);
    attempt({ kind: "watchlist-entry", path: file }, () => {
      const { entries, error } = readWatchlist(file);
      if (error) throw new Error(error); // went corrupt since the plan — leave it alone
      writeWatchlist(file, entries.filter((e) => e.nwo.toLowerCase() !== plan.nwo.toLowerCase()));
      watchlistRemoved = true;
    });
  }
  // 2–4. Tickets, outbox ops, pending reviews.
  for (const i of byKind("inbox-ticket")) attempt(i, () => unlinkFn(i.path));
  for (const i of byKind("outbox-op")) attempt(i, () => unlinkFn(i.path));
  for (const i of byKind("assess-review"))
    attempt(i, () => void purgePending(cfg, i.detail as string, deps));
  for (const i of byKind("comment-review"))
    attempt(i, () => void removeDraft(cfg, i.detail as string, "discarded", deps));
  // 5. Worktree namespace under the advisory lock (one-directional courtesy —
  //    the blocker check above is the liveness guarantee, worktreePruneCmd.ts:104).
  for (const i of byKind("worktrees"))
    attempt(i, () => {
      const lock = acquireLockFn();
      if (lock === null) throw new Error("another worktree operation is in progress — try again");
      try {
        rmFn(i.path);
      } finally {
        lock.release();
      }
    });
  // 6. Kept user clone: clear junco's stale .git/worktrees registrations. Best-effort.
  if (plan.mode === "watched" && plan.clone !== null && !plan.clone.managed) {
    summary.push({ kind: "clone", path: plan.clone.path, outcome: "kept", detail: "user-owned" });
    await gitFn(["worktree", "prune"], plan.clone.path).catch(() => ({ code: 1, stdout: "" }));
  }
  // 7. History, mirror, cache.
  for (const i of byKind("assess-history")) attempt(i, () => unlinkFn(i.path));
  for (const i of byKind("mirror")) attempt(i, () => rmFn(i.path));
  for (const i of byKind("github-cache")) attempt(i, () => unlinkFn(i.path));
  // 8. Managed clone last (largest; a crash mid-run leaves the re-clonable part).
  for (const i of byKind("clone")) attempt(i, () => rmFn(i.path));

  return {
    ok: summary.every((s) => s.outcome !== "failed"),
    refused: null,
    blockedTicketId: null,
    watchlistRemoved,
    summary,
  };
}
```

- [ ] **Step 4: Run to verify pass.**
- [ ] **Step 5: Prettier + commit** — `git commit -m "feat(unwatch): runUnwatch — ordered deletion, per-item isolation"`

---

### Task 6: CLI — `runUnwatchCommand`, `--plan` flag, USAGE, palette roster

**Files:**
- Modify: `src/unwatchCmd.ts` (add `runUnwatchCommand`)
- Modify: `src/cli.ts` (USAGE rows, `parseCli` option, subcommand branch, `CliDeps.runUnwatchCommandFn`)
- Modify: `src/tui/cliRunner.ts` (roster row)
- Test: `tests/unwatchCmd.test.ts` (command layer), `tests/cli.test.ts` (wiring), `tests/tuiCliRunner.test.ts` (roster↔USAGE pin — should pass without edits once USAGE has the row; verify)

**Interfaces:**
- Consumes: `planUnwatch`/`runUnwatch`; cli.ts patterns at `src/cli.ts:636-644` (rm) and `:644-668` (outbox lazy import).
- Produces: `runUnwatchCommand(cfg, args, { plan }, deps)` → exit code; CLI contract:
  - `junco unwatch` (no nwo) or a non-`owner/repo` arg → usage line, exit 2.
  - `--plan`: `print(JSON.stringify(outcome) + "\n")` — ONE line, the `PlanOutcome` verbatim; exit 0 when `outcome.ok` (blocked included), exit 1 on refusal.
  - Execute headlines (first printed line, exactly):
    - refused config-defined → `junco unwatch: <nwo> is defined in config.json — remove it there\n`, exit 1
    - refused watchlist-unreadable → `junco unwatch: watchlist unreadable — fix it before writing\n`, exit 1
    - blocked → `junco unwatch: <nwo> has a ticket in flight (<id>) — wait for it to finish\n`, exit 1
    - empty summary → `junco unwatch: nothing to clean for <nwo>\n`, exit 0
    - all deleted/kept → `unwatched <nwo>: deleted <n> item(s)\n`, exit 0
    - any failed → `junco unwatch: <k> deletion(s) failed for <nwo>\n`, exit 1
    - then one line per summary row: `  <outcome>: <kind> <detail ?? path>\n`

- [ ] **Step 1: Write the failing tests** — command layer in `tests/unwatchCmd.test.ts`:

```ts
describe("runUnwatchCommand", () => {
  const capture = () => {
    const out: string[] = [];
    return { out, printFn: (s: string) => out.push(s) };
  };

  it("--plan prints the PlanOutcome as one JSON line, exit 0", async () => {
    const { cfg } = makeTree();
    watch(cfg, "acme/api", join(dataTreePaths(cfg).clonesWatched, "acme", "api"));
    const { out, printFn } = capture();
    expect(await runUnwatchCommand(cfg, ["acme/api"], { plan: true }, { printFn })).toBe(0);
    const parsed = JSON.parse(out.join("").trim());
    expect(parsed.ok).toBe(true);
    expect(parsed.plan.nwo).toBe("acme/api");
  });

  it("bad args → usage, exit 2", async () => {
    const { cfg } = makeTree();
    const { printFn } = capture();
    expect(await runUnwatchCommand(cfg, [], { plan: false }, { printFn })).toBe(2);
    expect(await runUnwatchCommand(cfg, ["not-an-nwo"], { plan: false }, { printFn })).toBe(2);
  });

  it("execute success headline + rows, exit 0; blocked exits 1", async () => {
    const { cfg } = makeTree();
    const clone = join(dataTreePaths(cfg).clonesWatched, "acme", "api");
    watch(cfg, "acme/api", clone);
    const { out, printFn } = capture();
    expect(await runUnwatchCommand(cfg, ["acme/api"], { plan: false }, { printFn })).toBe(0);
    expect(out[0]).toMatch(/^unwatched acme\/api: deleted \d+ item\(s\)\n$/);
  });
});
```

In `tests/cli.test.ts`, follow the existing `runRmCommand`-style wiring test pattern (grep `rm` there): assert `junco unwatch acme/api --plan` routes to an injected `runUnwatchCommandFn` with `values.plan === true`, and that `--plan` is accepted by strict parseArgs.

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.** `runUnwatchCommand` validates `args[0]` against `/^[\w.-]+\/[\w.-]+$/` (the watchlist's `NWO_RE`), then branches plan/execute per the contract above. `cli.ts`: add `plan: { type: "boolean", default: false }` to `parseCli` options; add the branch after `rm` (lazy import, `deps.runUnwatchCommandFn` seam on `CliDeps` mirroring `runOutboxCommandFn`); USAGE subcommand row `  unwatch <owner/repo> [--plan]  Stop watching a repo and delete its junco-owned state (--plan previews as JSON)` and Options row `  --plan                (unwatch) Print what would be deleted as JSON; delete nothing`. `cliRunner.ts`: `cmd("unwatch", "<owner/repo> [--plan]", "Stop watching a repo and delete its junco-owned state"),` after the `rm` row.
- [ ] **Step 4: Run to verify pass** — `npx vitest run tests/unwatchCmd.test.ts tests/cli.test.ts tests/tuiCliRunner.test.ts > /tmp/out 2>&1; echo "exit: $?"`.
- [ ] **Step 5: Prettier + commit** — `git commit -m "feat(unwatch): CLI subcommand with --plan preview"`

---

### Task 7: TUI — guarded `unwatch` mnemonic

**Files:**
- Modify: `src/tui/viewActions.ts:63` (`{ id: "unwatch", label: "unwatch", guarded: true }`)
- Test: `tests/tuiViewActions.test.ts` (pinned letters)

**Interfaces:**
- Consumes: `deriveMnemonics` (guarded ⇒ uppercase candidate sequence, `src/tui/mnemonics.ts:72`).
- Produces: derived key changes the pin test must assert: `unwatch` → `U` (was `u`); freeing `u` lets `queue` claim `u` (was `e`, since `q` is quit-reserved); freeing `e` lets `review` claim `e` (was `v`). No other letter should move — the pin test's failure diff is the authority; verify each changed letter is exactly this cascade before accepting it.

- [ ] **Step 1: Update the pin expectations** in `tests/tuiViewActions.test.ts` to `unwatch: "U"`, `queue: "u"`, `review: "e"` (locate the pinned main-context letter map; it asserts every derived key).
- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/tuiViewActions.test.ts > /tmp/out 2>&1; echo "exit: $?"` — fails against the un-edited source.
- [ ] **Step 3: Implement** the one-line `guarded: true` change.
- [ ] **Step 4: Run to verify pass.** Also run `tests/tuiApp.test.tsx` here to see which App tests now fail on the `u`→`U` key — expected failures fixed in Task 8 (do NOT fix them here; note them in the Task 8 hand-off).
- [ ] **Step 5: Prettier + commit** — `git commit -m "feat(tui): unwatch is a guarded mnemonic"`

---

### Task 8: TUI — plan → confirm → execute flow

**Files:**
- Create: `src/tui/unwatchSummary.ts`
- Modify: `src/tui/hooks/useWatchlist.ts` (add `reload`)
- Modify: `src/tui/App.tsx` (rewrite `unwatch` callback ~line 908; `runLocalAction` gains `onSuccess`; drop the `removeEntry` destructure if now unused)
- Test: Create `tests/tuiUnwatchSummary.test.ts`; modify `tests/tuiApp.test.tsx` (three existing unwatch tests + new flow tests)

**Interfaces:**
- Consumes: `UnwatchPlan`/`PlanOutcome` (type-only import from `../unwatchCmd.js` — pure module, safe), `useConfirm`'s `askConfirm` (precedents `src/tui/App.tsx:1425-1455`), `runCliFn`/`runLocalAction`/`githubEvictRepo` (existing App plumbing), `firstNonEmptyLine` (already in App).
- Produces:
  - `src/tui/unwatchSummary.ts`: `export function summarizeUnwatchPlan(plan: UnwatchPlan): string` — counts per kind in this order with these labels: clone → `managed clone`; inbox-ticket → `N queued ticket(s)`; worktrees → `worktrees`; outbox-op → `N outbox op(s)`; assess-review → `N pending assess batch(es)`; comment-review → `N pending comment draft(s)`; assess-history → `assess history`; mirror → `mirror`; github-cache → `github cache`; joined with ` · ` and prefixed `Will delete: `; `plan.kept` non-empty appends ` — keeps: ` + kept joined by `, `; empty `items` returns `No junco-owned state to delete — just stop watching.`; always ends with ` Continue?`.
  - `useWatchlist` additionally returns `reload: () => void` (re-read the file; set entries when readable, always set the error state).
  - `runLocalAction` opts gain `onSuccess?: () => void`, invoked when `rr.code === 0` before the cheap re-poll.

- [ ] **Step 1: Write the failing tests.** `tests/tuiUnwatchSummary.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { summarizeUnwatchPlan } from "../src/tui/unwatchSummary.js";
import type { UnwatchPlan } from "../src/unwatchCmd.js";

const base: UnwatchPlan = {
  nwo: "acme/api", mode: "watched", external: false,
  clone: { path: "/c", managed: true },
  items: [
    { kind: "clone", path: "/c" },
    { kind: "inbox-ticket", path: "/q/a.md", detail: "a" },
    { kind: "inbox-ticket", path: "/q/b.md", detail: "b" },
    { kind: "worktrees", path: "/w/ns" },
  ],
  kept: [], blocked: null,
};

it("itemizes with counts in kind order", () => {
  expect(summarizeUnwatchPlan(base)).toBe(
    "Will delete: managed clone · 2 queued ticket(s) · worktrees Continue?",
  );
});

it("appends keeps and handles the empty plan", () => {
  const kept = { ...base, clone: { path: "/me", managed: false }, items: base.items.slice(1), kept: ["clone (user-owned): /me"] };
  expect(summarizeUnwatchPlan(kept)).toContain("— keeps: clone (user-owned): /me");
  expect(summarizeUnwatchPlan({ ...base, items: [], kept: [] })).toBe(
    "No junco-owned state to delete — just stop watching. Continue?",
  );
});
```

In `tests/tuiApp.test.tsx`: extend the local `renderApp` helper to pass an optional `runCliFn` through to `<App … runCliFn={…}>` (App already accepts the prop, `src/tui/App.tsx:124`). Then:

- Rewrite **"unwatch removes watchlist entries but refuses config entries"** (line ~654): key is now `U`; the config-entry refusal toast is unchanged (no spawn); for the watchlist entry, fake `runCliFn` returns `{ code: 0, output: JSON.stringify({ ok: true, plan: { nwo: "alx/coral", mode: "watched", external: false, clone: { path: "/c/coral", managed: false }, items: [], kept: ["clone (user-owned): /c/coral"], blocked: null } }) + "\n", timedOut: false }` for the `--plan` call; `until` the confirm modal shows `unwatch alx/coral`; press `y`; the execute fake removes the entry from the watchlist file itself (simulating the CLI) and returns `{ code: 0, output: "unwatched alx/coral: deleted 0 item(s)\n", timedOut: false }`; assert the two spawns' argv (`["unwatch", ["alx/coral", "--plan"]]` then `["unwatch", ["alx/coral"]]`) and `until(() => readWatchlist(file).entries.length === 0)`.
- Update the **review-chip** (~860) and **PR-attention-chip** (~1485) tests the same way: `U`, plan fake, `y`, execute fake mutates the file; the chip assertions now hold after the execute resolves (eviction runs in `onSuccess`).
- Add **"blocked plan toasts and never opens the modal"**: plan fake returns `blocked: { ticketId: "live-1" }`; assert the toast text contains `in flight` and no `Continue?` frame appears, and only ONE spawn happened.
- Add **"n dismisses without spawning the execute"**: press `U`, `until` modal, press `n`; assert exactly one spawn (`--plan`) total and the watchlist file untouched.

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.** `useWatchlist.reload`:

```ts
const reload = useCallback(() => {
  const { entries, error } = readWatchlist(watchlistFile);
  setWatchlistError(error);
  if (!error) setWatchlistEntries(entries);
}, [watchlistFile]);
```

`runLocalAction`: add `onSuccess?: () => void` to `opts`; in the `.then`, `if (rr.code === 0) opts.onSuccess?.();` immediately after the success toast, before the re-poll. Rewrite the `unwatch` callback (replacing `removeEntry`/direct eviction; keep the dispatch site at ~1316 unchanged):

```ts
const unwatch = useCallback(
  (nwo: string) => {
    const mapping = repoMappings.find((r) => r.nwo.toLowerCase() === nwo.toLowerCase());
    if (!mapping) return void showToast("info", "not in watchlist");
    if (mapping.fromConfig) return void showToast("info", `${mapping.nwo} is defined in config.json`);
    if (watchlistError) return void showToast("error", "watchlist unreadable — fix it before writing");
    void runCliFn("unwatch", [mapping.nwo, "--plan"]).then((rr) => {
      if (!aliveRef.current) return;
      if (rr.code !== 0)
        return void showToast("error", firstNonEmptyLine(rr.output) ?? "unwatch: plan failed");
      // Store warnings may precede the JSON in the merged stream — parse the LAST line.
      const lines = rr.output.split("\n").filter((l) => l.trim() !== "");
      let outcome: PlanOutcome | null = null;
      try {
        outcome = JSON.parse(lines[lines.length - 1] ?? "") as PlanOutcome;
      } catch {
        /* fall through to the error toast */
      }
      if (outcome === null || !outcome.ok)
        return void showToast("error", "unwatch: unreadable plan");
      const plan = outcome.plan;
      if (plan.blocked)
        return void showToast(
          "info",
          `${mapping.nwo}: ticket in flight (${plan.blocked.ticketId}) — wait for it to finish`,
        );
      askConfirm({
        title: `unwatch ${mapping.nwo}`,
        danger: true,
        body: summarizeUnwatchPlan(plan),
        onConfirm: () =>
          runLocalAction("unwatch", [mapping.nwo], {
            label: "unwatch",
            onSuccess: () => {
              githubEvictRepo(mapping.nwo);
              reloadWatchlist();
            },
          }),
      });
    });
  },
  [repoMappings, watchlistError, showToast, runCliFn, askConfirm, runLocalAction, githubEvictRepo, reloadWatchlist],
);
```

(`reloadWatchlist` is the hook's `reload` as destructured in App; `aliveRef` is already in scope and deliberately not a dep — refs are stable, matching the file's existing pattern. `exhaustive-deps` runs at error severity: keep the dep array exactly complete.) If `removeEntry` is now unused in App, remove it from the destructure; leave the hook's export and its tests alone.

- [ ] **Step 4: Run to verify pass** — `npx vitest run tests/tuiApp.test.tsx tests/tuiUnwatchSummary.test.ts tests/tuiViewActions.test.ts > /tmp/out 2>&1; echo "exit: $?"`, then `npm run lint` (react-hooks deps at error).
- [ ] **Step 5: Prettier + commit** — `git commit -m "feat(tui): unwatch plans, confirms itemized deletion, executes via CLI"`

---

### Task 9: git-harness integration test

**Files:**
- Create: `tests/unwatchCmd.git.test.ts`

**Interfaces:**
- Consumes: `runUnwatch` (real fs + real git), `repoDiscriminator`.

- [ ] **Step 1: Write the test** (real git; CI provides `git config user.*`; locally the harness pattern in `tests/helpers/gitHarness.ts` shows the init idiom — reuse its helpers if they fit, else `execFileSync`):

```ts
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
// … makeTree/watch fixture imported or duplicated from tests/unwatchCmd.test.ts
//   (extract the fixture into tests/helpers/unwatchTree.ts if importing across
//   test files is awkward — small, mechanical) …

const g = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" });

describe("runUnwatch against real git state", () => {
  it("removes a real worktree namespace; kept user clone gets pruned registrations", async () => {
    const { root, cfg } = makeTree();
    const mine = join(root, "my-checkout");
    mkdirSync(mine, { recursive: true });
    g(mine, "init", "-b", "main");
    g(mine, "commit", "--allow-empty", "-m", "seed");
    watch(cfg, "acme/api", mine);
    const ns = join(cfg.worktreeRoot, repoDiscriminator(mine));
    mkdirSync(ns, { recursive: true });
    g(mine, "worktree", "add", join(ns, "ticket-1"), "-b", "junco/ticket-1");
    const res = await runUnwatch(cfg, "acme/api"); // default gitFn — real git
    expect(res.ok).toBe(true);
    expect(existsSync(ns)).toBe(false);
    expect(existsSync(mine)).toBe(true);
    // git worktree prune cleared the stale registration the rm left behind.
    expect(g(mine, "worktree", "list")).not.toContain("ticket-1");
  });
});
```

- [ ] **Step 2: Run to verify it fails only for the right reason** (it should PASS if Tasks 1–5 are correct — this is a confirmation harness, not TDD red; if it fails, that is a real bug to fix in `unwatchCmd.ts`, not in the test).
- [ ] **Step 3: Prettier + commit** — `git commit -m "test(unwatch): real-git worktree removal + kept-clone prune"`

---

### Task 10: docs + full gate

**Files:**
- Modify: `ARCHITECTURE.md` (module map: add `unwatchCmd.ts` beside `rmCmd.ts`/`worktreePruneCmd.ts` — one row, same style: what it does, plan/execute, residue mode)

- [ ] **Step 1: Add the module-map row** (read the neighboring rows first; match their voice and length).
- [ ] **Step 2: Full gate**

Run: `npm run lint && npm run format:check && npm run typecheck && npm run build && npm test > /tmp/gate 2>&1; echo "exit: $?"; tail -5 /tmp/gate`
Expected: exit 0, all ~3,290+ tests green.

- [ ] **Step 3: Audit commits** — `git log --format='%B' main..HEAD | grep -iE 'co-authored|generated with'` must print nothing; amend any offender.
- [ ] **Step 4: Commit** — `git commit -m "docs: unwatchCmd in the module map"`

---

## Self-review (run after writing, fixed inline)

- Spec coverage: refusals/clone classification (T1), queue+worktrees+blocker (T2), nwo-keyed stores + new exports (T3), residue mode (T4), ordered execute + lock + prune + isolation (T5), CLI contract (T6), guarded mnemonic (T7), TUI flow + reload + onSuccess (T8), real-git harness (T9), docs+gate (T10). Non-goals need no task.
- Type consistency: `PlanOutcome`/`UnwatchPlan`/`PlanItem`/`SummaryRow`/`UnwatchResult` defined once in the header block; every task imports, none redefines.
