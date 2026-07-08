# GitHub Outbox (Offline Junco) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When GitHub is unreachable, junco parks every GitHub side effect (label ops, issue comments, PR push+create) in a durable outbox, keeps executing pre-synced work, auto-flushes on reconnect, and shows an unpushed indicator in the dashboard.

**Architecture:** One new module `src/githubOutbox.ts` owns the op store (one JSON file per op, FIFO by filename) and the flush executor; the three GitHub-touching layers (reporter, prFlow endgame, dashboard client) route network failures through `tryOrEnqueue`. The daemon flushes at the top of every bridge sweep; `junco outbox` gives manual list/flush; the dashboard header shows `⇡N unpushed` off the existing 2 s queue-snapshot poll.

**Tech Stack:** TypeScript strict/ESM, existing `gh`/`git` wrappers (`GitOpError`, `isNetworkError` in `src/git.ts`), vitest + ink-testing-library. NO new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-07-github-outbox-design.md`

## Global Constraints

- Branch `feat/github-outbox-offline` off `main` (the queue + workspace branches merged first). Conventional commits, suite green at every commit, **no AI attribution** ever.
- **Zero new dependencies, zero new config keys** (the outbox is always on). `src/ticketSchema.ts` untouched. Q&A read-only default untouched. No Pi SDK imports.
- Network-vs-permanent classification is EXACTLY `e instanceof GitOpError && isNetworkError(e.stderr)` — reuse `src/git.ts` exports, never re-implement patterns.
- Flush semantics: FIFO by filename; network error stops the whole flush without incrementing `attempts` on untried ops; non-network error increments `attempts`, and at `attempts >= 3` the op moves to `dead/`. Comment idempotency via trailing `<!-- junco:outbox:<id> -->` marker checked before posting. Composite `pr` ops checkpoint `pushed`/`prUrl` back into the op file after each step.
- Reporter contract stays best-effort for NON-network errors (warn-and-swallow); only network errors enqueue. When `outcome.prQueued`, the reporter skips BOTH its finalize comment and its done/working label flip (the composite op owns both).
- Dashboard: queued actions keep optimistic labels (no rollback); the issues list serves the disk cache when offline with a stale badge; `⇡N unpushed` chip in the warn color, hidden at 0.
- Every side effect behind injectable deps; tests never touch the network (fake gh/git returning network-pattern stderr like `"connect: network is unreachable"`).
- Vitest exit-code trap (capture explicitly); `npx prettier --write` before each commit; Ink tests use bounded until-loops; live runtime files untouched.
- **Config-fixture sweep:** `QueueSnapshot` gains `outboxDepth` in Task 7 — every full-snapshot literal in tests (`tuiApp` QUEUE_SNAP, `tuiQueue` IDLE/BUSY/FULL, `tuiRail` QUEUE fixtures, `queueSnapshot` expectations) must gain the field or fail at runtime.

---

### Task 1: Outbox store — op model, enqueue, list, depth

**Files:**
- Create: `src/githubOutbox.ts`
- Test: `tests/githubOutbox.test.ts`

**Interfaces:**
- Consumes: `Config` (`stateDir`), node fs.
- Produces (all later tasks rely on these exact names):

```ts
export type OutboxOp =
  | { kind: "labels"; nwo: string; issue: number; add: string[]; remove: string[] }
  | { kind: "comment"; nwo: string; issue: number; body: string }
  | { kind: "push"; repoPath: string; branch: string }
  | {
      kind: "pr";
      repoPath: string;
      branch: string;
      nwo: string;
      issue: number | null;
      base: string;
      title: string;
      bodyText: string;
      draft: boolean;
      labels: string[];
      reviewers: string[];
      finalize: { ticketId: string; status: string; finalText: string } | null;
      pushed: boolean;
      prUrl: string | null;
    };

export interface StoredOp {
  id: string;            // filename stem
  path: string;
  createdAt: string;     // ISO
  origin: "dashboard" | "reporter" | "prflow";
  issueKey: string | null; // "<nwo>#<n>"
  attempts: number;
  lastError: string | null;
  op: OutboxOp;
}

export interface OutboxDeps {
  readdirFn?: (d: string) => string[];
  readFileFn?: (p: string) => string;
  writeFileFn?: (p: string, s: string) => void;
  renameFn?: (a: string, b: string) => void;
  mkdirFn?: (d: string) => void;
  rmFn?: (p: string) => void;
  nowFn?: () => Date;
}

export function outboxPaths(cfg: Config): { dir: string; dead: string };
export function enqueueOp(cfg: Config, origin: StoredOp["origin"], op: OutboxOp, deps?: OutboxDeps): string; // returns id
export function listOps(cfg: Config, deps?: OutboxDeps): StoredOp[];   // FIFO, skips unparseable with a warn
export function outboxDepth(cfg: Config, deps?: OutboxDeps): number;   // cheap readdir count
```

- [ ] **Step 1: Write the failing tests** — create `tests/githubOutbox.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { outboxPaths, enqueueOp, listOps, outboxDepth } from "../src/githubOutbox.js";
import type { Config } from "../src/types.js";

function cfgAt(root: string): Config {
  return { stateDir: root } as unknown as Config;
}
const LABELS = { kind: "labels", nwo: "a/b", issue: 7, add: ["junco:approved"], remove: [] } as const;

describe("outbox store", () => {
  it("enqueue writes one atomic JSON file; list round-trips the envelope", () => {
    const root = mkdtempSync(join(tmpdir(), "junco-obx-"));
    const cfg = cfgAt(root);
    const id = enqueueOp(cfg, "dashboard", { ...LABELS });
    const files = readdirSync(outboxPaths(cfg).dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toBe(`${id}.json`);
    const [stored] = listOps(cfg);
    expect(stored.origin).toBe("dashboard");
    expect(stored.issueKey).toBe("a/b#7");
    expect(stored.attempts).toBe(0);
    expect(stored.op).toMatchObject({ kind: "labels", add: ["junco:approved"] });
    expect(Date.parse(stored.createdAt)).toBeGreaterThan(0);
  });

  it("list is FIFO by filename even with same-millisecond enqueues", () => {
    const root = mkdtempSync(join(tmpdir(), "junco-obx2-"));
    const cfg = cfgAt(root);
    const t = new Date("2026-07-07T10:00:00Z");
    const deps = { nowFn: () => t };
    const a = enqueueOp(cfg, "reporter", { ...LABELS }, deps);
    const b = enqueueOp(cfg, "reporter", { ...LABELS, issue: 8 }, deps);
    const c = enqueueOp(cfg, "reporter", { ...LABELS, issue: 9 }, deps);
    expect(listOps(cfg).map((s) => s.id)).toEqual([a, b, c]); // seq breaks the tie
  });

  it("issueKey is null for push ops; depth counts only .json in the live dir", () => {
    const root = mkdtempSync(join(tmpdir(), "junco-obx3-"));
    const cfg = cfgAt(root);
    enqueueOp(cfg, "prflow", { kind: "push", repoPath: "/r", branch: "junco/x" });
    writeFileSync(join(outboxPaths(cfg).dir, "junk.txt"), "x");
    expect(listOps(cfg)[0].issueKey).toBeNull();
    expect(outboxDepth(cfg)).toBe(1);
  });

  it("unparseable op files are skipped, not fatal", () => {
    const root = mkdtempSync(join(tmpdir(), "junco-obx4-"));
    const cfg = cfgAt(root);
    enqueueOp(cfg, "dashboard", { ...LABELS });
    writeFileSync(join(outboxPaths(cfg).dir, "0000-bad.json"), "{nope");
    expect(listOps(cfg)).toHaveLength(1);
  });

  it("missing dir (fresh install) → empty list, depth 0", () => {
    const cfg = cfgAt(join(tmpdir(), "junco-obx-nonexistent-xyz"));
    expect(listOps(cfg)).toEqual([]);
    expect(outboxDepth(cfg)).toBe(0);
  });
});
```

- [ ] **Step 2: Verify failure** — `npx vitest run tests/githubOutbox.test.ts > /tmp/o1 2>&1; echo "exit: $?"; tail -5 /tmp/o1` → FAIL (module missing).

- [ ] **Step 3: Implement** the store half of `src/githubOutbox.ts`:

```ts
/**
 * GitHub outbox — durable store-and-forward for GitHub side effects when the
 * network is down. One JSON file per op under <state_dir>/github-outbox/
 * (atomic tmp+rename, watchlist pattern); filename <epoch-ms>-<seq>-<kind>
 * makes lexicographic order the FIFO (and per-issue) replay order. Poisoned
 * ops dead-letter into github-outbox/dead/ — same philosophy as failed/.
 */

import {
  readdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { join, basename } from "node:path";
import type { Config } from "./types.js";
import { log } from "./logging.js";

// (OutboxOp, StoredOp, OutboxDeps exactly as in the Interfaces block above)

let seq = 0; // same-ms tiebreaker; module-lifetime monotonic

export function outboxPaths(cfg: Config): { dir: string; dead: string } {
  const dir = join(cfg.stateDir, "github-outbox");
  return { dir, dead: join(dir, "dead") };
}

function issueKeyOf(op: OutboxOp): string | null {
  return "nwo" in op && "issue" in op && typeof op.issue === "number"
    ? `${op.nwo}#${op.issue}`
    : null;
}

export function enqueueOp(
  cfg: Config,
  origin: StoredOp["origin"],
  op: OutboxOp,
  deps: OutboxDeps = {},
): string {
  const writeFileFn = deps.writeFileFn ?? ((p: string, s: string) => writeFileSync(p, s, "utf8"));
  const renameFn = deps.renameFn ?? renameSync;
  const mkdirFn = deps.mkdirFn ?? ((d: string) => mkdirSync(d, { recursive: true }));
  const nowFn = deps.nowFn ?? ((): Date => new Date());
  const { dir } = outboxPaths(cfg);
  mkdirFn(dir);
  const now = nowFn();
  const id = `${now.getTime()}-${String(seq++).padStart(4, "0")}-${op.kind}`;
  const stored: Omit<StoredOp, "path"> = {
    id,
    createdAt: now.toISOString(),
    origin,
    issueKey: issueKeyOf(op),
    attempts: 0,
    lastError: null,
    op,
  };
  const dst = join(dir, `${id}.json`);
  const tmp = `${dst}.tmp`;
  writeFileFn(tmp, JSON.stringify(stored, null, 2));
  renameFn(tmp, dst);
  return id;
}

export function listOps(cfg: Config, deps: OutboxDeps = {}): StoredOp[] {
  const readdirFn = deps.readdirFn ?? readdirSync;
  const readFileFn = deps.readFileFn ?? ((p: string) => readFileSync(p, "utf8"));
  const { dir } = outboxPaths(cfg);
  let names: string[];
  try {
    names = readdirFn(dir);
  } catch {
    return []; // no outbox yet
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

export function outboxDepth(cfg: Config, deps: OutboxDeps = {}): number {
  const readdirFn = deps.readdirFn ?? readdirSync;
  try {
    return readdirFn(outboxPaths(cfg).dir).filter((n) => n.endsWith(".json")).length;
  } catch {
    return 0;
  }
}
```

(also import nothing unused; `rmSync` and the remaining imports arrive in Task 2 — include them only when used, or add in Task 2.)

- [ ] **Step 4: Verify green** — `npx vitest run tests/githubOutbox.test.ts > /tmp/o1 2>&1; echo "exit: $?"; tail -5 /tmp/o1` → PASS; `npm run build` → exit 0.

- [ ] **Step 5: Commit**
```bash
npx prettier --write src/githubOutbox.ts tests/githubOutbox.test.ts
git add src/githubOutbox.ts tests/githubOutbox.test.ts
git commit -m "feat(outbox): durable op store — FIFO json files under state dir"
```

---

### Task 2: `tryOrEnqueue` + `flushOutbox` executor

**Files:**
- Modify: `src/githubOutbox.ts` (append)
- Test: `tests/githubOutbox.test.ts` (append)

**Interfaces:**
- Consumes: `gh`, `git`, `GitOpError`, `isNetworkError` from `src/git.ts` (all exported); Task 1 store.
- Produces:

```ts
export interface FlushDeps extends OutboxDeps {
  ghFn?: typeof gh;
  gitFn?: typeof git;
}
export interface FlushResult { sent: number; dead: number; remaining: number; offline: boolean }

export function isOffline(e: unknown): boolean; // GitOpError + isNetworkError(e.stderr)
export async function tryOrEnqueue(
  cfg: Config,
  origin: StoredOp["origin"],
  op: OutboxOp,
  live: () => Promise<void>,
): Promise<"sent" | "queued">;
export async function flushOutbox(cfg: Config, deps?: FlushDeps): Promise<FlushResult>;
export const OUTBOX_MARKER_PREFIX = "<!-- junco:outbox:"; // comment idempotency
export const MAX_OP_ATTEMPTS = 3;
```

Executor semantics per kind (binding):
- `labels` → `gh issue edit <n> --repo <nwo> [--add-label x…] [--remove-label y…]` (skip the call entirely when both lists are empty).
- `comment` → first `gh api repos/<nwo>/issues/<n>/comments --paginate --jq '.[].body'` and if any line contains `${OUTBOX_MARKER_PREFIX}${id} -->` treat as already posted (sent, delete op). Otherwise post via `--body-file` (temp file, cleaned up) with `\n\n${OUTBOX_MARKER_PREFIX}${id} -->\n` appended.
- `push` → `git -C <repoPath> push --set-upstream origin <branch>` (180 s timeout — mirrors `pushBranch` in src/pr.ts:111).
- `pr` → stepwise with checkpoints written back to the op file after each step:
  1. if `!pushed`: push as above → set `pushed: true`, rewrite file.
  2. if `prUrl === null`: `gh pr create --repo <nwo> --base <base> --head <branch> --title <title> --body-file <tmp>` (+`--draft` when draft, `--label`/`--reviewer` per array — argv mirrors `openPullRequest` in src/pr.ts:130); URL = last stdout line starting `https://`. If stderr contains `already exists`, resolve via `gh pr view <branch> --repo <nwo> --json url --jq .url`. Set `prUrl`, rewrite file.
  3. if `finalize !== null && issue !== null`: build the comment `Opened <prUrl>\n\n<excerpt>` where excerpt = finalize.finalText trimmed to 700 chars at a word boundary (reuse the shape of `excerpt()` in githubReport.ts — import `buildFinalComment` is NOT reusable here since it takes a Ticket; implement a local `prFlushComment(finalize, prUrl)` that produces `Opened <url>\n\n<capped finalText>` and append the outbox marker), post it idempotently like `comment`.
  4. `gh issue edit` flip `<done-label>` on / `working` off — labels derive from `lifecycleLabels(cfg.github.triggerLabel)`: add `ll.done` when `TERMINAL_DONE_STATUSES.has(finalize.status)` else `ll.failed`, remove `ll.working`. Skip when `issue === null`.
- After a fully successful op: delete its file (`rmFn`).
- Any step throwing offline (`isOffline`) → stop the whole flush, return `{offline: true}`, attempts untouched for THIS op too (offline is not the op's fault). Non-network throw → `attempts++ / lastError`, rewrite file; when `attempts >= MAX_OP_ATTEMPTS` move file into `dead/` (mkdir, rename) and count `dead`.

- [ ] **Step 1: Write the failing tests** — append to `tests/githubOutbox.test.ts`:

```ts
import { flushOutbox, tryOrEnqueue, isOffline, MAX_OP_ATTEMPTS, OUTBOX_MARKER_PREFIX } from "../src/githubOutbox.js";
import { GitOpError } from "../src/git.js";

const NET_ERR = new GitOpError("gh failed", "connect: network is unreachable", 1);
const PERM_ERR = new GitOpError("gh failed", "HTTP 404: Not Found", 1);

/** Scriptable gh/git fakes: each call records argv; behavior comes from a
 * queue of responses or a handler function. */
function fakes(handler: (tool: "gh" | "git", args: string[]) => { stdout?: string } | void) {
  const calls: { tool: string; args: string[] }[] = [];
  const ghFn = (async (_cfg: unknown, args: string[]) => {
    calls.push({ tool: "gh", args });
    return { code: 0, stdout: "", stderr: "", ...(handler("gh", args) ?? {}) };
  }) as never;
  const gitFn = (async (_cfg: unknown, args: string[]) => {
    calls.push({ tool: "git", args });
    return { code: 0, stdout: "", stderr: "", ...(handler("git", args) ?? {}) };
  }) as never;
  return { calls, ghFn, gitFn };
}

describe("isOffline / tryOrEnqueue", () => {
  it("classifies exactly GitOpError + network stderr", () => {
    expect(isOffline(NET_ERR)).toBe(true);
    expect(isOffline(PERM_ERR)).toBe(false);
    expect(isOffline(new Error("connect: network is unreachable"))).toBe(false); // not GitOpError
  });
  it("live success → sent, nothing stored; offline → queued; permanent → rethrow", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-obx-t-"));
    const cfg = cfgAt(root);
    expect(await tryOrEnqueue(cfg, "reporter", { ...LABELS }, async () => {})).toBe("sent");
    expect(outboxDepth(cfg)).toBe(0);
    expect(
      await tryOrEnqueue(cfg, "reporter", { ...LABELS }, async () => {
        throw NET_ERR;
      }),
    ).toBe("queued");
    expect(outboxDepth(cfg)).toBe(1);
    await expect(
      tryOrEnqueue(cfg, "reporter", { ...LABELS }, async () => {
        throw PERM_ERR;
      }),
    ).rejects.toThrow("HTTP 404");
    expect(outboxDepth(cfg)).toBe(1); // permanent error did NOT enqueue
  });
});

describe("flushOutbox", () => {
  it("labels op → one gh issue edit; file deleted on success", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-obx-f1-"));
    const cfg = cfgAt(root);
    enqueueOp(cfg, "dashboard", { kind: "labels", nwo: "a/b", issue: 7, add: ["x"], remove: ["y"] });
    const f = fakes(() => undefined);
    const r = await flushOutbox(cfg, { ghFn: f.ghFn, gitFn: f.gitFn });
    expect(r).toMatchObject({ sent: 1, dead: 0, remaining: 0, offline: false });
    expect(f.calls[0].args).toEqual([
      "issue", "edit", "7", "--repo", "a/b", "--add-label", "x", "--remove-label", "y",
    ]);
    expect(outboxDepth(cfg)).toBe(0);
  });

  it("comment op appends the marker and skips when the marker already exists upstream", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-obx-f2-"));
    const cfg = cfgAt(root);
    const id = enqueueOp(cfg, "reporter", { kind: "comment", nwo: "a/b", issue: 7, body: "hello" });
    let posted = 0;
    const f = fakes((tool, args) => {
      if (tool === "gh" && args[0] === "api") return { stdout: `${OUTBOX_MARKER_PREFIX}${id} -->` };
      if (tool === "gh" && args[0] === "issue" && args[1] === "comment") posted++;
      return undefined;
    });
    const r = await flushOutbox(cfg, { ghFn: f.ghFn, gitFn: f.gitFn });
    expect(r.sent).toBe(1);
    expect(posted).toBe(0); // marker found → treated as already delivered
  });

  it("offline mid-flush stops everything, attempts untouched, remaining counted", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-obx-f3-"));
    const cfg = cfgAt(root);
    enqueueOp(cfg, "dashboard", { ...LABELS });
    enqueueOp(cfg, "dashboard", { ...LABELS, issue: 8 });
    const f = fakes(() => {
      throw NET_ERR;
    });
    const r = await flushOutbox(cfg, { ghFn: f.ghFn, gitFn: f.gitFn });
    expect(r).toMatchObject({ sent: 0, dead: 0, remaining: 2, offline: true });
    expect(listOps(cfg).every((s) => s.attempts === 0)).toBe(true);
  });

  it("permanent failure increments attempts and dead-letters at MAX_OP_ATTEMPTS", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-obx-f4-"));
    const cfg = cfgAt(root);
    enqueueOp(cfg, "dashboard", { ...LABELS });
    const f = fakes(() => {
      throw PERM_ERR;
    });
    for (let i = 1; i < MAX_OP_ATTEMPTS; i++) {
      const r = await flushOutbox(cfg, { ghFn: f.ghFn, gitFn: f.gitFn });
      expect(r).toMatchObject({ sent: 0, dead: 0, remaining: 1 });
      expect(listOps(cfg)[0].attempts).toBe(i);
      expect(listOps(cfg)[0].lastError).toContain("404");
    }
    const last = await flushOutbox(cfg, { ghFn: f.ghFn, gitFn: f.gitFn });
    expect(last).toMatchObject({ dead: 1, remaining: 0 });
    expect(outboxDepth(cfg)).toBe(0);
    expect(readdirSync(outboxPaths(cfg).dead)).toHaveLength(1);
  });

  it("pr composite: push → create → finalize comment → labels, with checkpoint resume", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-obx-f5-"));
    const cfg = {
      stateDir: root,
      github: { triggerLabel: "junco" },
    } as unknown as Config;
    enqueueOp(cfg, "prflow", {
      kind: "pr", repoPath: "/repo", branch: "junco/fix-7", nwo: "a/b", issue: 7,
      base: "main", title: "Fix things", bodyText: "the body", draft: false,
      labels: [], reviewers: [],
      finalize: { ticketId: "gh-a-b-7", status: "completed", finalText: "did the thing" },
      pushed: false, prUrl: null,
    });
    // First flush: push succeeds, `pr create` dies offline → checkpoint pushed:true
    const f1 = fakes((tool, args) => {
      if (tool === "git") return undefined; // push ok
      if (args[0] === "pr" && args[1] === "create") throw NET_ERR;
      return undefined;
    });
    const r1 = await flushOutbox(cfg, { ghFn: f1.ghFn, gitFn: f1.gitFn });
    expect(r1.offline).toBe(true);
    const cp = listOps(cfg)[0].op as Extract<OutboxOp, { kind: "pr" }>;
    expect(cp.pushed).toBe(true);
    expect(cp.prUrl).toBeNull();
    // Second flush: everything succeeds; push must NOT run again
    let pushes = 0;
    const posted: string[] = [];
    const f2 = fakes((tool, args) => {
      if (tool === "git" && args.includes("push")) { pushes++; return undefined; }
      if (args[0] === "pr" && args[1] === "create") return { stdout: "https://github.com/a/b/pull/9\n" };
      if (args[0] === "api") return { stdout: "" }; // no marker upstream
      if (args[0] === "issue" && args[1] === "comment") { posted.push(args.join(" ")); return undefined; }
      return undefined;
    });
    const r2 = await flushOutbox(cfg, { ghFn: f2.ghFn, gitFn: f2.gitFn });
    expect(r2).toMatchObject({ sent: 1, offline: false, remaining: 0 });
    expect(pushes).toBe(0); // checkpoint respected
    expect(posted).toHaveLength(1);
    const labelCall = f2.calls.find((c) => c.args[0] === "issue" && c.args[1] === "edit");
    expect(labelCall!.args).toContain("junco:done");
    expect(labelCall!.args).toContain("junco:working");
  });

  it("pr create 'already exists' resolves the URL via pr view", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-obx-f6-"));
    const cfg = { stateDir: root, github: { triggerLabel: "junco" } } as unknown as Config;
    enqueueOp(cfg, "prflow", {
      kind: "pr", repoPath: "/repo", branch: "junco/x", nwo: "a/b", issue: null,
      base: "main", title: "t", bodyText: "b", draft: false, labels: [], reviewers: [],
      finalize: null, pushed: true, prUrl: null,
    });
    const f = fakes((tool, args) => {
      if (args[0] === "pr" && args[1] === "create")
        throw new GitOpError("gh failed", "a pull request for branch already exists", 1);
      if (args[0] === "pr" && args[1] === "view") return { stdout: "https://github.com/a/b/pull/3\n" };
      return undefined;
    });
    const r = await flushOutbox(cfg, { ghFn: f.ghFn, gitFn: f.gitFn });
    expect(r.sent).toBe(1);
  });
});
```

- [ ] **Step 2: Verify failure** — `npx vitest run tests/githubOutbox.test.ts > /tmp/o2 2>&1; echo "exit: $?"; tail -8 /tmp/o2` → FAIL (exports missing).

- [ ] **Step 3: Implement** — append to `src/githubOutbox.ts`:

```ts
import { gh, git, GitOpError, isNetworkError } from "./git.js";
import { lifecycleLabels } from "./githubInbox.js";
import { TERMINAL_DONE_STATUSES } from "./types.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

export const OUTBOX_MARKER_PREFIX = "<!-- junco:outbox:";
export const MAX_OP_ATTEMPTS = 3;
const GH_TIMEOUT = 60_000;
const PUSH_TIMEOUT = 180_000; // mirrors pushBranch (src/pr.ts:111)

export function isOffline(e: unknown): boolean {
  return e instanceof GitOpError && isNetworkError(e.stderr);
}

export async function tryOrEnqueue(
  cfg: Config,
  origin: StoredOp["origin"],
  op: OutboxOp,
  live: () => Promise<void>,
): Promise<"sent" | "queued"> {
  try {
    await live();
    return "sent";
  } catch (e) {
    if (!isOffline(e)) throw e;
    const id = enqueueOp(cfg, origin, op);
    log.info("github unreachable — queued to outbox", { id, kind: op.kind });
    return "queued";
  }
}

export interface FlushDeps extends OutboxDeps {
  ghFn?: typeof gh;
  gitFn?: typeof git;
}
export interface FlushResult {
  sent: number;
  dead: number;
  remaining: number;
  offline: boolean;
}

function marker(id: string): string {
  return `${OUTBOX_MARKER_PREFIX}${id} -->`;
}

/** Word-boundary excerpt for the flushed finalize comment (same policy as
 * githubReport.excerpt, kept local to avoid an import cycle). */
function cap(text: string, limit = 700): string {
  const t = text.trim();
  if (t.length <= limit) return t;
  const slice = t.slice(0, limit);
  const atWord = slice.lastIndexOf(" ");
  return slice.slice(0, atWord > 0 ? atWord : limit).trimEnd() + " …";
}

export async function flushOutbox(cfg: Config, deps: FlushDeps = {}): Promise<FlushResult> {
  const ghFn = deps.ghFn ?? gh;
  const gitFn = deps.gitFn ?? git;
  const renameFn = deps.renameFn ?? renameSync;
  const mkdirFn = deps.mkdirFn ?? ((d: string) => mkdirSync(d, { recursive: true }));
  const rmFn = deps.rmFn ?? ((p: string) => rmSync(p, { force: true }));
  const writeFileFn = deps.writeFileFn ?? ((p: string, s: string) => writeFileSync(p, s, "utf8"));
  const { dead } = outboxPaths(cfg);
  const result: FlushResult = { sent: 0, dead: 0, remaining: 0, offline: false };
  const ops = listOps(cfg, deps);

  const rewrite = (s: StoredOp): void => {
    const { path, ...rest } = s;
    const tmp = `${path}.tmp`;
    writeFileFn(tmp, JSON.stringify(rest, null, 2));
    renameFn(tmp, path);
  };

  const postCommentIdempotent = async (nwo: string, issue: number, body: string, id: string) => {
    const existing = await ghFn(
      cfg,
      ["api", "--paginate", `repos/${nwo}/issues/${issue}/comments`, "--jq", ".[].body"],
      { timeoutMs: GH_TIMEOUT },
    );
    if (existing.stdout.includes(marker(id))) return; // crash-replay: already delivered
    const dir = mkdtempSync(join(tmpdir(), "junco-obxc-"));
    const file = join(dir, "comment.md");
    writeFileSync(file, `${body.trimEnd()}\n\n${marker(id)}\n`, "utf8");
    try {
      await ghFn(cfg, ["issue", "comment", String(issue), "--repo", nwo, "--body-file", file], {
        timeoutMs: GH_TIMEOUT,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  const execute = async (s: StoredOp): Promise<void> => {
    const op = s.op;
    switch (op.kind) {
      case "labels": {
        const args = ["issue", "edit", String(op.issue), "--repo", op.nwo];
        for (const l of op.add) args.push("--add-label", l);
        for (const l of op.remove) args.push("--remove-label", l);
        if (op.add.length + op.remove.length === 0) return;
        await ghFn(cfg, args, { timeoutMs: GH_TIMEOUT });
        return;
      }
      case "comment":
        await postCommentIdempotent(op.nwo, op.issue, op.body, s.id);
        return;
      case "push":
        await gitFn(cfg, ["-C", op.repoPath, "push", "--set-upstream", "origin", op.branch], {
          timeoutMs: PUSH_TIMEOUT,
        });
        return;
      case "pr": {
        if (!op.pushed) {
          await gitFn(cfg, ["-C", op.repoPath, "push", "--set-upstream", "origin", op.branch], {
            timeoutMs: PUSH_TIMEOUT,
          });
          op.pushed = true;
          rewrite(s);
        }
        if (op.prUrl === null) {
          const dir = mkdtempSync(join(tmpdir(), "junco-obxb-"));
          const bodyFile = join(dir, "body.md");
          writeFileSync(bodyFile, op.bodyText, "utf8");
          try {
            const argv = [
              "pr", "create", "--repo", op.nwo, "--base", op.base, "--head", op.branch,
              "--title", op.title, "--body-file", bodyFile,
            ];
            if (op.draft) argv.push("--draft");
            for (const l of op.labels) argv.push("--label", l);
            for (const r of op.reviewers) argv.push("--reviewer", r);
            const out = await ghFn(cfg, argv, { timeoutMs: GH_TIMEOUT });
            const url = out.stdout
              .trim()
              .split("\n")
              .reverse()
              .find((l: string) => l.startsWith("https://"));
            if (!url) throw new GitOpError("gh pr create returned no URL", out.stderr, 1);
            op.prUrl = url;
          } catch (e) {
            if (e instanceof GitOpError && /already exists/i.test(e.stderr)) {
              const v = await ghFn(
                cfg,
                ["pr", "view", op.branch, "--repo", op.nwo, "--json", "url", "--jq", ".url"],
                { timeoutMs: GH_TIMEOUT },
              );
              op.prUrl = v.stdout.trim();
            } else {
              throw e;
            }
          } finally {
            rmSync(dirnameOf(bodyFile), { recursive: true, force: true });
          }
          rewrite(s);
        }
        if (op.finalize !== null && op.issue !== null) {
          const body = `Opened ${op.prUrl}\n\n${cap(op.finalize.finalText)}`;
          await postCommentIdempotent(op.nwo, op.issue, body, s.id);
          const ll = lifecycleLabels(cfg.github.triggerLabel);
          const doneLabel = TERMINAL_DONE_STATUSES.has(op.finalize.status) ? ll.done : ll.failed;
          await ghFn(
            cfg,
            ["issue", "edit", String(op.issue), "--repo", op.nwo, "--add-label", doneLabel, "--remove-label", ll.working],
            { timeoutMs: GH_TIMEOUT },
          );
        }
        return;
      }
    }
  };

  for (let i = 0; i < ops.length; i++) {
    const s = ops[i];
    if (result.offline) {
      result.remaining++;
      continue;
    }
    try {
      await execute(s);
      rmFn(s.path);
      result.sent++;
    } catch (e) {
      if (isOffline(e)) {
        result.offline = true;
        result.remaining++;
        continue;
      }
      s.attempts += 1;
      s.lastError = e instanceof Error ? e.message : String(e);
      if (s.attempts >= MAX_OP_ATTEMPTS) {
        mkdirFn(dead);
        renameFn(s.path, join(dead, basename(s.path)));
        result.dead++;
        log.warn("outbox op dead-lettered", { id: s.id, error: s.lastError });
      } else {
        rewrite(s);
        result.remaining++;
      }
    }
  }
  return result;
}
```

Note: `dirnameOf` is a slip in the sketch — use `dirname(bodyFile)` from `node:path` (import `dirname`). Cleanup targets the temp dir, not the file.

- [ ] **Step 4: Verify green** — `npx vitest run tests/githubOutbox.test.ts > /tmp/o2 2>&1; echo "exit: $?"; tail -5 /tmp/o2` → PASS; `npm run build` exit 0.

- [ ] **Step 5: Commit**
```bash
npx prettier --write src/githubOutbox.ts tests/githubOutbox.test.ts
git add src/githubOutbox.ts tests/githubOutbox.test.ts
git commit -m "feat(outbox): tryOrEnqueue seam + flush executor with checkpoints and dead-letter"
```

---

### Task 3: Reporter integration (+ `prQueued` contract)

**Files:**
- Modify: `src/reporter.ts` (`TicketOutcome` + `outcomeFromPrFlow`), `src/prFlow.ts` (add `prQueued: boolean` to `PrFlowResult`/`prOutcome` init only — behavior lands in Task 4), `src/githubReport.ts`
- Test: `tests/githubReport.test.ts` (append), `tests/reporter.test.ts` (touch if it builds outcome literals)

**Interfaces:**
- Consumes: `tryOrEnqueue`, `isOffline` (Task 2).
- Produces: `TicketOutcome.prQueued?: boolean`; `outcomeFromPrFlow` copies `flow.prQueued ?? false`; `githubReport` enqueues on network errors and skips comment+flip when `outcome.prQueued`.

- [ ] **Step 1: Write the failing tests** — append to `tests/githubReport.test.ts` (reuse the file's existing fake-gh/reporter helpers; if it has a `makeReporter`-style helper, extend it to accept a gh that throws):

```ts
import { GitOpError } from "../src/git.js";
import { listOps, outboxPaths } from "../src/githubOutbox.js";

const NET = new GitOpError("gh failed", "connect: network is unreachable", 1);

describe("reporter offline (outbox)", () => {
  it("onStart label swap queues a labels op when offline", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-rep-obx-"));
    const cfg = repCfg(root); // the file's cfg helper, with stateDir=root and triggerLabel "junco"
    const reporter = makeGithubReporter(cfg, { ghFn: async () => { throw NET; } });
    await reporter.onStart(prTicket); // the file's pr-ticket fixture (github.kind "pr")
    const ops = listOps(cfg);
    expect(ops).toHaveLength(1);
    expect(ops[0].op).toMatchObject({
      kind: "labels", add: ["junco:working"], remove: ["junco:queued"],
    });
  });

  it("onFinal comment + labels queue as two ops offline (comment first)", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-rep-obx2-"));
    const cfg = repCfg(root);
    const reporter = makeGithubReporter(cfg, { ghFn: async () => { throw NET; } });
    await reporter.onFinal(prTicket, {
      kind: "pr", status: "completed", prUrl: "https://x/pr/1", finalText: "done!", failureReason: null,
    });
    const kinds = listOps(cfg).map((o) => o.op.kind);
    expect(kinds).toEqual(["comment", "labels"]);
  });

  it("non-network errors keep the warn-and-swallow contract (nothing queued)", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-rep-obx3-"));
    const cfg = repCfg(root);
    const reporter = makeGithubReporter(cfg, {
      ghFn: async () => { throw new GitOpError("gh failed", "HTTP 403", 1); },
    });
    await expect(reporter.onStart(prTicket)).resolves.toBeUndefined();
    expect(listOps(cfg)).toHaveLength(0);
  });

  it("prQueued outcome skips finalize comment AND label flip", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-rep-obx4-"));
    const cfg = repCfg(root);
    const calls: string[][] = [];
    const reporter = makeGithubReporter(cfg, {
      ghFn: (async (_c: unknown, args: string[]) => { calls.push(args); return { code: 0, stdout: "", stderr: "" }; }) as never,
    });
    await reporter.onFinal(prTicket, {
      kind: "pr", status: "completed", prUrl: null, finalText: "x", failureReason: null, prQueued: true,
    });
    expect(calls).toHaveLength(0);
    expect(listOps(cfg)).toHaveLength(0);
  });
});
```

(Adapt fixture/helper names to the file's actual ones — read it first; the assertions above are the contract.)

- [ ] **Step 2: Verify failure** — `npx vitest run tests/githubReport.test.ts > /tmp/o3 2>&1; echo "exit: $?"; tail -8 /tmp/o3` → FAIL.

- [ ] **Step 3: Implement.**

`src/reporter.ts` — `TicketOutcome` gains `/** PR endgame parked in the outbox; the composite op owns the finalize comment + label flip. */ prQueued?: boolean;` and `outcomeFromPrFlow` adds `prQueued: flow.prQueued ?? false,`.

`src/prFlow.ts` — `PrFlowResult`'s `prOutcome` type (the `PrOutcome` interface near line 52) gains `prQueued: boolean;`, initialized `false` in the initializer near line 69, and `PrFlowResult` exposes it however `flowResult` currently derives fields (thread `prOutcome.prQueued` through — inspect `flowResult`/`finalizePr` and mirror how `prUrl` travels). No behavioral change yet.

`src/githubReport.ts`:
1. Imports: `import { tryOrEnqueue, isOffline } from "./githubOutbox.js";`
2. `swap` and `postComment` stay; `guard` becomes outbox-aware by taking the op to queue:

```ts
  const guardOrQueue = async (
    label: string,
    id: string,
    op: OutboxOp,
    fn: () => Promise<void>,
  ): Promise<void> => {
    try {
      await tryOrEnqueue(cfg, "reporter", op, fn);
    } catch (e) {
      // Non-network: best-effort by contract — warn and swallow, as before.
      log.warn(`github reporter: ${label} failed (issue state on GitHub may be stale)`, {
        id,
        error: errMsg(e),
      });
    }
  };
```
   (import `OutboxOp` type; keep the old `guard` deleted — every call site migrates.)
3. Call sites build the equivalent op: swaps →
   `{ kind: "labels", nwo: g.nwo, issue: g.issue, add: [addLabel], remove: [removeLabel] }`;
   comments → `{ kind: "comment", nwo: g.nwo, issue: g.issue, body }` (body built BEFORE the call so the op captures it).
4. `onFinal` pr/ask path starts with: `if (outcome.prQueued) return; // composite outbox op owns comment + flip`.

- [ ] **Step 4: Verify green** — `npx vitest run tests/githubReport.test.ts tests/reporter.test.ts tests/prFlow.test.ts > /tmp/o3 2>&1; echo "exit: $?"; tail -5 /tmp/o3` → PASS (prFlow suite proves the type additions are inert). Fix any outcome-literal fixtures that now miss nothing (field is optional — expect no changes needed).

- [ ] **Step 5: Commit**
```bash
npx prettier --write src/reporter.ts src/prFlow.ts src/githubReport.ts tests/githubReport.test.ts
git add src/reporter.ts src/prFlow.ts src/githubReport.ts tests/githubReport.test.ts
git commit -m "feat(outbox): reporter queues comments/labels offline; prQueued outcome contract"
```

---

### Task 4: prFlow offline endgame

**Files:**
- Modify: `src/prFlow.ts` (phases 11–12, ~lines 590–655), `src/finalize.ts` (result-section note when prQueued — locate where `prUrl`/phase notes render), `src/repo.ts` or wherever the base fetch runs (offline fetch tolerance — grep `fetch` there)
- Test: `tests/prFlow.test.ts` (append)

**Interfaces:**
- Consumes: `enqueueOp`, `isOffline` (Task 2); `derivePrTitle`, `buildPrBody` (already in prFlow scope); `RepoContext` fields (`baseBranch`, `branchName`, `draft`, `labels`, `reviewers`); Task 3's `prOutcome.prQueued`.
- Produces: offline fresh-PR push/create failures → composite `pr` op + done ticket with `prQueued: true`; offline amend push → `push` op; offline base fetch → proceed with local base + PR-body warning line `> ⚠️ Built offline from a possibly stale base — rebase check recommended.`

- [ ] **Step 1: Write the failing tests** — append to `tests/prFlow.test.ts`, using the file's existing git-harness + fake-gh helpers (read them first; the flow tests already simulate push/PR):

```ts
// Offline endgame: push dies with a network error → ticket completes,
// composite pr op queued, worktree preserved, reporter comment suppressed.
it("offline push queues a composite pr op and finalizes done with prQueued", async () => {
  // Arrange the harness exactly like the nearest successful-PR test, but make
  // the ghFn/gitFn push step throw:
  //   new GitOpError("push failed", "connect: network is unreachable", 1)
  const { flow, cfg } = await runFlowWithOfflinePush(); // helper built on the file's harness
  expect(flow.requeued).toBe(false);
  expect(TERMINAL_DONE_STATUSES.has(flow.status)).toBe(true);
  expect(flow.prUrl).toBeNull();
  expect(flow.prQueued).toBe(true);
  const ops = listOps(cfg);
  expect(ops).toHaveLength(1);
  const op = ops[0].op as Extract<OutboxOp, { kind: "pr" }>;
  expect(op.kind).toBe("pr");
  expect(op.branch).toMatch(/^junco\//);
  expect(op.finalize?.status).toBe(flow.status);
  expect(op.pushed).toBe(false);
});

it("offline gh pr create (after successful push) checkpoints pushed:true", async () => {
  const { flow, cfg } = await runFlowWithOfflinePrCreate();
  expect(flow.prQueued).toBe(true);
  const op = listOps(cfg)[0].op as Extract<OutboxOp, { kind: "pr" }>;
  expect(op.pushed).toBe(true);
  expect(op.prUrl).toBeNull();
});

it("non-network push failure keeps today's behavior (phaseError, no op)", async () => {
  const { flow, cfg } = await runFlowWithPermanentPushFailure(); // stderr "denied"
  expect(flow.prQueued ?? false).toBe(false);
  expect(listOps(cfg)).toHaveLength(0);
  expect(flow.phaseError).toContain("push/commit failed");
});
```

(The three `runFlowWith*` helpers are thin wrappers over the file's existing flow-driver fixture — same repo harness, scripted failure at the named step. Follow the file's established pattern for scripting `gitFn`/`ghFn` failures.)

- [ ] **Step 2: Verify failure** — `npx vitest run tests/prFlow.test.ts > /tmp/o4 2>&1; echo "exit: $?"; tail -8 /tmp/o4` → FAIL.

- [ ] **Step 3: Implement** in `src/prFlow.ts`:

Phase 11 catch (line ~607) gains an offline branch BEFORE the existing GitOpError handling:

```ts
  } catch (e) {
    if (!(e instanceof GitOpError)) throw e;
    if (isOffline(e) && !isAmend(ctx)) {
      // Offline fresh-PR endgame: park the whole push→PR→comment→labels
      // sequence in the outbox; the ticket's work is DONE locally.
      const opId = queueOfflinePr(false /* pushed */);
      prOutcome.prQueued = true;
      prOutcome.worktreePreserved = true;
      log.info(`github unreachable — PR queued to outbox (${opId})`);
      return flowResult(finalizePr(claimedPath, result, prOutcome, { dirs }), prOutcome, result);
    }
    if (isOffline(e) && isAmend(ctx)) {
      enqueueOp(cfg, "prflow", { kind: "push", repoPath: ctx.repo, branch: ctx.branchName });
      prOutcome.prQueued = false; // URL known; reporter comment proceeds normally
      prOutcome.pushed = false;
      prOutcome.worktreePreserved = true;
      prOutcome.prUrl = amendTarget?.prUrl ?? null;
      log.info("github unreachable — amend push queued to outbox");
      return flowResult(finalizePr(claimedPath, result, prOutcome, { dirs }), prOutcome, result);
    }
    const phaseError = `push/commit failed: ${e.message}`;
    // ... existing handling unchanged
```

with a local helper defined in the flow's scope (it has `ctx`, `nwo`, `task`, `result`, `prOutcome`):

```ts
  const queueOfflinePr = (pushed: boolean): string => {
    const title = derivePrTitle(ctx, task);
    const bodyText = buildPrBody(task, ctx, prOutcome, result);
    return enqueueOp(cfg, "prflow", {
      kind: "pr",
      repoPath: ctx.repo,
      branch: ctx.branchName,
      nwo,
      issue: task.github?.issue ?? null,
      base: ctx.baseBranch,
      title,
      bodyText,
      draft: ctx.draft,
      labels: ctx.labels,
      reviewers: ctx.reviewers,
      finalize: task.github
        ? { ticketId: task.id, status: result.status, finalText: result.finalText }
        : null,
      pushed,
      prUrl: null,
    });
  };
```

Phase 12 catch (line ~641) gains the parallel branch: `if (isOffline(e)) { const opId = queueOfflinePr(true); prOutcome.prQueued = true; prOutcome.worktreePreserved = true; ... same return }` — worktree cleanup must be SKIPPED in this branch (do not call `cleanupWorktree`).

`src/finalize.ts`: where the result section renders `prUrl`/phase notes, add — when the outcome carries `prQueued` — the line `PR queued for offline push — junco will open it automatically when GitHub is reachable.` (thread `prQueued` the same way `prUrl` travels into finalize; inspect `finalizePr`'s options/prOutcome usage and mirror it).

Base-fetch tolerance: find the fetch call in the repo-preparation phase (grep `"fetch"` in src/repo.ts / prFlow phases 1–2); wrap: on `isOffline(e)` log a warn `offline — proceeding from local base` and continue; `buildPrBody` gains the stale-base line when that flag is set (thread a `staleBase: boolean` through `prOutcome`).

Note: `result.status` at the offline-push point — confirm which variable carries the terminal status in scope (the flow computes it before finalize; use the same value `finalizePr` receives). Adjust `flowResult(...)` argument shape to the file's actual signature (it takes an optional phaseError — omit it here; offline is not a failure).

- [ ] **Step 4: Verify green** — `npx vitest run tests/prFlow.test.ts tests/finalize.test.ts tests/runOnce.test.ts > /tmp/o4 2>&1; echo "exit: $?"; tail -5 /tmp/o4` → PASS.

- [ ] **Step 5: Commit**
```bash
npx prettier --write src/prFlow.ts src/finalize.ts src/repo.ts tests/prFlow.test.ts
git add -A src tests/prFlow.test.ts tests/finalize.test.ts
git commit -m "feat(outbox): offline PR endgame — composite op, done ticket, stale-base tolerance"
```

---

### Task 5: Sweep flush-first + metrics

**Files:**
- Modify: `src/githubInbox.ts` (`pollGithubInbox` line ~526: flush before the repo loop; `BridgeDeps` gains `flushFn?`), `src/metrics.ts` (outbox counters), `src/daemon.ts` (only if the sweep call site needs the metrics hook — inspect where `recordBridgeSweep` is called)
- Test: `tests/githubInbox.test.ts` (append), `tests/metrics.test.ts` (append)

**Interfaces:**
- Consumes: `flushOutbox`, `outboxDepth` (Task 2).
- Produces: `MetricsSnapshot` gains `outboxDepth: number; outboxEnqueued: number; outboxFlushed: number; outboxDead: number; lastFlushAt: string | null` (additive); `RunMetrics.recordOutboxFlush(r: FlushResult, depth: number)` and `recordOutboxEnqueue()`; sweep calls flush FIRST and records.

- [ ] **Step 1: Failing tests.** metrics (append to `tests/metrics.test.ts`):

```ts
it("outbox counters accumulate and snapshot additively", () => {
  const m = new RunMetrics(() => new Date("2026-07-07T10:00:00Z"));
  m.recordOutboxEnqueue();
  m.recordOutboxFlush({ sent: 2, dead: 1, remaining: 3, offline: false }, 3);
  const s = m.snapshot();
  expect(s.outboxEnqueued).toBe(1);
  expect(s.outboxFlushed).toBe(2);
  expect(s.outboxDead).toBe(1);
  expect(s.outboxDepth).toBe(3);
  expect(s.lastFlushAt).toBe("2026-07-07T10:00:00.000Z");
});
```

githubInbox (append; reuse the file's sweep fixtures):

```ts
it("sweep flushes the outbox before listing issues", async () => {
  const order: string[] = [];
  // fake flushFn records "flush"; the fake ghFn's issue-list handler records "list".
  // assert order[0] === "flush" and "list" comes after.
});
it("sweep continues quietly when flush reports offline", async () => {
  // flushFn resolves { offline: true, ... }; listing throws network error →
  // pollGithubInbox resolves 0 without throwing.
});
```

(Write these against the file's actual BridgeDeps/fixture helpers — read them first; the two assertions above are the contract.)

- [ ] **Step 2: Verify failure**, **Step 3: Implement** (`BridgeDeps` gains `flushFn?: typeof flushOutbox`; top of `pollGithubInbox`: `const flush = deps.flushFn ?? flushOutbox; const fr = await flush(cfg); deps.metricsFn?.(fr)` — thread metrics however the sweep currently reports (`recordBridgeSweep` call site in daemon.ts; add `metrics.recordOutboxFlush(fr, outboxDepth(cfg))` beside it or pass through BridgeDeps — pick the pattern the file already uses for bridge metrics). `enqueueOp` callers do NOT touch metrics directly; instead `RunMetrics.recordOutboxEnqueue()` is called from `tryOrEnqueue`? No — metrics is a daemon-side singleton; `tryOrEnqueue` runs in dashboard too. Keep metrics recording ONLY at the sweep (depth + flush results); drop `recordOutboxEnqueue` from tryOrEnqueue and call it in the reporter's queue path via the daemon-owned singleton import, mirroring how other daemon-side code records. If that coupling is awkward, record enqueues by DELTA: sweep computes depth and that suffices — then implement `recordOutboxEnqueue` anyway for the reporter path (daemon process) and skip it in the dashboard (separate process; its /health comes from the daemon). Follow whichever the codebase's existing metric call pattern makes cleanest and document the choice in the commit.)

- [ ] **Step 4: Suites** — `npx vitest run tests/githubInbox.test.ts tests/metrics.test.ts tests/healthServer.test.ts tests/daemon.test.ts > /tmp/o5 2>&1; echo "exit: $?"; tail -5 /tmp/o5` → PASS (healthServer's full-snapshot literal needs the five new fields — the Config-fixture-sweep rule).

- [ ] **Step 5: Commit** — `feat(outbox): sweep flush-first + outbox metrics in /health`

---

### Task 6: Dashboard client — queued actions + issue-list cache

**Files:**
- Modify: `src/tui/ghClient.ts`
- Test: `tests/tuiGhClient.test.ts` (append)

**Interfaces:**
- Consumes: `tryOrEnqueue`, `outboxDepth` (Task 2).
- Produces:
  - `applyAction` return becomes `Promise<Result<{ queued: boolean }>>` — `{ok: true, value: {queued: false}}` live, `{queued: true}` when offline-queued; non-network errors unchanged (`ok: false`).
  - `listIssues` becomes `Promise<Result<{ issues: DashIssue[]; staleAt: string | null }>>` — fresh fetch writes `<state_dir>/github-cache/issues-<owner>__<repo>.json` (`{ fetchedAt, issues }`, atomic tmp+rename) and returns `staleAt: null`; a network failure serves the cache with `staleAt = fetchedAt`; network failure with no cache → `ok: false` as today.
  - `makeGhDashboardClient(cfg, deps)` deps gain fs fns for the cache (same seam style as queueSnapshot).

- [ ] **Step 1: Failing tests** (append to `tests/tuiGhClient.test.ts`, following its existing fake-gh style):

```ts
const NET = new GitOpError("gh failed", "connect: network is unreachable", 1);

it("applyAction offline queues a labels op and reports queued:true", async () => { /* ghFn throws NET; assert listOps has the dispatch op with the trigger label; result {ok:true,value:{queued:true}} */ });
it("applyAction permanent failure still returns ok:false and queues nothing", async () => { /* 403 */ });
it("listIssues success writes the cache and returns staleAt null", async () => { /* assert cache file content */ });
it("listIssues offline serves the cache with staleAt set", async () => { /* first call ok, then ghFn throws NET; same issues, staleAt === fetchedAt */ });
it("listIssues offline with no cache is an error (today's behavior)", async () => {});
```

Write these fully against the file's helpers — each body is 5–10 lines using its `makeClient`-style setup with `stateDir` pointed at a mkdtemp.

- [ ] **Steps 2–4: fail → implement → green.** Implementation notes: wrap the `edit` call in `applyAction` with `tryOrEnqueue(cfg, "dashboard", labelsOpFor(action, ...), () => edit(...))` where `labelsOpFor` mirrors the switch's add/remove lists exactly (dispatch → add trigger; dispatchAsk → add trigger+askLabel; approve → add approved; replan → remove planReady/approved-as-applicable; recycle → remove present terminal labels; keep the zero-op recycle short-circuit BEFORE enqueueing). Cache path helper `cachePathFor(cfg, nwo)` replaces `/` with `__`. Callers of the changed signatures (App.tsx) are updated in Task 7 — to keep THIS task green, update `src/tui/App.tsx`'s two call sites minimally in this task (destructure `.issues` and ignore `staleAt`/`queued` for now) and run the tui suites.

- [ ] **Step 4b: Suites** — `npx vitest run tests/tuiGhClient.test.ts tests/tuiApp.test.tsx tests/tuiInteractive.test.tsx > /tmp/o6 2>&1; echo "exit: $?"; tail -5 /tmp/o6` → PASS.

- [ ] **Step 5: Commit** — `feat(outbox): dashboard actions queue offline; issue list served from disk cache`

---

### Task 7: Dashboard UI — unpushed chip + stale badge + queued toast

**Files:**
- Modify: `src/tui/queueSnapshot.ts` (`outboxDepth` field), `src/tui/components/Chrome.tsx` (Header chip), `src/tui/components/IssueList.tsx` (staleAt badge), `src/tui/components/HelpModal.tsx` (system row), `src/tui/App.tsx` (thread staleAt + queued toast wording)
- Test: `tests/queueSnapshot.test.ts`, `tests/tuiChrome.test.tsx`, `tests/tuiIssueList.test.tsx`, `tests/tuiApp.test.tsx` (+ EVERY full QueueSnapshot literal: `tuiQueue`, `tuiRail`, `tuiApp` QUEUE_SNAP — the fixture-sweep rule)

**Interfaces:**
- Consumes: Task 2 `outboxDepth`, Task 6 client signatures.
- Produces: `QueueSnapshot.outboxDepth: number` (readdir count inside the snapshot builder, deps-injected); `Header` props gain `outboxDepth: number` → chip `⇡N unpushed` in `theme.warn`, hidden at 0; `IssueList` props gain `staleAt: string | null` → title badge `offline · HH:MM` (fmtClock) in warn when set; App: action results with `queued: true` toast `"offline — action queued (⇡N)"` (info kind, N = snapshot depth) and do NOT roll back optimistic labels; `staleAt` from listIssues threads into IssueList.

- [ ] **Step 1: Failing tests** — exact assertions:
  - queueSnapshot: enqueue two ops into the sandbox state dir → snapshot `outboxDepth === 2`; empty → 0.
  - Chrome: `render(<Header … outboxDepth={3} …/>)` frame contains `⇡3 unpushed`; `outboxDepth={0}` frame does NOT contain `unpushed`.
  - IssueList: `staleAt="2026-07-07T14:00:00Z"` → title contains `offline ·` and a `\d{2}:\d{2}` match; `staleAt={null}` → no `offline ·`.
  - tuiApp: fake client whose applyAction resolves `{ok:true,value:{queued:true}}` → press `d` → until-loop for toast `offline — action queued`; optimistic `planning` badge still visible after the toast (no rollback).
  - HelpModal: system section gains a row documenting the `⇡N unpushed` chip / `junco outbox flush` — frame contains `unpushed`.

- [ ] **Steps 2–4: fail → implement → green** (including the fixture sweep — grep `recent: \[\]` and `error: null` across tests to find every snapshot literal). Suites: `npx vitest run tests/queueSnapshot.test.ts tests/tuiChrome.test.tsx tests/tuiIssueList.test.tsx tests/tuiApp.test.tsx tests/tuiQueue.test.tsx tests/tuiRail.test.tsx tests/tuiWorkspace.test.tsx > /tmp/o7 2>&1; echo "exit: $?"` → 0.

- [ ] **Step 5: Commit** — `feat(dashboard): unpushed outbox chip, offline stale badge, queued-action toast`

---

### Task 8: `junco outbox` CLI + palette + status/doctor

**Files:**
- Create: `src/outboxCmd.ts`
- Modify: `src/cli.ts` (subcommand + USAGE), `src/tui/cliRunner.ts` (roster), `src/statusCmd.ts` (outbox line), `src/doctor.ts` (outbox check)
- Test: `tests/outboxCmd.test.ts` (new), `tests/cli.test.ts`, `tests/tuiCliRunner.test.ts`, `tests/statusCmd.test.ts` (or wherever status is covered), `tests/doctor.test.ts`

**Interfaces:**
- Consumes: `listOps`, `flushOutbox`, `outboxDepth`, `outboxPaths`.
- Produces: `runOutboxCommand(cfg, args: string[], deps?): Promise<number>` — no args: list (`<age> <kind> <issueKey ?? branch> attempts=N lastError?`, plus dead count footer; empty → `outbox empty`); `["flush"]`: run flush, print `sent N · dead N · remaining N` + `offline — will retry when GitHub is reachable` when offline; exit 0 unless flush left dead ops (exit 1 so scripts notice).
- cli.ts: `outbox` case (lazy import like other cmds), USAGE line `outbox [flush]      List or push the offline GitHub backlog`.
- cliRunner roster: `cmd("outbox", "[flush]", "List or push the offline GitHub backlog")`.
- statusCmd: after the queue line, `outbox:    N queued · M dead` printed only when N+M > 0 (M = dead-dir count; add a `deadCount` helper export to githubOutbox or count in statusCmd via readdir).
- doctor: warn check `outbox backlog: N queued (junco outbox flush)` when N > 0; separate warn when dead > 0.

- [ ] **Steps 1–4: TDD as usual** — tests assert exact output lines and exit codes with injected fake fs/flush; cli.test gets the case + USAGE assertions (mirror the `retry` patterns); tuiCliRunner roster test extends the roster↔USAGE consistency test.

- [ ] **Step 5: Commit** — `feat(outbox): junco outbox list/flush CLI, palette entry, status + doctor visibility`

---

### Task 9: Docs + full gate

**Files:**
- Modify: `README.md` (new "Offline / flaky network" subsection under GitHub-integrated mode + dashboard section mention of the chip), `ARCHITECTURE.md` (module row for `githubOutbox.ts`; reporter/prFlow rows gain the offline note)

**Interfaces:** none — document shipped behavior; read `githubOutbox.ts` + the reporter/prFlow diffs before writing; stack-agnostic wording.

- [ ] **Step 1: README** — cover: what queues (actions, comments, labels, PR push+create), where (`<state_dir>/github-outbox/`), auto-flush (next daemon sweep after reconnect), manual (`junco outbox` / `junco outbox flush` / palette), the `⇡N unpushed` chip and `offline · HH:MM` stale badge, dead-letter semantics (`github-outbox/dead/`, surfaced by doctor), and the trust note (ops replay under your own gh auth; approval verification still happens live at sweep time).
- [ ] **Step 2: ARCHITECTURE** — add `githubOutbox.ts` row: `Offline store-and-forward: FIFO op files under state dir, tryOrEnqueue seam, flush executor (checkpointed composite PR op, comment idempotency markers, dead-letter).`
- [ ] **Step 3: Full gate** — `npm run lint && npm run format:check && npm run build && npx vitest run > /tmp/gate 2>&1; echo "exit: $?"; tail -5 /tmp/gate` → exit 0.
- [ ] **Step 4: Commit** — `docs: offline junco — outbox lifecycle, indicators, flush commands`
