/**
 * Tests for src/planSetBridge.ts — the plan-set dispatch door (spec
 * 2026-08-20, Layer 2): compile → materialize → fan-out, called from
 * pollGithubInbox's plan-ready branch when planSets.enabled. Written FIRST
 * (TDD). dispatchPlanSet itself needs NO gh — it is pure fs (compiler +
 * planSets store), so these tests exercise it directly with no gh fakes.
 *
 * maintainPlanSets (Task 10) is the sweep-driven maintenance door: dashboard
 * comment, set-level labels, degraded comment. Its tests use a REAL fake-gh
 * SHELL SCRIPT (not a JS ghFn stub) because the assertions need the actual
 * comment bytes gh received — dashboard/degraded bodies are written to a
 * tempfile and passed as `-F body=@file` / `--body-file file`, and that
 * tempfile is rm'd by the caller right after the gh call returns. The fake
 * script logs each call as `>>> <argv>\n<body if any>\n<<<\n` so the test can
 * recover both the argv and the exact body bytes per call.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  rmSync,
  chmodSync,
} from "node:fs";
import type { Config, Paths } from "../src/types.js";
import { queuePaths } from "../src/config.js";
import { readPlanSetRecord, writePlanSetRecord, type PlanSetRecord } from "../src/planSets.js";
import { dispatchPlanSet, maintainPlanSets } from "../src/planSetBridge.js";
import { makeConfig } from "./helpers/config.js";

const NOW = "2026-08-20T12:00:00.000Z";

const FENCE = `version: 1
tasks:
  - {id: a, title: T A, depends_on: [], description: Build A., acceptance: [works]}
  - {id: b, title: T B, depends_on: [a], description: Build B., acceptance: [works]}
`;

describe("dispatchPlanSet", () => {
  let root: string;
  let cfg: Config;
  let qp: Paths;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "junco-bridge-"));
    cfg = makeConfig(
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
      { planSets: { enabled: true, mergePollSeconds: 60, maxTasks: 10 } },
    );
    qp = queuePaths(cfg);
    mkdirSync(qp.inbox, { recursive: true });
    mkdirSync(qp.processing, { recursive: true });
    mkdirSync(qp.done, { recursive: true });
    mkdirSync(qp.failed, { recursive: true });
  });

  it("compiles, materializes, and fans out; record carries the children", () => {
    const r = dispatchPlanSet(cfg, { nwo: "acme/api", path: "/sbxroot/clone" }, 9, FENCE, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.submitted).toHaveLength(2);
    const rec = readPlanSetRecord(cfg, r.submitted[0].replace(/-a$/, ""));
    expect(rec).not.toBeNull();
    expect(rec?.tasks.map((t) => t.id)).toEqual(["a", "b"]);
    expect(rec?.github).toEqual({ nwo: "acme/api", issue: 9 });
    expect(existsSync(join(qp.inbox, `${rec?.planId}-a.md`))).toBe(true);
  });

  it("compile errors dispatch nothing and return the whole error list", () => {
    const r = dispatchPlanSet(
      cfg,
      { nwo: "acme/api", path: "/p" },
      9,
      "version: 1\ntasks: []",
      NOW,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.length).toBeGreaterThan(0);
    expect(readdirSync(qp.inbox)).toEqual([]);
  });

  it("re-dispatch after a crash resubmits only missing children (done child skipped)", () => {
    const first = dispatchPlanSet(cfg, { nwo: "acme/api", path: "/p" }, 9, FENCE, NOW);
    if (!first.ok) throw new Error("setup");
    const planId = first.submitted[0].replace(/-a$/, "");
    // child a "finished" while the label swap was lost:
    renameSync(join(qp.inbox, `${planId}-a.md`), join(qp.done, `${planId}-a.md`));
    rmSync(join(qp.inbox, `${planId}-b.md`));
    const again = dispatchPlanSet(cfg, { nwo: "acme/api", path: "/p" }, 9, FENCE, NOW);
    expect(again.ok && again.submitted).toEqual([`${planId}-b`]);
    expect(again.ok && again.skipped).toEqual([`${planId}-a`]);
  });
});

// ---------------------------------------------------------------------------
// maintainPlanSets — sweep-driven dashboard, labels, degraded comment
// ---------------------------------------------------------------------------

interface CallBlock {
  argv: string;
  body: string;
}

/** Parses the fake-gh log into per-call {argv, body} blocks (see the fake-gh
 * script comment below for the log format). */
function parseLog(log: string): CallBlock[] {
  const blocks: CallBlock[] = [];
  const re = />>> ([^\n]*)\n([\s\S]*?)<<<\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(log))) {
    blocks.push({ argv: m[1], body: m[2] });
  }
  return blocks;
}

/**
 * Writes a fake-gh shell script that logs every invocation as
 * `>>> <argv>\n<body-file contents if any>\n<<<\n` to `argsFile`, then
 * dispatches on argv shape:
 *   - `api repos/<nwo>/issues/<n>/comments -F body=@… --jq .id` → dashboard
 *     CREATE: prints `555` (the new comment id).
 *   - `api repos/<nwo>/issues/comments/<id> -X PATCH -F body=@…` → dashboard
 *     UPDATE: exits 0, unless `opts.patch404` — then it exits 1 with stderr
 *     containing "404" (simulating a deleted comment), same shape gh itself
 *     uses for a real API 404.
 *   - `issue edit …` / `issue comment …` → label swap / degraded comment:
 *     exits 0.
 *   - anything else → logs "unhandled" to stderr and exits 1 (a silent gap
 *     in the fake would otherwise read as a passing test).
 */
function writeFakeGh(
  root: string,
  opts: { patch404?: boolean } = {},
): { ghBin: string; argsFile: string } {
  const argsFile = join(root, "gh.log");
  const ghBin = join(root, "fake-gh.sh");
  const patchBody = opts.patch404
    ? `echo "HTTP 404: Not Found (https://api.github.com/repos/x/issues/comments/1)" >&2; exit 1`
    : `exit 0`;
  writeFileSync(
    ghBin,
    `#!/bin/sh
{
  printf '>>> %s\\n' "$*"
  prevarg=""
  for arg in "$@"; do
    if [ "$prevarg" = "--body-file" ]; then
      cat "$arg"
      printf '\\n'
    fi
    case "$arg" in
      body=@*)
        f=$(printf '%s' "$arg" | cut -c7-)
        cat "$f"
        printf '\\n'
        ;;
    esac
    prevarg="$arg"
  done
  printf '<<<\\n'
} >> ${JSON.stringify(argsFile)}
args="$*"
case "$args" in
  "api repos/"*"/comments -F body=@"*" --jq .id")
    echo 555
    exit 0
    ;;
  "api repos/"*"/issues/comments/"*" -X PATCH -F body=@"*)
    ${patchBody}
    ;;
  "issue edit "*)
    exit 0
    ;;
  "issue comment "*)
    exit 0
    ;;
  *)
    echo "fake-gh: unhandled: $args" >&2
    exit 1
    ;;
esac
`,
    "utf8",
  );
  chmodSync(ghBin, 0o755);
  return { ghBin, argsFile };
}

function baseRecord(overrides: Partial<PlanSetRecord> = {}): PlanSetRecord {
  return {
    v: 1,
    planId: "p1",
    hash: "abc123",
    repoPath: "/sbxroot/repo",
    github: { nwo: "acme/api", issue: 9 },
    tasks: [{ id: "a", ticketId: "p1-a", dependsOn: [] }],
    createdAt: "2026-08-20T00:00:00Z",
    statusCommentId: null,
    degradedPosted: false,
    lastLabel: null,
    closed: false,
    ...overrides,
  };
}

describe("maintainPlanSets", () => {
  let root: string;
  let cfg: Config;
  let qp: Paths;
  let ghBin: string;
  let argsFile: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "junco-maintain-"));
    const fake = writeFakeGh(root);
    ghBin = fake.ghBin;
    argsFile = fake.argsFile;
    cfg = makeConfig(
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
      { ghBin, planSets: { enabled: true, mergePollSeconds: 60, maxTasks: 10 } },
    );
    qp = queuePaths(cfg);
    mkdirSync(qp.inbox, { recursive: true });
    mkdirSync(qp.processing, { recursive: true });
    mkdirSync(qp.done, { recursive: true });
    mkdirSync(qp.failed, { recursive: true });
  });

  const readLog = (): CallBlock[] =>
    existsSync(argsFile) ? parseLog(readFileSync(argsFile, "utf8")) : [];

  it("first maintenance posts the dashboard, stores the comment id, applies working label", async () => {
    // Two tasks: "a" is mid-run (processing), "b" depends on "a" and hasn't
    // been picked up yet (still in inbox, dep unsatisfied) — this also
    // covers the carried-over gap: renderDashboard's "waiting on: …" row.
    const rec = baseRecord({
      tasks: [
        { id: "a", ticketId: "p1-a", dependsOn: [] },
        { id: "b", ticketId: "p1-b", dependsOn: ["p1-a"] },
      ],
    });
    writePlanSetRecord(cfg, rec);
    writeFileSync(join(qp.processing, "p1-a.md"), "---\nid: p1-a\n---\n");
    writeFileSync(join(qp.inbox, "p1-b.md"), "---\nid: p1-b\ndepends_on: [p1-a]\n---\n");

    await maintainPlanSets(cfg);

    const blocks = readLog();
    const create = blocks.find((b) => b.argv.includes("--jq .id"));
    expect(create).toBeDefined();
    expect(create!.argv).toContain(`repos/acme/api/issues/9/comments`);
    expect(create!.body).toContain("waiting on: `p1-a`");

    const labelSwap = blocks.find((b) => b.argv.startsWith("issue edit"));
    expect(labelSwap).toBeDefined();
    expect(labelSwap!.argv).toContain("--add-label junco:working");
    expect(labelSwap!.argv).toContain("--remove-label junco:queued");

    const persisted = readPlanSetRecord(cfg, "p1");
    expect(persisted?.statusCommentId).toBe(555);
    expect(persisted?.lastLabel).toBe("junco:working");
    // trimEnd: the fake-gh log adds a trailing blank line after `cat`-ing the
    // body file that isn't part of the actual bytes gh received as content.
    expect(persisted?.lastDashboard?.trimEnd()).toBe(create!.body.trimEnd());
    expect(persisted?.closed).toBe(false);
  });

  it("unchanged state produces zero gh calls on the next sweep", async () => {
    const rec = baseRecord({
      tasks: [{ id: "a", ticketId: "p1-a", dependsOn: [] }],
    });
    writePlanSetRecord(cfg, rec);
    writeFileSync(join(qp.processing, "p1-a.md"), "---\nid: p1-a\n---\n");

    await maintainPlanSets(cfg);
    const afterFirst = readLog().length;
    expect(afterFirst).toBeGreaterThan(0);

    await maintainPlanSets(cfg);
    const afterSecond = readLog().length;
    expect(afterSecond).toBe(afterFirst);
  });

  it("failure posts one degraded comment (once) and the failed label at all-terminal", async () => {
    // "a" done, "b" failed with a dependency-failure reason — this also
    // covers the carried-over gap: renderDashboard's
    // "failed — dependency `X` failed" row.
    const rec = baseRecord({
      tasks: [
        { id: "a", ticketId: "p1-a", dependsOn: [] },
        { id: "b", ticketId: "p1-b", dependsOn: [] },
      ],
    });
    writePlanSetRecord(cfg, rec);
    writeFileSync(
      join(qp.done, "p1-a.md"),
      "---\nid: p1-a\n---\nA\n\n---\n<!-- junco-result\nstatus: completed\n-->\n",
    );
    writeFileSync(
      join(qp.failed, "p1-b.md"),
      "---\nid: p1-b\n---\nB\n\n---\n<!-- junco-result\nstatus: failed\ndependency_failed: ext-dep-x\n-->\n",
    );

    await maintainPlanSets(cfg);
    const blocks1 = readLog();
    const dashboard1 = blocks1.find((b) => b.argv.includes("--jq .id"));
    expect(dashboard1?.body).toContain("failed — dependency `ext-dep-x` failed");
    const degradedComments1 = blocks1.filter((b) => b.argv.startsWith("issue comment"));
    expect(degradedComments1).toHaveLength(1);

    const afterFirst = readPlanSetRecord(cfg, "p1");
    expect(afterFirst?.degradedPosted).toBe(true);
    expect(afterFirst?.lastLabel).toBe("junco:failed");
    expect(afterFirst?.closed).toBe(true);

    // Second sweep: closed records are skipped entirely — degraded comment
    // must stay posted exactly once, and the closed record shouldn't get
    // re-processed (no new label/dashboard calls at all).
    await maintainPlanSets(cfg);
    const blocks2 = readLog();
    const degradedComments2 = blocks2.filter((b) => b.argv.startsWith("issue comment"));
    expect(degradedComments2).toHaveLength(1); // unchanged — still exactly one, ever
    expect(blocks2.length).toBe(blocks1.length); // closed → fully skipped
  });

  it("dashboard body change on a later sweep PATCHes the existing comment (not create)", async () => {
    const rec = baseRecord({ tasks: [{ id: "a", ticketId: "p1-a", dependsOn: [] }] });
    writePlanSetRecord(cfg, rec);
    writeFileSync(join(qp.processing, "p1-a.md"), "---\nid: p1-a\n---\n");

    await maintainPlanSets(cfg);
    expect(readPlanSetRecord(cfg, "p1")?.statusCommentId).toBe(555);

    // Task finishes — dashboard body changes (processing → done).
    renameSync(join(qp.processing, "p1-a.md"), join(qp.done, "p1-a.md"));
    writeFileSync(
      join(qp.done, "p1-a.md"),
      "---\nid: p1-a\n---\nA\n\n---\n<!-- junco-result\nstatus: completed\n-->\n",
    );

    await maintainPlanSets(cfg);
    const blocks = readLog();
    const patch = blocks.find((b) => b.argv.includes("-X PATCH"));
    expect(patch).toBeDefined();
    expect(patch!.argv).toContain("repos/acme/api/issues/comments/555");
    expect(patch!.body).toContain("- [x] `a` — done");
    // No second create call — the PATCH path reused the cached id.
    expect(blocks.filter((b) => b.argv.includes("--jq .id"))).toHaveLength(1);

    const persisted = readPlanSetRecord(cfg, "p1");
    expect(persisted?.lastLabel).toBe("junco:done");
    expect(persisted?.closed).toBe(true);
  });

  it("PATCH 404 (comment deleted) nulls the cached statusCommentId so the next sweep recreates", async () => {
    // Two tasks: "a" finishes partway through (triggering the dashboard
    // PATCH under test); "b" stays processing throughout, so the set never
    // goes all-terminal/closed — closing gates a "next sweep" from happening
    // at all (item 5 is unconditional on allTerminal, independent of whether
    // the dashboard sync itself succeeded), which would make a "recreates on
    // the next sweep" assertion untestable with a single-task record.
    //
    // beforeEach already wrote a normal fake-gh at cfg.ghBin; each writeFakeGh
    // call below overwrites that same script file to swap its PATCH behavior
    // for the next sweep, without touching cfg.ghBin itself.
    const rec = baseRecord({
      tasks: [
        { id: "a", ticketId: "p1-a", dependsOn: [] },
        { id: "b", ticketId: "p1-b", dependsOn: [] },
      ],
    });
    writePlanSetRecord(cfg, rec);
    writeFileSync(join(qp.processing, "p1-a.md"), "---\nid: p1-a\n---\n");
    writeFileSync(join(qp.processing, "p1-b.md"), "---\nid: p1-b\n---\n");

    await maintainPlanSets(cfg);
    expect(readPlanSetRecord(cfg, "p1")?.statusCommentId).toBe(555);

    renameSync(join(qp.processing, "p1-a.md"), join(qp.done, "p1-a.md"));
    writeFileSync(
      join(qp.done, "p1-a.md"),
      "---\nid: p1-a\n---\nA\n\n---\n<!-- junco-result\nstatus: completed\n-->\n",
    );

    writeFakeGh(root, { patch404: true }); // this sweep's PATCH returns 404
    await maintainPlanSets(cfg);
    const afterPatch404 = readPlanSetRecord(cfg, "p1");
    expect(afterPatch404?.statusCommentId).toBeNull();
    expect(afterPatch404?.closed).toBe(false); // "b" is still processing
    // lastDashboard must NOT have advanced to the new body — a failed sync
    // must not be recorded as synced, or the next sweep would wrongly skip.
    expect(afterPatch404?.lastDashboard).not.toContain("- [x] `a` — done");

    writeFakeGh(root); // back to normal — third sweep recreates
    await maintainPlanSets(cfg);
    expect(readPlanSetRecord(cfg, "p1")?.statusCommentId).toBe(555);
  });
});
