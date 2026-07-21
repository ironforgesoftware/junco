# Assess any repo + review queue — Plan 1 (headless core) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `junco assess` into a read-only audit that parks findings in a durable review store and a per-finding human-confirmed CLI step that files them as GitHub issues on any repo — owned or not.

**Architecture:** A new durable store (`assessReview.ts`) holds `PendingAssess` batches. `assessFlow.ts` stops filing and parks batches instead. A new least-privilege filing core (`assessFiling.ts`) files a confirmed selection through the existing outbox seam, with labels demoted to owned-only best-effort data and dedup unified on `--author @me` + body markers. New CLI subcommands `assess review` / `assess file` drive the confirm step. This is Plan 1 (headless-complete); the TUI review view is Plan 2 (separate plan).

**Tech Stack:** TypeScript (Node ≥ 22.19, ESM/NodeNext, strict), vitest, zod, `gh`/`git` CLIs behind injectable `deps` seams.

**Spec:** `docs/superpowers/specs/2026-07-09-assess-any-repo-review-queue-design.md`

## Global Constraints

- **ESM/NodeNext:** every intra-repo import ends in `.js` (e.g. `import { x } from "./findings.js"`). Node ≥ 22.19, strict TS.
- **Injectable deps seam:** every side effect (fs, `gh`, `git`) goes behind a `*Deps` interface with real-fn defaults. Tests never touch the network or a real model.
- **Never import the Pi SDK at module top level** in `src/` (not relevant to these files, but the rule stands).
- **`src/ticketSchema.ts` is the stable public contract** — do NOT modify it; this plan adds no ticket fields (`external`/`autoPlan`/`nwo` are derived at audit time).
- **No new `Config` field** — deliberately, to avoid the makeConfig fixture sweep across `tests/{runOnce,prFlow,orphans,repo,worktree,daemon}.test.ts`.
- **No AI attribution in commits** — no `Co-Authored-By: Claude`, no "Generated with Claude Code". If a subagent appends one, amend it away.
- **Conventional commits:** `feat:`/`refactor:`/`docs:` with optional scope; suite green at every commit.
- **Branch:** `feat/assess-any-repo-review` (already created off `origin/main`; the spec commit `c9c20cf` is on it).
- **Full gate before "done":** `npm run lint && npm run format:check && npm run typecheck && npm run build && npm test`. Capture vitest exit explicitly — never pipe into grep/tail: `npx vitest run > /tmp/out 2>&1; echo "exit: $?"`.

## File Structure

| File                                | Responsibility                                                                           | Action     |
| ----------------------------------- | ---------------------------------------------------------------------------------------- | ---------- |
| `src/assessReview.ts`               | Durable `PendingAssess` store (write/list/read/remove/count)                             | **Create** |
| `src/assessFiling.ts`               | Least-privilege filing core: `createIssueLive` + `fileFindings`                          | **Create** |
| `src/assessFlow.ts`                 | Phase A: audit → park batch (remove filing phases; add external detect + freshness sync) | Modify     |
| `src/externalRepo.ts`               | `syncExternalClone` — fetch + hard-reset a managed clone to upstream default             | Modify     |
| `src/githubOutbox.ts`               | `fetchFindingMarkers` → author-scoped list query                                         | Modify     |
| `src/assessCmd.ts`                  | Resolution includes external entries; `runAssessReviewCommand` / `runAssessFileCommand`  | Modify     |
| `src/cli.ts`                        | Route `assess review` / `assess file`; `--only` option; usage text                       | Modify     |
| `src/statusCmd.ts`, `src/doctor.ts` | Surface pending-review count                                                             | Modify     |
| Docs                                | Etiquette invariant, README, skill, ARCHITECTURE.md                                      | Modify     |

Tests are colocated as `tests/<name>.test.ts` (vitest, excluded from `dist/`).

---

### Task 1: `assessReview.ts` — durable pending store

**Files:**

- Create: `src/assessReview.ts`
- Test: `tests/assessReview.test.ts`

**Interfaces:**

- Consumes: `Config` (`src/types.js`, `cfg.stateDir: string`), `Finding` (`src/findings.js`).
- Produces:
  - `interface PendingAssess { id: string; nwo: string; external: boolean; autoPlan: boolean; repoPath: string; createdAt: string; findings: Finding[] }`
  - `assessReviewPaths(cfg): { dir: string; filed: string }`
  - `writePending(cfg, batch: PendingAssess, deps?): string` (returns dst path)
  - `listPending(cfg, deps?): PendingAssess[]` (sorted by filename)
  - `readPending(cfg, id, deps?): { batch: PendingAssess | null; error: string | null }` (missing → `{null,null}`)
  - `removePending(cfg, id, deps?): void` (archives to `filed/`)
  - `pendingCount(cfg, deps?): number`
  - `interface AssessReviewDeps { readFileFn?; writeFileFn?; renameFn?; mkdirFn?; readdirFn? }`

- [ ] **Step 1: Write the failing test**

```ts
// tests/assessReview.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  writePending,
  listPending,
  readPending,
  removePending,
  pendingCount,
  assessReviewPaths,
  type PendingAssess,
} from "../src/assessReview.js";
import type { Config } from "../src/types.js";

function cfg(stateDir: string): Config {
  return { stateDir } as unknown as Config; // only stateDir is read by this module
}
function batch(id: string): PendingAssess {
  return {
    id,
    nwo: "o/r",
    external: true,
    autoPlan: false,
    repoPath: "/x",
    createdAt: "2026-07-09T00:00:00.000Z",
    findings: [
      {
        fingerprint: "abc123",
        kind: "code",
        severity: "high",
        ruleId: "R",
        title: "T",
        description: "d",
        references: [],
      },
    ],
  };
}

describe("assessReview store", () => {
  it("writes, lists, reads, and archives a batch", () => {
    const dir = mkdtempSync(join(tmpdir(), "arv-"));
    const c = cfg(dir);
    writePending(c, batch("assess-x-1"));
    expect(pendingCount(c)).toBe(1);
    expect(listPending(c).map((b) => b.id)).toEqual(["assess-x-1"]);
    expect(readPending(c, "assess-x-1").batch?.nwo).toBe("o/r");

    removePending(c, "assess-x-1");
    expect(pendingCount(c)).toBe(0);
    expect(existsSync(join(assessReviewPaths(c).filed, "assess-x-1.json"))).toBe(true);
  });

  it("missing batch reads as {null,null}; corrupt as error; missing dir → empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "arv-"));
    const c = cfg(dir);
    expect(readPending(c, "nope")).toEqual({ batch: null, error: null });
    expect(listPending(c)).toEqual([]);
    expect(pendingCount(c)).toBe(0);

    writePending(c, batch("good"));
    writeFileSync(join(assessReviewPaths(c).dir, "bad.json"), "{not json");
    expect(listPending(c).map((b) => b.id)).toEqual(["good"]); // bad skipped, not thrown
    expect(readPending(c, "bad").error).toMatch(/not valid JSON/);
  });

  it("re-writing the same id overwrites (no duplicate file)", () => {
    const dir = mkdtempSync(join(tmpdir(), "arv-"));
    const c = cfg(dir);
    writePending(c, batch("dup"));
    writePending(c, { ...batch("dup"), nwo: "o/r2" });
    expect(readdirSync(assessReviewPaths(c).dir).filter((n) => n.endsWith(".json"))).toHaveLength(
      1,
    );
    expect(readPending(c, "dup").batch?.nwo).toBe("o/r2");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/assessReview.test.ts`
Expected: FAIL — cannot find module `../src/assessReview.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/assessReview.ts
/**
 * Durable review queue for `junco assess` — one JSON file per audit batch under
 * <state_dir>/assess-review/ (atomic tmp+rename, watchlist/outbox pattern). The
 * audit (assessFlow.ts) PARKS findings here; a human-confirmed file step
 * (assessFiling.ts, via the CLI) files them. Never throws on read: missing →
 * empty, corrupt → skipped/`error`. Reviewed batches archive to filed/.
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./types.js";
import type { Finding } from "./findings.js";
import { log } from "./logging.js";

export interface PendingAssess {
  id: string; // = the assess ticket id (stable across requeue → re-run overwrites)
  nwo: string;
  external: boolean;
  autoPlan: boolean;
  repoPath: string;
  createdAt: string; // ISO
  findings: Finding[];
}

export interface AssessReviewDeps {
  readFileFn?: (p: string) => string;
  writeFileFn?: (p: string, s: string) => void;
  renameFn?: (a: string, b: string) => void;
  mkdirFn?: (d: string) => void;
  readdirFn?: (d: string) => string[];
}

export function assessReviewPaths(cfg: Config): { dir: string; filed: string } {
  const dir = join(cfg.stateDir, "assess-review");
  return { dir, filed: join(dir, "filed") };
}

export function writePending(
  cfg: Config,
  batch: PendingAssess,
  deps: AssessReviewDeps = {},
): string {
  const writeFileFn = deps.writeFileFn ?? ((p: string, s: string) => writeFileSync(p, s, "utf8"));
  const renameFn = deps.renameFn ?? renameSync;
  const mkdirFn = deps.mkdirFn ?? ((d: string) => mkdirSync(d, { recursive: true }));
  const { dir } = assessReviewPaths(cfg);
  mkdirFn(dir);
  const dst = join(dir, `${batch.id}.json`);
  const tmp = `${dst}.tmp`;
  writeFileFn(tmp, JSON.stringify(batch, null, 2) + "\n");
  renameFn(tmp, dst);
  return dst;
}

export function listPending(cfg: Config, deps: AssessReviewDeps = {}): PendingAssess[] {
  const readdirFn = deps.readdirFn ?? readdirSync;
  const readFileFn = deps.readFileFn ?? ((p: string) => readFileSync(p, "utf8"));
  const { dir } = assessReviewPaths(cfg);
  let names: string[];
  try {
    names = readdirFn(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith(".json"))
    .sort()
    .flatMap((n) => {
      try {
        return [JSON.parse(readFileFn(join(dir, n))) as PendingAssess];
      } catch (e) {
        log.warn("skipping unparseable pending assess batch", { name: n, error: String(e) });
        return [];
      }
    });
}

export function readPending(
  cfg: Config,
  id: string,
  deps: AssessReviewDeps = {},
): { batch: PendingAssess | null; error: string | null } {
  const readFileFn = deps.readFileFn ?? ((p: string) => readFileSync(p, "utf8"));
  const { dir } = assessReviewPaths(cfg);
  let raw: string;
  try {
    raw = readFileFn(join(dir, `${id}.json`));
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return { batch: null, error: null };
    return { batch: null, error: e instanceof Error ? e.message : String(e) };
  }
  try {
    return { batch: JSON.parse(raw) as PendingAssess, error: null };
  } catch (e) {
    return { batch: null, error: `pending batch is not valid JSON: ${(e as Error).message}` };
  }
}

export function removePending(cfg: Config, id: string, deps: AssessReviewDeps = {}): void {
  const renameFn = deps.renameFn ?? renameSync;
  const mkdirFn = deps.mkdirFn ?? ((d: string) => mkdirSync(d, { recursive: true }));
  const { dir, filed } = assessReviewPaths(cfg);
  mkdirFn(filed);
  renameFn(join(dir, `${id}.json`), join(filed, `${id}.json`));
}

export function pendingCount(cfg: Config, deps: AssessReviewDeps = {}): number {
  const readdirFn = deps.readdirFn ?? readdirSync;
  try {
    return readdirFn(assessReviewPaths(cfg).dir).filter((n) => n.endsWith(".json")).length;
  } catch {
    return 0;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/assessReview.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/assessReview.ts tests/assessReview.test.ts
git commit -m "feat(assess): durable pending-review store"
```

---

### Task 2: `fetchFindingMarkers` → author-scoped dedup

**Files:**

- Modify: `src/githubOutbox.ts:295-322` (`fetchFindingMarkers`)
- Test: `tests/githubOutbox.test.ts` (update the existing `fetchFindingMarkers` test)

**Interfaces:**

- Produces: `fetchFindingMarkers(cfg, nwo, ghFn)` — unchanged signature; now lists `--author @me --state all` (no `--label`), still scans bodies for `<!-- junco:finding:fp -->`.

- [ ] **Step 1: Write the failing test**

Find the existing `fetchFindingMarkers` test in `tests/githubOutbox.test.ts` (search `fetchFindingMarkers`). Add/adjust a case asserting the argv is author-scoped and label-free:

```ts
it("fetchFindingMarkers lists by author, not by label, and scans bodies", async () => {
  const calls: string[][] = [];
  const ghFn = (async (_cfg: unknown, args: string[]) => {
    calls.push(args);
    return {
      stdout: JSON.stringify([{ body: `x ${findingMarker("deadbeef")} y` }]),
      stderr: "",
      code: 0,
    };
  }) as unknown as typeof gh;
  const markers = await fetchFindingMarkers(cfgFixture(), "o/r", ghFn);
  expect(markers.has("deadbeef")).toBe(true);
  expect(calls[0]).toContain("--author");
  expect(calls[0]).toContain("@me");
  expect(calls[0]).not.toContain("--label");
});
```

(Reuse the file's existing `gh` fake shape, `findingMarker` import from `../src/findings.js`, and its `cfgFixture()`/config helper — match the names already in `tests/githubOutbox.test.ts`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/githubOutbox.test.ts -t fetchFindingMarkers`
Expected: FAIL — argv still contains `--label`.

- [ ] **Step 3: Write minimal implementation**

In `src/githubOutbox.ts`, change the `fetchFindingMarkers` argv and its doc comment. Replace the `--label`/`FINDING_LABEL` pair with author scoping:

```ts
// Fingerprints already filed on <nwo>: scan the bodies of every issue AUTHORED
// BY THE OPERATOR (state all, most recent 500) for finding markers. Author-scoped
// (not label-scoped) so the SAME dedup works on repos junco cannot label — the
// finding marker in the body is the identity, the label was only ever a list
// filter. Bodies can be null (githubInbox.ts GhIssue precedent) → treated as
// empty. Older label-based issues were authored by @me too, so replay stays correct.
//
// KNOWN LIMITATION: `--limit 500` truncates on repos with >500 finding issues
// (issue #41 follow-up). Second limitation: on a shared OWNED repo where multiple
// operator accounts file findings, `--author @me` misses a teammate's issue and
// can re-file; the marker keeps that from corrupting state.
export async function fetchFindingMarkers(
  cfg: Config,
  nwo: string,
  ghFn: typeof gh,
): Promise<Set<string>> {
  const listed = await ghFn(
    cfg,
    [
      "issue",
      "list",
      "--repo",
      nwo,
      "--author",
      "@me",
      "--state",
      "all",
      "--limit",
      "500",
      "--json",
      "body",
    ],
    { timeoutMs: GH_TIMEOUT },
  );
  const bodies = (JSON.parse(listed.stdout) as { body: string | null }[]).map((b) =>
    typeof b.body === "string" ? b.body : "",
  );
  return extractFindingMarkers(bodies);
}
```

Note: `FINDING_LABEL` is still imported/used by `ensureFindingLabels` and `FINDING_LABEL_SPECS` — do NOT remove the import.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/githubOutbox.test.ts`
Expected: PASS (fix any other case in that file that asserted the old `--label` argv).

- [ ] **Step 5: Commit**

```bash
git add src/githubOutbox.ts tests/githubOutbox.test.ts
git commit -m "refactor(outbox): dedup finding issues by author, not label"
```

---

### Task 3: `assessFiling.ts` — least-privilege filing core

**Files:**

- Create: `src/assessFiling.ts`
- Modify: `src/assessFlow.ts` — remove `createIssueLive` (moved here) and its now-unused imports (do this in Step 3 here; assessFlow's own filing is removed in Task 5).
- Test: `tests/assessFiling.test.ts`

**Interfaces:**

- Consumes: `PendingAssess`, `removePending` (Task 1); `tryOrEnqueue`, `fetchFindingMarkers`, `ensureFindingLabels`, `OutboxOp` (`githubOutbox.js`); `buildIssueTitle`, `buildIssueBody`, `findingLabels`, `Finding` (`findings.js`); `gh`, `GitOpError`, `isNetworkError` (`git.js`).
- Produces:
  - `interface FileResult { created: number; queuedOffline: number; deduped: number; failed: number; urls: string[]; warnings: string[] }`
  - `interface FileFindingsDeps { ghFn?: typeof gh }`
  - `createIssueLive(cfg, nwo, title, bodyText, labels, ghFn): Promise<string | null>`
  - `fileFindings(cfg, batch: PendingAssess, selected: Set<string>, deps?): Promise<FileResult>`

- [ ] **Step 1: Write the failing test**

```ts
// tests/assessFiling.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileFindings } from "../src/assessFiling.js";
import {
  assessReviewPaths,
  writePending,
  readPending,
  type PendingAssess,
} from "../src/assessReview.js";
import { findingMarker } from "../src/findings.js";
import type { Config } from "../src/types.js";
import type { gh } from "../src/git.js";

function cfg(stateDir: string): Config {
  return { stateDir, github: { triggerLabel: "junco" } } as unknown as Config;
}
function pending(external: boolean): PendingAssess {
  return {
    id: "assess-x-1",
    nwo: "o/r",
    external,
    autoPlan: false,
    repoPath: "/x",
    createdAt: "2026-07-09T00:00:00.000Z",
    findings: [
      {
        fingerprint: "f1",
        kind: "code",
        severity: "high",
        ruleId: "R1",
        title: "One",
        description: "d1",
        references: [],
      },
      {
        fingerprint: "f2",
        kind: "code",
        severity: "low",
        ruleId: "R2",
        title: "Two",
        description: "d2",
        references: [],
      },
    ],
  };
}

/** gh fake: records argv; empty issue-list (no prior markers); issue-create prints a URL. */
function ghFake(calls: string[][]): typeof gh {
  return (async (_c: unknown, args: string[]) => {
    calls.push(args);
    if (args[0] === "issue" && args[1] === "list") return { stdout: "[]", stderr: "", code: 0 };
    if (args[0] === "issue" && args[1] === "create")
      return { stdout: "https://github.com/o/r/issues/9\n", stderr: "", code: 0 };
    return { stdout: "", stderr: "", code: 0 };
  }) as unknown as typeof gh;
}

describe("fileFindings", () => {
  it("files only the selected findings and archives the batch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "afl-"));
    const c = cfg(dir);
    writePending(c, pending(false));
    const calls: string[][] = [];
    const res = await fileFindings(c, pending(false), new Set(["f1"]), { ghFn: ghFake(calls) });

    expect(res.created).toBe(1);
    expect(res.urls).toEqual(["https://github.com/o/r/issues/9"]);
    const creates = calls.filter((a) => a[0] === "issue" && a[1] === "create");
    expect(creates).toHaveLength(1);
    // owned → labelled
    expect(creates[0]).toContain("--label");
    // archived
    expect(readPending(c, "assess-x-1").batch).toBeNull();
  });

  it("external batch files WITHOUT labels and never calls label create", async () => {
    const dir = mkdtempSync(join(tmpdir(), "afl-"));
    const c = cfg(dir);
    writePending(c, pending(true));
    const calls: string[][] = [];
    await fileFindings(c, pending(true), new Set(["f1", "f2"]), { ghFn: ghFake(calls) });

    const creates = calls.filter((a) => a[0] === "issue" && a[1] === "create");
    expect(creates).toHaveLength(2);
    for (const cr of creates) expect(cr).not.toContain("--label");
    expect(calls.some((a) => a[0] === "label")).toBe(false);
  });

  it("skips a finding already filed (marker present in author-scoped list)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "afl-"));
    const c = cfg(dir);
    writePending(c, pending(true));
    const ghFn = (async (_c: unknown, args: string[]) => {
      if (args[1] === "list")
        return { stdout: JSON.stringify([{ body: findingMarker("f1") }]), stderr: "", code: 0 };
      if (args[1] === "create")
        return { stdout: "https://github.com/o/r/issues/9\n", stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 0 };
    }) as unknown as typeof gh;
    const res = await fileFindings(c, pending(true), new Set(["f1", "f2"]), { ghFn });
    expect(res.deduped).toBe(1);
    expect(res.created).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/assessFiling.test.ts`
Expected: FAIL — cannot find module `../src/assessFiling.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/assessFiling.ts` (move `createIssueLive` verbatim from `assessFlow.ts:99-139`, then add `fileFindings`):

```ts
// src/assessFiling.ts
/**
 * Least-privilege filing core for `junco assess`. Files a human-confirmed
 * SELECTION from a parked review batch (assessReview.ts) as GitHub issues,
 * through the outbox seam (githubOutbox.ts) so offline runs converge. Labels are
 * owned-only best-effort DATA (external batches file label-free); dedup is
 * author-scoped + marker-based, identical for owned and unowned. This module is
 * the seam SP-2 (comment) / SP-3 (issue-context) build on.
 */
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Config } from "./types.js";
import { gh, GitOpError, isNetworkError } from "./git.js";
import {
  tryOrEnqueue,
  fetchFindingMarkers,
  ensureFindingLabels,
  type OutboxOp,
} from "./githubOutbox.js";
import { buildIssueTitle, buildIssueBody, findingLabels, type Finding } from "./findings.js";
import { removePending, type PendingAssess } from "./assessReview.js";
import { log } from "./logging.js";

const GH_TIMEOUT = 60_000;

export interface FileFindingsDeps {
  ghFn?: typeof gh;
}
export interface FileResult {
  created: number;
  queuedOffline: number;
  deduped: number;
  failed: number;
  urls: string[];
  warnings: string[];
}

function describeError(e: unknown): string {
  if (e instanceof GitOpError) return e.stderr || e.message;
  return e instanceof Error ? e.message : String(e);
}

/** Create ONE issue live; return the URL gh prints, or null. Moved verbatim from
 * assessFlow.ts — the body goes to a temp file, labels flatten into --label flags. */
export async function createIssueLive(
  cfg: Config,
  nwo: string,
  title: string,
  bodyText: string,
  labels: string[],
  ghFn: typeof gh,
): Promise<string | null> {
  const dir = mkdtempSync(join(tmpdir(), "junco-assess-"));
  const file = join(dir, "issue.md");
  writeFileSync(file, bodyText, "utf8");
  try {
    const out = await ghFn(
      cfg,
      [
        "issue",
        "create",
        "--repo",
        nwo,
        "--title",
        title,
        "--body-file",
        file,
        ...labels.flatMap((l) => ["--label", l]),
      ],
      { timeoutMs: GH_TIMEOUT },
    );
    return (
      out.stdout
        .trim()
        .split("\n")
        .reverse()
        .find((l) => l.startsWith("https://")) ?? null
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** File the SELECTED findings from a parked batch, then archive the batch.
 * Owned → labelled (best-effort ensure; on failure, file label-free rather than
 * fail the issue). External → label-free by construction. Author-scoped dedup
 * skips anything already filed. Offline → durable outbox op. */
export async function fileFindings(
  cfg: Config,
  batch: PendingAssess,
  selected: Set<string>,
  deps: FileFindingsDeps = {},
): Promise<FileResult> {
  const ghFn = deps.ghFn ?? gh;
  const result: FileResult = {
    created: 0,
    queuedOffline: 0,
    deduped: 0,
    failed: 0,
    urls: [],
    warnings: [],
  };
  const toFile = batch.findings.filter((f) => selected.has(f.fingerprint));
  if (toFile.length === 0) {
    removePending(cfg, batch.id);
    return result;
  }

  // Authoritative dedup: network failure degrades to empty (converges via the
  // outbox flush re-check); any other error is fatal for this file attempt.
  let filed: Set<string>;
  try {
    filed = await fetchFindingMarkers(cfg, batch.nwo, ghFn);
  } catch (e) {
    if (e instanceof GitOpError && isNetworkError(e.stderr)) {
      result.warnings.push(`GitHub dedup unavailable (offline): ${describeError(e)}`);
      filed = new Set();
    } else {
      throw e instanceof GitOpError ? new GitOpError(describeError(e), e.stderr, e.returncode) : e;
    }
  }

  // Best-effort labels (owned only). If ensure fails, drop to label-free so the
  // issues still land — the marker+title carry the same information.
  let labelFree = batch.external;
  if (!batch.external) {
    const union = new Set<string>();
    for (const f of toFile) {
      for (const l of findingLabels(f, {
        autoPlan: batch.autoPlan,
        triggerLabel: cfg.github.triggerLabel,
      })) {
        union.add(l);
      }
    }
    if (union.size > 0) {
      try {
        await ensureFindingLabels(cfg, batch.nwo, [...union], ghFn);
      } catch (e) {
        labelFree = true;
        result.warnings.push(`could not ensure labels — filing label-free: ${describeError(e)}`);
      }
    }
  }
  const labelsFor = (f: Finding): string[] =>
    labelFree
      ? []
      : findingLabels(f, { autoPlan: batch.autoPlan, triggerLabel: cfg.github.triggerLabel });

  for (const f of toFile) {
    if (filed.has(f.fingerprint)) {
      result.deduped++;
      continue;
    }
    const title = buildIssueTitle(f);
    const bodyText = buildIssueBody(f);
    const labels = labelsFor(f);
    const op: OutboxOp = {
      kind: "issue-create",
      nwo: batch.nwo,
      title,
      bodyText,
      labels,
      fingerprint: f.fingerprint,
    };
    let url: string | null = null;
    try {
      const outcome = await tryOrEnqueue(cfg, "assess", op, async () => {
        url = await createIssueLive(cfg, batch.nwo, title, bodyText, labels, ghFn);
      });
      if (outcome === "sent") {
        result.created++;
        if (url) result.urls.push(url);
      } else {
        result.queuedOffline++;
      }
    } catch (e) {
      result.failed++;
      result.warnings.push(`could not file "${title}": ${describeError(e)}`);
    }
  }
  log.info("assess findings filed", {
    id: batch.id,
    nwo: batch.nwo,
    ...{
      created: result.created,
      queued: result.queuedOffline,
      deduped: result.deduped,
      failed: result.failed,
    },
  });
  removePending(cfg, batch.id);
  return result;
}
```

Then in `src/assessFlow.ts`, delete the local `createIssueLive` (lines ~99-139) — Task 5 removes its remaining callers, but delete the function now and add an import so the file still compiles if referenced: at the top, the filing import is added in Task 5. For this task, just remove the function body and leave assessFlow otherwise intact (its Phase 9 still references `createIssueLive`; to keep the build green **do Task 5 in the same PR** — see note). To keep each task independently green, instead of deleting from assessFlow here, **re-export** is unnecessary; simplest: leave assessFlow's copy in place for now and delete it in Task 5. Adjust Step 3: do NOT touch assessFlow in this task.

> Implementation note: `createIssueLive` temporarily exists in both `assessFlow.ts` and `assessFiling.ts` between Task 3 and Task 5. That is fine — Task 5 deletes assessFlow's copy when it removes the filing phases. Duplicated private helper for one commit, no export clash.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/assessFiling.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/assessFiling.ts tests/assessFiling.test.ts
git commit -m "feat(assess): least-privilege filing core (label-free + author dedup)"
```

---

### Task 4: `syncExternalClone` — freshness sync

**Files:**

- Modify: `src/externalRepo.ts` (add `syncExternalClone`)
- Test: `tests/externalRepo.test.ts` (add a case)

**Interfaces:**

- Consumes: `git` (`git.js`), `Config`.
- Produces: `syncExternalClone(cfg, repoPath, deps?): Promise<void>` — `git fetch origin`, resolve origin's default branch via `git symbolic-ref refs/remotes/origin/HEAD`, hard-reset the working tree to it. Uses the existing `ExternalRepoDeps.gitFn` seam.

- [ ] **Step 1: Write the failing test**

Add to `tests/externalRepo.test.ts` (match its existing gitFn-fake style):

```ts
it("syncExternalClone fetches origin and hard-resets to the default branch", async () => {
  const calls: string[][] = [];
  const gitFn = (async (_c: unknown, args: string[]) => {
    calls.push(args);
    if (args.includes("symbolic-ref"))
      return { stdout: "refs/remotes/origin/main\n", stderr: "", code: 0 };
    return { stdout: "", stderr: "", code: 0 };
  }) as unknown as typeof git;
  await syncExternalClone(cfgFixture(), "/clones/o/r", { gitFn });
  expect(calls.some((a) => a.includes("fetch") && a.includes("origin"))).toBe(true);
  const reset = calls.find((a) => a.includes("reset"));
  expect(reset).toBeDefined();
  expect(reset).toContain("--hard");
  expect(reset).toContain("origin/main");
});
```

Add `syncExternalClone` to the file's imports from `../src/externalRepo.js`, and `git` from `../src/git.js`. Reuse the file's `cfgFixture()` helper (or its equivalent config builder).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/externalRepo.test.ts -t syncExternalClone`
Expected: FAIL — `syncExternalClone` is not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/externalRepo.ts`:

```ts
const FETCH_TIMEOUT = 180_000;

/** Sync a managed external clone to upstream's current default branch before an
 * audit: fetch origin, resolve origin/HEAD, hard-reset the working tree to it.
 * Junco OWNS these clones (under externalReposRoot), so a reset is safe — this
 * makes assess reflect upstream's live default branch, not the provisioned
 * snapshot. NEVER call this on an owned repo (the operator's own checkout). */
export async function syncExternalClone(
  cfg: Config,
  repoPath: string,
  deps: ExternalRepoDeps = {},
): Promise<void> {
  const gitFn = deps.gitFn ?? git;
  await gitFn(cfg, ["-C", repoPath, "fetch", "origin"], { timeoutMs: FETCH_TIMEOUT });
  const head = await gitFn(cfg, ["-C", repoPath, "symbolic-ref", "refs/remotes/origin/HEAD"], {
    check: false,
  });
  // "refs/remotes/origin/main" → "origin/main"; fall back to origin/HEAD if unset.
  const ref = head.code === 0 ? head.stdout.trim().replace(/^refs\/remotes\//, "") : "origin/HEAD";
  await gitFn(cfg, ["-C", repoPath, "reset", "--hard", ref], { timeoutMs: FETCH_TIMEOUT });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/externalRepo.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/externalRepo.ts tests/externalRepo.test.ts
git commit -m "feat(assess): syncExternalClone — refresh managed clone to upstream default"
```

---

### Task 5: `assessFlow.ts` — Phase A parks instead of files

**Files:**

- Modify: `src/assessFlow.ts` (remove filing phases 8-9 and `createIssueLive`; add external detect, sync call, park)
- Test: `tests/assessFlow.test.ts` (update existing expectations + add park cases)

**Interfaces:**

- Consumes: `writePending`, `PendingAssess` (Task 1); `syncExternalClone` (Task 4).
- Produces: `runAssessFlow` still returns `AssessFlowResult`, but the filing counts (`created`/`queuedOffline`/`deduped`/`failed`/`capped`/`urls`) are replaced by a single `parked: number` (findings written to the review store). Update `AssessFlowResult` accordingly.

- [ ] **Step 1: Write the failing test**

In `tests/assessFlow.test.ts`, existing tests assert issues are filed (they inspect `gh issue create` calls / `created` counts). Rewrite the primary success case to assert **parking** instead:

```ts
it("parks findings in the review store instead of filing them", async () => {
  const { cfgObj, ticket, claimed } = await makeAssessFixture({
    // agent finalText carries one code finding via the junco-findings fence
    findings: [
      { kind: "code", severity: "high", ruleId: "R", title: "Bug", location: { path: "a.ts" } },
    ],
    originNwo: "o/r", // owned (repoPath NOT under externalReposRoot)
  });
  const res = await runAssessFlow(cfgObj, ticket, claimed, fakeDeps());
  expect(res.parked).toBeGreaterThanOrEqual(1);

  const pend = listPending(cfgObj);
  expect(pend).toHaveLength(1);
  expect(pend[0].nwo).toBe("o/r");
  expect(pend[0].external).toBe(false);
});

it("marks the batch external and forces autoPlan false when the clone is under externalReposRoot", async () => {
  const { cfgObj, ticket, claimed } = await makeAssessFixture({
    findings: [
      { kind: "code", severity: "high", ruleId: "R", title: "Bug", location: { path: "a.ts" } },
    ],
    originNwo: "up/stream",
    external: true, // repoPath placed under cfg.github.externalReposRoot
    autoPlan: true,
  });
  await runAssessFlow(cfgObj, ticket, claimed, fakeDeps());
  const [b] = listPending(cfgObj);
  expect(b.external).toBe(true);
  expect(b.autoPlan).toBe(false);
});
```

Add `import { listPending } from "../src/assessReview.js";`. Extend the file's fixture helper so a test can place `repoPath` under `cfg.github.externalReposRoot` and set an origin nwo (the git fake already scripts `remote get-url origin`). Keep the existing "not a directory", "no origin", npm-audit, transient-requeue, and hallucination-filter tests — they assert Phase 1-5 behavior that is unchanged (they should still pass once the return shape swaps `created→parked`; adjust their assertions minimally).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/assessFlow.test.ts`
Expected: FAIL — `res.parked` undefined; `listPending` empty (flow still files).

- [ ] **Step 3: Write minimal implementation**

In `src/assessFlow.ts`:

1. **Imports:** remove `mkdtempSync, writeFileSync, rmSync, tmpdir` if now unused; remove `tryOrEnqueue, ensureFindingLabels, buildIssueTitle, buildIssueBody, findingLabels, type OutboxOp` if only the filing path used them (keep `buildIssueTitle` only if still referenced — it is NOT after removing the cap/overflow section, so remove it). Add:

```ts
import { resolve as pathResolve, sep } from "node:path"; // already imports resolve/sep — reuse
import { writePending, type PendingAssess } from "./assessReview.js";
import { syncExternalClone } from "./externalRepo.js";
```

2. **Delete** the local `createIssueLive` function (moved to assessFiling.ts in Task 3).
3. **`AssessFlowResult`:** replace `found/deduped/created/queuedOffline/dropped/capped/failed/urls` filing fields with `parked: number` (keep `found`, `dropped` — they describe the audit; drop the rest). Update `buildSummary` to report "N findings awaiting review — run `junco assess file <id>`".
4. **External detection** (after Phase 2 resolves `nwo`):

```ts
const externalRoot = pathResolve(expandHome(cfg.github.externalReposRoot));
const external = repoPath === externalRoot || repoPath.startsWith(externalRoot + sep);
```

5. **Freshness sync** (external only, before the agent audit / after containment):

```ts
if (external) {
  try {
    await syncExternalClone(cfg, repoPath, { gitFn });
  } catch (e) {
    warnings.push(`could not sync external clone to upstream default: ${describeError(e)}`);
  }
}
```

6. **Replace Phase 7-9** (cap + labels + file loop) with **park**:

```ts
// --- Phase 7: Park all findings ≥ minSeverity for human review. No cap here —
// per-finding confirm (junco assess file) is the volume gate. ---
const parked: PendingAssess = {
  id: ticket.id,
  nwo,
  external,
  autoPlan: external ? false : (ticket.assess?.autoPlan ?? false),
  repoPath,
  createdAt: nowFn().toISOString(),
  findings: afterDedup, // the merged, severity-filtered, GH-deduped set
};
if (afterDedup.length > 0) writePending(cfg, parked);
counts.parked = afterDedup.length;
```

Keep Phase 6 (audit-time GH dedup pre-filter) as-is (now author-scoped via Task 2). Remove `bySeverity/toFile/overflow/cappedTitles` and the `autoPlan` local that fed labels. 7. Update the `counts` object: drop `created/queuedOffline/deduped/capped/failed`, add `parked`. `found` = `merged.length` (pre-GH-dedup) unchanged; `deduped` (audit-time) may stay as an informational count if you keep it — simplest: keep `found`, `deduped` (audit pre-filter), `dropped`, add `parked`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/assessFlow.test.ts`
Expected: PASS (adjust any remaining filing-era assertions).

- [ ] **Step 5: Commit**

```bash
git add src/assessFlow.ts tests/assessFlow.test.ts
git commit -m "feat(assess): audit parks findings for review instead of filing"
```

---

### Task 6: `assessCmd.ts` — resolution includes external repos

**Files:**

- Modify: `src/assessCmd.ts:92-102` (nwo resolution)
- Test: `tests/assessCmd.test.ts` (add external-resolution case)

**Interfaces:**

- Produces: `runAssessCommand` unchanged signature; `junco assess <external-nwo>` now resolves to the managed clone path instead of failing "not watched".

- [ ] **Step 1: Write the failing test**

Add to `tests/assessCmd.test.ts` (match its existing fake-submit style):

```ts
it("resolves an external watchlist entry to its clone path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "acmd-"));
  const c = cfg(dir); // stateDir = dir
  // write a watchlist with an external entry
  writeWatchlist(watchlistPath(c), [
    { nwo: "up/stream", path: join(dir, "clone"), external: true },
  ]);
  let submitted = "";
  const code = await runAssessCommand(
    c,
    "up/stream",
    { autoPlan: false },
    {
      printFn: () => {},
      submitFn: ((_c, content) => {
        submitted = content;
        return "/dst";
      }) as never,
    },
  );
  expect(code).toBe(0);
  expect(submitted).toContain(JSON.stringify(join(dir, "clone")));
});
```

Import `writeWatchlist, watchlistPath` from `../src/watchlist.js`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/assessCmd.test.ts -t external`
Expected: FAIL — resolution returns "not watched" (code 2).

- [ ] **Step 3: Write minimal implementation**

In `src/assessCmd.ts`, replace the `resolveWatchedRepos` lookup (which excludes external) with one that reads the raw watchlist too. Change the import and the match:

```ts
import { readWatchlist, watchlistPath } from "./watchlist.js";
// ...
if (NWO_RE.test(target) && !isDirectory(target)) {
  // Include EXTERNAL entries: assess now files (via review) on repos the operator
  // does not own, so external clones are valid targets (unlike the bridge poll,
  // which still excludes them via resolveWatchedRepos).
  const fromConfig = cfg.github.repos.find((r) => r.nwo.toLowerCase() === target.toLowerCase());
  const { entries } = readWatchlist(watchlistPath(cfg));
  const fromWatch = entries.find((e) => e.nwo.toLowerCase() === target.toLowerCase());
  const match = fromConfig ?? fromWatch;
  if (!match) {
    print(
      `junco assess: '${target}' is not watched — add it under [[github.repos]] in config.toml, or watch it from the dashboard, then retry\n`,
    );
    return 2;
  }
  repoPath = expandHome(match.path);
}
```

(Keep the `config.repos` win-on-conflict order. Remove the now-unused `resolveWatchedRepos` import if nothing else uses it.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/assessCmd.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/assessCmd.ts tests/assessCmd.test.ts
git commit -m "feat(assess): allow external watchlist repos as assess targets"
```

---

### Task 7: `junco assess review` subcommand

**Files:**

- Modify: `src/assessCmd.ts` (add `runAssessReviewCommand`)
- Modify: `src/cli.ts:397-406` (route `assess review`), `src/cli.ts:95` (usage)
- Test: `tests/assessCmd.test.ts`

**Interfaces:**

- Consumes: `listPending`, `readPending` (Task 1).
- Produces: `runAssessReviewCommand(cfg, id: string | undefined, deps?): Promise<number>` — no id → list batches (`id · nwo · N findings · age`); with id → print each finding's fingerprint, severity, title.

- [ ] **Step 1: Write the failing test**

```ts
it("assess review lists pending batches and shows one", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arv-"));
  const c = cfg(dir);
  writePending(c, {
    id: "assess-x-1",
    nwo: "o/r",
    external: true,
    autoPlan: false,
    repoPath: "/x",
    createdAt: "2026-07-09T00:00:00.000Z",
    findings: [
      {
        fingerprint: "f1",
        kind: "code",
        severity: "high",
        ruleId: "R",
        title: "Bug",
        description: "",
        references: [],
      },
    ],
  });
  let out = "";
  const print = (s: string) => {
    out += s;
  };
  expect(await runAssessReviewCommand(c, undefined, { printFn: print })).toBe(0);
  expect(out).toContain("assess-x-1");
  expect(out).toContain("o/r");

  out = "";
  expect(await runAssessReviewCommand(c, "assess-x-1", { printFn: print })).toBe(0);
  expect(out).toContain("f1");
  expect(out).toContain("Bug");
});
```

Import `writePending` from `../src/assessReview.js` and `runAssessReviewCommand` from `../src/assessCmd.js`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/assessCmd.test.ts -t "assess review"`
Expected: FAIL — `runAssessReviewCommand` not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `src/assessCmd.ts`:

```ts
import { listPending, readPending } from "./assessReview.js";

export async function runAssessReviewCommand(
  cfg: Config,
  id: string | undefined,
  deps: AssessCmdDeps = {},
): Promise<number> {
  const print = deps.printFn ?? ((s: string) => process.stdout.write(s));
  if (id === undefined) {
    const pending = listPending(cfg);
    if (pending.length === 0) {
      print("no pending assess reviews\n");
      return 0;
    }
    for (const b of pending) {
      const scope = b.external ? "external" : "owned";
      print(`${b.id}  ${b.nwo} (${scope})  ${b.findings.length} findings  ${b.createdAt}\n`);
    }
    print(`\nreview one: junco assess review <id> · file: junco assess file <id> --all\n`);
    return 0;
  }
  const { batch, error } = readPending(cfg, id);
  if (error) {
    print(`junco assess review: ${error}\n`);
    return 1;
  }
  if (!batch) {
    print(`junco assess review: no pending batch '${id}'\n`);
    return 2;
  }
  print(`${batch.id}  ${batch.nwo} (${batch.external ? "external" : "owned"})\n`);
  for (const f of batch.findings) {
    print(`  ${f.fingerprint}  [${f.severity}]  ${f.title}\n`);
  }
  print(`\nfile all: junco assess file ${batch.id} --all\n`);
  print(
    `file some: junco assess file ${batch.id} --only ${batch.findings
      .map((f) => f.fingerprint)
      .slice(0, 2)
      .join(",")}\n`,
  );
  return 0;
}
```

In `src/cli.ts`, inside `if (subcommand === "assess") {`, branch on `positionals[1]`:

```ts
if (subcommand === "assess") {
  const cfg = loadConfigFn(configPath);
  const sub = positionals[1];
  if (sub === "review") {
    const { runAssessReviewCommand } = await import("./assessCmd.js");
    return runAssessReviewCommand(cfg, positionals[2], { printFn });
  }
  // (file branch added in Task 8)
  const { runAssessCommand } = await import("./assessCmd.js");
  return runAssessCommand(
    cfg,
    positionals[1],
    { autoPlan: values["auto-plan"] === true },
    { printFn },
  );
}
```

Update the usage line at `src/cli.ts:95`:

```
  assess <path|owner/repo> [--auto-plan]  audit a repo; findings await review (junco assess review)
  assess review [<id>]                    list pending assess reviews, or show one
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/assessCmd.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/assessCmd.ts src/cli.ts tests/assessCmd.test.ts
git commit -m "feat(assess): junco assess review — list/show pending findings"
```

---

### Task 8: `junco assess file` subcommand

**Files:**

- Modify: `src/assessCmd.ts` (add `runAssessFileCommand`)
- Modify: `src/cli.ts` (route `assess file`; add `only` parseArgs option; usage)
- Test: `tests/assessCmd.test.ts`

**Interfaces:**

- Consumes: `readPending` (Task 1), `fileFindings` (Task 3).
- Produces: `runAssessFileCommand(cfg, id, opts: { all: boolean; only: string | undefined }, deps?): Promise<number>` — requires `all` or `only`; maps to a `Set<fingerprint>`; calls `fileFindings`; prints counts + URLs.

- [ ] **Step 1: Write the failing test**

```ts
it("assess file requires a selection and files the chosen findings", async () => {
  const dir = mkdtempSync(join(tmpdir(), "afc-"));
  const c = cfg(dir);
  writePending(c, {
    id: "assess-x-1",
    nwo: "o/r",
    external: true,
    autoPlan: false,
    repoPath: "/x",
    createdAt: "2026-07-09T00:00:00.000Z",
    findings: [
      {
        fingerprint: "f1",
        kind: "code",
        severity: "high",
        ruleId: "R",
        title: "One",
        description: "",
        references: [],
      },
      {
        fingerprint: "f2",
        kind: "code",
        severity: "low",
        ruleId: "R",
        title: "Two",
        description: "",
        references: [],
      },
    ],
  });
  let out = "";
  const print = (s: string) => {
    out += s;
  };

  // no selection → usage error, files nothing
  expect(
    await runAssessFileCommand(
      c,
      "assess-x-1",
      { all: false, only: undefined },
      { printFn: print },
    ),
  ).toBe(2);

  const ghFn = (async (_c: unknown, args: string[]) => {
    if (args[1] === "list") return { stdout: "[]", stderr: "", code: 0 };
    if (args[1] === "create")
      return { stdout: "https://github.com/o/r/issues/1\n", stderr: "", code: 0 };
    return { stdout: "", stderr: "", code: 0 };
  }) as never;

  out = "";
  const code = await runAssessFileCommand(
    c,
    "assess-x-1",
    { all: false, only: "f1" },
    { printFn: print, fileDeps: { ghFn } },
  );
  expect(code).toBe(0);
  expect(out).toContain("filed 1");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/assessCmd.test.ts -t "assess file"`
Expected: FAIL — `runAssessFileCommand` not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `src/assessCmd.ts` (extend `AssessCmdDeps` with an optional `fileDeps` + `fileFindingsFn` for injection):

```ts
import { fileFindings, type FileFindingsDeps } from "./assessFiling.js";

export interface AssessFileDeps {
  printFn?: (s: string) => void;
  fileDeps?: FileFindingsDeps;
  fileFindingsFn?: typeof fileFindings;
}

export async function runAssessFileCommand(
  cfg: Config,
  id: string | undefined,
  opts: { all: boolean; only: string | undefined },
  deps: AssessFileDeps = {},
): Promise<number> {
  const print = deps.printFn ?? ((s: string) => process.stdout.write(s));
  const fileFn = deps.fileFindingsFn ?? fileFindings;
  if (!id) {
    print("Usage: junco assess file <id> --all | --only <fp,fp,...>\n");
    return 2;
  }
  if (!opts.all && !opts.only) {
    print("junco assess file: choose findings with --all or --only <fp,...>\n");
    return 2;
  }
  const { batch, error } = readPending(cfg, id);
  if (error) {
    print(`junco assess file: ${error}\n`);
    return 1;
  }
  if (!batch) {
    print(`junco assess file: no pending batch '${id}'\n`);
    return 2;
  }
  const selected = opts.all
    ? new Set(batch.findings.map((f) => f.fingerprint))
    : new Set(
        (opts.only ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      );

  const res = await fileFn(cfg, batch, selected, deps.fileDeps ?? {});
  print(
    `filed ${res.created} · queued ${res.queuedOffline} · already-filed ${res.deduped} · failed ${res.failed}\n`,
  );
  for (const u of res.urls) print(`  ${u}\n`);
  for (const w of res.warnings) print(`  ! ${w}\n`);
  return res.failed > 0 ? 1 : 0;
}
```

In `src/cli.ts`: add `only: { type: "string" }` to the parseArgs `options` (near `all` on line 179), route the `file` sub, and add usage:

```ts
if (sub === "file") {
  const { runAssessFileCommand } = await import("./assessCmd.js");
  return runAssessFileCommand(
    cfg,
    positionals[2],
    { all: values.all === true, only: values.only as string | undefined },
    { printFn },
  );
}
```

Usage line:

```
  assess file <id> --all | --only <fp,...>  file reviewed findings as issues
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/assessCmd.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/assessCmd.ts src/cli.ts tests/assessCmd.test.ts
git commit -m "feat(assess): junco assess file — confirm and file reviewed findings"
```

---

### Task 9: surface pending-review count in status + doctor

**Files:**

- Modify: `src/statusCmd.ts:94-98`
- Modify: `src/doctor.ts:201-206` (mirror the outbox backlog check)
- Test: `tests/statusCmd.test.ts` (if present; else assert via a focused unit test)

**Interfaces:**

- Consumes: `pendingCount` (Task 1).

- [ ] **Step 1: Write the failing test**

In `tests/statusCmd.test.ts` (match its existing harness; if the file does not exist, add a minimal one that calls `runStatusCommand` with a stateDir holding one pending batch and asserts the output). Assertion:

```ts
it("status shows the pending assess-review count", async () => {
  const dir = mkdtempSync(join(tmpdir(), "st-"));
  const c = cfg(dir);
  writePending(c, {
    id: "a",
    nwo: "o/r",
    external: true,
    autoPlan: false,
    repoPath: "/x",
    createdAt: "2026-07-09T00:00:00.000Z",
    findings: [],
  });
  let out = "";
  await runStatusCommand(c, {
    printFn: (s: string) => {
      out += s;
    } /* + any required stubs */,
  });
  expect(out).toContain("assess review");
  expect(out).toMatch(/1 pending/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/statusCmd.test.ts -t pending`
Expected: FAIL — no such line.

- [ ] **Step 3: Write minimal implementation**

In `src/statusCmd.ts`, add after the outbox block (line ~98):

```ts
import { pendingCount } from "./assessReview.js";
// ...
const reviews = pendingCount(cfg);
if (reviews > 0) {
  print(`assess review: ${reviews} pending (junco assess review)\n`);
}
```

In `src/doctor.ts`, mirror the outbox backlog finding (after the `outboxDepth` block, ~line 205):

```ts
import { pendingCount } from "./assessReview.js";
// ...
const reviews = pendingCount(cfg);
if (reviews > 0) {
  findings.push({
    level: "info",
    message: `${reviews} assess finding(s) awaiting review (junco assess review)`,
  });
}
```

(Match `doctor.ts`'s actual finding-push shape — use its existing `level`/`message` object form.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/statusCmd.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/statusCmd.ts src/doctor.ts tests/statusCmd.test.ts
git commit -m "feat(assess): surface pending review count in status and doctor"
```

---

### Task 10: documentation

**Files:**

- Modify: `docs/superpowers/specs/2026-07-08-external-repo-dispatch-design.md` (invariant pointer)
- Modify: `README.md` (assess section)
- Modify: `skills/junco-dispatch/SKILL.md` (or the packaged skill's assess-mode text — locate with grep)
- Modify: `ARCHITECTURE.md` (module map)

- [ ] **Step 1: Update the etiquette invariant pointer**

In `2026-07-08-external-repo-dispatch-design.md`, at the "Etiquette invariant" line (~29), append:

```markdown
> **Superseded (2026-07-09):** the "no comments/issues on the upstream tracker" clause is
> lifted for `junco assess` under a human-confirmed review gate — see
> `2026-07-09-assess-any-repo-review-queue-design.md`. Dispatch's fork/push/PR clauses stand.
```

- [ ] **Step 2: Update README assess section**

Locate the assess prose (grep `assess` in `README.md`). Replace "files issues directly" framing with: assess now **audits then parks findings for review**; you file them per-finding with `junco assess review` / `junco assess file <id>`; works on **any watched repo, owned or not** (unowned repos get label-free issues). Keep it stack-agnostic — no personal-setup strings, say "inference endpoint" not a server name.

- [ ] **Step 3: Update the packaged skill**

Grep for the assess-mode blurb: `grep -rn "one GitHub issue per finding" skills/`. Update it to describe the review→confirm gate and external-repo eligibility. No personal-setup strings (omp/omlx/pi/launchd/vault/model names) — the packaged skill ships stack-agnostic.

- [ ] **Step 4: Update ARCHITECTURE.md module map**

Add `assessReview.ts` (durable review store) and `assessFiling.ts` (least-privilege filing core) to the module map, and note assess is now two-phase (audit parks → CLI confirm files).

- [ ] **Step 5: Commit**

```bash
git add docs/ README.md skills/ ARCHITECTURE.md
git commit -m "docs: assess review queue + redrawn etiquette invariant"
```

---

## Final verification (run before opening the PR)

- [ ] **Full gate:** `npm run lint && npm run format:check && npm run typecheck && npm run build && npm test` — capture vitest exit explicitly (`npx vitest run > /tmp/out 2>&1; echo "exit: $?"`).
- [ ] **Type sweep for tests** (CLAUDE.md gotcha — lint doesn't type-check tests/): `npx tsc --noEmit -p tsconfig.eslint.json` and confirm no NEW errors beyond the ~57 pre-existing (see the test-type-sweep memory).
- [ ] **Attribution sweep:** `git log origin/main..HEAD --format='%an %ae%n%b' | grep -i claude` returns nothing; amend away any subagent-added `Co-Authored-By` trailer.
- [ ] **Live check (throwaway repo only):** on a scratch repo you own but pass no labels, confirm `gh issue create --repo <you>/<scratch> --title t --body b` succeeds and that adding `--label doesnotexist` fails — validating the label-free path's premise. Never run against a real project.
- [ ] **Merge `origin/main`** into the branch (parallel-session drift) and re-run the gate.

## Self-review (completed by plan author)

- **Spec coverage:** two-phase split (Tasks 3,5) · durable store (Task 1) · least-privilege filing + best-effort labels (Task 3) · author-scoped unified dedup (Task 2) · external detection + freshness sync (Tasks 4,5) · gate removal (Task 6) · CLI review/file (Tasks 7,8) · status/health (Task 9) · docs + invariant (Task 10). Per-finding select is the `--only`/`--all` selection (Task 8); the TUI checklist is Plan 2 (out of scope). `maxIssuesPerRun` repurposing: parking ignores it (Task 5); the pre-selection default is a review-UI concern deferred to Plan 2 — noted, not silently dropped.
- **Placeholders:** none — every code step carries real code; the one "match the file's existing fixture" notes point at concrete existing helpers.
- **Type consistency:** `PendingAssess`/`fileFindings`/`FileResult`/`fetchFindingMarkers` signatures are consistent across Tasks 1,3,5,7,8; `AssessFlowResult` field swap (`created…→parked`) is called out in Task 5.
