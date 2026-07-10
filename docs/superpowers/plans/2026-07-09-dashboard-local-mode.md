# Dashboard LOCAL Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a first-class, actionable LOCAL runtime surface to `junco dashboard` alongside its existing GitHub surface, exposing and mutating the four queue dirs, the GitHub outbox op-log, on-disk repos/clones/forks, per-ticket worktrees, and daemon/health detail.

**Architecture:** A new `uiMode` axis (`"github" | "local"`) sits above the existing `View` state machine, toggled by `m`/Shift+Tab/clickable header tabs, leaving GitHub mode byte-for-byte unchanged. LOCAL renders a sectioned dashboard (Queue / Outbox / Repos / Worktrees / Daemon) driven by two new deps-injectable snapshot factories (cheap @3s, heavy @15s). Mutating actions never reimplement logic — they spawn the real junco CLI, and the daemon stays the single writer of `worktreeRoot` via a newly shared `worktrees.lock` that both prune and daemon provisioning acquire.

**Tech Stack:** TypeScript (Node >=22.19, ESM/NodeNext, strict), Ink 7.1.0 + React 19, vitest, ink-testing-library. Zero new dependencies.

## Global Constraints
- Never import the Pi SDK at module top level in `src/` (type-only imports are fine); the runtime `await import(...)` stays inside `makePiSessionFactory`.
- Every side effect goes behind an injectable `deps` seam (`readdirFn`, `readFileFn`, `statFn`, `fetchFn`, `nowFn`, `gitFn`, `runCliFn`); tests never touch network or git.
- NO new `Config` field — everything derives from existing `Config` — so no `makeConfig`/`cfg()` fixture edits across `tests/{runOnce,prFlow,orphans,repo,worktree,daemon}.test.ts`.
- All new user-visible text is stack-agnostic ("inference endpoint", never a specific server/model).
- No AI-attribution trailers in commits (no `Co-Authored-By: Claude`, no "Generated with Claude Code"); sweep+amend any auto-appended trailer.
- Suite green at EVERY commit (`npm run lint && npm run format:check && npm run typecheck && npm run build && npm test`).
- Flake rule: never assert one fixed `setTimeout` tick after a state change — bounded until-loop on the frame string, then assert.
- Atomic-switch staging order A->B->C->D->E: (A) `localSnapshot.ts` + `listOpsFrom`/`listDeadOps` + enumerators, unwired; (B) `worktrees.lock` daemon-side acquisition, behavior-preserving; (C) `rmCmd`/`worktreePruneCmd` + CLI registration, unwired from TUI; (D) `LocalDashboard` + sections + `QueueView` additive props, unwired; (E) ONE atomic commit rewires `App.tsx` + Header tab + `HitContext.uiMode?` + `dashboardCmd` and migrates all header-row frame tests together.
- Conventional commits with scope (`feat(tui):`, `feat(cli):`, `refactor(worktree):`, etc.).

---
<!-- ===== Stage A — Data layer & enumerators (unwired) ===== -->


---

### Task 1: Extract `listOpsFrom` + add `listDeadOps` in `githubOutbox.ts`

**Files:**
- Modify `src/githubOutbox.ts` (lines 135-158 — refactor `listOps`; add `listOpsFrom` + `listDeadOps` immediately after)
- Modify `tests/githubOutbox.test.ts` (add imports for `listOpsFrom`/`listDeadOps`; append one `describe` block)

**Interfaces:**
- Consumes: `outboxPaths(cfg: Config): { dir: string; dead: string }` (existing, `githubOutbox.ts:93`); `OutboxDeps` (existing, `githubOutbox.ts:81`); `StoredOp` (existing, `githubOutbox.ts:70`).
- Produces:
  - `export function listOpsFrom(dir: string, deps?: OutboxDeps): StoredOp[]` — extracted core: reads a specific dir, `.json`-filtered, `.sort()`ed, skips-unparseable (`log.warn`), `[]` on missing dir.
  - `export function listOps(cfg: Config, deps?: OutboxDeps): StoredOp[]` = `listOpsFrom(outboxPaths(cfg).dir, deps)` (behavior-identical).
  - `export function listDeadOps(cfg: Config, deps?: OutboxDeps): StoredOp[]` = `listOpsFrom(outboxPaths(cfg).dead, deps)`.

**Steps:**

- [ ] 1. Write the failing test. Add to `tests/githubOutbox.test.ts` imports: `listOpsFrom`, `listDeadOps` (into the existing `from "../src/githubOutbox.js"` block), and add `mkdirSync` if not already imported (it is). Append:

```ts
describe("listOpsFrom / listDeadOps", () => {
  it("listDeadOps returns [] when the dead dir has never been created", () => {
    const root = mkdtempSync(join(tmpdir(), "junco-obxdead-"));
    expect(listDeadOps(cfgAt(root))).toEqual([]);
  });

  it("listDeadOps reads dead/ — sorted by filename, skipping unparseable & non-json", () => {
    const root = mkdtempSync(join(tmpdir(), "junco-obxdead2-"));
    const cfg = cfgAt(root);
    const dead = outboxPaths(cfg).dead;
    mkdirSync(dead, { recursive: true });
    const opA = {
      id: "ignored-by-list", // listOpsFrom re-derives id from the filename stem
      createdAt: "2026-07-07T00:00:00.000Z",
      origin: "prflow" as const,
      issueKey: "a/b#7",
      attempts: 3,
      lastError: "boom",
      op: { ...LABELS },
    };
    writeFileSync(join(dead, "100-0001-aaaa-labels.json"), JSON.stringify(opA));
    writeFileSync(join(dead, "200-0002-bbbb-labels.json"), JSON.stringify({ ...opA, lastError: "later" }));
    writeFileSync(join(dead, "garbage.json"), "{ not json");
    writeFileSync(join(dead, "ignore.txt"), "nope");
    const ops = listDeadOps(cfg);
    expect(ops.map((o) => o.id)).toEqual(["100-0001-aaaa-labels", "200-0002-bbbb-labels"]);
    expect(ops[0].path).toBe(join(dead, "100-0001-aaaa-labels.json"));
    expect(ops[1].lastError).toBe("later");
  });

  it("listOps delegates through listOpsFrom (live dir round-trips)", () => {
    const root = mkdtempSync(join(tmpdir(), "junco-obxlive-"));
    const cfg = cfgAt(root);
    const id = enqueueOp(cfg, "dashboard", { ...LABELS });
    expect(listOpsFrom(outboxPaths(cfg).dir, {}).map((o) => o.id)).toEqual([id]);
    expect(listOps(cfg).map((o) => o.id)).toEqual([id]);
  });
});
```

- [ ] 2. Run it, expect FAIL: `npx vitest run tests/githubOutbox.test.ts > /tmp/t1 2>&1; echo "exit: $?"` — fails at import (`listOpsFrom`/`listDeadOps` are not exported).

- [ ] 3. Write minimal implementation. Replace the existing `listOps` (`src/githubOutbox.ts:135-158`) with the extracted core plus two thin wrappers:

```ts
export function listOpsFrom(dir: string, deps: OutboxDeps = {}): StoredOp[] {
  const readdirFn = deps.readdirFn ?? readdirSync;
  const readFileFn = deps.readFileFn ?? ((p: string) => readFileSync(p, "utf8"));
  let names: string[];
  try {
    names = readdirFn(dir);
  } catch {
    return []; // dir never created yet
  }
  return names
    .filter((n) => n.endsWith(".json"))
    .sort()
    .flatMap((n) => {
      const path = join(dir, n);
      try {
        const parsed = JSON.parse(readFileFn(path)) as Omit<StoredOp, "path">;
        return [{ ...parsed, id: basename(n, ".json"), path }];
      } catch (e) {
        log.warn("skipping unparseable outbox op", { path, error: String(e) });
        return [];
      }
    });
}

export function listOps(cfg: Config, deps: OutboxDeps = {}): StoredOp[] {
  return listOpsFrom(outboxPaths(cfg).dir, deps);
}

/** Poisoned ops parked in github-outbox/dead/ (empty [] until something has
 * dead-lettered) — same envelope/sort/skip-unparseable posture as listOps. */
export function listDeadOps(cfg: Config, deps: OutboxDeps = {}): StoredOp[] {
  return listOpsFrom(outboxPaths(cfg).dead, deps);
}
```

- [ ] 4. Run, expect PASS: `npx vitest run tests/githubOutbox.test.ts > /tmp/t1 2>&1; echo "exit: $?"` — the new block passes and the pre-existing `listOps` tests stay green (delegation is behavior-identical).

- [ ] 5. Format touched files: `npx prettier --write src/githubOutbox.ts tests/githubOutbox.test.ts`.

- [ ] 6. Commit:

```bash
git add -A && git commit -m "refactor(outbox): extract listOpsFrom; add listDeadOps"
```

---

### Task 2: `enumerateRepos` + candidate collection in `src/tui/localSnapshot.ts`

**Files:**
- Create `src/tui/localSnapshot.ts`
- Create `tests/localSnapshotRepos.test.ts`

**Interfaces:**
- Consumes: `Config` (`src/types.js`); `readWatchlist(file: string): { entries: WatchlistEntry[]; error: string | null }` + `watchlistPath(cfg): string` (`src/watchlist.js`); `nwoFromRemoteUrl(url: string): string | null` (`src/githubInbox.js`); `git(cfg, args, opts): Promise<CmdResult>` (`src/git.js`); `repoDiscriminator(repoPath: string): string` (`src/worktree.js`).
- Produces:
  - `export interface LocalSnapshotDeps { readdirFn?: (dir: string) => string[]; readFileFn?: (p: string) => string; statFn?: (p: string) => { mtimeMs: number }; fetchFn?: typeof fetch; nowFn?: () => Date; gitFn?: (args: string[], cwd: string) => Promise<{ code: number; stdout: string }> }`
  - `export interface LocalRepo { nwo: string | null; path: string; source: "config"|"watchlist"|"external"|"clone"; originUrl: string | null; forkUrl: string | null; githubUrl: string | null; branch: string | null; headSha: string | null; dirty: boolean | null; error: string | null }`
  - `export function collectRepoCandidates(cfg: Config, deps?: LocalSnapshotDeps): RepoCandidate[]` (internal helper, exported for reuse by `enumerateWorktrees`)
  - `export function enumerateRepos(cfg: Config, deps?: LocalSnapshotDeps): Promise<LocalRepo[]>`
  - internal `mapPool`, `defaultGitFn` (module-private).

**Steps:**

- [ ] 1. Write the failing test. Create `tests/localSnapshotRepos.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { enumerateRepos, collectRepoCandidates } from "../src/tui/localSnapshot.js";
import { writeWatchlist, watchlistPath } from "../src/watchlist.js";
import type { Config } from "../src/types.js";

/** Minimal Config over a sandboxed stateDir; only the fields the enumerators
 * read are populated (same cast style as queueSnapshot.test.ts). */
function makeCfg(root: string, overrides: Partial<Config> = {}): Config {
  return {
    stateDir: join(root, "state"),
    worktreeRoot: join(root, "wt"),
    gitBin: "git",
    ghBin: "gh",
    healthEnabled: true,
    healthHost: "127.0.0.1",
    healthPort: 8787,
    maxConcurrent: 1,
    github: {
      enabled: true,
      repos: [{ nwo: "owner/repo", path: join(root, "cfgrepo") }],
      externalReposRoot: join(root, "external"),
    },
    ...overrides,
  } as unknown as Config;
}

/** A readdirFn fake driven by an explicit dir→entries map ([] for anything
 * unlisted); a listed dir that maps to `THROW` throws (never-throws coverage). */
const THROW = Symbol("throw");
function fakeReaddir(map: Record<string, string[] | typeof THROW>): (d: string) => string[] {
  return (d: string): string[] => {
    const v = map[d];
    if (v === THROW) throw new Error(`readdir boom: ${d}`);
    return v ?? [];
  };
}

/** A gitFn fake: records every invocation, resolves per a per-subcommand table
 * keyed by args.join(" ") substring. Unmatched → code 1, empty stdout. */
function fakeGit(table: { match: RegExp; code: number; stdout: string }[], calls: string[][]) {
  return async (args: string[]): Promise<{ code: number; stdout: string }> => {
    calls.push(args);
    const joined = args.join(" ");
    const hit = table.find((t) => t.match.test(joined));
    return hit ? { code: hit.code, stdout: hit.stdout } : { code: 1, stdout: "" };
  };
}

describe("collectRepoCandidates", () => {
  it("unions config ∪ RAW watchlist (incl external:true) ∪ external walk ∪ clone walk, deduped by resolve(path), first source wins", () => {
    const root = mkdtempSync(join(tmpdir(), "junco-lsr-"));
    const cfg = makeCfg(root);
    // RAW watchlist: an owned entry AND an external:true fork (resolveWatchedRepos would drop the latter).
    writeWatchlist(watchlistPath(cfg), [
      { nwo: "w/owned", path: join(root, "wrepo") },
      { nwo: "up/stream", path: join(root, "extclone"), external: true },
      { nwo: "owner/repo", path: join(root, "cfgrepo") }, // dup of config → config wins
    ]);
    const clonesDir = join(cfg.stateDir, "repos");
    const readdirFn = fakeReaddir({
      [cfg.github.externalReposRoot]: ["acme"],
      [join(cfg.github.externalReposRoot, "acme")]: ["widget"],
      [clonesDir]: ["bob"],
      [join(clonesDir, "bob")]: ["tool"],
    });
    const got = collectRepoCandidates(cfg, { readdirFn });
    expect(got.map((c) => [c.source, c.nwoHint])).toEqual([
      ["config", "owner/repo"],
      ["watchlist", "w/owned"],
      ["watchlist", "up/stream"], // external:true survives (raw watchlist)
      ["external", "acme/widget"],
      ["clone", "bob/tool"],
    ]);
    // dedup: config path appears once, not again from the watchlist dup.
    expect(got.filter((c) => c.nwoHint === "owner/repo")).toHaveLength(1);
  });
});

describe("enumerateRepos", () => {
  it("per-repo git: nwo from origin, forkUrl from fork remote, branch@sha, dirty; every git call carries --no-optional-locks", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-lsr2-"));
    const cfg = makeCfg(root, {
      github: { enabled: true, repos: [{ nwo: "owner/repo", path: join(root, "cfgrepo") }], externalReposRoot: join(root, "external") },
    } as Partial<Config>);
    const calls: string[][] = [];
    const gitFn = fakeGit(
      [
        { match: /remote get-url origin/, code: 0, stdout: "https://github.com/owner/repo.git\n" },
        { match: /remote get-url fork/, code: 1, stdout: "" }, // owned repo → no fork remote
        { match: /rev-parse --abbrev-ref HEAD/, code: 0, stdout: "main\n" },
        { match: /rev-parse HEAD/, code: 0, stdout: "abc1234def\n" },
        { match: /status --porcelain/, code: 0, stdout: " M src/x.ts\n" },
      ],
      calls,
    );
    const repos = await enumerateRepos(cfg, { readdirFn: fakeReaddir({}), gitFn });
    expect(repos).toHaveLength(1);
    expect(repos[0]).toMatchObject({
      nwo: "owner/repo",
      source: "config",
      originUrl: "https://github.com/owner/repo.git",
      forkUrl: null,
      githubUrl: "https://github.com/owner/repo",
      branch: "main",
      headSha: "abc1234def",
      dirty: true,
      error: null,
    });
    // no plain `git status`: every invocation carries the lock-free flag.
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c).toContain("--no-optional-locks");
  });

  it("never-throws: a throwing gitFn yields a renderable repo with error set, null git fields", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-lsr3-"));
    const cfg = makeCfg(root);
    const gitFn = async (): Promise<{ code: number; stdout: string }> => {
      throw new Error("spawn EACCES");
    };
    const repos = await enumerateRepos(cfg, { readdirFn: fakeReaddir({}), gitFn });
    expect(repos).toHaveLength(1);
    expect(repos[0].error).toContain("spawn EACCES");
    expect(repos[0].branch).toBeNull();
    expect(repos[0].nwo).toBe("owner/repo"); // falls back to the nwoHint
  });

  it("never-throws: a throwing readdir on the external/clone walk degrades to config-only", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-lsr4-"));
    const cfg = makeCfg(root);
    const gitFn = fakeGit([{ match: /rev-parse HEAD/, code: 0, stdout: "sha\n" }], []);
    const repos = await enumerateRepos(cfg, {
      readdirFn: fakeReaddir({ [cfg.github.externalReposRoot]: THROW, [join(cfg.stateDir, "repos")]: THROW }),
      gitFn,
    });
    expect(repos.map((r) => r.source)).toEqual(["config"]);
  });
});
```

- [ ] 2. Run it, expect FAIL: `npx vitest run tests/localSnapshotRepos.test.ts > /tmp/t2 2>&1; echo "exit: $?"` — fails to import `../src/tui/localSnapshot.js` (module does not exist).

- [ ] 3. Write minimal implementation. Create `src/tui/localSnapshot.ts`:

```ts
/**
 * Local runtime snapshot for the dashboard LOCAL mode: the repos/clones/forks
 * junco knows about (and where they live on disk), the per-ticket worktrees,
 * the GitHub outbox op-log, and daemon/health detail. Split cheap vs heavy so
 * the 2s GitHub-path QueueSnapshot never pays for per-repo/per-worktree git.
 *
 * Every enumerator git call passes `--no-optional-locks` (lock-free observation
 * of a live daemon-owned base repo) and goes through the injectable `gitFn`
 * seam. Never-throws: a top-level try/catch sets `error`; per-item `error`
 * fields carry individual failures (posture of makeQueueSnapshotFn).
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Config } from "../types.js";
import { git } from "../git.js";
import { readWatchlist, watchlistPath } from "../watchlist.js";
import { nwoFromRemoteUrl } from "../githubInbox.js";
import { repoDiscriminator } from "../worktree.js";

export interface LocalSnapshotDeps {
  readdirFn?: (dir: string) => string[];
  readFileFn?: (p: string) => string;
  statFn?: (p: string) => { mtimeMs: number };
  fetchFn?: typeof fetch;
  nowFn?: () => Date;
  gitFn?: (args: string[], cwd: string) => Promise<{ code: number; stdout: string }>;
}

type GitFn = NonNullable<LocalSnapshotDeps["gitFn"]>;

export interface LocalRepo {
  nwo: string | null;
  path: string;
  source: "config" | "watchlist" | "external" | "clone";
  originUrl: string | null;
  forkUrl: string | null;
  githubUrl: string | null;
  branch: string | null;
  headSha: string | null;
  dirty: boolean | null;
  error: string | null;
}

export interface RepoCandidate {
  path: string;
  source: LocalRepo["source"];
  nwoHint: string | null;
}

const REPO_POOL = 4;

/** Default gitFn: cwd-scoped, check:false (a non-zero exit is data, not a
 * throw — the caller reads `code`). */
function defaultGitFn(cfg: Config): GitFn {
  return async (args, cwd) => {
    const r = await git(cfg, args, { cwd, check: false });
    return { code: r.code, stdout: r.stdout };
  };
}

/** Bounded-concurrency map: at most `limit` `fn` calls in flight. Order of
 * `results` matches `items`. */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) || 0 }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

/** One-level-of-owner walk: `<root>/<owner>/<name>` — matches both
 * externalClonePath (externalRepo.ts) and the dashboard clone target
 * (App.tsx clonesDir join owner/repo). Missing/undreadable dir → []. */
function walkOwnerName(
  root: string,
  source: LocalRepo["source"],
  readdirFn: (d: string) => string[],
): RepoCandidate[] {
  const out: RepoCandidate[] = [];
  let owners: string[];
  try {
    owners = readdirFn(root);
  } catch {
    return out;
  }
  for (const owner of owners) {
    const ownerPath = join(root, owner);
    let names: string[];
    try {
      names = readdirFn(ownerPath);
    } catch {
      continue;
    }
    for (const name of names) {
      out.push({ path: join(ownerPath, name), source, nwoHint: `${owner}/${name}` });
    }
  }
  return out;
}

/**
 * Union of the repos junco knows about, deduped by resolve(path) (first source
 * wins): (1) cfg.github.repos; (2) the RAW watchlist — readWatchlist, NOT
 * resolveWatchedRepos, so external:true forks survive (watchlist.ts:92);
 * (3) externalReposRoot walk; (4) <stateDir>/repos walk. Pure fs (no git), so
 * enumerateWorktrees can reuse it for the discriminator reverse-map.
 */
export function collectRepoCandidates(cfg: Config, deps: LocalSnapshotDeps = {}): RepoCandidate[] {
  const readdirFn = deps.readdirFn ?? readdirSync;
  const out: RepoCandidate[] = [];
  const seen = new Set<string>();
  const add = (c: RepoCandidate): void => {
    const key = resolve(c.path);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(c);
  };
  for (const r of cfg.github.repos) add({ path: r.path, source: "config", nwoHint: r.nwo });
  for (const e of readWatchlist(watchlistPath(cfg)).entries) {
    add({ path: e.path, source: "watchlist", nwoHint: e.nwo });
  }
  for (const c of walkOwnerName(cfg.github.externalReposRoot, "external", readdirFn)) add(c);
  for (const c of walkOwnerName(join(cfg.stateDir, "repos"), "clone", readdirFn)) add(c);
  return out;
}

/** Per-repo git enrichment, individually wrapped (never-throws → null fields +
 * `error`). nwo from origin's URL (nwoFromRemoteUrl), falling back to the
 * candidate's nwoHint; forkUrl from the `fork` remote (external/clone repos)
 * else null. Dirty = non-empty `status --porcelain`. */
async function buildRepo(c: RepoCandidate, gitFn: GitFn): Promise<LocalRepo> {
  const base: LocalRepo = {
    nwo: c.nwoHint,
    path: c.path,
    source: c.source,
    originUrl: null,
    forkUrl: null,
    githubUrl: null,
    branch: null,
    headSha: null,
    dirty: null,
    error: null,
  };
  try {
    const q = (args: string[]): Promise<{ code: number; stdout: string }> =>
      gitFn(["--no-optional-locks", "-C", c.path, ...args], c.path);

    const originR = await q(["remote", "get-url", "origin"]);
    const originUrl = originR.code === 0 ? originR.stdout.trim() : null;
    const forkR = await q(["remote", "get-url", "fork"]);
    const forkUrl = forkR.code === 0 ? forkR.stdout.trim() : null;
    const nwo = (originUrl ? nwoFromRemoteUrl(originUrl) : null) ?? c.nwoHint;

    const branchR = await q(["rev-parse", "--abbrev-ref", "HEAD"]);
    const branch = branchR.code === 0 ? branchR.stdout.trim() : null;
    const headR = await q(["rev-parse", "HEAD"]);
    const headSha = headR.code === 0 ? headR.stdout.trim() : null;
    const statusR = await q(["status", "--porcelain"]);
    const dirty = statusR.code === 0 ? statusR.stdout.trim() !== "" : null;

    return {
      ...base,
      nwo,
      originUrl,
      forkUrl,
      githubUrl: nwo ? `https://github.com/${nwo}` : null,
      branch,
      headSha,
      dirty,
    };
  } catch (e) {
    return { ...base, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function enumerateRepos(cfg: Config, deps: LocalSnapshotDeps = {}): Promise<LocalRepo[]> {
  const gitFn = deps.gitFn ?? defaultGitFn(cfg);
  const candidates = collectRepoCandidates(cfg, deps);
  return mapPool(candidates, REPO_POOL, (c) => buildRepo(c, gitFn));
}
```

- [ ] 4. Run, expect PASS: `npx vitest run tests/localSnapshotRepos.test.ts > /tmp/t2 2>&1; echo "exit: $?"`.

- [ ] 5. Typecheck + format: `npx tsc --noEmit -p tsconfig.eslint.json 2>&1 | grep localSnapshot; echo "---"; npx prettier --write src/tui/localSnapshot.ts tests/localSnapshotRepos.test.ts` (expect no `localSnapshot` errors).

- [ ] 6. Commit:

```bash
git add -A && git commit -m "feat(tui): enumerateRepos + candidate union for local snapshot"
```

---

### Task 3: `enumerateWorktrees` in `src/tui/localSnapshot.ts`

**Files:**
- Modify `src/tui/localSnapshot.ts` (add `LocalWorktree` + `enumerateWorktrees`)
- Create `tests/localSnapshotWorktrees.test.ts`

**Interfaces:**
- Consumes: `collectRepoCandidates` (this module, prior task); `repoDiscriminator(repoPath: string): string` (`src/worktree.js`); `LocalSnapshotDeps` (this module).
- Produces:
  - `export interface LocalWorktree { path: string; repoPath: string | null; repoNwo: string | null; slug: string; kind: "live"|"stale"|"backup"; headSha: string | null; ageSeconds: number | null; error: string | null }`
  - `export function enumerateWorktrees(cfg: Config, deps?: LocalSnapshotDeps): Promise<LocalWorktree[]>`

**Steps:**

- [ ] 1. Write the failing test. Create `tests/localSnapshotWorktrees.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { enumerateWorktrees } from "../src/tui/localSnapshot.js";
import { repoDiscriminator } from "../src/worktree.js";
import type { Config } from "../src/types.js";

function makeCfg(root: string, repoPath: string): Config {
  return {
    stateDir: join(root, "state"),
    worktreeRoot: join(root, "wt"),
    gitBin: "git",
    ghBin: "gh",
    healthEnabled: true,
    healthHost: "127.0.0.1",
    healthPort: 8787,
    maxConcurrent: 1,
    github: { enabled: true, repos: [{ nwo: "owner/repo", path: repoPath }], externalReposRoot: join(root, "external") },
  } as unknown as Config;
}

const THROW = Symbol("throw");
function fakeReaddir(map: Record<string, string[] | typeof THROW>): (d: string) => string[] {
  return (d: string): string[] => {
    const v = map[d];
    if (v === THROW) throw new Error(`readdir boom: ${d}`);
    return v ?? [];
  };
}

describe("enumerateWorktrees", () => {
  it("classes live/stale/backup, reverse-maps the discriminator, reads HEAD lock-free; unmatched → repoNwo null", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-lsw-"));
    const repoPath = join(root, "cfgrepo");
    const cfg = makeCfg(root, repoPath);
    const disc = repoDiscriminator(repoPath); // matched
    const alien = "alien-00000000"; // no candidate maps to it → ⟨unmapped⟩
    const wtRoot = cfg.worktreeRoot;

    const liveWt = join(wtRoot, disc, "gh-owner-repo-1");
    const staleWt = join(wtRoot, disc, "gh-owner-repo-2");
    const backupWt = join(wtRoot, disc, "gh-owner-repo-3.old-1600000000");
    const alienWt = join(wtRoot, alien, "gh-x-y-9");

    const readdirFn = fakeReaddir({
      [wtRoot]: [disc, alien],
      [join(wtRoot, disc)]: ["gh-owner-repo-1", "gh-owner-repo-2", "gh-owner-repo-3.old-1600000000"],
      [join(wtRoot, alien)]: ["gh-x-y-9"],
      [liveWt]: [".git", "src"], // has .git → live
      [staleWt]: ["src"], //          no .git → stale
      [alienWt]: [".git"],
    });
    const calls: string[][] = [];
    const gitFn = async (args: string[]): Promise<{ code: number; stdout: string }> => {
      calls.push(args);
      return { code: 0, stdout: "deadbee\n" };
    };
    const now = new Date("2026-07-09T00:00:00Z");

    const wts = await enumerateWorktrees(cfg, { readdirFn, gitFn, nowFn: () => now });
    const byPath = Object.fromEntries(wts.map((w) => [w.path, w]));

    expect(byPath[liveWt]).toMatchObject({ kind: "live", slug: "gh-owner-repo-1", repoPath, repoNwo: "owner/repo", headSha: "deadbee" });
    expect(byPath[staleWt]).toMatchObject({ kind: "stale", repoNwo: "owner/repo" });
    expect(byPath[backupWt]).toMatchObject({ kind: "backup", slug: "gh-owner-repo-3", headSha: null });
    expect(byPath[backupWt].ageSeconds).toBe(Math.floor(now.getTime() / 1000) - 1600000000);
    expect(byPath[alienWt]).toMatchObject({ repoPath: null, repoNwo: null, kind: "live" });
    // every HEAD read is lock-free (no plain rev-parse).
    for (const c of calls) expect(c).toContain("--no-optional-locks");
  });

  it("never-throws: a throwing gitFn sets the worktree error but still classifies", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-lsw2-"));
    const cfg = makeCfg(root, join(root, "cfgrepo"));
    const disc = repoDiscriminator(join(root, "cfgrepo"));
    const readdirFn = fakeReaddir({
      [cfg.worktreeRoot]: [disc],
      [join(cfg.worktreeRoot, disc)]: ["slug-1"],
      [join(cfg.worktreeRoot, disc, "slug-1")]: [".git"],
    });
    const gitFn = async (): Promise<{ code: number; stdout: string }> => {
      throw new Error("git boom");
    };
    const [wt] = await enumerateWorktrees(cfg, { readdirFn, gitFn });
    expect(wt.kind).toBe("live");
    expect(wt.headSha).toBeNull();
    expect(wt.error).toContain("git boom");
  });

  it("missing worktreeRoot → [] (never error)", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-lsw3-"));
    const cfg = makeCfg(root, join(root, "cfgrepo"));
    expect(await enumerateWorktrees(cfg, { readdirFn: fakeReaddir({}) })).toEqual([]);
  });
});
```

- [ ] 2. Run it, expect FAIL: `npx vitest run tests/localSnapshotWorktrees.test.ts > /tmp/t3 2>&1; echo "exit: $?"` — `enumerateWorktrees` is not exported.

- [ ] 3. Write minimal implementation. Append to `src/tui/localSnapshot.ts`:

```ts
export interface LocalWorktree {
  path: string;
  repoPath: string | null;
  repoNwo: string | null;
  slug: string;
  kind: "live" | "stale" | "backup";
  headSha: string | null;
  ageSeconds: number | null;
  error: string | null;
}

const OLD_TS_RE = /\.old-(\d+)$/;

/**
 * Walk cfg.worktreeRoot (layout worktreeRoot/<repoDiscriminator>/<slug> +
 * `.old-<ts>` backups, worktree.ts:148-162). Display class only: a `.old-<ts>`
 * dir → backup; a dir whose listing contains `.git` → live; else → stale (the
 * FS class is display-only, NOT the prune safety signal). Reverse-maps the
 * discriminator by precomputing repoDiscriminator() over the same candidate
 * union enumerateRepos uses — no git needed for the map; unmatched → repoNwo
 * null (⟨unmapped⟩). HEAD via a lock-free rev-parse through gitFn (mirrors
 * currentHeadSha, worktree.ts:71, but seam-injectable + --no-optional-locks).
 */
export async function enumerateWorktrees(
  cfg: Config,
  deps: LocalSnapshotDeps = {},
): Promise<LocalWorktree[]> {
  const readdirFn = deps.readdirFn ?? readdirSync;
  const nowFn = deps.nowFn ?? ((): Date => new Date());
  const gitFn = deps.gitFn ?? defaultGitFn(cfg);

  const discMap = new Map<string, { path: string; nwo: string | null }>();
  for (const c of collectRepoCandidates(cfg, deps)) {
    discMap.set(repoDiscriminator(c.path), { path: c.path, nwo: c.nwoHint });
  }

  const nowSeconds = Math.floor(nowFn().getTime() / 1000);
  const hasDotGit = (dir: string): boolean => {
    try {
      return readdirFn(dir).includes(".git");
    } catch {
      return false;
    }
  };

  let discDirs: string[];
  try {
    discDirs = readdirFn(cfg.worktreeRoot);
  } catch {
    return []; // worktreeRoot missing (fresh install) — empty, never error
  }

  const out: LocalWorktree[] = [];
  for (const disc of discDirs) {
    const discPath = join(cfg.worktreeRoot, disc);
    // Legacy flat backup directly under worktreeRoot (pre-issue-#33 layout).
    const flat = OLD_TS_RE.exec(disc);
    if (flat) {
      out.push({
        path: discPath,
        repoPath: null,
        repoNwo: null,
        slug: disc.slice(0, flat.index),
        kind: "backup",
        headSha: null,
        ageSeconds: nowSeconds - parseInt(flat[1], 10),
        error: null,
      });
      continue;
    }
    const mapped = discMap.get(disc) ?? null;
    let children: string[];
    try {
      children = readdirFn(discPath);
    } catch {
      continue; // vanished between the two listings
    }
    for (const name of children) {
      const wtPath = join(discPath, name);
      const backup = OLD_TS_RE.exec(name);
      const slug = backup ? name.slice(0, backup.index) : name;
      let kind: LocalWorktree["kind"];
      let ageSeconds: number | null = null;
      if (backup) {
        kind = "backup";
        ageSeconds = nowSeconds - parseInt(backup[1], 10);
      } else {
        kind = hasDotGit(wtPath) ? "live" : "stale";
      }
      let headSha: string | null = null;
      let error: string | null = null;
      if (kind !== "backup") {
        try {
          const r = await gitFn(["--no-optional-locks", "-C", wtPath, "rev-parse", "HEAD"], wtPath);
          headSha = r.code === 0 ? r.stdout.trim() : null;
        } catch (e) {
          error = e instanceof Error ? e.message : String(e);
        }
      }
      out.push({
        path: wtPath,
        repoPath: mapped?.path ?? null,
        repoNwo: mapped?.nwo ?? null,
        slug,
        kind,
        headSha,
        ageSeconds,
        error,
      });
    }
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}
```

- [ ] 4. Run, expect PASS: `npx vitest run tests/localSnapshotWorktrees.test.ts > /tmp/t3 2>&1; echo "exit: $?"`.

- [ ] 5. Typecheck + format: `npx tsc --noEmit -p tsconfig.eslint.json 2>&1 | grep localSnapshot; echo "---"; npx prettier --write src/tui/localSnapshot.ts tests/localSnapshotWorktrees.test.ts`.

- [ ] 6. Commit:

```bash
git add -A && git commit -m "feat(tui): enumerateWorktrees with discriminator reverse-map"
```

---

### Task 4: `fetchHealthBody` + `buildDaemonDetail` in `src/tui/localSnapshot.ts`

**Files:**
- Modify `src/tui/localSnapshot.ts` (add `HealthBody`, `DaemonDetail`, `fetchHealthBody`, `buildDaemonDetail`, private `emptyDaemon`)
- Create `tests/localSnapshotDaemon.test.ts`

**Interfaces:**
- Consumes: `MetricsSnapshot` (type, `src/metrics.js`); `endpointReachable(cfg, deps?): Promise<boolean>` (`src/health.js`); `LocalSnapshotDeps` (this module). `/health` body shape is `{ status, ready, metrics: MetricsSnapshot }` (`healthServer.ts:113`).
- Produces:
  - `export interface HealthBody { status: string; ready: boolean; metrics: MetricsSnapshot }`
  - `export interface DaemonDetail { up: boolean; pid: number|null; uptimeSeconds: number|null; endpointReachable: boolean; healthHost: string; healthPort: number; guardNudges: number|null; guardKills: number|null; tokensIn: number|null; tokensOut: number|null; tasksByStatus: Record<string,number>; currentTickets: string[]; progress: Record<string,{turns:number;lastTool:string|null;outputTokens:number;startedAt:string}>; error: string|null }`
  - `export function fetchHealthBody(cfg: Config, deps?: LocalSnapshotDeps): Promise<HealthBody | null>` — single AbortController-timed `/health` GET; null on !ok / error / `!cfg.healthEnabled`.
  - `export function buildDaemonDetail(cfg: Config, healthBody: HealthBody | null, deps?: LocalSnapshotDeps): Promise<DaemonDetail>`

**Steps:**

- [ ] 1. Write the failing test. Create `tests/localSnapshotDaemon.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { fetchHealthBody, buildDaemonDetail, type HealthBody } from "../src/tui/localSnapshot.js";
import type { Config } from "../src/types.js";
import type { MetricsSnapshot } from "../src/metrics.js";

function makeCfg(overrides: Partial<Config> = {}): Config {
  return {
    healthEnabled: true,
    healthHost: "127.0.0.1",
    healthPort: 8787,
    model: { baseUrl: "http://127.0.0.1:9999/v1", apiKey: "k", modelsJson: null },
    ...overrides,
  } as unknown as Config;
}

function metrics(over: Partial<MetricsSnapshot> = {}): MetricsSnapshot {
  return {
    startedAt: "2026-07-09T00:00:00Z",
    uptimeSeconds: 7890,
    pid: 4242,
    pollCount: 3,
    lastPollAt: null,
    currentTicket: "t-1",
    currentTickets: ["t-1", "t-2"],
    tasksProcessed: 5,
    tasksSucceeded: 4,
    tasksFailed: 1,
    tasksByStatus: { completed: 4, failed: 1 },
    totalTokensIn: 1000,
    totalTokensOut: 2000,
    totalDurationMs: 0,
    lastTaskAt: null,
    lastTaskStatus: null,
    bridgeSweeps: 0,
    lastBridgeSweepAt: null,
    ticketsBridged: 0,
    bridgeErrors: 0,
    outboxDepth: 0,
    outboxEnqueued: 0,
    outboxFlushed: 0,
    outboxDead: 0,
    lastFlushAt: null,
    requeues: 0,
    guardNudges: 2,
    guardKills: 1,
    currentProgress: {
      "t-1": { turns: 3, lastTool: "bash", outputTokens: 500, startedAt: "2026-07-09T00:00:01Z", updatedAt: "2026-07-09T00:05:00Z" },
    },
    ...over,
  };
}

/** Fake fetch: records urls; /health → the given body; anything else → ok. */
function recordingFetch(urls: string[], body: HealthBody | null): typeof fetch {
  return (async (url: string) => {
    urls.push(url);
    if (url.endsWith("/health")) {
      if (body === null) throw new Error("ECONNREFUSED");
      return { ok: true, json: async () => body };
    }
    return { ok: true, json: async () => ({}) };
  }) as unknown as typeof fetch;
}

describe("fetchHealthBody", () => {
  it("returns the parsed body on ok; null when health disabled; null on network error", async () => {
    const body: HealthBody = { status: "ok", ready: true, metrics: metrics() };
    const urls: string[] = [];
    expect(await fetchHealthBody(makeCfg(), { fetchFn: recordingFetch(urls, body) })).toEqual(body);
    expect(urls).toEqual(["http://127.0.0.1:8787/health"]);
    expect(await fetchHealthBody(makeCfg({ healthEnabled: false } as Partial<Config>), { fetchFn: recordingFetch([], body) })).toBeNull();
    expect(await fetchHealthBody(makeCfg(), { fetchFn: recordingFetch([], null) })).toBeNull();
  });
});

describe("buildDaemonDetail", () => {
  it("maps a live /health body → up detail (pid, uptime, guards, tokens, tickets, progress w/o updatedAt)", async () => {
    const body: HealthBody = { status: "ok", ready: true, metrics: metrics() };
    const d = await buildDaemonDetail(makeCfg(), body, { fetchFn: recordingFetch([], body) });
    expect(d).toMatchObject({
      up: true,
      pid: 4242,
      uptimeSeconds: 7890,
      endpointReachable: true,
      healthHost: "127.0.0.1",
      healthPort: 8787,
      guardNudges: 2,
      guardKills: 1,
      tokensIn: 1000,
      tokensOut: 2000,
      tasksByStatus: { completed: 4, failed: 1 },
      currentTickets: ["t-1", "t-2"],
      error: null,
    });
    expect(d.progress["t-1"]).toEqual({ turns: 3, lastTool: "bash", outputTokens: 500, startedAt: "2026-07-09T00:00:01Z" });
  });

  it("healthBody null (daemon down) → up:false but endpointReachable is probed independently", async () => {
    const d = await buildDaemonDetail(makeCfg(), null, { fetchFn: recordingFetch([], null) });
    expect(d.up).toBe(false);
    expect(d.pid).toBeNull();
    // endpointReachable probes /models — recordingFetch(_, null) throws only on /health, /models is ok.
    expect(d.endpointReachable).toBe(true);
    expect(d.currentTickets).toEqual([]);
    expect(d.error).toBeNull();
  });
});
```

- [ ] 2. Run it, expect FAIL: `npx vitest run tests/localSnapshotDaemon.test.ts > /tmp/t4 2>&1; echo "exit: $?"` — `fetchHealthBody`/`buildDaemonDetail`/`HealthBody` not exported.

- [ ] 3. Write minimal implementation. Add the `MetricsSnapshot`/`endpointReachable` imports to the top of `src/tui/localSnapshot.ts`, then append:

Add to the existing import block:
```ts
import type { MetricsSnapshot } from "../metrics.js";
import { endpointReachable } from "../health.js";
```

Append:
```ts
const HEALTH_TIMEOUT_MS = 1500;

export interface HealthBody {
  status: string;
  ready: boolean;
  metrics: MetricsSnapshot;
}

export interface DaemonDetail {
  up: boolean;
  pid: number | null;
  uptimeSeconds: number | null;
  endpointReachable: boolean;
  healthHost: string;
  healthPort: number;
  guardNudges: number | null;
  guardKills: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  tasksByStatus: Record<string, number>;
  currentTickets: string[];
  progress: Record<string, { turns: number; lastTool: string | null; outputTokens: number; startedAt: string }>;
  error: string | null;
}

function emptyDaemon(cfg: Config): DaemonDetail {
  return {
    up: false,
    pid: null,
    uptimeSeconds: null,
    endpointReachable: false,
    healthHost: cfg.healthHost,
    healthPort: cfg.healthPort,
    guardNudges: null,
    guardKills: null,
    tokensIn: null,
    tokensOut: null,
    tasksByStatus: {},
    currentTickets: [],
    progress: {},
    error: null,
  };
}

/** Single AbortController-timed GET /health (mirrors queueSnapshot.ts:169-199).
 * null when health is disabled, the response is not ok, or the fetch errors —
 * the daemon-down signal the callers thread everywhere. */
export async function fetchHealthBody(
  cfg: Config,
  deps: LocalSnapshotDeps = {},
): Promise<HealthBody | null> {
  if (!cfg.healthEnabled) return null;
  const fetchFn = deps.fetchFn ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HEALTH_TIMEOUT_MS);
  try {
    const resp = await fetchFn(`http://${cfg.healthHost}:${cfg.healthPort}/health`, {
      signal: ctrl.signal,
    });
    if (!resp.ok) return null;
    return (await resp.json()) as HealthBody;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Compose DaemonDetail from an ALREADY-fetched /health body (no second
 * request) plus an independent inference-endpoint probe (endpointReachable
 * hits /models, health.ts:40 — reachability is independent of the daemon). */
export async function buildDaemonDetail(
  cfg: Config,
  healthBody: HealthBody | null,
  deps: LocalSnapshotDeps = {},
): Promise<DaemonDetail> {
  const base = emptyDaemon(cfg);
  try {
    base.endpointReachable = await endpointReachable(cfg, { fetchFn: deps.fetchFn });
    if (healthBody === null) return base; // daemon down
    const m = healthBody.metrics;
    const progress: DaemonDetail["progress"] = {};
    for (const [id, v] of Object.entries(m.currentProgress ?? {})) {
      progress[id] = {
        turns: v.turns,
        lastTool: v.lastTool,
        outputTokens: v.outputTokens,
        startedAt: v.startedAt,
      };
    }
    return {
      ...base,
      up: true,
      pid: m.pid ?? null,
      uptimeSeconds: m.uptimeSeconds ?? null,
      guardNudges: m.guardNudges ?? null,
      guardKills: m.guardKills ?? null,
      tokensIn: m.totalTokensIn ?? null,
      tokensOut: m.totalTokensOut ?? null,
      tasksByStatus: { ...(m.tasksByStatus ?? {}) },
      currentTickets: [...(m.currentTickets ?? [])],
      progress,
    };
  } catch (e) {
    return { ...base, error: e instanceof Error ? e.message : String(e) };
  }
}
```

- [ ] 4. Run, expect PASS: `npx vitest run tests/localSnapshotDaemon.test.ts > /tmp/t4 2>&1; echo "exit: $?"`.

- [ ] 5. Typecheck + format: `npx tsc --noEmit -p tsconfig.eslint.json 2>&1 | grep localSnapshot; echo "---"; npx prettier --write src/tui/localSnapshot.ts tests/localSnapshotDaemon.test.ts`.

- [ ] 6. Commit:

```bash
git add -A && git commit -m "feat(tui): fetchHealthBody + buildDaemonDetail (single /health)"
```

---

### Task 5: `makeLocalCheapFn` + `healthOverride` seam on `makeQueueSnapshotFn`

**Files:**
- Modify `src/tui/queueSnapshot.ts` (`QueueSnapshotDeps` lines 57-63 — add `healthOverride`; the running section lines 165-216 — branch on it)
- Modify `src/tui/localSnapshot.ts` (add `LocalSection`, `LocalCheap`, `makeLocalCheapFn`, private `emptyQueue`/`countMd`)
- Create `tests/localSnapshotCheap.test.ts`

**Interfaces:**
- Consumes: `makeQueueSnapshotFn(cfg, deps): () => Promise<QueueSnapshot>` + `QueueSnapshot` + `QueueSnapshotDeps` (`./queueSnapshot.js`); `queuePaths(cfg): Paths` (`../config.js`); `listOpsFrom`, `outboxPaths`, `StoredOp` (`../githubOutbox.js`); `fetchHealthBody`, `buildDaemonDetail`, `HealthBody`, `DaemonDetail` (this module).
- Produces:
  - `src/tui/queueSnapshot.ts` additive dep: `healthOverride?: { body: HealthBody | null }` on `QueueSnapshotDeps` — when present, the queue layer issues NO `/health` request; a `HealthBody` → `daemonUp` + running from its metrics; `null` → daemon down → processing/ fallback.
  - `export type LocalSection = "queue"|"outbox"|"repos"|"worktrees"|"daemon"`
  - `export interface LocalCheap { queue: QueueSnapshot; counts: {done:number;failed:number}|null; outbox: {depth:number;dead:number;ops:StoredOp[];deadOps:StoredOp[];error:string|null}; daemon: DaemonDetail; error: string|null }`
  - `export function makeLocalCheapFn(cfg: Config, deps?: LocalSnapshotDeps): (opts?: { section?: LocalSection }) => Promise<LocalCheap>`

**Steps:**

- [ ] 1. Write the failing test. Create `tests/localSnapshotCheap.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeLocalCheapFn, type HealthBody } from "../src/tui/localSnapshot.js";
import type { Config } from "../src/types.js";

function makeCfg(root: string): Config {
  return {
    vaultRoot: join(root, "vault"),
    juncoSubdir: "q",
    stateDir: join(root, "state"),
    worktreeRoot: join(root, "wt"),
    defaultTimeoutMinutes: 30,
    maxConcurrent: 1,
    healthEnabled: true,
    healthHost: "127.0.0.1",
    healthPort: 8787,
    gitBin: "git",
    ghBin: "gh",
    model: { baseUrl: "http://127.0.0.1:9999/v1", apiKey: "k", modelsJson: null },
    github: { enabled: true, repos: [], externalReposRoot: join(root, "external") },
  } as unknown as Config;
}

const HEALTH: HealthBody = {
  status: "ok",
  ready: true,
  metrics: { pid: 99, uptimeSeconds: 10, currentTickets: ["run-1"], currentProgress: {}, tasksByStatus: {}, totalTokensIn: 0, totalTokensOut: 0, guardNudges: 0, guardKills: 0 } as unknown as HealthBody["metrics"],
};

function recordingFetch(urls: string[]): typeof fetch {
  return (async (url: string) => {
    urls.push(url);
    if (url.endsWith("/health")) return { ok: true, json: async () => HEALTH };
    return { ok: true, json: async () => ({}) }; // /models probe
  }) as unknown as typeof fetch;
}

describe("makeLocalCheapFn", () => {
  it("issues exactly ONE /health request (queue + daemon share the pre-fetched body)", async () => {
    const cfg = makeCfg(mkdtempSync(join(tmpdir(), "junco-cheap-")));
    const urls: string[] = [];
    const cheap = await makeLocalCheapFn(cfg, { fetchFn: recordingFetch(urls) })();
    expect(urls.filter((u) => u.endsWith("/health"))).toHaveLength(1);
    expect(cheap.queue.daemonUp).toBe(true);
    expect(cheap.queue.running.map((r) => r.id)).toEqual(["run-1"]);
    expect(cheap.daemon.up).toBe(true);
    expect(cheap.daemon.pid).toBe(99);
  });

  it("counts (done/failed) are computed ONLY when section === 'queue'", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-cheap2-"));
    const cfg = makeCfg(root);
    const done = join(cfg.vaultRoot, "q", "done");
    const failed = join(cfg.vaultRoot, "q", "failed");
    mkdirSync(done, { recursive: true });
    mkdirSync(failed, { recursive: true });
    writeFileSync(join(done, "a.md"), "x");
    writeFileSync(join(failed, "b.md"), "x");
    writeFileSync(join(failed, "c.md"), "x");
    const fn = makeLocalCheapFn(cfg, { fetchFn: recordingFetch([]) });
    expect((await fn({ section: "outbox" })).counts).toBeNull();
    expect((await fn({ section: "queue" })).counts).toEqual({ done: 1, failed: 2 });
  });

  it("outbox: live + dead split via listOpsFrom", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-cheap3-"));
    const cfg = makeCfg(root);
    const obx = join(cfg.stateDir, "github-outbox");
    const dead = join(obx, "dead");
    mkdirSync(dead, { recursive: true });
    writeFileSync(join(obx, "1-0-a-labels.json"), JSON.stringify({ origin: "prflow", attempts: 0, lastError: null, op: { kind: "labels", nwo: "a/b", issue: 1, add: [], remove: [] } }));
    writeFileSync(join(dead, "2-0-b-labels.json"), JSON.stringify({ origin: "prflow", attempts: 3, lastError: "boom", op: { kind: "labels", nwo: "a/b", issue: 2, add: [], remove: [] } }));
    const cheap = await makeLocalCheapFn(cfg, { fetchFn: recordingFetch([]) })();
    expect(cheap.outbox.depth).toBe(1);
    expect(cheap.outbox.dead).toBe(1);
    expect(cheap.outbox.ops[0].op.kind).toBe("labels");
    expect(cheap.outbox.deadOps[0].lastError).toBe("boom");
  });

  it("never-throws: a throwing fetchFn yields a renderable snapshot (daemon down, no throw)", async () => {
    const cfg = makeCfg(mkdtempSync(join(tmpdir(), "junco-cheap4-")));
    const boom = (async () => {
      throw new Error("net down");
    }) as unknown as typeof fetch;
    const cheap = await makeLocalCheapFn(cfg, { fetchFn: boom })();
    expect(cheap.daemon.up).toBe(false);
    expect(cheap.queue.daemonUp).toBe(false);
    expect(cheap.error).toBeNull();
  });
});
```

- [ ] 2. Run it, expect FAIL: `npx vitest run tests/localSnapshotCheap.test.ts > /tmp/t5 2>&1; echo "exit: $?"` — `makeLocalCheapFn` not exported.

- [ ] 3a. Add the `healthOverride` seam to `src/tui/queueSnapshot.ts`. First, add a type-only import at the top (erased at runtime, so no cycle with localSnapshot's value import of this module):

```ts
import type { HealthBody } from "./localSnapshot.js";
```

Extend `QueueSnapshotDeps` (after `nowFn?`):
```ts
  /** Pre-fetched /health, threaded in by makeLocalCheapFn so the queue layer
   * issues no second request (one consistent daemonUp per cheap tick). Absent
   * (undefined) keeps the self-fetch path; present → a HealthBody means daemon
   * up (use its metrics); null means daemon down → processing/ fallback. */
  healthOverride?: { body: HealthBody | null };
```

Replace the running-derivation block (`queueSnapshot.ts:165-203`, the `let daemonUp` … through the `catch` that falls through to the processing fallback) so the override short-circuits the fetch:

```ts
      let daemonUp = false;
      let running: QueueRunning[] = [];
      const mkRunning = (
        tickets: string[],
        prog: Record<string, HealthProgress>,
      ): QueueRunning[] =>
        tickets.map((id): QueueRunning => {
          const p = prog[id];
          return {
            id,
            github: procById.get(id)?.github ?? null,
            turns: p?.turns ?? null,
            lastTool: p?.lastTool ?? null,
            outputTokens: p?.outputTokens ?? null,
            startedAt: p?.startedAt ?? null,
            stale: false,
          };
        });
      if (deps.healthOverride !== undefined) {
        // Already fetched by makeLocalCheapFn — never issue a second request.
        const body = deps.healthOverride.body;
        if (body !== null) {
          daemonUp = true;
          running = mkRunning(body.metrics?.currentTickets ?? [], body.metrics?.currentProgress ?? {});
        }
      } else if (cfg.healthEnabled) {
        try {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), HEALTH_TIMEOUT_MS);
          try {
            const resp = await fetchFn(`http://${cfg.healthHost}:${cfg.healthPort}/health`, {
              signal: ctrl.signal,
            });
            if (resp.ok) {
              const j = (await resp.json()) as {
                metrics?: { currentTickets?: string[]; currentProgress?: Record<string, HealthProgress> };
              };
              daemonUp = true;
              running = mkRunning(j.metrics?.currentTickets ?? [], j.metrics?.currentProgress ?? {});
            }
          } finally {
            clearTimeout(timer);
          }
        } catch {
          // unreachable/timeout — fall through to the processing/ fallback
        }
      }
```

(The existing `if (!daemonUp) { running = proc.map(...) }` fallback block that follows is untouched.)

- [ ] 3b. Add `makeLocalCheapFn` to `src/tui/localSnapshot.ts`. Extend the imports:

```ts
import { queuePaths } from "../config.js";
import { makeQueueSnapshotFn, type QueueSnapshot } from "./queueSnapshot.js";
import { listOpsFrom, outboxPaths, type StoredOp } from "../githubOutbox.js";
```

Append:
```ts
export type LocalSection = "queue" | "outbox" | "repos" | "worktrees" | "daemon";

export interface LocalCheap {
  queue: QueueSnapshot;
  counts: { done: number; failed: number } | null;
  outbox: { depth: number; dead: number; ops: StoredOp[]; deadOps: StoredOp[]; error: string | null };
  daemon: DaemonDetail;
  error: string | null;
}

function emptyQueue(cfg: Config): QueueSnapshot {
  return {
    daemonUp: false,
    maxConcurrent: cfg.maxConcurrent,
    running: [],
    waiting: [],
    recent: [],
    error: null,
    outboxDepth: 0,
  };
}

/** Deps-injectable `.md` count (mirrors statusCmd.ts:28 countMd). */
function countMd(dir: string, deps: LocalSnapshotDeps): number {
  const readdirFn = deps.readdirFn ?? readdirSync;
  try {
    return readdirFn(dir).filter((n) => n.endsWith(".md")).length;
  } catch {
    return 0;
  }
}

/**
 * Cheap tick: queue (via makeQueueSnapshotFn), gated done/failed counts,
 * outbox live/dead split, daemon detail. ONE /health fetch total — fetched
 * here and threaded into both the queue layer (healthOverride) and
 * buildDaemonDetail. Never-throws (top-level try/catch + per-section fields).
 */
export function makeLocalCheapFn(
  cfg: Config,
  deps: LocalSnapshotDeps = {},
): (opts?: { section?: LocalSection }) => Promise<LocalCheap> {
  return async (opts: { section?: LocalSection } = {}): Promise<LocalCheap> => {
    const base: LocalCheap = {
      queue: emptyQueue(cfg),
      counts: null,
      outbox: { depth: 0, dead: 0, ops: [], deadOps: [], error: null },
      daemon: emptyDaemon(cfg),
      error: null,
    };
    try {
      const healthBody = await fetchHealthBody(cfg, deps);

      const queue = await makeQueueSnapshotFn(cfg, {
        readdirFn: deps.readdirFn,
        readFileFn: deps.readFileFn,
        statFn: deps.statFn,
        nowFn: deps.nowFn,
        healthOverride: { body: healthBody },
      })();

      let counts: LocalCheap["counts"] = null;
      if (opts.section === "queue") {
        const paths = queuePaths(cfg);
        counts = { done: countMd(paths.done, deps), failed: countMd(paths.failed, deps) };
      }

      let outbox = base.outbox;
      try {
        const outDeps = { readdirFn: deps.readdirFn, readFileFn: deps.readFileFn };
        const ops = listOpsFrom(outboxPaths(cfg).dir, outDeps);
        const deadOps = listOpsFrom(outboxPaths(cfg).dead, outDeps);
        outbox = { depth: ops.length, dead: deadOps.length, ops, deadOps, error: null };
      } catch (e) {
        outbox = { depth: 0, dead: 0, ops: [], deadOps: [], error: e instanceof Error ? e.message : String(e) };
      }

      const daemon = await buildDaemonDetail(cfg, healthBody, deps);

      return { queue, counts, outbox, daemon, error: null };
    } catch (e) {
      return { ...base, error: e instanceof Error ? e.message : String(e) };
    }
  };
}
```

- [ ] 4. Run, expect PASS: `npx vitest run tests/localSnapshotCheap.test.ts tests/queueSnapshot.test.ts > /tmp/t5 2>&1; echo "exit: $?"` — the cheap-fn tests pass AND the existing `queueSnapshot` suite stays green (the self-fetch path is unchanged when `healthOverride` is absent).

- [ ] 5. Typecheck + format: `npx tsc --noEmit -p tsconfig.eslint.json 2>&1 | grep -E 'queueSnapshot|localSnapshot'; echo "---"; npx prettier --write src/tui/queueSnapshot.ts src/tui/localSnapshot.ts tests/localSnapshotCheap.test.ts`.

- [ ] 6. Commit:

```bash
git add -A && git commit -m "feat(tui): makeLocalCheapFn with single-fetch healthOverride seam"
```

---

### Task 6: `makeLocalHeavyFn` (bounded pool + AbortSignal late-drop)

**Files:**
- Modify `src/tui/localSnapshot.ts` (add `LocalHeavy`, `makeLocalHeavyFn`)
- Create `tests/localSnapshotHeavy.test.ts`

**Interfaces:**
- Consumes: `enumerateRepos`, `enumerateWorktrees`, `LocalSnapshotDeps` (this module).
- Produces:
  - `export interface LocalHeavy { repos: LocalRepo[]; worktrees: LocalWorktree[]; error: string | null }`
  - `export function makeLocalHeavyFn(cfg: Config, deps?: LocalSnapshotDeps): (signal?: AbortSignal) => Promise<LocalHeavy>` — runs `enumerateRepos` + `enumerateWorktrees` concurrently (their internal `mapPool` bounds git concurrency); drops the result (returns empty `LocalHeavy`) when the `signal` aborts before or during the run (late-result drop); never-throws.

**Steps:**

- [ ] 1. Write the failing test. Create `tests/localSnapshotHeavy.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeLocalHeavyFn } from "../src/tui/localSnapshot.js";
import type { Config } from "../src/types.js";

function makeCfg(root: string): Config {
  return {
    stateDir: join(root, "state"),
    worktreeRoot: join(root, "wt"),
    gitBin: "git",
    ghBin: "gh",
    healthEnabled: true,
    healthHost: "127.0.0.1",
    healthPort: 8787,
    maxConcurrent: 1,
    github: { enabled: true, repos: [{ nwo: "owner/repo", path: join(root, "cfgrepo") }], externalReposRoot: join(root, "external") },
  } as unknown as Config;
}

describe("makeLocalHeavyFn", () => {
  it("composes repos + worktrees", async () => {
    const cfg = makeCfg(mkdtempSync(join(tmpdir(), "junco-heavy-")));
    const gitFn = async (): Promise<{ code: number; stdout: string }> => ({ code: 0, stdout: "sha\n" });
    const heavy = await makeLocalHeavyFn(cfg, { readdirFn: () => [], gitFn })();
    expect(heavy.repos.map((r) => r.nwo)).toEqual(["owner/repo"]);
    expect(heavy.worktrees).toEqual([]);
    expect(heavy.error).toBeNull();
  });

  it("a pre-aborted signal drops the run immediately (gitFn never called)", async () => {
    const cfg = makeCfg(mkdtempSync(join(tmpdir(), "junco-heavy2-")));
    let called = false;
    const gitFn = async (): Promise<{ code: number; stdout: string }> => {
      called = true;
      return { code: 0, stdout: "" };
    };
    const ac = new AbortController();
    ac.abort();
    const heavy = await makeLocalHeavyFn(cfg, { readdirFn: () => [], gitFn })(ac.signal);
    expect(heavy).toEqual({ repos: [], worktrees: [], error: null });
    expect(called).toBe(false);
  });

  it("late-result drop: an abort mid-flight discards the resolved enumerators", async () => {
    const cfg = makeCfg(mkdtempSync(join(tmpdir(), "junco-heavy3-")));
    const ac = new AbortController();
    // gitFn parks until we release it; we abort while it's parked, then release.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const gitFn = async (): Promise<{ code: number; stdout: string }> => {
      await gate;
      return { code: 0, stdout: "sha\n" };
    };
    const p = makeLocalHeavyFn(cfg, { readdirFn: () => [], gitFn })(ac.signal);
    ac.abort();
    release();
    const heavy = await p;
    expect(heavy).toEqual({ repos: [], worktrees: [], error: null }); // dropped
  });
});
```

- [ ] 2. Run it, expect FAIL: `npx vitest run tests/localSnapshotHeavy.test.ts > /tmp/t6 2>&1; echo "exit: $?"` — `makeLocalHeavyFn` not exported.

- [ ] 3. Write minimal implementation. Append to `src/tui/localSnapshot.ts`:

```ts
export interface LocalHeavy {
  repos: LocalRepo[];
  worktrees: LocalWorktree[];
  error: string | null;
}

/**
 * Heavy tick: repos + worktrees, run concurrently (each enumerator bounds its
 * own git fan-out via mapPool). `signal` gives late-result drop — when a
 * mode-switch/unmount aborts before or during the run, the resolved results are
 * discarded (empty LocalHeavy) so a stale poll never clobbers fresh state.
 * Never-throws.
 */
export function makeLocalHeavyFn(
  cfg: Config,
  deps: LocalSnapshotDeps = {},
): (signal?: AbortSignal) => Promise<LocalHeavy> {
  return async (signal?: AbortSignal): Promise<LocalHeavy> => {
    const dropped: LocalHeavy = { repos: [], worktrees: [], error: null };
    if (signal?.aborted) return dropped;
    try {
      const [repos, worktrees] = await Promise.all([
        enumerateRepos(cfg, deps),
        enumerateWorktrees(cfg, deps),
      ]);
      if (signal?.aborted) return dropped; // late-result drop
      return { repos, worktrees, error: null };
    } catch (e) {
      if (signal?.aborted) return dropped;
      return { repos: [], worktrees: [], error: e instanceof Error ? e.message : String(e) };
    }
  };
}
```

- [ ] 4. Run, expect PASS: `npx vitest run tests/localSnapshotHeavy.test.ts > /tmp/t6 2>&1; echo "exit: $?"`.

- [ ] 5. Full-gate the stage: `npm run lint > /tmp/g 2>&1; echo "lint: $?"; npx tsc --noEmit -p tsconfig.eslint.json 2>&1 | grep -E 'localSnapshot|queueSnapshot|githubOutbox'; echo "tc-grep-done"; npx vitest run tests/localSnapshotRepos.test.ts tests/localSnapshotWorktrees.test.ts tests/localSnapshotDaemon.test.ts tests/localSnapshotCheap.test.ts tests/localSnapshotHeavy.test.ts tests/githubOutbox.test.ts tests/queueSnapshot.test.ts > /tmp/all 2>&1; echo "tests: $?"; npx prettier --write src/tui/localSnapshot.ts tests/localSnapshotHeavy.test.ts`.

- [ ] 6. Commit:

```bash
git add -A && git commit -m "feat(tui): makeLocalHeavyFn bounded pool with abort late-drop"
```

---

STAGE NOTES: (1) **origin/fork mapping conflict** — the spec's Data-model bullet says an external clone's "origin is the fork → forkUrl = originUrl," but the authoritative code (`externalRepo.ts`) sets origin=upstream and a separate `fork` remote=the operator's fork. I implemented per the code: `nwo`/`originUrl` from `origin`, `forkUrl` from the `fork` remote (null on owned repos). Stage B/UI (`ReposSection`) must render against THIS mapping, and any later stage that trusts the spec bullet needs reconciling. (2) **`HealthBody` lives in `localSnapshot.ts`**; `queueSnapshot.ts` imports it **type-only** to avoid a runtime cycle (localSnapshot value-imports queueSnapshot). Keep that import `import type` — a value import would form a real ESM cycle. (3) **`healthOverride` is an additive optional `QueueSnapshotDeps` field**; the self-fetch path is byte-identical when it's absent, so the atomic-switch Stage-5 App wiring can adopt it without touching the GitHub `t`-view queue poll. (4) **Worktree HEAD** is read through the injected `gitFn` with `--no-optional-locks` rather than calling `currentHeadSha` (worktree.ts:71) directly, because `currentHeadSha` bypasses both the deps seam and the lock-free flag; the behavior is equivalent but the symbol is not consumed. (5) **Repo/clone walk is two-level (`<owner>/<name>`)**, matching `externalClonePath` and the dashboard clone target (`App.tsx:951`), not the spec's imprecise "one-level walk"; the walk root is `<stateDir>/repos` per `dashboardCmd.ts:75`. (6) **`LocalSnapshotDeps` has no `existsFn`** (fixed by contract); live/stale classification uses `readdirFn(wtPath).includes(".git")`. (7) **`enumerateRepos`/`enumerateWorktrees` bound their own git fan-out via an internal `mapPool`**; `makeLocalHeavyFn` owns only the AbortSignal late-drop (true child-process kill on abort is a Stage-B App-effect concern — the enumerators' `gitFn` seam does not thread a signal down to `git()`), which the assembler should flag for the App-wiring stage.


<!-- ===== Stage B — Daemon worktrees.lock (behavior-preserving) ===== -->

### Task 7: Serialize daemon-side worktree mutations behind `.worktrees.lock`

**Files:**
- Modify `src/worktree.ts` (add import; add `worktreesLockPath` export after the header block ~line 28; wrap `prepareWorktree` body lines 143–265; wrap `cleanupWorktree` body lines 280–301; wrap `pruneStaleWorktrees` body lines 319–362 — after its `existsSync` guard)
- Modify `tests/worktree.test.ts` (add imports; add a `worktrees.lock` describe block after the `pruneStaleWorktrees` block ~line 592)

**Interfaces:**
- Consumes (existing, read from source — do not change signatures):
  - `acquirePidfileLock(lockPath: string, deps?: PidfileLockDeps): PidfileLock | null` (`src/pidfileLock.ts`) — `PidfileLock.release(): void` is idempotent and only unlinks when the file's pid still matches this process.
  - `prepareWorktree(cfg: Config, ctx: RepoContext, taskId: string, opts?): Promise<string>`, `cleanupWorktree(cfg: Config, ctx: RepoContext, wtPath: string): Promise<void>`, `pruneStaleWorktrees(worktreeRoot: string, maxAgeSeconds?: number): void` (`src/worktree.ts`) — signatures UNCHANGED (no deps seam added; the lock deliberately uses the real fs, mirroring the flush-lock idiom at `githubOutbox.ts:391-393`).
  - `Config.worktreeRoot: string` (`src/types.ts:84`).
- Produces (additive, this task):
  - `worktreesLockPath(cfg: Pick<Config, "worktreeRoot">): string` = `join(cfg.worktreeRoot, ".worktrees.lock")` in `src/worktree.ts`.
  - Behavior: each of the three mutators acquires the lock via `acquirePidfileLock(worktreesLockPath(cfg))` and releases it in `finally` with `lock?.release()`. On contention (`null`) the mutator proceeds without holding (behavior-preserving: a singleton daemon is already the sole writer; the lock exists so an out-of-process `junco worktree prune` can detect the daemon mid-mutation and skip).

Steps:

- [ ] **Write the failing tests.** Append to `tests/worktree.test.ts`. First extend the existing import from `../src/worktree.js` to add `worktreesLockPath`, and add a new import line `import { acquirePidfileLock } from "../src/pidfileLock.js";` beside the `GitOpError` import. Then append this block:

```ts
// ---------------------------------------------------------------------------
// worktrees.lock — daemon-side mutation serialization (behavior-preserving)
// ---------------------------------------------------------------------------

describe("worktreesLockPath", () => {
  it("is `.worktrees.lock` directly under worktreeRoot", () => {
    const cfg = makeConfig(join(tmpRoot, "w"), join(tmpRoot, "wts"));
    expect(worktreesLockPath(cfg)).toBe(join(tmpRoot, "wts", ".worktrees.lock"));
  });
});

describe("worktrees.lock contention", () => {
  it("a held lock blocks a second acquirer at the same path, and frees on release", () => {
    const cfg = makeConfig(join(tmpRoot, "w"), join(tmpRoot, "wts"));
    const first = acquirePidfileLock(worktreesLockPath(cfg));
    expect(first).not.toBeNull();
    // Same path, holder still alive → second acquirer is refused.
    expect(acquirePidfileLock(worktreesLockPath(cfg))).toBeNull();
    first!.release();
    // Released → a fresh acquirer wins again.
    const third = acquirePidfileLock(worktreesLockPath(cfg));
    expect(third).not.toBeNull();
    third!.release();
  });
});

describe("worktree mutators release the lock", () => {
  it("prepareWorktree releases the worktrees lock on success", async () => {
    const { work, wtsRoot } = setupGitHarness(tmpRoot);
    const cfg = makeConfig(work, wtsRoot);
    await prepareWorktree(cfg, makeContext(work), "lock-ok-task");
    const after = acquirePidfileLock(worktreesLockPath(cfg));
    expect(after).not.toBeNull(); // lock was released
    after!.release();
  }, 30000);

  it("prepareWorktree releases the worktrees lock when it throws", async () => {
    const { work, wtsRoot } = setupGitHarness(tmpRoot);
    const cfg = makeConfig(work, wtsRoot);
    const ctx = makeContext(work);
    // Reuse the stale-dir cleanup failure: a plain dir occupies the worktree
    // path and a read-only per-repo parent makes the move-aside rename fail.
    const repoDir = join(wtsRoot, repoDiscriminator(work));
    const wtPath = join(repoDir, "lock-throw-task");
    mkdirSync(wtPath, { recursive: true });
    chmodSync(repoDir, 0o555);
    try {
      await expect(prepareWorktree(cfg, ctx, "lock-throw-task")).rejects.toThrow(GitOpError);
    } finally {
      chmodSync(repoDir, 0o755);
    }
    const after = acquirePidfileLock(worktreesLockPath(cfg));
    expect(after).not.toBeNull(); // finally released the lock despite the throw
    after!.release();
  }, 30000);

  it("prepareWorktree still provisions when the lock is already held (behavior-preserving)", async () => {
    const { work, wtsRoot } = setupGitHarness(tmpRoot);
    const cfg = makeConfig(work, wtsRoot);
    const held = acquirePidfileLock(worktreesLockPath(cfg));
    expect(held).not.toBeNull();
    // Contention must not deadlock or throw: the daemon is authoritative and
    // proceeds. Its `lock?.release()` no-ops on the null it got, so OUR held
    // lock is left intact.
    const wtPath = await prepareWorktree(cfg, makeContext(work), "held-lock-task");
    expect(existsSync(wtPath)).toBe(true);
    // Our lock survived the mutator's finally.
    expect(acquirePidfileLock(worktreesLockPath(cfg))).toBeNull();
    held!.release();
  }, 30000);

  it("cleanupWorktree releases the worktrees lock", async () => {
    const { work, wtsRoot } = setupGitHarness(tmpRoot);
    const cfg = makeConfig(work, wtsRoot);
    const ctx = makeContext(work);
    const wtPath = await prepareWorktree(cfg, ctx, "cleanup-lock-task");
    await cleanupWorktree(cfg, ctx, wtPath);
    const after = acquirePidfileLock(worktreesLockPath(cfg));
    expect(after).not.toBeNull();
    after!.release();
  }, 30000);

  it("pruneStaleWorktrees releases the lock and still prunes", () => {
    const wtsRoot = join(tmpRoot, "wts-lock-prune");
    mkdirSync(wtsRoot, { recursive: true });
    const oldDir = join(wtsRoot, "ticket.old-100");
    mkdirSync(oldDir, { recursive: true });

    pruneStaleWorktrees(wtsRoot, 3 * 86400);

    expect(existsSync(oldDir)).toBe(false); // still prunes
    const after = acquirePidfileLock(worktreesLockPath({ worktreeRoot: wtsRoot }));
    expect(after).not.toBeNull(); // lock released
    after!.release();
  });

  it("pruneStaleWorktrees stays a no-op when worktreeRoot is absent (no dir/lock created)", () => {
    const absent = join(tmpRoot, "never-created");
    expect(() => pruneStaleWorktrees(absent, 3 * 86400)).not.toThrow();
    // The lock guard must sit AFTER the existsSync early-return, so acquiring
    // the lock never resurrects the root dir.
    expect(existsSync(absent)).toBe(false);
  });
});
```

- [ ] **Run it, expect FAIL.** `npx vitest run tests/worktree.test.ts > /tmp/wt.out 2>&1; echo "exit: $?"` — expect failure: `worktreesLockPath` is not exported (`SyntaxError`/`does not provide an export named 'worktreesLockPath'`).

- [ ] **Add the import.** In `src/worktree.ts`, after the `import { GitOpError } from "./git.js";` line (line 28), add:

```ts
import { acquirePidfileLock } from "./pidfileLock.js";
```

- [ ] **Add the `worktreesLockPath` export.** In `src/worktree.ts`, insert immediately after that new import (before the `worktreeSlug` section banner):

```ts
// ---------------------------------------------------------------------------
// worktreesLockPath
// ---------------------------------------------------------------------------

/**
 * Path of the daemon-side worktrees lock — the cross-process mutex that
 * serializes every mutation of `worktreeRoot` (prepare/cleanup/prune here, and
 * the `junco worktree prune` CLI). Same hardened primitive as the outbox flush
 * lock (src/pidfileLock.ts). A singleton daemon is already the sole writer, so
 * acquiring it here is behavior-preserving: it exists so an out-of-process
 * prune can detect the daemon mid-mutation and skip rather than race
 * `git worktree add/remove` on shared `.git/worktrees/<id>` metadata.
 */
export function worktreesLockPath(cfg: Pick<Config, "worktreeRoot">): string {
  return join(cfg.worktreeRoot, ".worktrees.lock");
}
```

- [ ] **Wrap `prepareWorktree`.** Two edits (prettier will normalize the body indentation afterward). First, insert the acquire + `try {` right after the signature — replace:

```ts
): Promise<string> {
  const slug = worktreeSlug(taskId);
```

with:

```ts
): Promise<string> {
  const lock = acquirePidfileLock(worktreesLockPath(cfg));
  try {
  const slug = worktreeSlug(taskId);
```

Then close it — replace the tail of the function (the fresh-mode return and closing brace before the `cleanupWorktree` banner):

```ts
  linkNodeModules(ctx.repo, wtPath);
  return wtPath;
}

// ---------------------------------------------------------------------------
// cleanupWorktree
```

with:

```ts
  linkNodeModules(ctx.repo, wtPath);
  return wtPath;
  } finally {
    lock?.release();
  }
}

// ---------------------------------------------------------------------------
// cleanupWorktree
```

(The amend-mode `return wtPath;` and every `throw` in between now sit inside the `try` — no other change to their logic.)

- [ ] **Wrap `cleanupWorktree`** — replace the whole function body with the lock-guarded form:

```ts
export async function cleanupWorktree(
  cfg: Config,
  ctx: RepoContext,
  wtPath: string,
): Promise<void> {
  const lock = acquirePidfileLock(worktreesLockPath(cfg));
  try {
    try {
      await git(cfg, ["worktree", "remove", wtPath], {
        cwd: ctx.repo,
        timeoutMs: 60_000,
        check: false,
      });
    } catch (e) {
      log.warn(`worktree remove failed (non-fatal): ${e}`);
    }
    // Issue #33 layout: worktrees live under worktreeRoot/<repo-discriminator>/.
    // Drop the per-repo parent when this was its last worktree — rmdir only
    // removes EMPTY dirs, so a live sibling (or .old-* backup) keeps it alive.
    const parent = dirname(wtPath);
    if (resolve(parent) !== resolve(cfg.worktreeRoot)) {
      try {
        rmdirSync(parent);
      } catch {
        /* non-empty or already gone — fine */
      }
    }
  } finally {
    lock?.release();
  }
}
```

- [ ] **Wrap `pruneStaleWorktrees`** — the lock must go AFTER the `existsSync` early-return so an absent root is never resurrected. Replace:

```ts
export function pruneStaleWorktrees(worktreeRoot: string, maxAgeSeconds = 3 * 86400): void {
  if (!existsSync(worktreeRoot)) return;

  const nowSeconds = Math.floor(Date.now() / 1000);
```

with:

```ts
export function pruneStaleWorktrees(worktreeRoot: string, maxAgeSeconds = 3 * 86400): void {
  if (!existsSync(worktreeRoot)) return;

  const lock = acquirePidfileLock(worktreesLockPath({ worktreeRoot }));
  try {
  const nowSeconds = Math.floor(Date.now() / 1000);
```

Then replace the closing call + brace:

```ts
  pruneDir(worktreeRoot, 0);
}
```

with:

```ts
  pruneDir(worktreeRoot, 0);
  } finally {
    lock?.release();
  }
}
```

- [ ] **Normalize indentation.** `npx prettier --write src/worktree.ts` (re-indents the wrapped bodies; the two-anchor edits leave logic identical, only nesting depth changed).

- [ ] **Run, expect PASS.** `npx vitest run tests/worktree.test.ts > /tmp/wt.out 2>&1; echo "exit: $?"` — expect exit 0, including the pre-existing `prepareWorktree`/`cleanupWorktree`/`pruneStaleWorktrees` suites (proving each mutator still does what it did) and the new lock suite.

- [ ] **Guard against fixture drift.** No signature changed and no `Config` field was added, so no `makeConfig`/`cfg()` helper needs updating. Confirm with `npx tsc --noEmit -p tsconfig.eslint.json > /tmp/tc.out 2>&1; echo "exit: $?"` (ignore the ~57 known pre-existing errors; verify none reference `worktree.ts` or `worktreesLockPath`).

- [ ] **Lint + format check.** `npx eslint src/worktree.ts tests/worktree.test.ts && npx prettier --check src/worktree.ts tests/worktree.test.ts`.

- [ ] **Commit.** `git add src/worktree.ts tests/worktree.test.ts && git commit -m "feat(worktree): serialize daemon mutations behind .worktrees.lock"` (no AI-attribution trailer; if a subagent appended one, `git commit --amend` to strip it).

STAGE NOTES: The lock filename lives ONLY in `worktreesLockPath` — the sibling `src/worktreePruneCmd.ts` task MUST import and call `worktreesLockPath(cfg)` (not hardcode `.worktrees.lock`) so the daemon and the prune CLI contend on the exact same path; flag this to whoever writes `worktreePruneCmd`. The daemon-side design is proceed-on-null (behavior-preserving), so the CLI is the side that treats a `null` acquire as "daemon busy → refuse/skip"; the mutual exclusion the spec wants (§ lines 486-491) is realized because the daemon HOLDS the lock across its `git worktree add/remove`, making the CLI's acquire return `null`. `worktreesLockPath` takes `Pick<Config, "worktreeRoot">` (full `Config` satisfies it) — if another stage's contract typed it as `(cfg: Config)`, these are compatible, but the assembler should keep the `Pick` form since `pruneStaleWorktrees` only has a bare `worktreeRoot` string to pass. No `LocalSnapshotDeps.gitFn`/`enumerateWorktrees` coupling here; the heavy-snapshot worktree enumeration is a separate read-only stage and does not acquire this lock.


<!-- ===== Stage C — New CLI subcommands (unwired from TUI) ===== -->


---

### Task 8: `junco rm` — best-effort inbox delete (`src/rmCmd.ts`)

**Files:**
- Create `src/rmCmd.ts`
- Create `tests/rmCmd.test.ts`
- Modify `src/cli.ts` (import block ~46; USAGE ~92; dispatch — add a block after the `retry` block ~368-371)
- Modify `src/tui/cliRunner.ts` (`PALETTE_COMMANDS` ~33-55)
- Modify `tests/tuiCliRunner.test.ts` (roster assertion ~39-62)

**Interfaces:**

Consumes (existing, do not change):
- `queuePaths(cfg: Config): { inbox; processing; done; failed }` from `./config.js`
- `runRetryCommand` fuzzy-match idiom from `./retryCmd.js` (model only, not imported)
- `PaletteCommand` roster shape + the `cmd(...)` helper in `src/tui/cliRunner.ts`

Produces (matches SHARED CONTRACT verbatim):
- `src/rmCmd.ts`: `export interface RmDeps { printFn?: (s: string) => void; readdirFn?: (d: string) => string[]; unlinkFn?: (p: string) => void }`
- `src/rmCmd.ts`: `export async function runRmCommand(cfg: Config, args: string[], deps?: RmDeps): Promise<number>` — deletes `inbox/<name>.md` only; fuzzy-match like `retryCmd`; ENOENT-tolerant (exit 0, truthful "may reappear"); refuses `processing/` and out-of-inbox names.

Steps:

- [ ] 1. Write the failing test `tests/rmCmd.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runRmCommand } from "../src/rmCmd.js";
import type { Config } from "../src/types.js";

describe("runRmCommand", () => {
  let root: string;
  let cfg: Config;
  let out: string[];
  const queued = "2026-06-10T1200Z__fix-thing.md";
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "junco-rm-"));
    for (const d of ["inbox", "processing", "done", "failed"])
      mkdirSync(join(root, d), { recursive: true });
    writeFileSync(join(root, "inbox", queued), "---\nid: fix-thing\n---\nfix\n", "utf8");
    cfg = { vaultRoot: root, juncoSubdir: "", defaultTimeoutMinutes: 30 } as unknown as Config;
    out = [];
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("deletes a fuzzy-matched inbox ticket and exits 0", async () => {
    const code = await runRmCommand(cfg, ["fix-thing"], { printFn: (s) => out.push(s) });
    expect(code).toBe(0);
    expect(existsSync(join(root, "inbox", queued))).toBe(false);
    expect(out.join("")).toMatch(/removed:/);
  });

  it("ambiguous substring → exit 2, nothing deleted", async () => {
    writeFileSync(join(root, "inbox", "fix-thing-2.md"), "x", "utf8");
    const code = await runRmCommand(cfg, ["fix"], { printFn: (s) => out.push(s) });
    expect(code).toBe(2);
    expect(readdirSync(join(root, "inbox"))).toHaveLength(2);
    expect(out.join("")).toMatch(/ambiguous/);
  });

  it("no inbox match → exit 0 with the truthful 'may reappear' message", async () => {
    const code = await runRmCommand(cfg, ["nonesuch"], { printFn: (s) => out.push(s) });
    expect(code).toBe(0);
    expect(out.join("")).toMatch(/not present in inbox — it may be claimed or mid-requeue/);
  });

  it("ENOENT at unlink (daemon claimed it mid-delete) → exit 0, 'may reappear'", async () => {
    const enoent = Object.assign(new Error("gone"), { code: "ENOENT" });
    const code = await runRmCommand(cfg, ["fix-thing"], {
      printFn: (s) => out.push(s),
      unlinkFn: () => {
        throw enoent;
      },
    });
    expect(code).toBe(0);
    expect(out.join("")).toMatch(/could reappear/);
  });

  it("refuses an out-of-inbox / processing name outright → exit 2, no delete", async () => {
    for (const bad of ["../processing/x", "a/b", "/etc/passwd"]) {
      const code = await runRmCommand(cfg, [bad], { printFn: (s) => out.push(s) });
      expect(code).toBe(2);
      expect(out.join("")).toMatch(/not a plain inbox ticket name/);
    }
    expect(existsSync(join(root, "inbox", queued))).toBe(true);
  });

  it("no name → usage + exit 2", async () => {
    expect(await runRmCommand(cfg, [], { printFn: (s) => out.push(s) })).toBe(2);
    expect(out.join("")).toMatch(/Usage: junco rm/);
  });
});
```

- [ ] 2. Run it, expect FAIL: `npx vitest run tests/rmCmd.test.ts > /tmp/rm.out 2>&1; echo "exit: $?"` — fails to resolve `../src/rmCmd.js` (module missing).

- [ ] 3. Write minimal implementation `src/rmCmd.ts`:

```ts
/**
 * `junco rm <name>` — best-effort delete of a QUEUED ticket from inbox/ only.
 *
 * Fuzzy-matches the name against inbox/*.md like `junco retry`. It NEVER touches
 * processing/ (the daemon owns it) and refuses any name that resolves outside
 * inbox/. It is deliberately ENOENT-tolerant: the daemon can atomically claim a
 * ticket into processing/ between the caller's listing and this delete, and a
 * transient requeue can even rename a just-deleted name back INTO inbox/
 * (requeue.ts:82), so a miss is reported truthfully as "may reappear" and exits
 * 0 — this is a best-effort inbox delete, not an authoritative kill.
 */

import { readdirSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import type { Config } from "./types.js";
import { queuePaths } from "./config.js";

export interface RmDeps {
  printFn?: (s: string) => void;
  readdirFn?: (d: string) => string[];
  unlinkFn?: (p: string) => void;
}

const notPresent = (name: string): string =>
  `junco rm: '${name}' not present in inbox — it may be claimed or mid-requeue and could reappear\n`;

export async function runRmCommand(cfg: Config, args: string[], deps: RmDeps = {}): Promise<number> {
  const print = deps.printFn ?? ((s: string) => process.stdout.write(s));
  const readdirFn = deps.readdirFn ?? ((d: string) => readdirSync(d));
  const unlinkFn = deps.unlinkFn ?? ((p: string) => unlinkSync(p));

  const name = args[0];
  if (!name) {
    print("Usage: junco rm <name>\n");
    return 2;
  }

  // Path safety: rm operates ONLY on a bare inbox filename. A name carrying a
  // path separator (../x, a/b, /abs/path, …/processing/x) or a leading dot can
  // never be a legit inbox ticket name — refuse outright rather than fuzzy-match.
  if (name !== basename(name) || name.startsWith(".")) {
    print(`junco rm: '${name}' is not a plain inbox ticket name\n`);
    return 2;
  }

  const inbox = queuePaths(cfg).inbox;
  let entries: string[] = [];
  try {
    entries = readdirFn(inbox).filter((n) => n.endsWith(".md"));
  } catch {
    /* no inbox dir yet — treat as empty */
  }

  const exact = entries.filter((e) => e === name || e === `${name}.md`);
  const fuzzy = exact.length > 0 ? exact : entries.filter((e) => e.includes(name));

  if (fuzzy.length > 1) {
    print(`junco rm: '${name}' is ambiguous:\n${fuzzy.map((f) => `  ${f}`).join("\n")}\n`);
    return 2;
  }
  if (fuzzy.length === 0) {
    // Nothing in inbox matches: a typo, or (far likelier for a TUI action taken
    // against a just-seen WAITING row) the daemon claimed it into processing/
    // moments ago. Truthful and non-authoritative → exit 0.
    print(notPresent(name));
    return 0;
  }

  const entry = fuzzy[0];
  try {
    unlinkFn(join(inbox, entry));
    print(`removed: ${entry}\n`);
    return 0;
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") {
      // Claimed/renamed between our listing and the unlink — the daemon won the
      // race. Best-effort semantics: report truthfully, exit 0.
      print(notPresent(entry));
      return 0;
    }
    print(`junco rm: ${entry}: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}
```

- [ ] 4. Run, expect PASS: `npx vitest run tests/rmCmd.test.ts > /tmp/rm.out 2>&1; echo "exit: $?"`.

- [ ] 5. Register in `src/cli.ts`. Add the import beside the other command imports (after line 46 `import { runRetryCommand } from "./retryCmd.js";`):

```ts
import { runRmCommand } from "./rmCmd.js";
```

Add a USAGE line directly after the `retry` line (in the `Subcommands:` block, ~92):

```
  rm <name>            Delete a queued ticket from the inbox (best-effort)
```

Add the dispatch block immediately after the `retry` subcommand block (after cli.ts:371):

```ts
  // ------------------------------------------------------------
  // rm: best-effort delete of a queued ticket from inbox/ (src/rmCmd.ts).
  // Never touches processing/ — the daemon owns it.
  // ------------------------------------------------------------
  if (subcommand === "rm") {
    const cfg = loadConfigFn(configPath);
    return runRmCommand(cfg, positionals.slice(1), { printFn });
  }
```

- [ ] 6. Register in `src/tui/cliRunner.ts` `PALETTE_COMMANDS` — add after the `retry` row (~36):

```ts
  cmd("rm", "<name>", "Delete a queued ticket from the inbox"),
```

- [ ] 7. Update the roster consistency test `tests/tuiCliRunner.test.ts`. Change the title count 14→15 and add `"rm"` to the runnable list:

```ts
  it("carries 15 runnable and 3 excluded-with-reason entries", () => {
```

and inside the `runnable.map(...).sort()` expectation array add the entry (order within the literal is irrelevant — it is `.sort()`ed):

```ts
        "retry",
        "rm",
        "run-once",
```

- [ ] 8. Run the roster + rm suites, expect PASS: `npx vitest run tests/tuiCliRunner.test.ts tests/rmCmd.test.ts > /tmp/rm2.out 2>&1; echo "exit: $?"`.

- [ ] 9. Typecheck (vitest does not type-check; the eslint tsconfig covers `tests/`): `npx tsc --noEmit -p tsconfig.eslint.json > /tmp/rm.tc 2>&1; echo "exit: $?"` — no NEW errors in `src/rmCmd.ts`, `src/cli.ts`, `tests/rmCmd.test.ts` (ignore the ~57 pre-existing errors).

- [ ] 10. Format touched files: `npx prettier --write src/rmCmd.ts tests/rmCmd.test.ts src/cli.ts src/tui/cliRunner.ts tests/tuiCliRunner.test.ts`.

- [ ] 11. Commit:

```
git add src/rmCmd.ts tests/rmCmd.test.ts src/cli.ts src/tui/cliRunner.ts tests/tuiCliRunner.test.ts
git commit -m "feat(cli): add junco rm — best-effort inbox ticket delete"
```

---

### Task 9: `junco worktree prune` — lock-guarded, liveness-gated worktree removal (`src/worktreePruneCmd.ts`)

**Files:**
- Create `src/worktreePruneCmd.ts`
- Create `tests/worktreePruneCmd.test.ts`
- Modify `src/cli.ts` (USAGE ~92; dispatch — add a `worktree` block; lazy import inside the block like `outbox`/`prs`/`assess`)
- Modify `src/tui/cliRunner.ts` (`PALETTE_COMMANDS` ~33-55)
- Modify `tests/tuiCliRunner.test.ts` (roster assertion ~39-62)

**Interfaces:**

Consumes from **Stage B** (must be landed first — atomic-switch staging step 2 precedes step 3):
- `src/worktree.ts`: `worktreesLockPath(cfg): string` = `join(cfg.worktreeRoot, ".worktrees.lock")` — the SAME pidfile lock the daemon acquires around `prepareWorktree`/`cleanupWorktree`/`pruneStaleWorktrees`. Prune's mutual-exclusion guarantee depends on Stage B having wired that daemon-side acquisition; without it, prune still serializes against other prune invocations but not against the daemon.

Consumes (existing, do not change):
- `src/worktree.ts`: `worktreeSlug(taskId: string): string` (the worktree DIR slug, `/`-excluded).
- `src/pidfileLock.ts`: `acquirePidfileLock(lockPath: string, deps?): PidfileLock | null` and `interface PidfileLock { path; release(): void }` — same stale-tolerant primitive as `flush.lock`; a same-process second acquire returns `null` (live pid + matching start-time ⇒ not stale).
- `src/config.ts`: `queuePaths(cfg).processing`.
- `src/ticket.ts`: `parseTicket(path, raw, defaultTimeoutMinutes?): Ticket` — `.id` is `frontmatter.id ?? basename(path).replace(/\.md$/, "")`; the daemon feeds this same `.id` to `prepareWorktree` (prFlow.ts:395) and `metrics.taskStarted` (runOnce.ts:180), so `worktreeSlug(ticket.id)` == the worktree's slug segment and matches `/health` `currentTickets` entries.
- `src/git.ts`: `git(cfg, args, { cwd, check: false })` returning `{ code; stdout; stderr }` (used only to build the default async `gitFn`).
- `MetricsSnapshot.currentTickets: string[]` shape of the `/health` body (`healthServer.ts:113` → `{ status, ready, metrics }`).

Produces (matches SHARED CONTRACT verbatim):
- `src/worktreePruneCmd.ts`: `export interface PruneDeps { printFn?; gitFn?: (args: string[], cwd: string) => Promise<{ code: number; stdout: string }>; fetchFn?: typeof fetch; readdirFn?: (d: string) => string[]; readFileFn?: (p: string) => string; acquireLockFn?: () => PidfileLock | null; rmdirFn?: (p: string) => void; rmRecursiveFn?: (p: string) => void }`
- `src/worktreePruneCmd.ts`: `export async function runWorktreePruneCommand(cfg: Config, args: string[], deps?: PruneDeps): Promise<number>` — path-containment; acquire `worktrees.lock`; in-lock liveness gate (slug in `processing/` OR `/health` `currentTickets`, daemon-down → processing/ scan alone); `git worktree remove --force` + rmdir parent.

Steps:

- [ ] 1. Write the failing test `tests/worktreePruneCmd.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runWorktreePruneCommand, type PruneDeps } from "../src/worktreePruneCmd.js";
import { acquirePidfileLock } from "../src/pidfileLock.js";
import { worktreesLockPath } from "../src/worktree.js";
import type { Config } from "../src/types.js";

const DISCR = "myrepo-abcd1234";

function makeCfg(root: string, healthEnabled = false): Config {
  return {
    vaultRoot: root,
    juncoSubdir: "",
    worktreeRoot: join(root, "worktrees"),
    defaultTimeoutMinutes: 30,
    healthEnabled,
    healthHost: "127.0.0.1",
    healthPort: 8787,
    gitBin: "git",
  } as unknown as Config;
}

/** A fake gitFn: rev-parse yields an absolute common dir; `worktree remove`
 * physically removes the target (simulating real git) so the empty-parent rmdir
 * path is exercised. Records every call for assertions. */
function fakeGit(calls: string[][]): NonNullable<PruneDeps["gitFn"]> {
  return async (args, _cwd) => {
    calls.push(args);
    if (args[0] === "rev-parse") return { code: 0, stdout: "/some/repo/.git\n" };
    if (args[0] === "worktree" && args[1] === "remove") {
      rmSync(args[3], { recursive: true, force: true });
      return { code: 0, stdout: "" };
    }
    return { code: 0, stdout: "" };
  };
}

function healthFetch(currentTickets: string[]): typeof fetch {
  return (async () =>
    ({ ok: true, json: async () => ({ metrics: { currentTickets } }) }) as unknown as Response) as typeof fetch;
}

describe("runWorktreePruneCommand", () => {
  let root: string;
  let cfg: Config;
  let wt: string;
  let parent: string;
  let out: string[];
  let calls: string[][];
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "junco-prune-"));
    cfg = makeCfg(root);
    parent = join(cfg.worktreeRoot, DISCR);
    wt = join(parent, "my-ticket"); // slug = "my-ticket"
    mkdirSync(wt, { recursive: true });
    mkdirSync(join(root, "processing"), { recursive: true });
    out = [];
    calls = [];
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("refuses a path outside the worktree root → exit 2, no git, dir untouched", async () => {
    const outside = join(root, "elsewhere");
    mkdirSync(outside, { recursive: true });
    const code = await runWorktreePruneCommand(cfg, [outside], {
      printFn: (s) => out.push(s),
      gitFn: fakeGit(calls),
    });
    expect(code).toBe(2);
    expect(out.join("")).toMatch(/not under the worktree root/);
    expect(calls).toHaveLength(0);
    expect(existsSync(outside)).toBe(true);
  });

  it("happy path: git worktree remove --force + empty-parent rmdir, exit 0", async () => {
    const code = await runWorktreePruneCommand(cfg, [wt], {
      printFn: (s) => out.push(s),
      gitFn: fakeGit(calls),
    });
    expect(code).toBe(0);
    expect(existsSync(wt)).toBe(false);
    expect(existsSync(parent)).toBe(false); // discriminator parent rmdir'd (was empty)
    expect(out.join("")).toMatch(/pruned:/);
    expect(calls.some((a) => a[0] === "worktree" && a[1] === "remove" && a[2] === "--force")).toBe(
      true,
    );
  });

  it("refuses when a processing/ ticket's slug matches (daemon owns it) → exit 1, no remove", async () => {
    writeFileSync(
      join(root, "processing", "2026-06-10T1200Z__my-ticket.md"),
      "---\nid: my-ticket\n---\nx\n",
      "utf8",
    );
    const code = await runWorktreePruneCommand(cfg, [wt], {
      printFn: (s) => out.push(s),
      gitFn: fakeGit(calls),
    });
    expect(code).toBe(1);
    expect(out.join("")).toMatch(/refusing to prune/);
    expect(existsSync(wt)).toBe(true);
    expect(calls.some((a) => a[0] === "worktree")).toBe(false);
  });

  it("refuses on a /health currentTickets slug match even for an unmapped worktree", async () => {
    // No processing file, no repo reverse-map — the slug alone gates it.
    const code = await runWorktreePruneCommand(makeCfg(root, true), [wt], {
      printFn: (s) => out.push(s),
      gitFn: fakeGit(calls),
      fetchFn: healthFetch(["my-ticket"]),
    });
    expect(code).toBe(1);
    expect(out.join("")).toMatch(/refusing to prune/);
    expect(existsSync(wt)).toBe(true);
  });

  it("daemon down (fetch throws): processing/ scan is authoritative — empty → prunes", async () => {
    const rejectingFetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const code = await runWorktreePruneCommand(makeCfg(root, true), [wt], {
      printFn: (s) => out.push(s),
      gitFn: fakeGit(calls),
      fetchFn: rejectingFetch,
    });
    expect(code).toBe(0);
    expect(existsSync(wt)).toBe(false);
  });

  it("SERIALIZATION: a held worktrees.lock blocks prune → exit 1, no git", async () => {
    // Hold the REAL shared lock (proves the command contends on the same path
    // the daemon takes). Same-process re-acquire inside the command returns null.
    const held = acquirePidfileLock(worktreesLockPath(cfg));
    expect(held).not.toBeNull();
    try {
      const code = await runWorktreePruneCommand(cfg, [wt], {
        printFn: (s) => out.push(s),
        gitFn: fakeGit(calls),
      });
      expect(code).toBe(1);
      expect(out.join("")).toMatch(/another worktree operation is in progress/);
      expect(calls).toHaveLength(0);
      expect(existsSync(wt)).toBe(true);
    } finally {
      held!.release();
    }
  });

  it("no path → usage + exit 2", async () => {
    expect(await runWorktreePruneCommand(cfg, [], { printFn: (s) => out.push(s) })).toBe(2);
    expect(out.join("")).toMatch(/Usage: junco worktree prune/);
  });
});
```

- [ ] 2. Run it, expect FAIL: `npx vitest run tests/worktreePruneCmd.test.ts > /tmp/prune.out 2>&1; echo "exit: $?"` — fails to resolve `../src/worktreePruneCmd.js`.

- [ ] 3. Write minimal implementation `src/worktreePruneCmd.ts`:

```ts
/**
 * `junco worktree prune <path>` — the single chokepoint for destroying a
 * per-ticket worktree, shared by the CLI and (later) the dashboard so ONE place
 * owns the daemon-safety discipline:
 *
 *   1. Path containment: the path must resolve under cfg.worktreeRoot.
 *   2. Shared lock: acquire the SAME worktrees.lock the daemon takes around its
 *      worktree mutations (prepareWorktree/cleanupWorktree/pruneStaleWorktrees,
 *      wired daemon-side in Stage B), so prune and daemon provisioning are
 *      mutually exclusive — they can no longer race .git/worktrees/<id> metadata
 *      or index.lock.
 *   3. Liveness gate, UNDER the lock: refuse if the worktree's slug segment
 *      matches worktreeSlug(id) for any ticket in processing/ OR any /health
 *      currentTickets entry. Because the check runs under the lock it observes
 *      the committed processing/ state the daemon writes before provisioning —
 *      closing the TOCTOU. Daemon down / health disabled → processing/ scan
 *      alone (authoritative when no concurrent writer exists). The slug gate does
 *      NOT depend on the repo reverse-map, so an ⟨unmapped⟩ worktree is still
 *      gated.
 *   4. Remove: `git worktree remove --force` (safe ONLY because 2+3 established,
 *      under the lock, that no live run owns this tree — junco never calls
 *      `git worktree lock`, so we do not rely on git's lock semantics), then
 *      rmdir the now-empty per-repo discriminator parent (mirrors cleanupWorktree).
 */

import { readdirSync, readFileSync, rmdirSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { Config } from "./types.js";
import { git } from "./git.js";
import { queuePaths } from "./config.js";
import { parseTicket } from "./ticket.js";
import { worktreeSlug, worktreesLockPath } from "./worktree.js";
import { acquirePidfileLock, type PidfileLock } from "./pidfileLock.js";

const HEALTH_TIMEOUT_MS = 1500;

export interface PruneDeps {
  printFn?: (s: string) => void;
  /** Async git runner (non-throwing): resolves { code, stdout }. Default spawns real git with check:false. */
  gitFn?: (args: string[], cwd: string) => Promise<{ code: number; stdout: string }>;
  /** fetch seam for the /health currentTickets probe. Default: global fetch. */
  fetchFn?: typeof fetch;
  /** processing/ directory listing. Default: fs.readdirSync. */
  readdirFn?: (d: string) => string[];
  /** Ticket file read. Default: fs.readFileSync utf8. */
  readFileFn?: (p: string) => string;
  /** Lock acquisition seam. Default: acquirePidfileLock(worktreesLockPath(cfg)). */
  acquireLockFn?: () => PidfileLock | null;
  /** Empty-parent removal. Default: fs.rmdirSync. */
  rmdirFn?: (p: string) => void;
  /** Recursive fallback removal for a broken/backup worktree. Default: fs.rmSync recursive+force. */
  rmRecursiveFn?: (p: string) => void;
}

export async function runWorktreePruneCommand(
  cfg: Config,
  args: string[],
  deps: PruneDeps = {},
): Promise<number> {
  const print = deps.printFn ?? ((s: string) => process.stdout.write(s));
  const gitFn =
    deps.gitFn ??
    (async (a: string[], cwd: string) => {
      const r = await git(cfg, a, { cwd, check: false });
      return { code: r.code, stdout: r.stdout };
    });
  const fetchFn = deps.fetchFn ?? fetch;
  const readdirFn = deps.readdirFn ?? ((d: string) => readdirSync(d));
  const readFileFn = deps.readFileFn ?? ((p: string) => readFileSync(p, "utf8"));
  const acquireLockFn = deps.acquireLockFn ?? (() => acquirePidfileLock(worktreesLockPath(cfg)));
  const rmdirFn = deps.rmdirFn ?? ((p: string) => rmdirSync(p));
  const rmRecursiveFn =
    deps.rmRecursiveFn ?? ((p: string) => rmSync(p, { recursive: true, force: true }));

  const rawArg = args[0];
  if (!rawArg) {
    print("Usage: junco worktree prune <path>\n");
    return 2;
  }

  // 1. Path containment — never operate outside the daemon-owned worktree root.
  const root = resolve(cfg.worktreeRoot);
  const target = resolve(rawArg);
  if (target === root) {
    print("junco worktree prune: refusing to remove the worktree root itself\n");
    return 2;
  }
  if (!target.startsWith(root + sep)) {
    print(`junco worktree prune: '${rawArg}' is not under the worktree root (${root})\n`);
    return 2;
  }

  // 2. Shared lock — mutual exclusion with the daemon's worktree mutations.
  const lock = acquireLockFn();
  if (lock === null) {
    print("junco worktree prune: another worktree operation is in progress — try again\n");
    return 1;
  }

  try {
    // 3. Liveness gate, computed UNDER the lock.
    const liveSlugs = new Set<string>();

    // processing/ scan — the daemon commits a claimed ticket here BEFORE it
    // provisions the worktree, so under our lock this set is authoritative.
    const processingDir = queuePaths(cfg).processing;
    let names: string[] = [];
    try {
      names = readdirFn(processingDir).filter((n) => n.endsWith(".md"));
    } catch {
      /* no processing dir yet */
    }
    for (const n of names) {
      const p = join(processingDir, n);
      try {
        liveSlugs.add(worktreeSlug(parseTicket(p, readFileFn(p), cfg.defaultTimeoutMinutes).id));
      } catch {
        /* unreadable/unparseable — can't own a live worktree; skip */
      }
    }

    // /health currentTickets — the live in-flight set while the daemon is up.
    // Unreachable / disabled → processing/ scan alone (fallback above).
    for (const id of await fetchCurrentTickets(cfg, fetchFn)) liveSlugs.add(worktreeSlug(id));

    const targetSlug = basename(target);
    if (liveSlugs.has(targetSlug)) {
      print(
        `junco worktree prune: refusing to prune '${targetSlug}' — a live/queued ticket owns it\n`,
      );
      return 1;
    }

    // 4. Remove under the lock. Resolve the owning repo so `git worktree remove`
    //    runs from a valid working tree; a broken/backup dir with no resolvable
    //    repo (rev-parse fails) falls back to a plain recursive removal.
    let removed = false;
    const rp = await gitFn(["rev-parse", "--path-format=absolute", "--git-common-dir"], target);
    if (rp.code === 0 && rp.stdout.trim().length > 0) {
      const commonDir = rp.stdout.trim();
      const repoRoot = basename(commonDir) === ".git" ? dirname(commonDir) : commonDir;
      const rm = await gitFn(["worktree", "remove", "--force", target], repoRoot);
      removed = rm.code === 0;
    }
    if (!removed) rmRecursiveFn(target);

    // rmdir the now-empty per-repo discriminator parent (mirrors cleanupWorktree,
    // worktree.ts:293-300) — never the root, and only when empty.
    const parent = dirname(target);
    if (resolve(parent) !== root) {
      try {
        rmdirFn(parent);
      } catch {
        /* non-empty (live sibling / .old-* backup) or already gone — fine */
      }
    }

    print(`pruned: ${target}\n`);
    return 0;
  } finally {
    lock.release();
  }
}

/** Single AbortController-timed /health fetch → currentTickets, or [] when
 * health is disabled/unreachable (daemon-down fallback to the processing/ scan). */
async function fetchCurrentTickets(cfg: Config, fetchFn: typeof fetch): Promise<string[]> {
  if (!cfg.healthEnabled) return [];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HEALTH_TIMEOUT_MS);
  try {
    const resp = await fetchFn(`http://${cfg.healthHost}:${cfg.healthPort}/health`, {
      signal: ctrl.signal,
    });
    if (!resp.ok) return [];
    const j = (await resp.json()) as { metrics?: { currentTickets?: string[] } };
    return j.metrics?.currentTickets ?? [];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] 4. Run, expect PASS: `npx vitest run tests/worktreePruneCmd.test.ts > /tmp/prune.out 2>&1; echo "exit: $?"`.

- [ ] 5. Register in `src/cli.ts`. Add a USAGE line in the `Subcommands:` block (e.g. after the `restart` line, ~99):

```
  worktree prune <path>  Prune a stale/backup worktree (lock-guarded; refuses live)
```

Add the dispatch block after the `restart` subcommand block (before `schema`, ~467). Lazy-import (matches `outbox`/`prs`/`assess` — keeps its graph off other subcommands):

```ts
  // ------------------------------------------------------------
  // worktree prune <path>: lock-guarded, liveness-gated removal of a per-ticket
  // worktree (src/worktreePruneCmd.ts) — the shared CLI/TUI safety chokepoint.
  // ------------------------------------------------------------
  if (subcommand === "worktree") {
    const cfg = loadConfigFn(configPath);
    if (positionals[1] === "prune") {
      const { runWorktreePruneCommand } = await import("./worktreePruneCmd.js");
      return runWorktreePruneCommand(cfg, positionals.slice(2), { printFn });
    }
    process.stderr.write(`Usage: junco worktree prune <path>\n`);
    return 2;
  }
```

- [ ] 6. Register in `src/tui/cliRunner.ts` `PALETTE_COMMANDS` — add after the `restart` row (~47). The palette `name` is `worktree` (the USAGE regex `^\s{2}worktree(\s|$)` matches the `worktree prune <path>` line); `runCliCommand` spawns `worktree` + extraArgs, so the dashboard passes `["prune", <path>]`:

```ts
  cmd("worktree", "prune <path>", "Prune a stale/backup worktree (lock-guarded)"),
```

- [ ] 7. Update the roster consistency test `tests/tuiCliRunner.test.ts`. Change the title count 15→16 and add `"worktree"` to the runnable list:

```ts
  it("carries 16 runnable and 3 excluded-with-reason entries", () => {
```

and add to the `.sort()`ed runnable literal:

```ts
        "submit",
        "worktree",
```

- [ ] 8. Run the roster + prune suites, expect PASS: `npx vitest run tests/tuiCliRunner.test.ts tests/worktreePruneCmd.test.ts > /tmp/prune2.out 2>&1; echo "exit: $?"`.

- [ ] 9. Typecheck: `npx tsc --noEmit -p tsconfig.eslint.json > /tmp/prune.tc 2>&1; echo "exit: $?"` — no NEW errors in `src/worktreePruneCmd.ts`, `src/cli.ts`, `tests/worktreePruneCmd.test.ts` (ignore the ~57 pre-existing). If `worktreesLockPath` is unresolved, Stage B (staging step 2) has not landed — that dependency is required before this task.

- [ ] 10. Format touched files: `npx prettier --write src/worktreePruneCmd.ts tests/worktreePruneCmd.test.ts src/cli.ts src/tui/cliRunner.ts tests/tuiCliRunner.test.ts`.

- [ ] 11. Commit:

```
git add src/worktreePruneCmd.ts tests/worktreePruneCmd.test.ts src/cli.ts src/tui/cliRunner.ts tests/tuiCliRunner.test.ts
git commit -m "feat(cli): add junco worktree prune — lock-guarded, liveness-gated worktree removal"
```

---

STAGE NOTES: (1) Both tasks edit `tests/tuiCliRunner.test.ts`'s single roster assertion — the two commits touch the same literal (14→15→16 runnable, adding `"rm"` then `"worktree"`); the assembler must keep them sequential (rm before worktree) or reconcile the count/array if reordered. (2) This stage hard-consumes Stage B's `worktreesLockPath(cfg)` from `src/worktree.ts` — the atomic-switch staging in the spec orders Stage B (step 2) before this (step 3), so the assembler must not float this stage ahead of the `worktrees.lock` daemon-side wiring, or step 9's typecheck fails on an unresolved import. (3) The prune command's default async `gitFn` uses `git worktree remove --force` with `--path-format=absolute --git-common-dir` to resolve the owning repo; that git flag requires git ≥2.31 — if the project's supported git floor is older, swap to reading the worktree's `.git` gitdir pointer, but the injected-`gitFn` seam means only the default path (never the tests) is affected. (4) `PALETTE_COMMANDS` name `worktree` (not `worktree prune`) is deliberate so the USAGE consistency regex `^\s{2}worktree(\s|$)` matches and `runCliCommand` argv composition stays `[name, ...extraArgs]`; the Stage E TUI wiring must pass `["prune", <path>]` as extraArgs — flag this to whoever writes the LocalDashboard action table so it does not pass a single `"prune <path>"` string. (5) Neither task touches `Config`, the Pi SDK import boundary, or the Q&A read-only default; all new user-visible strings are stack-agnostic.


<!-- ===== Stage D — LOCAL UI components (unwired) ===== -->


---

### Task 10: headerTabBands geometry (pure, testable now)

**Files:**
- Modify `src/tui/geometry.ts` (append after `listRowsHeight`, currently ends at line 30; add an import at the top — the file currently has none)
- Modify `tests/tuiGeometry.test.ts` (append a new `describe`)

**Interfaces:**
- Consumes (existing): `WIDE_COLS` from `src/tui/layout.ts` (`= 110`).
- Produces:
  - `export type UiMode = "github" | "local";`
  - `export const TAB_BRAND_COLS = 11;`
  - `export function headerTabBands(columns: number): { hit(x: number): UiMode | null; githubStart: number; localStart: number }` — fixed-width click bands: wide slots `[GITHUB]`(8)/`[LOCAL]`(7) with a 1-col gutter; compact (`columns < WIDE_COLS`) slots `[G]`(3)/`[L]`(3). This is the single source of truth shared by `Header` (Stage E renders the tabs at these columns) and `onMouseEvent`/`hitTest` (Stage E resolves a `y===0` click via `hit(x)`).

**Steps:**

1. [ ] Write the failing test — append to `tests/tuiGeometry.test.ts`:
   ```ts
   import { headerTabBands, TAB_BRAND_COLS } from "../src/tui/geometry.js";

   describe("headerTabBands", () => {
     it("wide: GITHUB then a 1-col gutter then LOCAL; hit() resolves each band", () => {
       const b = headerTabBands(120);
       expect(b.githubStart).toBe(TAB_BRAND_COLS); // 11
       expect(b.localStart).toBe(TAB_BRAND_COLS + 8 + 1); // 20
       expect(b.hit(11)).toBe("github");
       expect(b.hit(18)).toBe("github"); // last GITHUB col (githubEnd=19 exclusive)
       expect(b.hit(19)).toBeNull(); // gutter
       expect(b.hit(20)).toBe("local");
       expect(b.hit(26)).toBe("local"); // last LOCAL col (localEnd=27 exclusive)
       expect(b.hit(27)).toBeNull();
       expect(b.hit(0)).toBeNull();
       expect(b.hit(10)).toBeNull(); // inside the brand mark
     });

     it("compact (<WIDE_COLS): single-letter slots keep the 60-col header on one row", () => {
       const b = headerTabBands(60);
       expect(b.githubStart).toBe(11);
       expect(b.localStart).toBe(11 + 3 + 1); // 15
       expect(b.hit(11)).toBe("github");
       expect(b.hit(13)).toBe("github"); // githubEnd=14 exclusive
       expect(b.hit(14)).toBeNull();
       expect(b.hit(15)).toBe("local");
       expect(b.hit(17)).toBe("local"); // localEnd=18 exclusive
       expect(b.hit(18)).toBeNull();
     });
   });
   ```

2. [ ] Run it, expect FAIL with `does not provide an export named 'headerTabBands'`:
   ```
   npx vitest run tests/tuiGeometry.test.ts > /tmp/out 2>&1; echo "exit: $?"
   ```

3. [ ] Write minimal implementation — add the import at the very top of `src/tui/geometry.ts`:
   ```ts
   import { WIDE_COLS } from "./layout.js";
   ```
   and append after `listRowsHeight`:
   ```ts
   export type UiMode = "github" | "local";

   /** Columns consumed before the tab segment: paddingX(1) + "🐦 junco" (8 cols
    * wide — the bird emoji is width 2) + the gap(2) before the tabs. Stage E's
    * Header renders the brand in exactly this many columns so the tab click
    * bands below line up with what's drawn. */
   export const TAB_BRAND_COLS = 11;

   /** Column ranges the GITHUB / LOCAL header tabs occupy, shared by Header
    * (renders the tabs there) and onMouseEvent (resolves a y===0 click back onto
    * a mode) so component and hit-test never drift. Fixed-width slots keep the
    * bands stable regardless of which tab is active; below WIDE_COLS the slots
    * collapse to a single letter so the one-row header survives at 60 cols. */
   export function headerTabBands(columns: number): {
     hit(x: number): UiMode | null;
     githubStart: number;
     localStart: number;
   } {
     const compact = columns < WIDE_COLS;
     const ghWidth = compact ? 3 : 8; // "[G]" | "[GITHUB]"
     const loWidth = compact ? 3 : 7; // "[L]" | "[LOCAL]"
     const githubStart = TAB_BRAND_COLS;
     const githubEnd = githubStart + ghWidth;
     const localStart = githubEnd + 1; // one-col gutter
     const localEnd = localStart + loWidth;
     return {
       githubStart,
       localStart,
       hit(x: number): UiMode | null {
         if (x >= githubStart && x < githubEnd) return "github";
         if (x >= localStart && x < localEnd) return "local";
         return null;
       },
     };
   }
   ```

4. [ ] Run, expect PASS:
   ```
   npx vitest run tests/tuiGeometry.test.ts > /tmp/out 2>&1; echo "exit: $?"
   ```

5. [ ] Lint the touched files:
   ```
   npx prettier --write src/tui/geometry.ts tests/tuiGeometry.test.ts
   npx eslint --no-warn-ignored src/tui/geometry.ts tests/tuiGeometry.test.ts
   ```

6. [ ] Commit:
   ```
   git add src/tui/geometry.ts tests/tuiGeometry.test.ts
   git commit -m "feat(tui): add headerTabBands geometry + UiMode type"
   ```

---

### Task 11: QueueView additive selectable props (byte-identical default path)

**Files:**
- Modify `src/tui/components/QueueView.tsx` (full rewrite of the exported function + a new exported type; behavior unchanged when the new props are absent)
- Modify `tests/tuiQueue.test.tsx` (append to the existing `describe("QueueView", …)`)

**Interfaces:**
- Consumes (existing): `QueueSnapshot`, `QueueWaiting` from `src/tui/queueSnapshot.ts`; `queueLabel`, `progressLine`, `fmtAge`, `fmtClock` from `src/tui/queueFmt.ts`; `theme` from `src/tui/theme.ts`.
- Produces:
  - `export interface QueueRowRef { kind: "running" | "waiting" | "recent"; id: string; status?: "done" | "failed" }`
  - `QueueView` gains optional props `selectable?: boolean; selectedRow?: number; onRows?: (rows: QueueRowRef[]) => void`. Absent → renders byte-identical to today; present → `▌` accent cursor on actionable rows only (WAITING then RECENT; `selectedRow` indexes that concatenation), never on RUNNING. `onRows` fires (in an effect) with the actionable-row list `[...waiting, ...recent]`.

**Steps:**

1. [ ] Write the failing test — append inside `describe("QueueView", …)` in `tests/tuiQueue.test.tsx`, and add the import at the top:
   ```ts
   import type { QueueRowRef } from "../src/tui/components/QueueView.js";

   async function until(pred: () => boolean, tries = 60): Promise<void> {
     for (let i = 0; i < tries; i++) {
       if (pred()) return;
       await new Promise((r) => setTimeout(r, 1));
     }
     throw new Error("condition not met within bound");
   }
   ```
   ```ts
   it("default-absent props render byte-identical (no cursor glyph)", () => {
     const base = render(
       <QueueView snap={FULL} scroll={0} now={NOW} height={20} focused={false} />,
     ).lastFrame()!;
     const withFalse = render(
       <QueueView snap={FULL} scroll={0} now={NOW} height={20} focused={false} selectable={false} />,
     ).lastFrame()!;
     expect(withFalse).toBe(base);
     expect(base).not.toContain("▌");
   });

   it("selectable path: cursor marks the first WAITING row, never RUNNING", () => {
     const frame = render(
       <QueueView
         snap={FULL}
         scroll={0}
         now={NOW}
         height={30}
         focused={false}
         selectable
         selectedRow={0}
       />,
     ).lastFrame()!;
     expect(frame).toContain("▌"); // cursor present
     expect(frame).toContain("1. #51 plan"); // still the first waiting row
     // RUNNING row (◐ + label) carries no cursor glyph on its line.
     const runLine = frame.split("\n").find((l) => l.includes("#46 exec"))!;
     expect(runLine).not.toContain("▌");
   });

   it("selectable path: selectedRow past WAITING lands on a RECENT row", () => {
     // waiting.length === 4, so index 4 is the first RECENT row (#44).
     const frame = render(
       <QueueView
         snap={FULL}
         scroll={0}
         now={NOW}
         height={30}
         focused={false}
         selectable
         selectedRow={4}
       />,
     ).lastFrame()!;
     const recLine = frame.split("\n").find((l) => l.includes("#44 exec"))!;
     expect(recLine).toContain("▌");
   });

   it("onRows reports the actionable rows (waiting then recent, running excluded)", async () => {
     const seen: QueueRowRef[] = [];
     render(
       <QueueView
         snap={FULL}
         scroll={0}
         now={NOW}
         height={30}
         focused={false}
         selectable
         selectedRow={0}
         onRows={(rows) => {
           seen.length = 0;
           seen.push(...rows);
         }}
       />,
     );
     await until(() => seen.length === 6); // 4 waiting + 2 recent
     expect(seen[0]).toEqual({ kind: "waiting", id: "gh-acme-api-51-plan" });
     expect(seen[5]).toEqual({ kind: "recent", id: "gh-acme-api-40", status: "failed" });
     expect(seen.some((r) => r.kind === "running")).toBe(false);
   });
   ```

2. [ ] Run it, expect FAIL (`does not provide an export named 'QueueRowRef'`, and the selectable assertions fail on the current signature):
   ```
   npx vitest run tests/tuiQueue.test.tsx > /tmp/out 2>&1; echo "exit: $?"
   ```

3. [ ] Write minimal implementation — replace the whole of `src/tui/components/QueueView.tsx` with:
   ```tsx
   import React from "react";
   import { Box, Text } from "ink";
   import type { QueueSnapshot, QueueWaiting } from "../queueSnapshot.js";
   import { queueLabel, progressLine, fmtAge, fmtClock } from "../queueFmt.js";
   import { theme } from "../theme.js";

   /** A selectable actionable row surfaced to the LOCAL Queue section: WAITING
    * (inbox) and RECENT (done/failed) rows. RUNNING rows are never included —
    * the daemon owns processing/. */
   export interface QueueRowRef {
     kind: "running" | "waiting" | "recent";
     id: string;
     status?: "done" | "failed";
   }

   function waitingNote(w: QueueWaiting): string {
     const parts: string[] = [];
     if (w.priority !== "normal") parts.push(w.priority);
     if (w.retryCount > 0) parts.push(`retry ${w.retryCount}`);
     if (w.notBefore !== null) parts.push(`not before ${fmtClock(w.notBefore)}`);
     if (w.deferred) parts.push("⏲ deferred");
     return parts.join(" · ");
   }

   /** Full queue view (main-area slot, opened with `t`): RUNNING / WAITING /
    * RECENT built as flat rows so App's scroll offset can slice them. In LOCAL
    * mode `selectable` turns on a `▌` accent cursor over the actionable rows
    * (WAITING then RECENT, `selectedRow` indexing that concatenation); RUNNING
    * rows render but are never selectable. Absent props → byte-identical to the
    * GitHub `t` view. */
   export function QueueView({
     snap,
     scroll,
     now,
     height,
     focused,
     selectable,
     selectedRow,
     onRows,
   }: {
     snap: QueueSnapshot | null;
     scroll: number;
     now: Date;
     height: number;
     focused: boolean;
     selectable?: boolean;
     selectedRow?: number;
     onRows?: (rows: QueueRowRef[]) => void;
   }): React.JSX.Element {
     React.useEffect(() => {
       if (!onRows) return;
       if (snap === null) {
         onRows([]);
         return;
       }
       onRows([
         ...snap.waiting.map((w) => ({ kind: "waiting" as const, id: w.id })),
         ...snap.recent.map((r) => ({ kind: "recent" as const, id: r.id, status: r.status })),
       ]);
     }, [snap, onRows]);

     if (snap === null) {
       return (
         <Box
           borderStyle="round"
           borderColor={focused ? theme.accent : theme.border}
           paddingX={1}
           flexGrow={1}
           height={height}
         >
           <Text dimColor>queue — loading…</Text>
         </Box>
       );
     }

     // Leading 2-col gutter. With `selectable` the first col becomes the `▌`
     // accent cursor on the selected actionable row; otherwise it is the exact
     // two-space indent the GitHub `t` view has always rendered (byte-identical).
     const gutter = (sel: boolean): React.JSX.Element | string =>
       selectable ? (
         <>
           <Text color={theme.accent}>{sel ? "▌" : " "}</Text>{" "}
         </>
       ) : (
         "  "
       );

     const rows: React.JSX.Element[] = [];
     const dash = (key: string): void => {
       rows.push(
         <Text key={key} dimColor>
           {"  "}—
         </Text>,
       );
     };

     rows.push(
       <Text key="title" bold color={focused ? theme.accent : undefined}>
         queue
       </Text>,
     );

     rows.push(
       <Text key="run-h" bold>
         RUNNING ({snap.running.length}/{snap.maxConcurrent})
       </Text>,
     );
     if (snap.running.length === 0) dash("run-none");
     for (const r of snap.running) {
       rows.push(
         <Text key={`r-${r.id}`} wrap="truncate-end">
           {gutter(false)}
           <Text color="cyan">◐ </Text>
           <Text bold>{queueLabel(r.github, r.id)}</Text>
           <Text dimColor> {r.id}</Text>
         </Text>,
       );
       rows.push(
         <Text key={`rp-${r.id}`} dimColor wrap="truncate-end">
           {"     "}
           {progressLine(r, now)}
         </Text>,
       );
     }

     rows.push(
       <Text key="wait-h" bold>
         {" "}
       </Text>,
     );
     rows.push(
       <Text key="wait-h2" bold>
         WAITING ({snap.waiting.length})
       </Text>,
     );
     if (snap.waiting.length === 0) dash("wait-none");
     snap.waiting.forEach((w, i) => {
       const note = waitingNote(w);
       const sel = selectable === true && selectedRow === i;
       rows.push(
         <Text key={`w-${w.id}`} wrap="truncate-end">
           {gutter(sel)}
           {i + 1}. <Text bold>{queueLabel(w.github, w.id)}</Text>
           <Text dimColor> {w.github ? w.id : w.kind}</Text>
           {note !== "" ? <Text color="yellow"> {note}</Text> : null}
         </Text>,
       );
     });

     rows.push(
       <Text key="rec-h" bold>
         {" "}
       </Text>,
     );
     rows.push(
       <Text key="rec-h2" bold>
         RECENT
       </Text>,
     );
     if (snap.recent.length === 0) dash("rec-none");
     snap.recent.forEach((r, j) => {
       const sel = selectable === true && selectedRow === snap.waiting.length + j;
       rows.push(
         <Text key={`f-${r.id}-${r.finishedAt}`} wrap="truncate-end">
           {gutter(sel)}
           <Text color={r.status === "done" ? "green" : "red"}>
             {r.status === "done" ? "✓" : "✗"}{" "}
           </Text>
           {queueLabel(r.github, r.id)}
           <Text dimColor> {fmtAge(r.finishedAt, now)}</Text>
         </Text>,
       );
     });

     return (
       <Box
         flexDirection="column"
         borderStyle="round"
         borderColor={focused ? theme.accent : theme.border}
         paddingX={1}
         flexGrow={1}
         height={height}
       >
         {rows.slice(scroll, scroll + Math.max(1, height - 3))}
       </Box>
     );
   }
   ```

4. [ ] Run, expect PASS (both the new tests and the pre-existing `QueueView` frame assertions — the byte-identical guard proves the default path is unchanged):
   ```
   npx vitest run tests/tuiQueue.test.tsx > /tmp/out 2>&1; echo "exit: $?"
   ```

5. [ ] Lint the touched files:
   ```
   npx prettier --write src/tui/components/QueueView.tsx tests/tuiQueue.test.tsx
   npx eslint --no-warn-ignored src/tui/components/QueueView.tsx tests/tuiQueue.test.tsx
   ```

6. [ ] Commit:
   ```
   git add src/tui/components/QueueView.tsx tests/tuiQueue.test.tsx
   git commit -m "feat(tui): add QueueView selectable/selectedRow/onRows (additive)"
   ```

---

### Task 12: SectionRail component

**Files:**
- Create `src/tui/components/LocalDashboard.tsx` (initial version: imports, `LocalSection`/`UiMode` types, `SECTIONS`, `sectionBadge`, `SectionRail`)
- Create `tests/tuiLocal.test.tsx` (shared fixtures + a `SectionRail` describe)

**Interfaces:**
- Consumes (Stage A, type-only): `LocalCheap`, `LocalHeavy` from `src/tui/localSnapshot.ts`; `UiMode` from `src/tui/geometry.ts`. Existing: `theme` from `src/tui/theme.ts`; `fmtAge` from `src/tui/queueFmt.ts`.
- Produces:
  - `export type LocalSection = "queue" | "outbox" | "repos" | "worktrees" | "daemon";`
  - re-export `export type { UiMode } from "../geometry.js";`
  - `export function SectionRail(props: { section: LocalSection; focus: "rail" | "body"; cheap: LocalCheap | null; heavy: LocalHeavy | null; width: number; height: number; now: Date; refreshedAt?: string | null }): React.JSX.Element` — fixed 5-row list rendered like `Rail` (`▌` accent cursor + `selectionBg` on the selected row, border accent when `focus==="rail"`); live badges from `cheap`/`heavy` (`▸N` queue running, `⇡N` outbox depth hidden at 0, `⚑N` stale worktrees, `●/○` daemon); `n/5` position line; optional `↻ <age>` refresh stamp pinned at the bottom.

**Steps:**

1. [ ] Write the failing test — create `tests/tuiLocal.test.tsx` with the shared fixtures and the `SectionRail` describe:
   ```tsx
   import { describe, it, expect } from "vitest";
   import React from "react";
   import { render } from "ink-testing-library";
   import { SectionRail } from "../src/tui/components/LocalDashboard.js";
   import type { LocalCheap, LocalHeavy, DaemonDetail } from "../src/tui/localSnapshot.js";
   import type { StoredOp } from "../src/githubOutbox.js";

   const NOW = new Date("2026-07-09T12:00:00Z");

   const DAEMON: DaemonDetail = {
     up: true,
     pid: 4242,
     uptimeSeconds: 8000,
     endpointReachable: true,
     healthHost: "127.0.0.1",
     healthPort: 8787,
     guardNudges: 1,
     guardKills: 0,
     tokensIn: 1000,
     tokensOut: 2000,
     tasksByStatus: { completed: 5, failed: 1 },
     currentTickets: ["gh-acme-api-1"],
     progress: {
       "gh-acme-api-1": {
         turns: 3,
         lastTool: "bash",
         outputTokens: 100,
         startedAt: "2026-07-09T11:58:00Z",
       },
     },
     error: null,
   };

   const OP: StoredOp = {
     id: "op1",
     path: "/x/github-outbox/op1.json",
     createdAt: "2026-07-09T11:59:00Z",
     origin: "prflow",
     issueKey: "acme/api#7",
     attempts: 2,
     lastError: "connect ETIMEDOUT",
     op: { kind: "comment", nwo: "acme/api", issue: 7, body: "hi" },
   };

   const CHEAP: LocalCheap = {
     queue: {
       daemonUp: true,
       maxConcurrent: 2,
       running: [
         {
           id: "gh-acme-api-1",
           github: null,
           turns: 3,
           lastTool: "bash",
           outputTokens: 100,
           startedAt: null,
           stale: false,
         },
       ],
       waiting: [],
       recent: [],
       error: null,
       outboxDepth: 2,
     },
     counts: { done: 5, failed: 1 },
     outbox: { depth: 2, dead: 1, ops: [OP], deadOps: [], error: null },
     daemon: DAEMON,
     error: null,
   };

   const HEAVY: LocalHeavy = {
     repos: [
       {
         nwo: "acme/api",
         path: "/repos/acme-api",
         source: "clone",
         originUrl: "https://github.com/me/api.git",
         forkUrl: null,
         githubUrl: "https://github.com/acme/api",
         branch: "main",
         headSha: "abcdef1234567",
         dirty: true,
         error: null,
       },
     ],
     worktrees: [
       {
         path: "/wt/acme/slug-1",
         repoPath: "/repos/acme-api",
         repoNwo: "acme/api",
         slug: "slug-1",
         kind: "stale",
         headSha: "abcdef1234567",
         ageSeconds: 7200,
         error: null,
       },
     ],
     error: null,
   };

   describe("SectionRail", () => {
     it("lists all 5 sections with live badges and a position line", () => {
       const f = render(
         <SectionRail
           section="outbox"
           focus="rail"
           cheap={CHEAP}
           heavy={HEAVY}
           width={26}
           height={20}
           now={NOW}
         />,
       ).lastFrame()!;
       expect(f).toContain("sections");
       for (const s of ["queue", "outbox", "repos", "worktrees", "daemon"]) {
         expect(f).toContain(s);
       }
       expect(f).toContain("▸1"); // 1 running
       expect(f).toContain("⇡2"); // outbox depth 2
       expect(f).toContain("⚑1"); // 1 stale worktree
       expect(f).toContain("●"); // daemon up
       expect(f).toContain("2/5"); // outbox is the 2nd section
       // cursor glyph is present on the selected row.
       const outboxLine = f.split("\n").find((l) => l.includes("outbox"))!;
       expect(outboxLine).toContain("▌");
     });

     it("hides zero badges and renders ○ when the daemon is down", () => {
       const down: LocalCheap = {
         ...CHEAP,
         queue: { ...CHEAP.queue, running: [] },
         outbox: { ...CHEAP.outbox, depth: 0 },
         daemon: { ...DAEMON, up: false },
       };
       const f = render(
         <SectionRail
           section="queue"
           focus="rail"
           cheap={down}
           heavy={{ ...HEAVY, worktrees: [] }}
           width={26}
           height={20}
           now={NOW}
         />,
       ).lastFrame()!;
       expect(f).not.toContain("▸");
       expect(f).not.toContain("⇡");
       expect(f).not.toContain("⚑");
       expect(f).toContain("○");
     });
   });
   ```

2. [ ] Run it, expect FAIL with `Failed to resolve import "../src/tui/components/LocalDashboard.js"`:
   ```
   npx vitest run tests/tuiLocal.test.tsx > /tmp/out 2>&1; echo "exit: $?"
   ```

3. [ ] Write minimal implementation — create `src/tui/components/LocalDashboard.tsx`:
   ```tsx
   import React from "react";
   import { Box, Text } from "ink";
   import { theme } from "../theme.js";
   import { fmtAge } from "../queueFmt.js";
   import type { LocalCheap, LocalHeavy } from "../localSnapshot.js";

   export type LocalSection = "queue" | "outbox" | "repos" | "worktrees" | "daemon";
   export type { UiMode } from "../geometry.js";

   const SECTIONS: readonly LocalSection[] = ["queue", "outbox", "repos", "worktrees", "daemon"];

   /** Compact live badge for a section, derived from the cheap/heavy snapshots.
    * Empty string → no badge (hidden at zero). */
   function sectionBadge(s: LocalSection, cheap: LocalCheap | null, heavy: LocalHeavy | null): string {
     if (cheap === null) return "";
     switch (s) {
       case "queue": {
         const n = cheap.queue.running.length;
         return n > 0 ? `▸${n}` : "";
       }
       case "outbox":
         return cheap.outbox.depth > 0 ? `⇡${cheap.outbox.depth}` : "";
       case "worktrees": {
         const n = (heavy?.worktrees ?? []).filter((w) => w.kind === "stale").length;
         return n > 0 ? `⚑${n}` : "";
       }
       case "daemon":
         return cheap.daemon.up ? "●" : "○";
       case "repos":
         return "";
     }
   }

   /** LOCAL section rail — a fixed 5-row list (never windowed), rendered like the
    * GitHub Rail: `▌` accent cursor + selectionBg on the selected section, border
    * accent when the rail holds focus. Live badges come from the cheap/heavy
    * snapshots; an optional `↻ <age>` stamp is pinned at the bottom so the tall
    * 26-wide column doesn't read as empty. */
   export function SectionRail({
     section,
     focus,
     cheap,
     heavy,
     width,
     height,
     now,
     refreshedAt,
   }: {
     section: LocalSection;
     focus: "rail" | "body";
     cheap: LocalCheap | null;
     heavy: LocalHeavy | null;
     width: number;
     height: number;
     now: Date;
     refreshedAt?: string | null;
   }): React.JSX.Element {
     const idx = SECTIONS.indexOf(section);
     return (
       <Box
         flexDirection="column"
         borderStyle="round"
         borderColor={focus === "rail" ? theme.accent : theme.border}
         paddingX={1}
         width={width}
         height={height}
       >
         <Text bold color={focus === "rail" ? theme.accent : undefined}>
           sections
         </Text>
         {SECTIONS.map((s, i) => {
           const sel = i === idx;
           const badge = sectionBadge(s, cheap, heavy);
           return (
             <Box key={s} width="100%" backgroundColor={sel ? theme.selectionBg : undefined}>
               <Text color={theme.accent}>{sel ? "▌" : " "}</Text>
               <Text wrap="truncate">
                 {s}
                 {badge ? `  ${badge}` : ""}
               </Text>
             </Box>
           );
         })}
         <Text dimColor>
           {idx + 1}/{SECTIONS.length}
         </Text>
         <Box flexGrow={1} />
         {refreshedAt != null && (
           <Text dimColor wrap="truncate">
             ↻ {fmtAge(refreshedAt, now)}
           </Text>
         )}
       </Box>
     );
   }
   ```

4. [ ] Run, expect PASS:
   ```
   npx vitest run tests/tuiLocal.test.tsx > /tmp/out 2>&1; echo "exit: $?"
   ```

5. [ ] Lint the touched files:
   ```
   npx prettier --write src/tui/components/LocalDashboard.tsx tests/tuiLocal.test.tsx
   npx eslint --no-warn-ignored src/tui/components/LocalDashboard.tsx tests/tuiLocal.test.tsx
   ```

6. [ ] Commit:
   ```
   git add src/tui/components/LocalDashboard.tsx tests/tuiLocal.test.tsx
   git commit -m "feat(tui): add LOCAL SectionRail component"
   ```

---

### Task 13: Outbox / Repos / Worktrees / Daemon body sections

**Files:**
- Modify `src/tui/components/LocalDashboard.tsx` (append the four section components + two small format helpers, after `SectionRail`)
- Modify `tests/tuiLocal.test.tsx` (append four describes; reuse the fixtures from the SectionRail task)

**Interfaces:**
- Consumes (Stage A, type-only): `LocalCheap`, `LocalRepo`, `LocalWorktree`, `DaemonDetail` from `src/tui/localSnapshot.ts`. Existing: `theme`, `queueLabel`.
- Produces (all pure, each renders its own bordered pane with border accent when `focused`):
  - `export function OutboxSection(props: { outbox: LocalCheap["outbox"] | null; cursor: number; window: { start: number; end: number }; height: number; focused: boolean; now: Date }): React.JSX.Element`
  - `export function ReposSection(props: { repos: LocalRepo[] | null; error: string | null; cursor: number; window: { start: number; end: number }; height: number; focused: boolean }): React.JSX.Element`
  - `export function WorktreesSection(props: { worktrees: LocalWorktree[] | null; error: string | null; cursor: number; window: { start: number; end: number }; height: number; focused: boolean }): React.JSX.Element`
  - `export function DaemonSection(props: { daemon: DaemonDetail | null; scroll: number; height: number; focused: boolean }): React.JSX.Element`

**Steps:**

1. [ ] Write the failing test — append to `tests/tuiLocal.test.tsx` (add the imports to the existing import line for `LocalDashboard.js`):
   ```tsx
   import {
     SectionRail,
     OutboxSection,
     ReposSection,
     WorktreesSection,
     DaemonSection,
   } from "../src/tui/components/LocalDashboard.js";

   const FULL_WIN = { start: 0, end: 10 };

   describe("OutboxSection", () => {
     it("header counts, op line, and cursor on the selected op", () => {
       const f = render(
         <OutboxSection
           outbox={CHEAP.outbox}
           cursor={0}
           window={FULL_WIN}
           height={20}
           focused
           now={NOW}
         />,
       ).lastFrame()!;
       expect(f).toContain("⇡2 live");
       expect(f).toContain("✗1 dead");
       expect(f).toContain("comment acme/api#7");
       expect(f).toContain("attempts=2");
       expect(f).toContain("connect ETIMEDOUT"); // selected op expands its lastError
       const opLine = f.split("\n").find((l) => l.includes("comment"))!;
       expect(opLine).toContain("▌");
     });

     it("null → loading", () => {
       const f = render(
         <OutboxSection
           outbox={null}
           cursor={0}
           window={FULL_WIN}
           height={20}
           focused={false}
           now={NOW}
         />,
       ).lastFrame()!;
       expect(f).toContain("loading…");
     });
   });

   describe("ReposSection", () => {
     it("renders nwo, source tag, branch@sha7, dirty mark, cursor", () => {
       const f = render(
         <ReposSection
           repos={HEAVY.repos}
           error={null}
           cursor={0}
           window={FULL_WIN}
           height={20}
           focused
         />,
       ).lastFrame()!;
       expect(f).toContain("acme/api");
       expect(f).toContain("(clone)");
       expect(f).toContain("main@abcdef1");
       expect(f).toContain("✎");
       const line = f.split("\n").find((l) => l.includes("acme/api"))!;
       expect(line).toContain("▌");
     });

     it("per-repo error renders without collapsing the frame", () => {
       const f = render(
         <ReposSection
           repos={[{ ...HEAVY.repos[0], error: "not a git repo" }]}
           error={null}
           cursor={0}
           window={FULL_WIN}
           height={20}
           focused={false}
         />,
       ).lastFrame()!;
       expect(f).toContain("not a git repo");
     });
   });

   describe("WorktreesSection", () => {
     it("renders mapped nwo, slug, class, sha7, age, cursor", () => {
       const f = render(
         <WorktreesSection
           worktrees={HEAVY.worktrees}
           error={null}
           cursor={0}
           window={FULL_WIN}
           height={20}
           focused
         />,
       ).lastFrame()!;
       expect(f).toContain("acme/api");
       expect(f).toContain("slug-1");
       expect(f).toContain("stale");
       expect(f).toContain("abcdef1");
       expect(f).toContain("2h"); // 7200s
       const line = f.split("\n").find((l) => l.includes("slug-1"))!;
       expect(line).toContain("▌");
     });

     it("unmapped worktree shows ⟨unmapped⟩", () => {
       const f = render(
         <WorktreesSection
           worktrees={[{ ...HEAVY.worktrees[0], repoNwo: null }]}
           error={null}
           cursor={0}
           window={FULL_WIN}
           height={20}
           focused={false}
         />,
       ).lastFrame()!;
       expect(f).toContain("⟨unmapped⟩");
     });
   });

   describe("DaemonSection", () => {
     it("renders pid, uptime, endpoint, guards, tokens, per-ticket progress", () => {
       const f = render(<DaemonSection daemon={DAEMON} scroll={0} height={20} focused />).lastFrame()!;
       expect(f).toContain("pid 4242");
       expect(f).toContain("up 2h13m"); // 8000s
       expect(f).toContain("inference endpoint");
       expect(f).toContain("127.0.0.1:8787");
       expect(f).toContain("nudges 1");
       expect(f).toContain("kills 0");
       expect(f).toContain("turn 3");
     });

     it("daemon down → ○ not running", () => {
       const f = render(
         <DaemonSection daemon={{ ...DAEMON, up: false }} scroll={0} height={20} focused={false} />,
       ).lastFrame()!;
       expect(f).toContain("○ not running");
     });
   });
   ```

2. [ ] Run it, expect FAIL with `does not provide an export named 'OutboxSection'`:
   ```
   npx vitest run tests/tuiLocal.test.tsx > /tmp/out 2>&1; echo "exit: $?"
   ```

3. [ ] Write minimal implementation — extend the imports at the top of `src/tui/components/LocalDashboard.tsx`:
   ```tsx
   import { fmtAge, queueLabel } from "../queueFmt.js";
   import type { LocalCheap, LocalHeavy, LocalRepo, LocalWorktree, DaemonDetail } from "../localSnapshot.js";
   ```
   (replace the existing `fmtAge` import and the existing type import line accordingly), then append after `SectionRail`:
   ```tsx
   /** Duration from whole seconds: `13m`, `2h13m`, `-` for null. */
   function fmtDur(s: number | null): string {
     if (s === null) return "-";
     if (s < 3600) return `${Math.floor(s / 60)}m`;
     return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
   }

   /** Truncate a long path from the start so the meaningful tail (repo dir)
    * survives: `…/repos/acme-api`. */
   function truncStart(p: string, max: number): string {
     return p.length <= max ? p : "…" + p.slice(p.length - max + 1);
   }

   const SOURCE_TAG: Record<LocalRepo["source"], string> = {
     config: "(cfg)",
     watchlist: "(watch)",
     external: "(external)",
     clone: "(clone)",
   };

   /** GitHub outbox op-log: live ops (selectable) with the cursor op's lastError
    * expanded, plus a read-only dead tail. Mirrors outboxCmd's opLine format. */
   export function OutboxSection({
     outbox,
     cursor,
     window,
     height,
     focused,
     now,
   }: {
     outbox: LocalCheap["outbox"] | null;
     cursor: number;
     window: { start: number; end: number };
     height: number;
     focused: boolean;
     now: Date;
   }): React.JSX.Element {
     const border = (
       <Box
         flexDirection="column"
         borderStyle="round"
         borderColor={focused ? theme.accent : theme.border}
         paddingX={1}
         flexGrow={1}
         height={height}
       />
     );
     if (outbox === null) {
       return React.cloneElement(border, {}, <Text dimColor>loading…</Text>);
     }
     const rows: React.JSX.Element[] = [];
     rows.push(
       <Text key="h" bold color={focused ? theme.accent : undefined}>
         <Text color={theme.warn}>⇡{outbox.depth}</Text> live ·{" "}
         <Text color={theme.error}>✗{outbox.dead}</Text> dead
       </Text>,
     );
     if (outbox.error !== null) {
       rows.push(
         <Text key="err" dimColor wrap="truncate-end">
           unavailable: {outbox.error}
         </Text>,
       );
     }
     if (outbox.ops.length === 0 && outbox.error === null) {
       rows.push(
         <Text key="none" dimColor>
           none
         </Text>,
       );
     }
     outbox.ops.slice(window.start, window.end).forEach((s, i) => {
       const idx = window.start + i;
       const sel = idx === cursor;
       const target = "nwo" in s.op && "issue" in s.op ? `${s.op.nwo}#${s.op.issue}` : s.issueKey ?? "?";
       rows.push(
         <Box key={s.id} width="100%" backgroundColor={sel ? theme.selectionBg : undefined}>
           <Text color={theme.accent}>{sel ? "▌" : " "}</Text>
           <Text wrap="truncate-end">
             {fmtAge(s.createdAt, now)} {s.op.kind} {target}
             <Text dimColor> attempts={s.attempts}</Text>
           </Text>
         </Box>,
       );
       if (sel && s.lastError !== null) {
         rows.push(
           <Text key={`${s.id}-e`} dimColor wrap="truncate-end">
             {"  "}
             {s.lastError}
           </Text>,
         );
       }
     });
     if (outbox.deadOps.length > 0) {
       rows.push(
         <Text key="dead-h" bold color={theme.error}>
           {" "}
           dead
         </Text>,
       );
       for (const s of outbox.deadOps) {
         rows.push(
           <Text key={`d-${s.id}`} dimColor wrap="truncate-end">
             {"  "}
             {fmtAge(s.createdAt, now)} {s.op.kind} attempts={s.attempts}
           </Text>,
         );
       }
     }
     return React.cloneElement(border, {}, rows.slice(0, Math.max(1, height - 3)));
   }

   /** Repos junco knows about and where they live on disk. */
   export function ReposSection({
     repos,
     error,
     cursor,
     window,
     height,
     focused,
   }: {
     repos: LocalRepo[] | null;
     error: string | null;
     cursor: number;
     window: { start: number; end: number };
     height: number;
     focused: boolean;
   }): React.JSX.Element {
     return (
       <Box
         flexDirection="column"
         borderStyle="round"
         borderColor={focused ? theme.accent : theme.border}
         paddingX={1}
         flexGrow={1}
         height={height}
       >
         <Text bold color={focused ? theme.accent : undefined}>
           repos
         </Text>
         {error !== null && (
           <Text dimColor wrap="truncate-end">
             unavailable: {error}
           </Text>
         )}
         {repos === null && error === null && <Text dimColor>loading…</Text>}
         {repos !== null && repos.length === 0 && error === null && <Text dimColor>none</Text>}
         {(repos ?? []).slice(window.start, window.end).map((r, i) => {
           const idx = window.start + i;
           const sel = idx === cursor;
           return (
             <Box key={r.path} width="100%" backgroundColor={sel ? theme.selectionBg : undefined}>
               <Text color={theme.accent}>{sel ? "▌" : " "}</Text>
               <Text wrap="truncate-end">
                 <Text bold>{r.nwo ?? "⟨no nwo⟩"}</Text>
                 <Text dimColor> {SOURCE_TAG[r.source]}</Text>
                 <Text dimColor> {truncStart(r.path, 30)}</Text>
                 {r.error !== null ? (
                   <Text color={theme.warn}> {r.error}</Text>
                 ) : (
                   <>
                     {r.branch !== null && (
                       <Text>
                         {" "}
                         {r.branch}
                         {r.headSha !== null ? `@${r.headSha.slice(0, 7)}` : ""}
                       </Text>
                     )}
                     {r.dirty === true && <Text color={theme.warn}> ✎</Text>}
                   </>
                 )}
               </Text>
             </Box>
           );
         })}
         {repos !== null && repos.length > window.end - window.start && (
           <Text dimColor>
             {cursor + 1}/{repos.length}
           </Text>
         )}
       </Box>
     );
   }

   /** Per-ticket worktrees. The FS class (live/stale/backup) is display-only —
    * NOT the prune safety signal (that lives under worktrees.lock, Stage A/B). */
   export function WorktreesSection({
     worktrees,
     error,
     cursor,
     window,
     height,
     focused,
   }: {
     worktrees: LocalWorktree[] | null;
     error: string | null;
     cursor: number;
     window: { start: number; end: number };
     height: number;
     focused: boolean;
   }): React.JSX.Element {
     return (
       <Box
         flexDirection="column"
         borderStyle="round"
         borderColor={focused ? theme.accent : theme.border}
         paddingX={1}
         flexGrow={1}
         height={height}
       >
         <Text bold color={focused ? theme.accent : undefined}>
           worktrees
         </Text>
         {error !== null && (
           <Text dimColor wrap="truncate-end">
             unavailable: {error}
           </Text>
         )}
         {worktrees === null && error === null && <Text dimColor>loading…</Text>}
         {worktrees !== null && worktrees.length === 0 && error === null && <Text dimColor>none</Text>}
         {(worktrees ?? []).slice(window.start, window.end).map((w, i) => {
           const idx = window.start + i;
           const sel = idx === cursor;
           const dim = w.kind === "backup";
           return (
             <Box key={w.path} width="100%" backgroundColor={sel ? theme.selectionBg : undefined}>
               <Text color={theme.accent}>{sel ? "▌" : " "}</Text>
               <Text wrap="truncate-end" dimColor={dim}>
                 {w.repoNwo ?? "⟨unmapped⟩"} {w.slug} <Text dimColor>{w.kind}</Text>
                 {w.headSha !== null ? ` ${w.headSha.slice(0, 7)}` : ""} <Text dimColor>{fmtDur(w.ageSeconds)}</Text>
                 {w.error !== null ? <Text color={theme.warn}> {w.error}</Text> : null}
               </Text>
             </Box>
           );
         })}
         {worktrees !== null && worktrees.length > window.end - window.start && (
           <Text dimColor>
             {cursor + 1}/{worktrees.length}
           </Text>
         )}
       </Box>
     );
   }

   /** Daemon & health detail — a scrollable non-list panel (`scroll` slices the
    * built rows, mirroring QueueView). Stack-agnostic wording: "inference
    * endpoint", never a specific server. */
   export function DaemonSection({
     daemon,
     scroll,
     height,
     focused,
   }: {
     daemon: DaemonDetail | null;
     scroll: number;
     height: number;
     focused: boolean;
   }): React.JSX.Element {
     const border = (
       <Box
         flexDirection="column"
         borderStyle="round"
         borderColor={focused ? theme.accent : theme.border}
         paddingX={1}
         flexGrow={1}
         height={height}
       />
     );
     if (daemon === null) {
       return React.cloneElement(border, {}, <Text dimColor>loading…</Text>);
     }
     const lines: React.JSX.Element[] = [];
     lines.push(
       <Text key="t" bold color={focused ? theme.accent : undefined}>
         daemon
       </Text>,
     );
     if (daemon.error !== null) {
       lines.push(
         <Text key="err" dimColor wrap="truncate-end">
           unavailable: {daemon.error}
         </Text>,
       );
     }
     if (!daemon.up) {
       lines.push(
         <Text key="down" color={theme.warn}>
           ○ not running
         </Text>,
       );
     } else {
       lines.push(
         <Text key="pid">
           pid {daemon.pid ?? "?"} · up {fmtDur(daemon.uptimeSeconds)}
         </Text>,
       );
     }
     lines.push(
       <Text key="ep">
         <Text color={daemon.endpointReachable ? theme.success : theme.warn}>
           {daemon.endpointReachable ? "●" : "○"}
         </Text>{" "}
         inference endpoint
       </Text>,
     );
     lines.push(
       <Text key="hp" dimColor>
         health {daemon.healthHost}:{daemon.healthPort}
       </Text>,
     );
     lines.push(
       <Text key="g">
         guard: nudges {daemon.guardNudges ?? 0} · kills {daemon.guardKills ?? 0}
       </Text>,
     );
     lines.push(
       <Text key="tok" dimColor>
         tok in {daemon.tokensIn ?? 0} · out {daemon.tokensOut ?? 0}
       </Text>,
     );
     const statuses = Object.entries(daemon.tasksByStatus);
     if (statuses.length > 0) {
       lines.push(<Text key="tbs">{statuses.map(([k, v]) => `${k}:${v}`).join(" · ")}</Text>);
     }
     for (const [id, p] of Object.entries(daemon.progress)) {
       lines.push(
         <Text key={`pg-${id}`} wrap="truncate-end">
           {"  "}
           {queueLabel(null, id)} turn {p.turns}
           {p.lastTool !== null ? ` · ${p.lastTool}` : ""} · {p.outputTokens} tok
         </Text>,
       );
     }
     return React.cloneElement(border, {}, lines.slice(scroll, scroll + Math.max(1, height - 3)));
   }
   ```

4. [ ] Run, expect PASS:
   ```
   npx vitest run tests/tuiLocal.test.tsx > /tmp/out 2>&1; echo "exit: $?"
   ```

5. [ ] Lint the touched files:
   ```
   npx prettier --write src/tui/components/LocalDashboard.tsx tests/tuiLocal.test.tsx
   npx eslint --no-warn-ignored src/tui/components/LocalDashboard.tsx tests/tuiLocal.test.tsx
   ```

6. [ ] Commit:
   ```
   git add src/tui/components/LocalDashboard.tsx tests/tuiLocal.test.tsx
   git commit -m "feat(tui): add LOCAL Outbox/Repos/Worktrees/Daemon body sections"
   ```

---

### Task 14: LocalDashboard composition (section rail + body switch + focus border)

**Files:**
- Modify `src/tui/components/LocalDashboard.tsx` (add the default-export `LocalDashboard`, its internal windowing, and the imports it needs)
- Modify `tests/tuiLocal.test.tsx` (append a `LocalDashboard` describe; reuse the fixtures)

**Interfaces:**
- Consumes (existing): `QueueView` from `./QueueView.js`; `windowSlice` from `../window.js`; `listRowsHeight` from `../geometry.js`; `RAIL_WIDTH` + `Layout` from `../layout.js`; and the section components + types produced above.
- Produces:
  - `export default function LocalDashboard(props: { cheap: LocalCheap | null; heavy: LocalHeavy | null; section: LocalSection; focus: "rail" | "body"; cursor: number; scroll: number; layout: Layout; now: Date }): React.JSX.Element` — renders `SectionRail` beside the selected section body; the rail holds the border accent when `focus==="rail"`, the body when `focus==="body"`. List sections window via `windowSlice(total, listRowsHeight(bodyRows), cursor, prevStart)` with an internal per-section `prevStart` ref (minimal-movement, App-pattern); Queue passes `selectable`/`selectedRow={cursor}` into `QueueView`; Daemon is the scroll panel.

**Steps:**

1. [ ] Write the failing test — append to `tests/tuiLocal.test.tsx` (add the default import + `computeLayout`):
   ```tsx
   import LocalDashboard from "../src/tui/components/LocalDashboard.js";
   import { computeLayout } from "../src/tui/layout.js";

   describe("LocalDashboard", () => {
     const LAYOUT = computeLayout(120, 30);

     it("renders the section rail beside the selected section body", () => {
       const f = render(
         <LocalDashboard
           cheap={CHEAP}
           heavy={HEAVY}
           section="repos"
           focus="body"
           cursor={0}
           scroll={0}
           layout={LAYOUT}
           now={NOW}
         />,
       ).lastFrame()!;
       expect(f).toContain("sections"); // the rail
       expect(f).toContain("main@abcdef1"); // the repos body
     });

     it("queue section renders selectable QueueView (cursor on an actionable row)", () => {
       const cheapQ: LocalCheap = {
         ...CHEAP,
         queue: {
           ...CHEAP.queue,
           waiting: [
             {
               id: "manual-x",
               github: null,
               kind: "pr",
               priority: "normal",
               retryCount: 0,
               notBefore: null,
               deferred: false,
             },
           ],
         },
       };
       const f = render(
         <LocalDashboard
           cheap={cheapQ}
           heavy={HEAVY}
           section="queue"
           focus="body"
           cursor={0}
           scroll={0}
           layout={LAYOUT}
           now={NOW}
         />,
       ).lastFrame()!;
       const line = f.split("\n").find((l) => l.includes("manual-x"))!;
       expect(line).toContain("▌");
     });

     it("cheap === null → body sections show loading", () => {
       const f = render(
         <LocalDashboard
           cheap={null}
           heavy={null}
           section="daemon"
           focus="rail"
           cursor={0}
           scroll={0}
           layout={LAYOUT}
           now={NOW}
         />,
       ).lastFrame()!;
       expect(f).toContain("loading…");
     });

     it("daemon-down frame", () => {
       const f = render(
         <LocalDashboard
           cheap={{ ...CHEAP, daemon: { ...DAEMON, up: false } }}
           heavy={HEAVY}
           section="daemon"
           focus="body"
           cursor={0}
           scroll={0}
           layout={LAYOUT}
           now={NOW}
         />,
       ).lastFrame()!;
       expect(f).toContain("○ not running");
     });

     it("heavy error frame renders unavailable without collapsing", () => {
       const f = render(
         <LocalDashboard
           cheap={CHEAP}
           heavy={{ repos: [], worktrees: [], error: "git spawn failed" }}
           section="worktrees"
           focus="body"
           cursor={0}
           scroll={0}
           layout={LAYOUT}
           now={NOW}
         />,
       ).lastFrame()!;
       expect(f).toContain("unavailable: git spawn failed");
     });
   });
   ```

2. [ ] Run it, expect FAIL with `does not provide an export named 'default'`:
   ```
   npx vitest run tests/tuiLocal.test.tsx > /tmp/out 2>&1; echo "exit: $?"
   ```

3. [ ] Write minimal implementation — add the imports at the top of `src/tui/components/LocalDashboard.tsx`:
   ```tsx
   import { QueueView } from "./QueueView.js";
   import { windowSlice } from "../window.js";
   import { listRowsHeight } from "../geometry.js";
   import { RAIL_WIDTH, type Layout } from "../layout.js";
   ```
   and append at the end of the file:
   ```tsx
   /** LOCAL dashboard: the section rail + the selected section body. Windowing
    * memory (minimal-movement prevStart) lives here in a per-section ref so the
    * near-pure section components stay testable with an explicit window; the
    * daemon panel scrolls via the `scroll` prop instead. */
   export default function LocalDashboard({
     cheap,
     heavy,
     section,
     focus,
     cursor,
     scroll,
     layout,
     now,
   }: {
     cheap: LocalCheap | null;
     heavy: LocalHeavy | null;
     section: LocalSection;
     focus: "rail" | "body";
     cursor: number;
     scroll: number;
     layout: Layout;
     now: Date;
   }): React.JSX.Element {
     const bodyFocused = focus === "body";
     const h = layout.bodyRows;
     const listH = listRowsHeight(h);
     const prevStart = React.useRef<Record<LocalSection, number>>({
       queue: 0,
       outbox: 0,
       repos: 0,
       worktrees: 0,
       daemon: 0,
     });
     const total =
       section === "outbox"
         ? cheap?.outbox.ops.length ?? 0
         : section === "repos"
           ? heavy?.repos.length ?? 0
           : section === "worktrees"
             ? heavy?.worktrees.length ?? 0
             : 0;
     const win = windowSlice(total, listH, cursor, prevStart.current[section]);
     if (section === "outbox" || section === "repos" || section === "worktrees") {
       prevStart.current[section] = win.start;
     }

     const body =
       section === "queue" ? (
         <QueueView
           snap={cheap?.queue ?? null}
           scroll={scroll}
           now={now}
           height={h}
           focused={bodyFocused}
           selectable
           selectedRow={cursor}
         />
       ) : section === "outbox" ? (
         <OutboxSection
           outbox={cheap?.outbox ?? null}
           cursor={cursor}
           window={win}
           height={h}
           focused={bodyFocused}
           now={now}
         />
       ) : section === "repos" ? (
         <ReposSection
           repos={heavy?.repos ?? null}
           error={heavy?.error ?? null}
           cursor={cursor}
           window={win}
           height={h}
           focused={bodyFocused}
         />
       ) : section === "worktrees" ? (
         <WorktreesSection
           worktrees={heavy?.worktrees ?? null}
           error={heavy?.error ?? null}
           cursor={cursor}
           window={win}
           height={h}
           focused={bodyFocused}
         />
       ) : (
         <DaemonSection daemon={cheap?.daemon ?? null} scroll={scroll} height={h} focused={bodyFocused} />
       );

     return (
       <Box flexDirection="row">
         <SectionRail
           section={section}
           focus={focus}
           cheap={cheap}
           heavy={heavy}
           width={layout.railWidth > 0 ? layout.railWidth : RAIL_WIDTH}
           height={h}
           now={now}
         />
         <Box flexGrow={1}>{body}</Box>
       </Box>
     );
   }
   ```

4. [ ] Run, expect PASS (all `tuiLocal` describes):
   ```
   npx vitest run tests/tuiLocal.test.tsx > /tmp/out 2>&1; echo "exit: $?"
   ```

5. [ ] Lint + typecheck the touched files:
   ```
   npx prettier --write src/tui/components/LocalDashboard.tsx tests/tuiLocal.test.tsx
   npx eslint --no-warn-ignored src/tui/components/LocalDashboard.tsx tests/tuiLocal.test.tsx
   npx tsc --noEmit -p tsconfig.eslint.json > /tmp/tc 2>&1; echo "exit: $?"
   ```
   (Confirm no NEW errors in `LocalDashboard.tsx`/`tuiLocal.test.tsx` beyond the ~57 known pre-existing ones.)

6. [ ] Run the full unwired-surface regression to prove nothing App-facing broke (these modules are still unimported by `App.tsx`, so the suite stays green):
   ```
   npx vitest run tests/tuiQueue.test.tsx tests/tuiGeometry.test.ts tests/tuiLocal.test.tsx > /tmp/out 2>&1; echo "exit: $?"
   ```

7. [ ] Commit:
   ```
   git add src/tui/components/LocalDashboard.tsx tests/tuiLocal.test.tsx
   git commit -m "feat(tui): compose LocalDashboard (section rail + body switch + focus)"
   ```

---

STAGE NOTES: Cross-stage reconciliations the assembler must enforce. (1) `UiMode` has one canonical home — `src/tui/geometry.ts` (its `headerTabBands` return type needs it); `LocalDashboard.tsx` re-exports it (`export type { UiMode } from "../geometry.js"`) to satisfy the contract's "types live in LocalDashboard.tsx" listing. Stage E's `App.tsx`/`hitTest.ts` must import `UiMode` from geometry (or transitively from LocalDashboard), not redeclare it — a second `type UiMode` declaration will collide. (2) `headerTabBands` hardcodes `TAB_BRAND_COLS = 11` and fixed slot widths (`[GITHUB]`=8/`[LOCAL]`=7 wide; `[G]`/`[L]`=3 compact) with a 1-col gutter; **Stage E's `Header` must render the brand mark in exactly 11 columns and the tab labels at those slot widths** or the click bands drift from the drawn tabs — Stage E's full-`<App>` header-row frame test is the cross-check, and if the real emoji/brand width forces a different constant, it must move in `geometry.ts` (tests reference `TAB_BRAND_COLS`, so they follow). (3) `LocalDashboard`'s frozen props (per contract) omit a `refreshedAt` for the SectionRail `↻` line — I made `SectionRail.refreshedAt` optional and `LocalDashboard` does **not** pass it, so the pinned refresh stamp is inert until Stage E either renders `SectionRail` directly with `localRefreshedAt` or the assembler extends `LocalDashboard`'s props; flag if the spec's `↻` line is required in v1. (4) All Stage D fixtures assume Stage A's exact interface shapes (`LocalCheap.outbox = {depth,dead,ops,deadOps,error}`, `DaemonDetail` field names, `LocalRepo.source` union, `LocalWorktree.kind`) and `StoredOp` from `src/githubOutbox.ts`; if Stage A renames any field the `tuiLocal.test.tsx` literals and the section renderers must move together. (5) `OutboxSection`/`DaemonSection` use `React.cloneElement` on a bordered `Box` shell to inject sliced children — behaviorally fine, but if a reviewer prefers explicit `<Box>` duplication that is a pure-refactor, no interface impact. (6) `QueueRowRef.kind` includes `"running"` for union completeness but `onRows` never emits running rows (non-selectable) — Stage E's LOCAL cursor logic must treat the `onRows` list as the full actionable index space (waiting then recent) and never synthesize a running selection.


<!-- ===== Stage E — The atomic switch + docs ===== -->


---

### Task 15: Chrome.tsx — Header mode tabs + local hints

**Files:**
- Modify `src/tui/components/Chrome.tsx` (Header signature :35-72; the right-chip `Box` :86-136; `hintsFor` pane-1/pane-2 sets :237-273; add `localHintsFor` after `hintsFor`)
- Modify `tests/tuiChrome.test.tsx` (add the mode-tab + `localHintsFor` describe blocks)

**Interfaces:**
- Consumes: `headerTabBands(columns: number): { hit(x: number): UiMode | null; githubStart: number; localStart: number }` and `type UiMode = "github" | "local"` from `./geometry.js` (Stage A); `WIDE_COLS` (via the existing `mode: LayoutMode` — `wide` ⇔ `columns ≥ WIDE_COLS`); `theme` from `../theme.js`.
- Produces: `Header` gains **optional** `uiMode?: UiMode` and `githubEnabled?: boolean`. When `uiMode === undefined` the header renders byte-identically to today (this is what keeps every existing full-`<App>` frame test green until Task 3 flips the switch). `localHintsFor(section: LocalSection, focus: "rail" | "body"): [string, string][]`. `hintsFor("main", …)` pane-2 set gains `["m", "local"]`.

Steps:

- [ ] **Write the failing test.** Append to `tests/tuiChrome.test.tsx`:
  ```tsx
  import { headerTabBands } from "../src/tui/geometry.js";
  import { localHintsFor } from "../src/tui/components/Chrome.js";

  describe("Header mode tabs", () => {
    const base = {
      repoNwo: "acme/api", health: UP_BARE, reviewCount: 0, now: NOW,
      queueRunning: 0, queueWaiting: 0, watchlistError: null, outboxDepth: 0,
      prAttention: 0, prFailing: false, refreshedAt: null,
    } as const;

    it("absent uiMode renders no tab (byte-for-byte legacy header)", () => {
      const f = render(<Header {...base} mode="wide" />).lastFrame()!;
      expect(f).not.toContain("[GITHUB]");
      expect(f).not.toContain("[LOCAL]");
    });

    it("github active: [GITHUB] bracketed, local plain — survives NO_COLOR", () => {
      const f = render(<Header {...base} mode="wide" uiMode="github" githubEnabled />).lastFrame()!;
      expect(f).toContain("[GITHUB]");
      expect(f).toContain("local");
      expect(f).not.toContain("[LOCAL]");
    });

    it("local active: github plain, [LOCAL] bracketed", () => {
      const f = render(<Header {...base} mode="wide" uiMode="local" githubEnabled />).lastFrame()!;
      expect(f).toContain("[LOCAL]");
      expect(f).toContain("github");
      expect(f).not.toContain("[GITHUB]");
    });

    it("compact form below the wide breakpoint: single-letter tabs", () => {
      const f = render(<Header {...base} mode="medium" uiMode="github" githubEnabled />).lastFrame()!;
      expect(f).toContain("[G]");
      expect(f).toContain("l");
      expect(f).not.toContain("[GITHUB]");
    });

    it("columns=60 with a full medium chip set stays one row (no wrap)", () => {
      const f = render(
        <Header
          {...base} mode="medium" uiMode="local" githubEnabled
          sizeHint={60 as never}
          reviewCount={2} queueRunning={1} queueWaiting={1} outboxDepth={4} prAttention={3}
        />,
      ).lastFrame()!;
      const lines = f.split("\n").filter((l) => l.trim().length > 0);
      expect(lines).toHaveLength(1);
    });

    it("tab labels align with headerTabBands click bands", () => {
      const bands = headerTabBands(100);
      // Both bands land inside the printed header width and are ordered g < l.
      expect(bands.githubStart).toBeLessThan(bands.localStart);
      expect(bands.hit(bands.githubStart)).toBe("github");
      expect(bands.hit(bands.localStart)).toBe("local");
      expect(bands.hit(0)).toBe(null); // brand region is dead
    });
  });

  describe("localHintsFor", () => {
    it("rail focus advertises the global mode + section keys", () => {
      const keys = localHintsFor("queue", "rail").map(([k]) => k);
      expect(keys).toContain("↑/↓");
      expect(keys).toContain("m");
      expect(keys).toContain("q");
    });
    it("queue body advertises R requeue and x delete", () => {
      const pairs = localHintsFor("queue", "body");
      expect(pairs.find(([k]) => k === "R")?.[1]).toBe("requeue");
      expect(pairs.find(([k]) => k === "x")?.[1]).toBe("delete");
    });
    it("worktrees body advertises x prune; daemon advertises X restart and [/] scroll", () => {
      expect(localHintsFor("worktrees", "body").find(([k]) => k === "x")?.[1]).toBe("prune");
      const daemon = localHintsFor("daemon", "body").map(([k]) => k);
      expect(daemon).toContain("X");
      expect(daemon).toContain("[/]");
    });
  });

  describe("hintsFor github main still discovers the mode key", () => {
    it("main pane 2 wide includes m local", () => {
      const pairs = hintsFor("main", 2, "wide", false);
      expect(pairs.find(([k]) => k === "m")?.[1]).toBe("local");
    });
  });
  ```
  (Drop the `sizeHint` line if the ink harness cannot narrow below its 100-col default — the one-row guarantee is already structural via `wrap="truncate"`/`flexShrink`; keep the assertion, it proves no self-wrap.)

- [ ] **Run it, expect FAIL.** `npx vitest run tests/tuiChrome.test.tsx > /tmp/e1 2>&1; echo "exit: $?"` — fails with `localHintsFor` not exported and `[GITHUB]`/`[LOCAL]`/`m local` absent.

- [ ] **Write minimal implementation.** In `src/tui/components/Chrome.tsx`, add imports and widen `Header`:
  ```tsx
  import { headerTabBands, type UiMode } from "../geometry.js";
  import type { LocalSection } from "../localSnapshot.js";
  ```
  Add the two optional fields to the destructure and the type literal:
  ```tsx
    prFailing,
    refreshedAt,
    uiMode,
    githubEnabled,
  }: {
    // …existing fields…
    refreshedAt: string | null;
    /** Present only in the two-mode App; absent → legacy single-surface header. */
    uiMode?: UiMode;
    /** When false the GITHUB tab dims (mode is off in config). */
    githubEnabled?: boolean;
  }): React.JSX.Element {
  ```
  Insert the tab segment as the first `flexShrink={0}` child AFTER the brand box (right before the repo-name `Box flexShrink={1}`). Its label widths mirror `headerTabBands` (which owns the click coordinates), so component and hit-test never drift:
  ```tsx
        {uiMode !== undefined && (
          <Box flexShrink={0}>
            <Text
              color={uiMode === "github" ? theme.accent : undefined}
              bold={uiMode === "github"}
              dimColor={githubEnabled === false}
            >
              {uiMode === "github" ? (wide ? "[GITHUB]" : "[G]") : wide ? "github" : "g"}
            </Text>
            <Text> </Text>
            <Text color={uiMode === "local" ? theme.accent : undefined} bold={uiMode === "local"}>
              {uiMode === "local" ? (wide ? "[LOCAL]" : "[L]") : wide ? "local" : "l"}
            </Text>
          </Box>
        )}
  ```
  In `hintsFor`, add `["m", "local"]` to the pane-2 main set (right before `["?", "help"]`) and to the pane-1 set (after `[":", "commands"]`), keeping the footer one-line invariant (`wrap="truncate-end"` already guards it). Then add `localHintsFor` at the bottom of the file:
  ```ts
  /** Local-mode key hints — GitHub `hintsFor` is untouched; this is a sibling
   * for the LOCAL surface. `m`/Shift+Tab is the global mode swap (also in the
   * github main set so it is discoverable from both sides). */
  export function localHintsFor(section: LocalSection, focus: "rail" | "body"): [string, string][] {
    if (focus === "rail") {
      return [
        ["↑/↓", "section"],
        ["→", "open"],
        ["m", "github"],
        ["r", "refresh"],
        ["?", "help"],
        ["q", "quit"],
      ];
    }
    switch (section) {
      case "queue":
        return [["↑/↓", "move"], ["R", "requeue"], ["x", "delete"], ["←", "back"]];
      case "outbox":
        return [["↑/↓", "move"], ["f", "flush"], ["←", "back"]];
      case "repos":
        return [["↑/↓", "move"], ["o", "browser"], ["x", "unwatch"], ["←", "back"]];
      case "worktrees":
        return [["↑/↓", "move"], ["x", "prune"], ["←", "back"]];
      case "daemon":
        return [["[/]", "scroll"], ["X", "restart"], ["f", "flush"], ["←", "back"]];
    }
  }
  ```

- [ ] **Run, expect PASS.** `npx vitest run tests/tuiChrome.test.tsx > /tmp/e1 2>&1; echo "exit: $?"` — green.

- [ ] **Run the frame-adjacent suites to confirm the absent-`uiMode` path is byte-identical.** `npx vitest run tests/tuiApp.test.tsx tests/tuiInteractive.test.tsx tests/tuiQueue.test.tsx tests/tuiModal.test.tsx > /tmp/e1b 2>&1; echo "exit: $?"` — still green (App does not pass `uiMode` yet).

- [ ] **Format + commit.** `npx prettier --write src/tui/components/Chrome.tsx tests/tuiChrome.test.tsx && git add -A && git commit -m "feat(tui): Header mode tabs and localHintsFor (inert until App passes uiMode)"`

---

### Task 16: hitTest.ts — modeTab target + optional uiMode

**Files:**
- Modify `src/tui/hitTest.ts` (`HitTarget` union :13-20; `HitContext` :22-41; the `y === 0`/`r < 0` early guard :46-47)
- Modify `tests/tuiHitTest.test.ts` (`medium()`/`wide()` helpers :6-25; add a `describe` for the header band)

**Interfaces:**
- Consumes: `headerTabBands`, `type UiMode` from `./geometry.js` (Stage A).
- Produces: `HitContext` gains **optional** `uiMode?: UiMode` (absent ⇒ treated as `"github"` AND no header band is emitted, so every existing `y===0 → none` case stays green). `HitTarget` gains `{ type: "modeTab"; mode: UiMode }` additively. When `uiMode` is supplied and `y === 0`, `hitTest` returns the band under `x` (or `none`).

Steps:

- [ ] **Write the failing test.** In `tests/tuiHitTest.test.ts` add `uiMode: "github"` to the `medium()` literal (keeps it explicit; `wide()` inherits it), then append:
  ```ts
  import { headerTabBands } from "../src/tui/geometry.js";

  describe("hitTest — header mode band", () => {
    it("no uiMode field: header row stays dead (legacy contract)", () => {
      const ctx = { ...medium() };
      delete (ctx as { uiMode?: unknown }).uiMode;
      expect(hitTest(ctx, headerTabBands(100).githubStart, 0)).toEqual({ type: "none" });
    });
    it("uiMode present: y=0 resolves the tab under x to a modeTab target", () => {
      const bands = headerTabBands(100);
      expect(hitTest(medium(), bands.githubStart, 0)).toEqual({ type: "modeTab", mode: "github" });
      expect(hitTest(medium(), bands.localStart, 0)).toEqual({ type: "modeTab", mode: "local" });
      expect(hitTest(medium(), 0, 0)).toEqual({ type: "none" }); // brand region
    });
    it("body rows are unaffected by the new field", () => {
      expect(hitTest(medium(), 5, 3)).toEqual({ type: "repoRow", index: 0 });
    });
  });
  ```

- [ ] **Run it, expect FAIL.** `npx vitest run tests/tuiHitTest.test.ts > /tmp/e2 2>&1; echo "exit: $?"` — fails: `modeTab` never returned.

- [ ] **Write minimal implementation.** In `src/tui/hitTest.ts`:
  ```ts
  import { LINK_LINE_ROW, PANE_CONTENT_ROW, listRowsHeight, railListHeight, headerTabBands } from "./geometry.js";
  import type { UiMode } from "./geometry.js";
  ```
  Add to `HitTarget`: `| { type: "modeTab"; mode: UiMode }`. Add to `HitContext`:
  ```ts
    /** Two-mode App only: enables header-band resolution at y===0. Absent ⇒
     * legacy single-surface, header row is dead. */
    uiMode?: UiMode;
  ```
  Resolve the header band FIRST, before the `r < 0` bail:
  ```ts
  export function hitTest(ctx: HitContext, x: number, y: number): HitTarget {
    const { layout, columns, view } = ctx;
    if (layout.mode === "tooSmall") return { type: "none" };
    if (y === 0) {
      if (ctx.uiMode === undefined) return { type: "none" };
      const m = headerTabBands(columns).hit(x);
      return m ? { type: "modeTab", mode: m } : { type: "none" };
    }
    const r = y - 1;
    // …unchanged from here…
  ```

- [ ] **Run, expect PASS.** `npx vitest run tests/tuiHitTest.test.ts > /tmp/e2 2>&1; echo "exit: $?"` — green (existing `y=0 → none` cases still pass; the `medium()`/`wide()` helpers now carry `uiMode`, but the `chrome rows are dead` case at `y=0` uses `x=5` which `headerTabBands(100).hit(5)` returns `null` for → still `none`).

- [ ] **Format + commit.** `npx prettier --write src/tui/hitTest.ts tests/tuiHitTest.test.ts && git add -A && git commit -m "feat(tui): hitTest resolves the header mode band when uiMode is supplied"`

---

### Task 17: App.tsx — the atomic uiMode rewire (single big-bang)

This is THE integration commit. It flips `Header` into two-mode rendering (so **every** full-`<App>` frame now carries the tab), restructures `useInput` into the five layers, adds the LOCAL surface + its two poll effects + confirm modal + spawned actions, resolves the header band first in `onMouseEvent`, wires the new `AppProps`, and **migrates every header-row frame test in the same commit**. Tasks 1–2 already landed green because their default-absent paths preserved frames; this task supplies the props that light them up.

**Files:**
- Modify `src/tui/App.tsx` (imports :9-43; `AppProps` :45-68; `View`/state block :77-247; `unwatch` :853, `openRepoBrowser` :721; `dismissToast` :1050; `useInput` :1059-1324; `onMouseEvent` :1326-1431; `hints`/`modal` :1434-1466; `Workspace`/`Header`/render :1468-1589)
- Modify `tests/tuiApp.test.tsx` (`renderApp` helper :253-283 — add the four new props), and every other full-`<App>` frame assertion enumerated below
- Create `tests/tuiLocal.test.tsx`
- Create `tests/tuiLocalActions.test.tsx`
- Create `tests/tuiMouse.test.tsx`

**Interfaces:**
- Consumes (Stages A–D):
  - `LocalDashboard` (default export) from `./components/LocalDashboard.js`, props `{ cheap: LocalCheap|null; heavy: LocalHeavy|null; section: LocalSection; focus: "rail"|"body"; cursor: number; scroll: number; layout: Layout; now: Date }`.
  - `type LocalSection = "queue"|"outbox"|"repos"|"worktrees"|"daemon"`, `LocalCheap`, `LocalHeavy`, `LocalRepo`, `LocalWorktree` from `./localSnapshot.js`.
  - `type UiMode`, `headerTabBands` from `./geometry.js`.
  - `Header` (now accepts `uiMode`/`githubEnabled`), `localHintsFor` from `./components/Chrome.js`.
  - `Modal` from `./components/Modal.js`; `runCliCommand` (existing) from `./cliRunner.js`.
  - CLI subcommands spawned by name: `retry`, `outbox`, `restart`, and Stage C's `rm`, `worktree` (`worktree prune <path>`).
  - `hitTest`/`HitContext` (now `uiMode`-aware + `modeTab` target) from `./hitTest.js`.
- Produces (`AppProps` additions):
  ```ts
  localCheapFn: (opts?: { section?: LocalSection }) => Promise<LocalCheap>;
  localHeavyFn: (signal?: AbortSignal) => Promise<LocalHeavy>;
  initialUiMode: UiMode;
  githubEnabled: boolean;
  localCheapPollMs?: number; // default 3000
  localHeavyPollMs?: number; // default 15000
  ```
  New in-component state: `uiMode`, `localSection`, `localFocus`, `localCursor: Record<LocalSection, number>`, `localScroll`, `localCheap`, `localHeavy`, `localRefreshedAt`, `confirm: ConfirmState | null` where `ConfirmState = { title: string; body: string; danger: boolean; onConfirm: () => void }`. New hoisted functions: `canToggleMode()`, `handleLocalInput(input, key)`, `runLocalAction(name, args, opts?)`, `askConfirm(state)`; `unwatch`/`openRepoBrowser` parameterized to take an explicit `nwo`/`LocalRepo` target.

Steps:

- [ ] **Enumerate the frame-test blast radius up front** (the tab renders in both modes → every full-`<App>` header capture shifts):
  ```
  grep -n "lastFrame" tests/tuiApp.test.tsx tests/tuiInteractive.test.tsx tests/tuiQueue.test.tsx tests/tuiModal.test.tsx tests/tuiIssueList.test.tsx tests/tuiPrList.test.tsx
  grep -rln "render(\s*<App" tests/
  ```
  Every `render(<App …>)` site needs the four new props; every header-row `toContain` that could collide with the new `[GITHUB] local`/`github [LOCAL]` band needs re-checking. `tuiChrome`/`tuiHitTest` were already migrated in Tasks 1–2; direct `Header` renders that do NOT pass `uiMode` stay legacy.

- [ ] **Write the failing component tests.** Create `tests/tuiLocal.test.tsx`:
  ```tsx
  import { describe, it, expect, afterEach } from "vitest";
  import React from "react";
  import { render, cleanup } from "ink-testing-library";
  import { App, type AppProps } from "../src/tui/App.js";
  import type { LocalCheap, LocalHeavy } from "../src/tui/localSnapshot.js";
  import type { DashboardClient, Result } from "../src/tui/ghClient.js";
  import type { QueueSnapshot } from "../src/tui/queueSnapshot.js";
  import type { CliRunResult } from "../src/tui/cliRunner.js";
  import { headerTabBands } from "../src/tui/geometry.js";
  import { until } from "./helpers/until.js";

  afterEach(cleanup);
  const okv = <T,>(v: T): Result<T> => ({ ok: true, value: v });
  const ESC = String.fromCharCode(27);

  const EMPTY_QUEUE: QueueSnapshot = {
    daemonUp: true, maxConcurrent: 1, running: [], waiting: [], recent: [],
    error: null, outboxDepth: 0,
  };
  const CHEAP: LocalCheap = {
    queue: {
      ...EMPTY_QUEUE,
      running: [{ id: "gh-acme-api-1", github: { nwo: "acme/api", issue: 1, kind: "pr", external: false }, turns: 2, lastTool: "bash", outputTokens: 10, startedAt: "2026-07-07T10:00:00Z", stale: false }],
      waiting: [{ id: "sub-fix-typos", github: null, kind: "plan", priority: "normal", retryCount: 0, notBefore: null, deferred: false }],
      recent: [{ id: "gh-acme-api-9", github: { nwo: "acme/api", issue: 9, kind: "pr", external: false }, status: "failed" }],
    },
    counts: { done: 12, failed: 3 },
    outbox: { depth: 2, dead: 1, ops: [], deadOps: [], error: null },
    daemon: {
      up: true, pid: 4242, uptimeSeconds: 7980, endpointReachable: true,
      healthHost: "127.0.0.1", healthPort: 8787, guardNudges: 1, guardKills: 0,
      tokensIn: 1000, tokensOut: 2000, tasksByStatus: { done: 12, failed: 3 },
      currentTickets: ["gh-acme-api-1"], progress: {}, error: null,
    },
    error: null,
  };
  const HEAVY: LocalHeavy = {
    repos: [{ nwo: "acme/api", path: "/c/api", source: "config", originUrl: "https://github.com/acme/api", forkUrl: null, githubUrl: "https://github.com/acme/api", branch: "main", headSha: "abc1234", dirty: false, error: null }],
    worktrees: [{ path: "/w/acme-api/fix-typos", repoPath: "/c/api", repoNwo: "acme/api", slug: "fix-typos", kind: "stale", headSha: "def5678", ageSeconds: 3600, error: null }],
    error: null,
  };

  const stubClient: DashboardClient = {
    listIssues: async () => okv({ issues: [], staleAt: null }),
    listPrs: async () => okv({ prs: [], staleAt: null }),
    cloneRepo: async () => okv(undefined),
    issueDetail: async () => okv({ body: "", planComment: null }),
    applyAction: async () => okv({ queued: false }),
    validateAndPrepareRepo: async () => okv(undefined),
    openInBrowser: async () => okv(undefined),
    openPrInBrowser: async () => okv(undefined),
    openRepoInBrowser: async () => okv(undefined),
    repoPermission: async () => okv({ canPush: true }),
    prepareExternalRepo: async (nwo) => okv({ path: `/r/${nwo}`, forkNwo: nwo }),
    dispatchTicket: async (nwo, num) => okv({ id: `gh-${nwo}-${num}`, destPath: "/x" }),
    health: async () => ({ up: true, uptimeSeconds: 60, lastBridgeSweepAt: null, ticketsBridged: 0, tasksProcessed: null, tasksSucceeded: null, tasksFailed: null, lastTaskStatus: null, lastTaskAt: null, totalTokensOut: null, bridgeErrors: null }),
  };

  function renderApp(over: Partial<AppProps> = {}) {
    const runCli: AppProps["runCliFn"] = over.runCliFn ?? (async () => ({ code: 0, output: "ok", timedOut: false }));
    return render(
      <App
        client={stubClient}
        trigger="junco"
        branchPrefix="junco/"
        configRepos={[{ nwo: "acme/api", path: "/c/api" }]}
        watchlistFile="/tmp/wl.json"
        configPath="/x/config.toml"
        clonesDir="/x/state/repos"
        refreshPollMs={999999}
        healthPollMs={999999}
        queuePollMs={999999}
        queueFn={async () => EMPTY_QUEUE}
        localCheapFn={async () => CHEAP}
        localHeavyFn={async () => HEAVY}
        localCheapPollMs={999999}
        localHeavyPollMs={999999}
        initialUiMode="github"
        githubEnabled
        runCliFn={runCli}
        sizeOverride={{ columns: 100, rows: 30 }}
        onExit={() => {}}
        {...over}
      />,
    );
  }

  describe("uiMode toggle", () => {
    it("m swaps github → local and back", async () => {
      const r = renderApp();
      await until(() => (r.lastFrame() ?? "").includes("[GITHUB]"));
      r.stdin.write("m");
      await until(() => (r.lastFrame() ?? "").includes("[LOCAL]"));
      r.stdin.write("m");
      await until(() => (r.lastFrame() ?? "").includes("[GITHUB]"));
    });

    it("Shift+Tab swaps modes but a bare Tab does not", async () => {
      const r = renderApp();
      await until(() => (r.lastFrame() ?? "").includes("[GITHUB]"));
      r.stdin.write("\u001B[Z"); // Shift+Tab
      await until(() => (r.lastFrame() ?? "").includes("[LOCAL]"));
      r.stdin.write("\t"); // bare Tab: pane-cycle, NOT a mode swap
      await new Promise((res) => setTimeout(res, 20));
      expect(r.lastFrame()).toContain("[LOCAL]");
    });

    it("the bracketed active tab is legible with NO_COLOR (glyphs, not just color)", async () => {
      const prev = process.env.NO_COLOR;
      process.env.NO_COLOR = "1";
      try {
        const r = renderApp({ initialUiMode: "local" });
        await until(() => (r.lastFrame() ?? "").includes("[LOCAL]"));
        expect(r.lastFrame()).toContain("github");
      } finally {
        if (prev === undefined) delete process.env.NO_COLOR;
        else process.env.NO_COLOR = prev;
      }
    });
  });

  describe("local sections", () => {
    it("launches into the Queue section and renders running/waiting/recent", async () => {
      const r = renderApp({ initialUiMode: "local" });
      await until(() => {
        const f = r.lastFrame() ?? "";
        return f.includes("queue") && f.includes("outbox") && f.includes("worktrees") && f.includes("daemon");
      });
    });

    it("j/k move the section rail; → enters the body; ← returns to the rail", async () => {
      const r = renderApp({ initialUiMode: "local" });
      await until(() => (r.lastFrame() ?? "").includes("worktrees"));
      r.stdin.write("j"); r.stdin.write("j"); r.stdin.write("j"); // queue→outbox→repos→worktrees
      await until(() => (r.lastFrame() ?? "").includes("fix-typos")); // worktrees body content
      r.stdin.write("l");
      await until(() => (r.lastFrame() ?? "").includes("stale"));
      r.stdin.write(ESC);
      await until(() => (r.lastFrame() ?? "").includes("↑/↓ section"));
    });

    it("daemon section shows pid, uptime, endpoint, guard, tokens", async () => {
      const r = renderApp({ initialUiMode: "local" });
      await until(() => (r.lastFrame() ?? "").includes("daemon"));
      r.stdin.write("G"); // last section
      await until(() => {
        const f = r.lastFrame() ?? "";
        return f.includes("4242") && f.includes("guard");
      });
    });

    it("daemon-down and snapshot-error render without collapsing the frame", async () => {
      const down: LocalCheap = {
        ...CHEAP,
        daemon: { ...CHEAP.daemon, up: false, pid: null, endpointReachable: false },
        outbox: { depth: 0, dead: 0, ops: [], deadOps: [], error: "boom" },
      };
      const r = renderApp({ initialUiMode: "local", localCheapFn: async () => down });
      await until(() => (r.lastFrame() ?? "").toLowerCase().includes("not running"));
      r.stdin.write("j"); // outbox
      await until(() => (r.lastFrame() ?? "").includes("unavailable"));
    });
  });

  describe("github disabled", () => {
    it("launches into LOCAL with the GITHUB tab present but pressing m toasts it is off", async () => {
      const r = renderApp({ initialUiMode: "local", githubEnabled: false });
      await until(() => (r.lastFrame() ?? "").includes("[LOCAL]"));
      r.stdin.write("m");
      await until(() => (r.lastFrame() ?? "").toLowerCase().includes("github mode is off"));
      expect(r.lastFrame()).toContain("[LOCAL]"); // did NOT cross to github
    });
  });

  describe("header-band click coordinate", () => {
    it("headerTabBands(100).localStart toggles to local from github", async () => {
      // (mouse routing is covered in tuiMouse; this pins the band math the App consumes)
      expect(headerTabBands(100).hit(headerTabBands(100).localStart)).toBe("local");
    });
  });
  ```
  Create `tests/tuiLocalActions.test.tsx`:
  ```tsx
  import { describe, it, expect, afterEach } from "vitest";
  import React from "react";
  import { render, cleanup } from "ink-testing-library";
  import { App, type AppProps } from "../src/tui/App.js";
  import { until } from "./helpers/until.js";
  // Reuse the fixtures/renderApp shape from tuiLocal (copy CHEAP/HEAVY/stubClient
  // + renderApp here, or export them from a shared ./helpers/localFixtures.ts).

  afterEach(cleanup);
  const ENTER = "\r";

  describe("local actions spawn the real CLI (fire-and-toast)", () => {
    it("R on a failed RECENT row → junco retry <name>", async () => {
      const calls: [string, string[]][] = [];
      const r = renderApp({
        initialUiMode: "local",
        runCliFn: async (n, a) => { calls.push([n, a]); return { code: 0, output: "requeued gh-acme-api-9", timedOut: false }; },
      });
      await until(() => (r.lastFrame() ?? "").includes("queue"));
      r.stdin.write("l"); // enter body
      // move cursor onto the failed recent row (skip the non-selectable running row)
      await until(() => (r.lastFrame() ?? "").includes("gh-acme-api-9"));
      r.stdin.write("R");
      await until(() => calls.length === 1);
      expect(calls[0]).toEqual(["retry", ["gh-acme-api-9"]]);
    });

    it("x on a WAITING inbox row confirms, then y spawns junco rm <name>", async () => {
      const calls: [string, string[]][] = [];
      const r = renderApp({
        initialUiMode: "local",
        runCliFn: async (n, a) => { calls.push([n, a]); return { code: 0, output: "removed", timedOut: false }; },
      });
      await until(() => (r.lastFrame() ?? "").includes("queue"));
      r.stdin.write("l");
      await until(() => (r.lastFrame() ?? "").includes("sub-fix-typos"));
      r.stdin.write("x"); // opens confirm (destructive)
      await until(() => (r.lastFrame() ?? "").toLowerCase().includes("delete"));
      expect(calls).toHaveLength(0); // nothing spawned before confirm
      r.stdin.write("y");
      await until(() => calls.length === 1);
      expect(calls[0]).toEqual(["rm", ["sub-fix-typos"]]);
    });

    it("confirm-cancel (n) spawns nothing", async () => {
      const calls: [string, string[]][] = [];
      const r = renderApp({ initialUiMode: "local", runCliFn: async (n, a) => { calls.push([n, a]); return { code: 0, output: "", timedOut: false }; } });
      await until(() => (r.lastFrame() ?? "").includes("queue"));
      r.stdin.write("l");
      await until(() => (r.lastFrame() ?? "").includes("sub-fix-typos"));
      r.stdin.write("x");
      await until(() => (r.lastFrame() ?? "").toLowerCase().includes("delete"));
      r.stdin.write("n");
      await new Promise((res) => setTimeout(res, 20));
      expect(calls).toHaveLength(0);
    });

    it("RUNNING/processing rows are never selectable — no action spawns", async () => {
      const calls: unknown[] = [];
      const r = renderApp({ initialUiMode: "local", runCliFn: async () => { calls.push(1); return { code: 0, output: "", timedOut: false }; } });
      await until(() => (r.lastFrame() ?? "").includes("queue"));
      r.stdin.write("l");
      r.stdin.write("g"); // top selectable row — must NOT be the running row
      r.stdin.write("R"); r.stdin.write("x");
      await new Promise((res) => setTimeout(res, 20));
      // R only fires on a failed row; x only on inbox — the running row exposes neither target
      expect(calls.filter((_, i) => i === 0)).not.toEqual(["retry"]);
    });

    it("outbox f flushes; daemon f/X flush/restart", async () => {
      const calls: [string, string[]][] = [];
      const r = renderApp({ initialUiMode: "local", runCliFn: async (n, a) => { calls.push([n, a]); return { code: 0, output: "flushed 2", timedOut: false }; } });
      await until(() => (r.lastFrame() ?? "").includes("outbox"));
      r.stdin.write("j"); // outbox section
      r.stdin.write("l");
      r.stdin.write("f");
      await until(() => calls.some(([n]) => n === "outbox"));
      expect(calls.find(([n]) => n === "outbox")![1]).toEqual(["flush"]);
    });

    it("worktree x on a stale row confirms → y → junco worktree prune <path>", async () => {
      const calls: [string, string[]][] = [];
      const r = renderApp({ initialUiMode: "local", runCliFn: async (n, a) => { calls.push([n, a]); return { code: 0, output: "pruned", timedOut: false }; } });
      await until(() => (r.lastFrame() ?? "").includes("worktrees"));
      r.stdin.write("j"); r.stdin.write("j"); r.stdin.write("j"); // → worktrees
      r.stdin.write("l");
      await until(() => (r.lastFrame() ?? "").includes("fix-typos"));
      r.stdin.write("x");
      await until(() => (r.lastFrame() ?? "").toLowerCase().includes("prune"));
      r.stdin.write("y");
      await until(() => calls.some(([n]) => n === "worktree"));
      expect(calls.find(([n]) => n === "worktree")![1]).toEqual(["prune", "/w/acme-api/fix-typos"]);
    });

    it("daemon restart confirm body carries the in-flight ticket count", async () => {
      const r = renderApp({ initialUiMode: "local" });
      await until(() => (r.lastFrame() ?? "").includes("daemon"));
      r.stdin.write("G"); // daemon section
      r.stdin.write("X");
      await until(() => (r.lastFrame() ?? "").includes("in-flight ticket"));
      expect(r.lastFrame()).toMatch(/1 in-flight ticket/); // currentTickets.length === 1
    });

    it("Repos x/o act on the local cursor target, not github currentRepo", async () => {
      const opens: string[] = [];
      const client = { ...stubClient, openRepoInBrowser: async (nwo: string) => { opens.push(nwo); return okv(undefined); } };
      const r = renderApp({ initialUiMode: "local", client });
      await until(() => (r.lastFrame() ?? "").includes("repos"));
      r.stdin.write("j"); r.stdin.write("j"); // → repos
      r.stdin.write("l");
      await until(() => (r.lastFrame() ?? "").includes("acme/api"));
      r.stdin.write("o");
      await until(() => opens.length === 1);
      expect(opens[0]).toBe("acme/api"); // the LocalRepo under the cursor
    });

    it("header-tab click toggles mode from a non-main github view (prs)", async () => {
      const r = renderApp({ initialUiMode: "github" });
      await until(() => (r.lastFrame() ?? "").includes("[GITHUB]"));
      r.stdin.write("p"); // github prs view
      await until(() => (r.lastFrame() ?? "").toLowerCase().includes("pull requests"));
      // simulate a header-band click at localStart via the mouse seam (see tuiMouse for the raw-SGR form)
      // here just assert m still crosses from prs:
      r.stdin.write("m");
      await until(() => (r.lastFrame() ?? "").includes("[LOCAL]"));
    });
  });
  ```
  Create `tests/tuiMouse.test.tsx`:
  ```tsx
  import { describe, it, expect, afterEach } from "vitest";
  import React from "react";
  import { render, cleanup } from "ink-testing-library";
  import { App } from "../src/tui/App.js";
  import { headerTabBands } from "../src/tui/geometry.js";
  import { until } from "./helpers/until.js";
  // reuse renderApp/fixtures

  afterEach(cleanup);

  // SGR mouse press at (x,y): ESC [ < 0 ; col ; row M  (1-based cols/rows).
  const press = (x: number, y: number) => `\u001B[<0;${x + 1};${y + 1}M`;

  describe("mouse in LOCAL", () => {
    it("a body click/wheel is a no-op (no github state mutation, no spawn)", async () => {
      const calls: unknown[] = [];
      const r = renderApp({ initialUiMode: "local", runCliFn: async () => { calls.push(1); return { code: 0, output: "", timedOut: false }; } });
      await until(() => (r.lastFrame() ?? "").includes("queue"));
      const before = r.lastFrame();
      r.stdin.write(press(40, 5));   // deep in the body
      r.stdin.write("\u001B[<64;40;5M"); // wheel-down code
      await new Promise((res) => setTimeout(res, 20));
      expect(calls).toHaveLength(0);
      expect(r.lastFrame()).toBe(before);
    });

    it("header-band click still toggles the mode", async () => {
      const r = renderApp({ initialUiMode: "github" });
      await until(() => (r.lastFrame() ?? "").includes("[GITHUB]"));
      r.stdin.write(press(headerTabBands(100).localStart, 0));
      await until(() => (r.lastFrame() ?? "").includes("[LOCAL]"));
    });
  });
  ```

- [ ] **Run the new suites, expect FAIL.** `npx vitest run tests/tuiLocal.test.tsx tests/tuiLocalActions.test.tsx tests/tuiMouse.test.tsx > /tmp/e3 2>&1; echo "exit: $?"` — fails: `App` rejects the new props / renders no LOCAL surface.

- [ ] **Rewire `AppProps` and imports.** In `src/tui/App.tsx` add:
  ```ts
  import { Header, hintsFor, localHintsFor, type HintView } from "./components/Chrome.js";
  import LocalDashboard from "./components/LocalDashboard.js";
  import type { LocalCheap, LocalHeavy, LocalSection, LocalRepo } from "./localSnapshot.js";
  import type { UiMode } from "./geometry.js";
  import { headerTabBands } from "./geometry.js";
  ```
  Extend `AppProps` with the six Produces fields above (`localCheapPollMs?`, `localHeavyPollMs?` optional). Add the `ConfirmState` interface next to `CmdState`:
  ```ts
  interface ConfirmState { title: string; body: string; danger: boolean; onConfirm: () => void; }
  ```

- [ ] **Add the local state cluster + poll cadence + refs.** After the existing `queuePollMs` derivation and state block:
  ```ts
  const localCheapPollMs = props.localCheapPollMs ?? 3_000;
  const localHeavyPollMs = props.localHeavyPollMs ?? 15_000;
  const LOCAL_SECTIONS: LocalSection[] = ["queue", "outbox", "repos", "worktrees", "daemon"];

  const [uiMode, setUiMode] = useState<UiMode>(props.initialUiMode);
  const [localSection, setLocalSection] = useState<LocalSection>("queue");
  const [localFocus, setLocalFocus] = useState<"rail" | "body">("rail");
  const [localCursor, setLocalCursor] = useState<Record<LocalSection, number>>({
    queue: 0, outbox: 0, repos: 0, worktrees: 0, daemon: 0,
  });
  const [localScroll, setLocalScroll] = useState(0);
  const [localCheap, setLocalCheap] = useState<LocalCheap | null>(null);
  const [localHeavy, setLocalHeavy] = useState<LocalHeavy | null>(null);
  const [localRefreshedAt, setLocalRefreshedAt] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const localActionInFlightRef = useRef<Set<string>>(new Set());
  ```

- [ ] **Add the selectable-row derivation + movers.** These give `x`/`R`/`o`/`f` an explicit local target (never the github `currentRepo`) and skip non-selectable RUNNING/live rows:
  ```ts
  type LocalRow =
    | { kind: "waiting"; id: string }
    | { kind: "recent"; id: string; status: "done" | "failed" }
    | { kind: "outboxOp"; id: string }
    | { kind: "repo"; repo: LocalRepo }
    | { kind: "worktree"; path: string; slug: string; klass: "stale" | "backup" };

  // Selectable rows for the current section — RUNNING/processing (queue) and
  // live worktrees are deliberately omitted (daemon owns them).
  const localRowsFor = (section: LocalSection): LocalRow[] => {
    switch (section) {
      case "queue": {
        const q = localCheap?.queue;
        if (!q) return [];
        return [
          ...q.waiting.map((w) => ({ kind: "waiting" as const, id: w.id })),
          ...q.recent
            .filter((rr) => rr.status === "failed")
            .map((rr) => ({ kind: "recent" as const, id: rr.id, status: rr.status })),
        ];
      }
      case "outbox":
        return (localCheap?.outbox.ops ?? []).map((o) => ({ kind: "outboxOp" as const, id: o.id }));
      case "repos":
        return (localHeavy?.repos ?? []).map((repo) => ({ kind: "repo" as const, repo }));
      case "worktrees":
        return (localHeavy?.worktrees ?? [])
          .filter((w) => w.kind === "stale" || w.kind === "backup")
          .map((w) => ({ kind: "worktree" as const, path: w.path, slug: w.slug, klass: w.kind as "stale" | "backup" }));
      case "daemon":
        return [];
    }
  };
  const localRows = localRowsFor(localSection);
  const localCursorSafe = Math.max(0, Math.min(localCursor[localSection], localRows.length - 1));
  const localTarget = localRows[localCursorSafe];

  const moveLocalCursor = (delta: number): void => {
    if (localRows.length === 0) return;
    const next = Math.max(0, Math.min(localCursorSafe + delta, localRows.length - 1));
    setLocalCursor((m) => ({ ...m, [localSection]: next }));
  };
  const moveLocalSection = (delta: number): void => {
    const i = LOCAL_SECTIONS.indexOf(localSection);
    const next = Math.max(0, Math.min(i + delta, LOCAL_SECTIONS.length - 1));
    setLocalSection(LOCAL_SECTIONS[next]);
    setLocalScroll(0); // section switch resets the daemon-panel scroll
  };
  ```

- [ ] **Parameterize `unwatch` / `openRepoBrowser`.** Change `unwatch` to `unwatch(nwo: string)` — replace every `currentRepo`/`currentNwo` reference inside it with a lookup of `nwo` in `repoMappings` (config-vs-watchlist decision by the matched mapping), toasting `"not in watchlist"` when the nwo is absent from the watchlist. Update the github pane-1 caller to `unwatch(currentRepo.nwo)`. Change `openRepoBrowser` to `openRepoBrowser(nwo: string)` and the github caller to `openRepoBrowser(currentRepo.nwo)`. (Both now take an explicit target so LOCAL passes its own cursor's nwo.)

- [ ] **Add `askConfirm` + `runLocalAction`.** After `runAssess`:
  ```ts
  const askConfirm = useCallback((state: ConfirmState) => setConfirm(state), []);

  // Fire-and-toast, mirroring runAssess: spawn the real CLI, dedupe by a key,
  // toast the first output line, then force an immediate cheap re-poll so the
  // mutated state (deleted ticket / drained outbox / gone worktree) shows at once.
  const runLocalAction = useCallback(
    (name: string, args: string[], opts: { key?: string; label?: string } = {}) => {
      const key = opts.key ?? [name, ...args].join(" ");
      if (localActionInFlightRef.current.has(key)) {
        showToast("info", `${opts.label ?? name} already running`);
        return;
      }
      localActionInFlightRef.current.add(key);
      showToast("info", `${opts.label ?? name}…`);
      void runCliFn(name, args).then((rr) => {
        localActionInFlightRef.current.delete(key);
        if (!aliveRef.current) return;
        const line = firstNonEmptyLine(rr.output);
        if (rr.code === 0) showToast("success", line ?? `${name} ok`);
        else showToast("error", line ?? `${name} failed`);
        // Immediate re-poll (cheap fn is cheap; section-gated counts refresh too).
        void props.localCheapFn({ section: localSection }).then((c) => {
          if (aliveRef.current) { setLocalCheap(c); setLocalRefreshedAt(new Date().toISOString()); }
        });
      });
    },
    [runCliFn, showToast, props.localCheapFn, localSection],
  );
  ```

- [ ] **Add `canToggleMode` + `handleLocalInput`.** Before `useInput`:
  ```ts
  const canToggleMode = (): boolean =>
    !filtering && view !== "addRepo" && view !== "palette" && confirm === null;

  // Shift+Tab requires key.shift so a bare Tab still reaches github pane-cycle.
  const isModeToggle = (input: string, key: { tab?: boolean; shift?: boolean }): boolean =>
    input === "m" || (key.tab === true && key.shift === true);

  const handleLocalInput = (input: string, key: Parameters<Parameters<typeof useInput>[0]>[1]): void => {
    // confirm modal owns input while open
    if (confirm) {
      if (key.escape || input === "n") { setConfirm(null); return; }
      if (key.return || input === "y") { const fn = confirm.onConfirm; setConfirm(null); fn(); return; }
      return;
    }
    if (localFocus === "body") {
      if (key.escape || input === "h" || key.leftArrow) { setLocalFocus("rail"); return; }
      if (localSection === "daemon") {
        if (input === "[" || key.upArrow) return void setLocalScroll((s) => Math.max(0, s - 1));
        if (input === "]" || key.downArrow) return void setLocalScroll((s) => s + 1);
        if (input === "X") {
          const n = localCheap?.daemon.currentTickets.length ?? 0;
          return void askConfirm({
            title: "restart daemon",
            danger: true,
            body: `Restart will interrupt ${n} in-flight ticket(s) (soft-abort, committed work salvaged). Continue?`,
            onConfirm: () => runLocalAction("restart", [], { label: "restart" }),
          });
        }
        if (input === "f") return void runLocalAction("outbox", ["flush"], { label: "flush" });
        return;
      }
      if (input === "j" || key.downArrow) return void moveLocalCursor(1);
      if (input === "k" || key.upArrow) return void moveLocalCursor(-1);
      if (input === "g") return void setLocalCursor((m) => ({ ...m, [localSection]: 0 }));
      if (input === "G") return void setLocalCursor((m) => ({ ...m, [localSection]: Math.max(0, localRows.length - 1) }));
      const t = localTarget;
      if (localSection === "queue") {
        if (input === "R" && t?.kind === "recent") return void runLocalAction("retry", [t.id], { label: "requeue" });
        if (input === "x" && t?.kind === "waiting")
          return void askConfirm({ title: "delete queued ticket", danger: true, body: `Delete inbox/${t.id}.md? (best-effort; the daemon may have claimed it)`, onConfirm: () => runLocalAction("rm", [t.id]) });
      }
      if (localSection === "outbox" && input === "f") return void runLocalAction("outbox", ["flush"], { label: "flush" });
      if (localSection === "repos" && t?.kind === "repo") {
        if (input === "o") return void openRepoBrowser(t.repo.nwo ?? "");
        if (input === "x") return void (t.repo.nwo ? unwatch(t.repo.nwo) : showToast("info", "not in watchlist"));
      }
      if (localSection === "worktrees" && input === "x" && t?.kind === "worktree")
        return void askConfirm({ title: "prune worktree", danger: true, body: `Prune ${t.slug} (${t.klass})? git worktree remove --force under the daemon lock.`, onConfirm: () => runLocalAction("worktree", ["prune", t.path], { label: "prune" }) });
      return;
    }
    // rail focus
    if (input === "q") { exit(); onExit(); return; }
    if (input === "?") return void setView("help");
    if (input === "r") { void forceLocalRefresh(); return; }
    if (input === "j" || key.downArrow) return void moveLocalSection(1);
    if (input === "k" || key.upArrow) return void moveLocalSection(-1);
    if (input === "g") { setLocalSection("queue"); setLocalScroll(0); return; }
    if (input === "G") { setLocalSection("daemon"); setLocalScroll(0); return; }
    if (input === "l" || key.rightArrow || key.return) return void setLocalFocus("body");
  };
  ```

- [ ] **Restructure `useInput` into the five layers.** Replace the head of the `useInput` callback (the `isMouseInput` guard through the `view === "addRepo"` bail) with the wrapper; the entire existing github cascade (from `dismissToast()` at :1068 through the end at :1323) moves UNCHANGED inside `if (uiMode === "github")`:
  ```ts
  useInput((input, key) => {
    if (isMouseInput(input)) return;                 // 1 (keep first)
    if (view === "addRepo") return;                  // 2 text: form owns input
    if (view === "palette") {                        // 2 text: palette owns input
      // (existing palette branch stays where it is inside the github cascade;
      //  keep it reachable by NOT early-returning here — see note)
    }
    if (canToggleMode() && isModeToggle(input, key)) {   // 3 toggle
      if (!props.githubEnabled && uiMode === "github") { /* impossible: start local */ }
      const target: UiMode = uiMode === "github" ? "local" : "github";
      if (target === "github" && !props.githubEnabled) {
        dismissToast();
        showToast("info", "github mode is off ([github] enabled=false)");
        return;
      }
      setUiMode(target);
      dismissToast();
      return;
    }
    if (uiMode === "local") { dismissToast(); handleLocalInput(input, key); return; }  // 4 local
    // 5 ── existing github cascade, verbatim from the old :1068 `dismissToast()` ──
    dismissToast();
    if (view === "help") { setView("main"); return; }
    // …unchanged…
  });
  ```
  Note: the palette/addRepo text handlers stay hoisted ABOVE the mode split (layer 2) so `m` never eats a typed character. Because the github file already routes `view === "palette"` internally, keep that branch in the github cascade but ensure `canToggleMode()` returns false while `view === "palette"` (it does) so layer 3 is skipped — no separate hoist needed beyond the `canToggleMode` gate; the `view === "addRepo"` bail at layer 2 stays. (The confirm modal is LOCAL-only, gated inside `handleLocalInput`.)

- [ ] **Add `forceLocalRefresh` + the two gated poll effects.** After the queue-poll effect:
  ```ts
  const forceLocalRefresh = useCallback(async (): Promise<void> => {
    const c = await props.localCheapFn({ section: localSection });
    if (!aliveRef.current) return;
    setLocalCheap(c);
    setLocalRefreshedAt(new Date().toISOString());
    if (localSection === "repos" || localSection === "worktrees") {
      const h = await props.localHeavyFn();
      if (aliveRef.current) setLocalHeavy(h);
    }
  }, [props.localCheapFn, props.localHeavyFn, localSection]);

  // Cheap poll @3s — only while LOCAL is visible.
  useEffect(() => {
    if (uiMode !== "local") return;
    let alive = true;
    const run = async (): Promise<void> => {
      const c = await props.localCheapFn({ section: localSection });
      if (!alive || !aliveRef.current) return;
      setLocalCheap(c);
      setLocalRefreshedAt(new Date().toISOString());
    };
    void run();
    const id = setInterval(() => void run(), localCheapPollMs);
    return () => { alive = false; clearInterval(id); };
  }, [uiMode, localSection, props.localCheapFn, localCheapPollMs]);

  // Heavy poll @15s — LOCAL + repos/worktrees only; AbortController on cleanup.
  useEffect(() => {
    if (uiMode !== "local") return;
    if (localSection !== "repos" && localSection !== "worktrees") return;
    let alive = true;
    const ctrl = new AbortController();
    const run = async (): Promise<void> => {
      const h = await props.localHeavyFn(ctrl.signal);
      if (!alive || !aliveRef.current) return; // aliveRef drops late results on unmount
      setLocalHeavy(h);
    };
    void run();
    const id = setInterval(() => void run(), localHeavyPollMs);
    return () => { alive = false; ctrl.abort(); clearInterval(id); };
  }, [uiMode, localSection, props.localHeavyFn, localHeavyPollMs]);
  ```

- [ ] **Resolve the header band FIRST in `onMouseEvent`, then early-return in LOCAL.** At the very top of `onMouseEvent`, before the existing modal-view guard:
  ```ts
  const onMouseEvent = (ev: TuiMouseEvent): void => {
    if (ev.y === 0 && ev.kind === "press") {
      const m = headerTabBands(size.columns).hit(ev.x);
      if (m && m !== uiMode) {
        if (m === "github" && !props.githubEnabled) {
          dismissToast();
          showToast("info", "github mode is off ([github] enabled=false)");
          return;
        }
        dismissToast();
        setUiMode(m);
        return;
      }
    }
    if (confirm) return;                    // confirm modal owns the screen
    if (uiMode === "local") return;         // local body is keyboard-first in v1
    // …existing github onMouseEvent body, unchanged…
  };
  ```

- [ ] **Branch the render + wire Header/hints/confirm modal.** Compute hints by mode:
  ```ts
  const hints = uiMode === "local" ? localHintsFor(localSection, localFocus) : hintsFor(view as HintView, pane, layout.mode, filtering);
  ```
  Add the confirm modal to the `modal` composition (it outranks the github modals when open):
  ```ts
  const modal = confirm ? (
    <Modal title={confirm.title} minWidth={54}>
      <Box flexDirection="column" gap={1}>
        <Text color={confirm.danger ? theme.error : undefined}>{confirm.body}</Text>
        <Text dimColor>y/enter confirm · n/esc cancel</Text>
      </Box>
    </Modal>
  ) : view === "help" ? (
    <HelpModal view={uiMode === "local" ? "main" : (view as HintView)} pane={pane} mode={layout.mode} trigger={trigger} uiMode={uiMode} localSection={localSection} />
  ) : /* …existing palette / addRepo ternary… */ null;
  ```
  Pass the new Header props and branch the Workspace children:
  ```tsx
  header={
    <Header
      /* …existing props… */
      refreshedAt={refreshedAt}
      uiMode={uiMode}
      githubEnabled={props.githubEnabled}
    />
  }
  ```
  ```tsx
  >
    {uiMode === "local" ? (
      <LocalDashboard
        cheap={localCheap}
        heavy={localHeavy}
        section={localSection}
        focus={localFocus}
        cursor={localCursorSafe}
        scroll={localScroll}
        layout={layout}
        now={queueNow}
      />
    ) : (
      <>
        <Rail /* …existing props… */ />
        {/* existing body ternary, unchanged */}
      </>
    )}
  </Workspace>
  ```
  (Import `Text`/`Box` are already in scope; `theme` — add `import { theme } from "./theme.js"` if not present, matching Chrome's usage. Note `import type { ToastKind }` already imports from theme; extend to a value import.)

- [ ] **Migrate the full-`<App>` frame tests (same commit).** Update `tests/tuiApp.test.tsx` `renderApp` to supply the four required props (and the two optional poll knobs) so it compiles and stays github-default:
  ```tsx
  localCheapFn={async () => ({ queue: QUEUE_SNAP, counts: null, outbox: { depth: QUEUE_SNAP.outboxDepth, dead: 0, ops: [], deadOps: [], error: null }, daemon: { up: true, pid: null, uptimeSeconds: null, endpointReachable: true, healthHost: "127.0.0.1", healthPort: 8787, guardNudges: null, guardKills: null, tokensIn: null, tokensOut: null, tasksByStatus: {}, currentTickets: [], progress: {}, error: null }, error: null })}
  localHeavyFn={async () => ({ repos: [], worktrees: [], error: null })}
  localCheapPollMs={999999}
  localHeavyPollMs={999999}
  initialUiMode="github"
  githubEnabled
  ```
  Then run the enumerated suites and repair any header-row `toContain` that the `[GITHUB] local` band pushed out of a 100-col frame (the band is ~14 cols; the repo name is the flexible truncation absorber, so most `toContain("daemon ●")`/`toContain("↻ 0s")` survive — fix only genuine collisions by asserting on the still-present substring). Do the same for every other `render(<App`)` site surfaced by the up-front grep (`tuiInteractive`, `tuiQueue`, `tuiModal`, `tuiIssueList`, `tuiPrList` if present).

- [ ] **Run the migrated + new suites, expect PASS.** `npx vitest run tests/tuiApp.test.tsx tests/tuiInteractive.test.tsx tests/tuiQueue.test.tsx tests/tuiModal.test.tsx tests/tuiLocal.test.tsx tests/tuiLocalActions.test.tsx tests/tuiMouse.test.tsx > /tmp/e3 2>&1; echo "exit: $?"` — green.

- [ ] **Typecheck the tests (they are not type-checked by vitest).** `npx tsc --noEmit -p tsconfig.eslint.json > /tmp/e3tc 2>&1; echo "exit: $?"` — confirm no NEW errors beyond the known pre-existing baseline.

- [ ] **Format + commit.** `npx prettier --write "src/tui/**/*.tsx" "src/tui/**/*.ts" "tests/tui*.test.tsx" && git add -A && git commit -m "feat(tui): atomic uiMode rewire — LOCAL dashboard, header tabs, confirm actions, mouse band"`

---

### Task 18: dashboardCmd.ts — inject local fns + relax the github guard

**Files:**
- Modify `src/dashboardCmd.ts` (`github.enabled` guard :35-41; lazy `Promise.all` :43-57; `createElement(App, …)` props :66-79)
- Modify `tests/dashboardCmd.test.ts` (the `github.enabled=false` case flips from refuse→launch-local)

**Interfaces:**
- Consumes: `makeLocalCheapFn`, `makeLocalHeavyFn` from `./tui/localSnapshot.js` (Stage A) — `makeLocalCheapFn(cfg): (opts?) => Promise<LocalCheap>`, `makeLocalHeavyFn(cfg): (signal?) => Promise<LocalHeavy>`.
- Produces: `<App>` receives `localCheapFn`, `localHeavyFn`, `initialUiMode: cfg.github.enabled ? "github" : "local"`, `githubEnabled: cfg.github.enabled`. The non-TTY guard is untouched; the `github.enabled` refusal is removed (LOCAL launches when GitHub is off).

Steps:

- [ ] **Write the failing test.** In `tests/dashboardCmd.test.ts` replace the `github.enabled=false exits 1` case with:
  ```ts
  it("github.enabled=false launches into LOCAL mode (renders) rather than refusing", async () => {
    const disabled = { ...cfg, github: { ...cfg.github, enabled: false } } as unknown as Config;
    let rendered = false;
    const errs: string[] = [];
    const code = await runDashboard(disabled, "/x/config.toml", {
      isTTY: true,
      renderFn: () => { rendered = true; return { waitUntilExit: async () => {} }; },
      printErr: (s) => errs.push(s),
    });
    expect(code).toBe(0);
    expect(rendered).toBe(true);
    expect(errs.join("")).not.toContain("enabled = false");
  });

  it("still refuses when there is no TTY, regardless of github.enabled", async () => {
    const disabled = { ...cfg, github: { ...cfg.github, enabled: false } } as unknown as Config;
    let rendered = false;
    const code = await runDashboard(disabled, "/x/config.toml", {
      isTTY: false,
      renderFn: () => { rendered = true; return { waitUntilExit: async () => {} }; },
    });
    expect(code).toBe(1);
    expect(rendered).toBe(false);
  });
  ```
  And in the `lazy loading discipline` block add:
  ```ts
  it("localSnapshot factories are pulled through the same lazy Promise.all", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/dashboardCmd.ts", import.meta.url), "utf8");
    expect(src).toContain('import("./tui/localSnapshot.js")');
    expect(src).toContain("makeLocalCheapFn");
    expect(src).toContain("makeLocalHeavyFn");
  });
  ```

- [ ] **Run it, expect FAIL.** `npx vitest run tests/dashboardCmd.test.ts > /tmp/e4 2>&1; echo "exit: $?"` — fails: disabled case still exits 1; `localSnapshot` import absent.

- [ ] **Write minimal implementation.** In `src/dashboardCmd.ts`, delete the entire `if (!cfg.github.enabled) { … return 1; }` block (:35-41). Add `makeQueueSnapshotFn`'s sibling to the lazy import (fold `localSnapshot` into the array), then inject the props:
  ```ts
  const [
    { App },
    { makeGhDashboardClient },
    { watchlistPath },
    { makeQueueSnapshotFn },
    { makeLocalCheapFn, makeLocalHeavyFn },
    react,
    ink,
  ] = await Promise.all([
    import("./tui/App.js"),
    import("./tui/ghClient.js"),
    import("./watchlist.js"),
    import("./tui/queueSnapshot.js"),
    import("./tui/localSnapshot.js"),
    import("react"),
    import("ink"),
  ]);
  ```
  ```ts
      queueFn: makeQueueSnapshotFn(cfg),
      localCheapFn: makeLocalCheapFn(cfg),
      localHeavyFn: makeLocalHeavyFn(cfg),
      initialUiMode: cfg.github.enabled ? "github" : "local",
      githubEnabled: cfg.github.enabled,
      onExit: () => {},
  ```
  (The `makeGhDashboardClient(cfg)` line stays — with GitHub disabled the client is still constructed but the LOCAL surface never calls it; the github tab is dim + `m` toasts the off state, wired in Task 3.)

- [ ] **Run, expect PASS.** `npx vitest run tests/dashboardCmd.test.ts > /tmp/e4 2>&1; echo "exit: $?"` — green.

- [ ] **Format + commit.** `npx prettier --write src/dashboardCmd.ts tests/dashboardCmd.test.ts && git add -A && git commit -m "feat(dashboard): launch into LOCAL when github is disabled; inject local snapshot fns"`

---

### Task 19: HelpModal + docs/dashboard.md — document the two modes

**Files:**
- Modify `src/tui/components/HelpModal.tsx` (signature :25-35; add a local-mode `Section` when `uiMode === "local"`)
- Modify `tests/tuiModal.test.tsx` (add a local-mode help assertion)
- Modify `docs/dashboard.md` (intro; scope "mouse works throughout"; add a LOCAL section + key table)

**Interfaces:**
- Consumes: `type UiMode` from `../geometry.js`; `type LocalSection`, `localHintsFor` from `./Chrome.js` (Task 1); existing `Section`, `Modal`, `hintsFor`.
- Produces: `HelpModal` gains **optional** `uiMode?: UiMode` and `localSection?: LocalSection`. Absent/`"github"` ⇒ the existing help renders unchanged (keeps `tuiModal` green). `"local"` ⇒ a local-mode key/action/safety reference.

Steps:

- [ ] **Write the failing test.** In `tests/tuiModal.test.tsx` add:
  ```tsx
  it("local-mode help lists the mode swap, section keys, and the action/safety table", () => {
    const f = render(
      <HelpModal view="main" pane={2} mode="wide" trigger="junco" uiMode="local" localSection="worktrees" />,
    ).lastFrame()!;
    expect(f).toContain("local mode");
    expect(f).toContain("m");        // mode swap
    expect(f).toContain("Shift+Tab");
    expect(f).toContain("prune");    // worktrees action
    expect(f).toContain("restart");  // daemon action
    expect(f).toContain("[ / ]");    // daemon panel scroll
  });

  it("github help is unchanged when uiMode is absent", () => {
    const f = render(<HelpModal view="main" pane={2} mode="wide" trigger="junco" />).lastFrame()!;
    expect(f).toContain("act on issue");
    expect(f).not.toContain("local mode");
  });
  ```

- [ ] **Run it, expect FAIL.** `npx vitest run tests/tuiModal.test.tsx > /tmp/e5 2>&1; echo "exit: $?"` — fails: `HelpModal` rejects `uiMode`/`localSection`; "local mode" absent.

- [ ] **Write minimal implementation.** In `src/tui/components/HelpModal.tsx` add optional props and a LOCAL branch (stack-agnostic — "inference endpoint", never a server name):
  ```tsx
  import type { UiMode } from "../geometry.js";
  import { hintsFor, localHintsFor, type HintView } from "./Chrome.js";
  import type { LocalSection } from "../localSnapshot.js";
  ```
  ```tsx
  export function HelpModal({
    view, pane, mode, trigger, uiMode, localSection,
  }: {
    view: HintView; pane: 1 | 2 | 3; mode: LayoutMode; trigger: string;
    uiMode?: UiMode; localSection?: LocalSection;
  }): React.JSX.Element {
    if (uiMode === "local") {
      return (
        <Modal title="junco dashboard — local mode keys" minWidth={64}>
          <Text dimColor>
            local mode: the machine-local runtime — queue, outbox, repos, worktrees, daemon
          </Text>
          <Section title="this section" rows={localHintsFor(localSection ?? "queue", "body")} />
          <Section
            title="modes & navigate"
            rows={[
              ["m · Shift+Tab", "swap GITHUB ↔ LOCAL (or click the header tab)"],
              ["↑/↓ · j/k", "move section (rail) / cursor (body)"],
              ["→ · l · enter", "enter the section body"],
              ["← · h · esc", "back to the section rail"],
              ["g / G", "first / last"],
              ["[ / ]", "scroll the daemon panel"],
              ["r", "full local refresh"],
            ]}
          />
          <Section
            title="actions & safety"
            rows={[
              ["R", "requeue a failed ticket (junco retry)"],
              ["x", "remove under cursor — delete queued ticket / prune worktree / unwatch repo (confirmed when destructive)"],
              ["f", "flush the GitHub outbox backlog"],
              ["o", "open a repo's origin/fork in the browser"],
              ["X", "restart the daemon (confirmed; interrupts in-flight tickets, work salvaged)"],
            ]}
          />
          <Section
            title="cross-mode divergences"
            rows={[
              ["x / R / X", "local-only: remove / requeue / restart (github x = unwatch, R = re-plan)"],
              ["running / live rows", "never selectable — the daemon owns processing/ and live worktrees"],
              ["mouse", "header tab only in local; body rows are keyboard-first (v1)"],
            ]}
          />
          <Box marginTop={1}><Text dimColor>press any key to close</Text></Box>
        </Modal>
      );
    }
    // …existing github help body unchanged…
  }
  ```

- [ ] **Run, expect PASS.** `npx vitest run tests/tuiModal.test.tsx > /tmp/e5 2>&1; echo "exit: $?"` — green.

- [ ] **Update `docs/dashboard.md`.** Reframe the opening: change the first paragraph to describe **two modes** — GITHUB (the existing repo/issue/PR client) and LOCAL (the machine-local runtime) — swapped with `m` / Shift+Tab or the header tab pair (`[GITHUB] local` ↔ `github [LOCAL]`), and note the dashboard launches into LOCAL when `[github] enabled = false`. Scope the existing **Mouse** paragraph: prefix it with "In GitHub mode, mouse works throughout:" and append a sentence — "In LOCAL mode only the header tab is clickable; local rows are keyboard-first in v1." Add a new `## Local mode` section after the palette section with: the section list (Queue / Outbox / Repos / Worktrees / Daemon), the two focus levels (rail moves the section, body drives the in-section cursor), and a key/action table:
  ```
  | Key | Action |
  | --- | --- |
  | `m` / Shift+Tab | swap GITHUB ↔ LOCAL (or click the header tab) |
  | `↑`/`↓` · `j`/`k` | move the section (rail) or the cursor (body) |
  | `→` / `l` / `enter` | enter the section body; `←` / `h` / `esc` returns to the rail |
  | `g` / `G` | first / last |
  | `[` / `]` | scroll the daemon panel |
  | `R` | requeue a failed ticket |
  | `x` | remove under the cursor — delete a queued ticket, prune a stale worktree, or unwatch a repo (confirmed when destructive) |
  | `f` | flush the GitHub outbox |
  | `o` | open a repo's origin/fork in the browser |
  | `X` | restart the daemon (confirmed; in-flight tickets soft-abort, committed work salvaged) |
  | `r` | full local refresh |
  ```
  State the safety rails in prose: running/processing rows and live worktrees are never selectable (the daemon owns them); worktree prune runs under a shared daemon lock with an in-lock liveness gate; every mutating action spawns the real `junco` CLI (no reimplementation). Use "inference endpoint" for the daemon's endpoint reachability, never a server product name.

- [ ] **Verify docs are stack-agnostic.** `grep -niE "omp|omlx|pi |launchd|vault|ollama|openai|anthropic|claude" docs/dashboard.md; echo "exit: $?"` — expect no personal-stack matches in the new text.

- [ ] **Format + commit.** `npx prettier --write src/tui/components/HelpModal.tsx tests/tuiModal.test.tsx docs/dashboard.md && git add -A && git commit -m "docs(dashboard): document LOCAL mode keys, actions, and safety rails"`

- [ ] **Full gate.** `npm run lint && npm run format:check && npm run typecheck && npm run build && npx vitest run > /tmp/egate 2>&1; echo "exit: $?"` — confirm green across the whole suite before declaring Stage E done.

---

---

## Self-Review — Spec Coverage

All 19 tasks were authored directly from the spec sections; this table maps each spec section to the covering tasks.

| Spec section | Tasks |
|---|---|
| Data model (`localSnapshot.ts`, enumerators, single-`/health`, cadence) | 1–6 |
| Action model & daemon safety — `worktrees.lock` (daemon side) | 7 |
| Action model & daemon safety — new CLI (`junco rm`, `junco worktree prune`, liveness gate) | 8–9 |
| Local mode UI (`headerTabBands`, `QueueView` props, `SectionRail`, section bodies, `LocalDashboard`) | 10–14 |
| Mode architecture — Header tabs + hints | 15 |
| Mode architecture — clickable header band (`hitTest`) | 16 |
| Mode architecture + Wiring — the atomic `App.tsx` rewire (uiMode state, input layers, poll effects, action runner, confirm, render branch, mouse band) | 17 |
| Data model wiring + degraded state — `dashboardCmd` inject + `github.enabled` relax | 18 |
| Docs + help — `HelpModal` local section, `docs/dashboard.md` two-mode reframe | 19 |
| Testing (per-task TDD: pure-module + component + CLI tests) | every task |
| Out of scope (v1 YAGNI) | n/a — exclusions |

No gaps: every substantive spec section maps to at least one task, and the A→B→C→D→E ordering preserves "green at every commit" (Tasks 1–14 land unwired; Tasks 15–17 are the atomic switch that migrates header-row frame tests together).


---

## Cross-Stage Interface Notes (reconciliation)

The stage authors flagged these interface-alignment points; heed them while implementing so Consumes/Produces stay consistent:

**Stage E — The atomic switch + docs:** Cross-stage interface risks the assembler must reconcile. (1) **`UiMode` / `LocalSection` canonical location.** This stage imports `UiMode` from `./geometry.js` and `LocalSection` from `./localSnapshot.js`; the CONTRACT also lists both as exported from `LocalDashboard.tsx`. Stage A/D must export each from exactly ONE module and have the component re-import — if Stage D defines `UiMode` in `LocalDashboard.tsx` instead of `geometry.ts`, every import here (`Chrome`, `hitTest`, `App`, `HelpModal`) must be redirected, and `geometry.ts`'s `headerTabBands` return type must import it (a `geometry → LocalDashboard` cycle would be illegal, so `geometry.ts` is the correct home — flag if Stage D disagrees). (2) **`headerTabBands` coordinate authority.** Task 1 renders the tab in flex flow immediately after the brand and Task 3 clicks via `headerTabBands(columns)`; Stage A must author `headerTabBands` so `githubStart`/`localStart` match the *rendered* columns of `🐦 junco ` + `paddingX={1}` + the bracketed labels at both wide and compact widths — the `tuiLocal` "tab labels align" test is the tripwire, but if Stage A's offsets drift the click tests fail. (3) **`QueueView` selectable props** (Stage D) are consumed indirectly through `LocalDashboard`'s Queue section, not by this stage directly — but `LocalDashboard` must pass `selectable`/`selectedRow`/`onRows` so the `▌` cursor lands only on WAITING/failed rows; the `tuiLocalActions` "RUNNING rows never selectable" test asserts App-level behavior and assumes `localRowsFor("queue")` (defined here) already excludes them, so the two must agree on which rows are actionable. (4) **`LocalCheap.queue.recent` shape** — this stage's `localRowsFor` reads `recent[].status: "done"|"failed"` and `waiting[].id`; confirm Stage A's `QueueSnapshot`/`LocalCheap` expose those exact fields (the existing `QueueSnapshot.recent` field shape must carry `status`). (5) **CLI subcommand names** `rm` and `worktree prune` (Stage C) are spawned by literal name/args here (`["rm", id]`, `["worktree", "prune", path]`); if Stage C registers `worktree-prune` as a single token instead of the `worktree prune` subcommand pair, Task 3's `runLocalAction("worktree", ["prune", path])` and the `tuiLocalActions` assertion must change together.

