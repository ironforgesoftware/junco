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

import { describe, it, expect, beforeEach, vi } from "vitest";
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
import {
  readPlanSetRecord,
  writePlanSetRecord,
  plansDir,
  type PlanSetRecord,
} from "../src/planSets.js";
import { dispatchPlanSet, maintainPlanSets } from "../src/planSetBridge.js";
import { PLAN_COMMENT_MARKER, PLAN_SET_FENCE, extractPlanSetBody } from "../src/githubInbox.js";
import { hashPlan } from "../src/planCompiler.js";
import { sweepDependencies } from "../src/ticketDeps.js";
import { log } from "../src/logging.js";
import { makeConfig } from "./helpers/config.js";

// Boxed passthrough (mirrors tests/daemon.test.ts's runOnceBox pattern): every
// test gets the REAL submitTicket unless it overrides `.current` for its own
// duration. Needed only by the crash-window test below — a genuine per-child
// linkSync EEXIST race can't be forced from a test: whatever file we'd place
// to collide is exactly what ticketState's own pre-check would already read
// as "already landed" and skip BEFORE ever reaching submitTicket.
const submitTicketBox = vi.hoisted(() => ({
  current: null as unknown as (...a: unknown[]) => unknown,
}));
vi.mock("../src/dispatch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/dispatch.js")>();
  submitTicketBox.current = actual.submitTicket as unknown as (...a: unknown[]) => unknown;
  return {
    ...actual,
    submitTicket: (...args: unknown[]) => submitTicketBox.current(...args),
  };
});

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
 *   - `api user --jq .login` → the bridge's own viewer login (`opts.login`,
 *     default "junco-bot") — trySupersede's findOwnPlanComment author filter.
 *   - `api --paginate repos/<nwo>/issues/<n>/comments --jq …` → the OWN plan
 *     comment(s) NDJSON (`opts.comments`, default "" = none found) — mirrors
 *     tests/githubInbox.test.ts's `comments` fake.
 *   - `api --paginate repos/<nwo>/issues/<n>/events --jq …` → labeled-event
 *     NDJSON for `verifyLabelApplier` (`opts.events`, default "" = none) —
 *     mirrors tests/githubInbox.test.ts's `events`/`labeledEvent` fake.
 *   - `api repos/<nwo>/collaborators/<actor>/permission --jq .permission` →
 *     `opts.permission` (default "write") — mirrors tests/githubInbox.test.ts.
 *   - `issue view <n> --repo <nwo> --json labels` → `opts.issueLabels`
 *     (default `{"labels":[]}`) — trySupersede's approval-label read.
 *   - `issue edit …` / `issue comment …` → label swap / degraded/failure
 *     comment: exits 0.
 *   - anything else → logs "unhandled" to stderr and exits 1 (a silent gap
 *     in the fake would otherwise read as a passing test).
 */
function writeFakeGh(
  root: string,
  opts: {
    patch404?: boolean;
    login?: string;
    comments?: string;
    events?: string;
    permission?: string;
    issueLabels?: string;
  } = {},
): { ghBin: string; argsFile: string } {
  const argsFile = join(root, "gh.log");
  const ghBin = join(root, "fake-gh.sh");
  const patchBody = opts.patch404
    ? `echo "HTTP 404: Not Found (https://api.github.com/repos/x/issues/comments/1)" >&2; exit 1`
    : `exit 0`;
  const login = opts.login ?? "junco-bot";
  const comments = opts.comments ?? "";
  const events = opts.events ?? "";
  const permission = opts.permission ?? "write";
  const issueLabels = opts.issueLabels ?? '{"labels":[]}';
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
  "api --paginate repos/"*"/issues/"*"/comments --jq "*)
    cat <<'JUNCO_COMMENTS_EOF'
${comments}
JUNCO_COMMENTS_EOF
    exit 0
    ;;
  "api --paginate repos/"*"/issues/"*"/events --jq "*)
    cat <<'JUNCO_EVENTS_EOF'
${events}
JUNCO_EVENTS_EOF
    exit 0
    ;;
  "api repos/"*"/collaborators/"*"/permission --jq .permission")
    echo ${JSON.stringify(permission)}
    exit 0
    ;;
  "api user --jq .login")
    echo ${JSON.stringify(login)}
    exit 0
    ;;
  "issue view "*" --json labels")
    cat <<'JUNCO_LABELS_EOF'
${issueLabels}
JUNCO_LABELS_EOF
    exit 0
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

  it("unchanged state repeats only the supersede check on the next sweep (no dashboard/label churn)", async () => {
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
    // Every sweep re-checks each open record for an edited/re-approved plan
    // comment (trySupersede: a login fetch + the own-comment fetch) — that
    // per-sweep cost is unavoidable and load-bearing (it's how a closed set
    // ever notices a reopen). With no comment configured, findOwnPlanComment
    // returns null and trySupersede exits immediately, so the delta is
    // exactly those two calls — no repeated dashboard/label churn beneath it.
    expect(afterSecond - afterFirst).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Cold window (#298) — a record closed long enough ago stops paying the
  // per-sweep supersede probe (login + own-comment fetch) at all.
  // -------------------------------------------------------------------------

  it("does not probe a record closed longer ago than the cold window", async () => {
    writePlanSetRecord(cfg, baseRecord({ closed: true, closedAt: "2020-01-01T00:00:00.000Z" }));
    const before = readLog().length;
    await maintainPlanSets(cfg, { nowIso: "2026-08-22T00:00:00.000Z" });
    expect(readLog().length).toBe(before);
  });

  it("still probes a recently-closed record", async () => {
    writePlanSetRecord(cfg, baseRecord({ closed: true, closedAt: "2026-08-21T00:00:00.000Z" }));
    const before = readLog().length;
    await maintainPlanSets(cfg, { nowIso: "2026-08-22T00:00:00.000Z" });
    expect(readLog().length).toBeGreaterThan(before);
  });

  it("still probes a closed record from before closedAt existed", async () => {
    // No closedAt at all — older records predate the field. Must be treated
    // as warm (never silently skipped).
    writePlanSetRecord(cfg, baseRecord({ closed: true }));
    const before = readLog().length;
    await maintainPlanSets(cfg, { nowIso: "2026-08-22T00:00:00.000Z" });
    expect(readLog().length).toBeGreaterThan(before);
  });

  it("a closed record with no closedAt acquires one after a sweep, and a later sweep past the window skips it", async () => {
    // Without this stamp, a set closed BEFORE the cold-window upgrade would
    // stay warm forever — the exact cost #298's TTL was meant to bound —
    // because the absent-closedAt-means-warm rule above never lets it go
    // cold on its own.
    writePlanSetRecord(cfg, baseRecord({ closed: true }));
    await maintainPlanSets(cfg, { nowIso: "2026-08-22T00:00:00.000Z" });
    expect(readPlanSetRecord(cfg, "p1")?.closedAt).toBe("2026-08-22T00:00:00.000Z");

    // One window later (>30 days), the now-stamped record goes cold: the
    // next sweep skips its supersede probe entirely, same as a record that
    // was closed with a fresh closedAt from the start.
    const before = readLog().length;
    await maintainPlanSets(cfg, { nowIso: "2026-09-22T00:00:00.000Z" });
    expect(readLog().length).toBe(before);
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

    // Second sweep: closed records skip dashboard/label maintenance — degraded
    // comment must stay posted exactly once, and no new label/dashboard calls
    // fire — but a closed record is still a supersede CANDIDATE (a human can
    // edit + re-approve a finished set's plan comment to reopen it), so the
    // per-sweep supersede check (login + own-comment fetch) still runs; with
    // no comment configured it finds nothing and the record stays closed.
    await maintainPlanSets(cfg);
    const blocks2 = readLog();
    const degradedComments2 = blocks2.filter((b) => b.argv.startsWith("issue comment"));
    expect(degradedComments2).toHaveLength(1); // unchanged — still exactly one, ever
    expect(blocks2.length).toBe(blocks1.length + 2); // +supersede check only
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

  // -------------------------------------------------------------------------
  // Supersede — an edited, re-approved plan comment recompiles the set.
  // -------------------------------------------------------------------------

  const OWN_LOGIN = "junco-bot";
  const APPROVER = "alice";
  const COMMENT_CREATED_AT = "2026-08-20T00:00:00.000Z";
  const COMMENT_UPDATED_AT = "2026-08-20T10:00:00.000Z"; // the edit
  const APPROVAL_AT = "2026-08-20T11:00:00.000Z"; // re-approved AFTER the edit

  /** Wraps a `junco-plan` fence the way the bridge's own dashboard/plan
   * comment does — marker + a complete ```junco-plan fence — so
   * findOwnPlanComment/extractPlanSetBody can recover it. */
  function ownPlanComment(fence: string): string {
    return [
      PLAN_COMMENT_MARKER,
      "",
      "Edited plan.",
      "",
      "```" + PLAN_SET_FENCE,
      fence.trimEnd(),
      "```",
      "",
    ].join("\n");
  }

  /** fake-gh options for "own comment (edited fence) + a fresh `approved`
   * label from a verified writer, postdating the edit" — the exact shape
   * trySupersede's approval gate requires. */
  function approvedSupersedeGhOpts(fence: string): {
    login: string;
    comments: string;
    events: string;
    permission: string;
    issueLabels: string;
  } {
    return {
      login: OWN_LOGIN,
      comments: JSON.stringify({
        author: OWN_LOGIN,
        body: ownPlanComment(fence),
        created_at: COMMENT_CREATED_AT,
        updated_at: COMMENT_UPDATED_AT,
      }),
      events: JSON.stringify({
        actor: APPROVER,
        label: "junco:approved",
        created_at: APPROVAL_AT,
      }),
      permission: "write",
      issueLabels: JSON.stringify({ labels: [{ name: "junco:approved" }] }),
    };
  }

  const EDITED_FENCE = `version: 1
tasks:
  - {id: a, title: T A, depends_on: [], description: Build A., acceptance: [works]}
  - {id: b, title: T B v2, depends_on: [], description: Build B v2., acceptance: [works]}
  - {id: c, title: T C, depends_on: [], description: Build C., acceptance: [works]}
`;

  it("supersede: edited+approved plan recompiles, skips done tasks, resets degraded/closed", async () => {
    const rec = baseRecord({
      hash: "orig-hash",
      tasks: [
        { id: "a", ticketId: "p1-a", dependsOn: [] },
        { id: "b", ticketId: "p1-b", dependsOn: [] },
      ],
      statusCommentId: 777,
      degradedPosted: true,
      lastLabel: "junco:done",
      closed: true, // a finished set — supersede must reopen it
      lastDashboard: "stale dashboard body",
    });
    writePlanSetRecord(cfg, rec);
    writeFileSync(
      join(qp.done, "p1-a.md"),
      "---\nid: p1-a\n---\nA\n\n---\n<!-- junco-result\nstatus: completed\n-->\n",
    );
    writeFileSync(join(qp.inbox, "p1-b.md"), "---\nid: p1-b\n---\nOld B body\n");

    writeFakeGh(root, approvedSupersedeGhOpts(EDITED_FENCE));
    await maintainPlanSets(cfg);

    const expectedHash = hashPlan(extractPlanSetBody(ownPlanComment(EDITED_FENCE)) as string);

    // 1. The old, unclaimed "b" is superseded-failed (never ran) — moved to
    // failed/ before the fresh "b" (below) is resubmitted into inbox.
    const supersededB = readFileSync(join(qp.failed, "p1-b.md"), "utf8");
    expect(supersededB).toContain("status: failed");
    expect(supersededB).toContain(`superseded: ${expectedHash}`);
    expect(supersededB).not.toContain("dependency_failed");
    expect(supersededB).toContain("Old B body"); // original content preserved above the marker

    // 2. Fresh "b" (edited content) and brand-new "c" land in inbox; "a"
    // (done) is skipped by the whole-queue idempotence check.
    const freshB = readFileSync(join(qp.inbox, "p1-b.md"), "utf8");
    expect(freshB).toContain("T B v2");
    expect(existsSync(join(qp.inbox, "p1-c.md"))).toBe(true);
    expect(readFileSync(join(qp.inbox, "p1-c.md"), "utf8")).toContain("T C");
    expect(existsSync(join(qp.done, "p1-a.md"))).toBe(true); // untouched

    // 3. The record is FRESH: new hash, same planId, degraded/closed reset,
    // statusCommentId kept. lastLabel is re-derived by the ordinary
    // maintenance steps that run in the SAME sweep against this fresh
    // record (queued: "a" done, "b"/"c" freshly queued — none processing).
    const persisted = readPlanSetRecord(cfg, "p1");
    expect(persisted?.planId).toBe("p1");
    expect(persisted?.hash).toBe(expectedHash);
    expect(persisted?.hash).not.toBe("orig-hash");
    expect(persisted?.statusCommentId).toBe(777);
    expect(persisted?.degradedPosted).toBe(false);
    expect(persisted?.closed).toBe(false);
    expect(persisted?.lastLabel).toBe("junco:queued");
    expect(persisted?.tasks.map((t) => t.id).sort()).toEqual(["a", "b", "c"]);

    // 4. The plan.md copy was also refreshed.
    expect(readFileSync(join(plansDir(cfg), "p1.md"), "utf8")).toContain("T B v2");

    // 5. The `approved` label that authorized this supersede is removed.
    const blocks = readLog();
    const approvedRemoval = blocks.find((b) => b.argv.includes("--remove-label junco:approved"));
    expect(approvedRemoval).toBeDefined();
  });

  // #293-critical-4: crash-idempotent supersede ordering — the fan-out loop
  // must run to completion (containing any per-child submit failure) BEFORE
  // the fresh record is materialized, not after. This test can't force a
  // genuine crash mid-loop, so it proves the same observable shape a crash
  // would leave behind via the next-closest thing: one child's submitTicket
  // call throws (simulating an inbox-slug collision) while its siblings
  // succeed. It demonstrates two things the OLD (materialize-then-fan-out)
  // ordering could not guarantee together: (a) a per-child failure is
  // contained — the rest of the fan-out still lands, and (b) the record is
  // written only AFTER the loop finishes, not straddling it — the exact
  // window where the old ordering could strand a fresh (new-hash) record on
  // disk with children not yet actually submitted, which the NEXT sweep's
  // hash check (step 2: newHash === record.hash) would then wrongly read as
  // "unchanged" and never retry.
  it("a partial fan-out failure (one child's submit throws) still materializes the fresh record after the others land, and warns", async () => {
    const rec = baseRecord({
      hash: "orig-hash",
      tasks: [
        { id: "a", ticketId: "p1-a", dependsOn: [] },
        { id: "b", ticketId: "p1-b", dependsOn: [] },
      ],
      lastLabel: "junco:done",
      closed: true, // a finished set — supersede must reopen it
    });
    writePlanSetRecord(cfg, rec);
    writeFileSync(
      join(qp.done, "p1-a.md"),
      "---\nid: p1-a\n---\nA\n\n---\n<!-- junco-result\nstatus: completed\n-->\n",
    );
    writeFileSync(join(qp.inbox, "p1-b.md"), "---\nid: p1-b\n---\nOld B body\n");

    writeFakeGh(root, approvedSupersedeGhOpts(EDITED_FENCE));
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});

    // EDITED_FENCE compiles to tasks a/b/c — make ONLY "c"'s submit throw,
    // exactly like a genuine inbox-slug collision (dispatch.ts's "ticket
    // already queued" error), while "b" (a real recompile) still goes
    // through the real submitTicket.
    const realSubmitTicket = submitTicketBox.current;
    submitTicketBox.current = (...args: unknown[]) => {
      const opts = args[2] as { idHint?: string } | undefined;
      if (opts?.idHint === "p1-c") {
        throw new Error("ticket already queued: /sbxroot/queue/inbox/p1-c.md");
      }
      return realSubmitTicket(...args);
    };
    try {
      await maintainPlanSets(cfg);
    } finally {
      submitTicketBox.current = realSubmitTicket;
    }

    // "b" (the edited recompile) landed normally; "c" did not — its submit
    // threw and was contained, not fatal to the rest of the fan-out.
    const freshB = readFileSync(join(qp.inbox, "p1-b.md"), "utf8");
    expect(freshB).toContain("T B v2");
    expect(existsSync(join(qp.inbox, "p1-c.md"))).toBe(false);

    // The fresh record is STILL materialized — new hash, full task list
    // (including the failed "c", which the fan-out will pick up on a later
    // supersede or an operator retry) — proving materialization happens once
    // fan-out has run, not interleaved with (or ahead of) it.
    const expectedHash = hashPlan(extractPlanSetBody(ownPlanComment(EDITED_FENCE)) as string);
    const persisted = readPlanSetRecord(cfg, "p1");
    expect(persisted?.hash).toBe(expectedHash);
    expect(persisted?.hash).not.toBe("orig-hash");
    expect(persisted?.tasks.map((t) => t.id).sort()).toEqual(["a", "b", "c"]);

    const warned = warnSpy.mock.calls.some(
      (call) => typeof call[0] === "string" && call[0].includes("child submit failed at fan-out"),
    );
    expect(warned).toBe(true);
    warnSpy.mockRestore();
  });

  it("supersede defers while a child is processing", async () => {
    const rec = baseRecord({
      hash: "orig-hash",
      tasks: [
        { id: "a", ticketId: "p1-a", dependsOn: [] },
        { id: "b", ticketId: "p1-b", dependsOn: [] },
      ],
      lastLabel: "junco:working",
      closed: false,
    });
    writePlanSetRecord(cfg, rec);
    writeFileSync(join(qp.inbox, "p1-a.md"), "---\nid: p1-a\n---\nA\n");
    writeFileSync(join(qp.processing, "p1-b.md"), "---\nid: p1-b\n---\nB in flight\n");

    writeFakeGh(root, approvedSupersedeGhOpts(EDITED_FENCE));
    await maintainPlanSets(cfg);

    // Deferred: nothing disposed, nothing fanned out, the record untouched.
    // The whole per-record sweep is skipped this pass (not just the
    // supersede attempt) — the ordinary dashboard/label maintenance for this
    // record catches up on a later, quiescent sweep instead.
    expect(existsSync(join(qp.processing, "p1-b.md"))).toBe(true); // untouched
    expect(existsSync(join(qp.inbox, "p1-a.md"))).toBe(true); // untouched, no c
    expect(existsSync(join(qp.inbox, "p1-c.md"))).toBe(false);
    expect(existsSync(join(qp.failed, "p1-b.md"))).toBe(false); // never disposed

    const persisted = readPlanSetRecord(cfg, "p1");
    expect(persisted?.hash).toBe("orig-hash"); // unchanged — no supersede happened
    expect(persisted?.tasks.map((t) => t.id)).toEqual(["a", "b"]); // old task list
    expect(persisted?.lastLabel).toBe("junco:working"); // ordinary maintenance never ran
    expect(persisted?.statusCommentId).toBeNull(); // no dashboard call this sweep

    const blocks = readLog();
    expect(blocks.find((b) => b.argv.includes("--remove-label junco:approved"))).toBeUndefined();
    expect(blocks.find((b) => b.argv.startsWith("issue edit"))).toBeUndefined();
    expect(blocks.find((b) => b.argv.includes("--jq .id"))).toBeUndefined(); // no dashboard create
  });

  const BAD_FENCE = `version: 1
tasks: []
`;

  it("supersede compile failure is bounded: exactly one failure comment across two sweeps", async () => {
    // Task "a" is left fully absent (never seeded in any queue dir) so the
    // sweep-1 dispose pass (which runs BEFORE the compile check, per step 5)
    // is a no-op — isolating this test to the bounded-re-entry behavior under
    // test, not the (separate, expected) ordinary dashboard/label maintenance
    // that runs on sweep 2 once trySupersede returns "unchanged".
    const rec = baseRecord({
      hash: "orig-hash",
      tasks: [{ id: "a", ticketId: "p1-a", dependsOn: [] }],
      lastLabel: "junco:working",
      closed: false,
    });
    writePlanSetRecord(cfg, rec);

    writeFakeGh(root, approvedSupersedeGhOpts(BAD_FENCE));
    const expectedFailedHash = hashPlan(extractPlanSetBody(ownPlanComment(BAD_FENCE)) as string);

    const failureComments = (): CallBlock[] =>
      readLog().filter(
        (b) => b.argv.startsWith("issue comment") && b.body.includes("could not recompile"),
      );
    const approvalLabelReads = (): CallBlock[] =>
      readLog().filter((b) => b.argv.startsWith("issue view"));
    const approvedRemovals = (): CallBlock[] =>
      readLog().filter((b) => b.argv.includes("--remove-label junco:approved"));

    // Sweep 1: compile fails — one failure comment, approved label removed,
    // lastFailedHash stamped; old record (hash, tasks) otherwise untouched.
    await maintainPlanSets(cfg);
    const afterFirst = readPlanSetRecord(cfg, "p1");
    expect(afterFirst?.hash).toBe("orig-hash");
    expect(afterFirst?.lastFailedHash).toBe(expectedFailedHash);
    expect(afterFirst?.tasks.map((t) => t.id)).toEqual(["a"]);
    expect(failureComments()).toHaveLength(1);
    expect(approvalLabelReads()).toHaveLength(1);
    expect(approvedRemovals()).toHaveLength(1);

    // Sweep 2: the fake gh still reports the SAME edited fence and the SAME
    // (never-really-removed, since the fake is stateless) `approved` label —
    // exactly the scenario that would re-trigger forever without
    // lastFailedHash. It must short-circuit at the hash gate (step 2), before
    // ever re-reading labels/events/permission, and post nothing new.
    await maintainPlanSets(cfg);
    expect(failureComments()).toHaveLength(1); // still exactly one, ever
    expect(approvalLabelReads()).toHaveLength(1); // no re-read of labels
    expect(approvedRemovals()).toHaveLength(1); // no repeat removal attempt

    const afterSecond = readPlanSetRecord(cfg, "p1");
    expect(afterSecond?.hash).toBe("orig-hash");
    expect(afterSecond?.lastFailedHash).toBe(expectedFailedHash);
  });

  it("supersede resubmits an execution-failed old task (not just an unclaimed one); its dependent does not cascade", async () => {
    const rec = baseRecord({
      hash: "orig-hash",
      tasks: [
        { id: "x", ticketId: "p1-x", dependsOn: [] },
        { id: "y", ticketId: "p1-y", dependsOn: ["p1-x"] },
      ],
      lastLabel: "junco:failed",
      closed: false,
    });
    writePlanSetRecord(cfg, rec);
    // "x" ran and failed for real on a prior attempt (ordinary failed result,
    // no dependency_failed) — NOT in inbox, so supersedeUnclaimed leaves it
    // alone; it must still be resubmitted on this recompile (spec: only a
    // DONE ticket skips — a stale failed one is not "absent").
    writeFileSync(
      join(qp.failed, "p1-x.md"),
      "---\nid: p1-x\n---\nX body\n\n---\n<!-- junco-result\nstatus: failed\n-->\n",
    );
    // "y" is still an unclaimed, dependency-waiting inbox ticket.
    writeFileSync(
      join(qp.inbox, "p1-y.md"),
      "---\nid: p1-y\ndepends_on: [p1-x]\n---\nOld Y body\n",
    );

    const FIX_FENCE = `version: 1
tasks:
  - {id: x, title: T X v2, depends_on: [], description: Build X v2., acceptance: [works]}
  - {id: y, title: T Y, depends_on: [x], description: Build Y., acceptance: [works]}
`;
    writeFakeGh(root, approvedSupersedeGhOpts(FIX_FENCE));
    await maintainPlanSets(cfg);

    // The fresh "x" landed in inbox (fan-out did NOT read its stale failed/
    // copy as "already handled") — the old failed/ copy stays as audit,
    // untouched (never went through supersedeUnclaimed — it wasn't in inbox).
    const freshX = readFileSync(join(qp.inbox, "p1-x.md"), "utf8");
    expect(freshX).toContain("T X v2");
    const oldFailedX = readFileSync(join(qp.failed, "p1-x.md"), "utf8");
    expect(oldFailedX).not.toContain("superseded:");

    // The fresh "y" landed in inbox too, with its depends_on edge intact —
    // the OLD "y" (which WAS in inbox) is the one that got superseded-failed.
    const freshY = readFileSync(join(qp.inbox, "p1-y.md"), "utf8");
    expect(freshY).toContain("T Y");
    expect(freshY).toContain("depends_on: [p1-x]");
    const oldFailedY = readFileSync(join(qp.failed, "p1-y.md"), "utf8");
    expect(oldFailedY).toContain("superseded:");
    expect(oldFailedY).toContain("Old Y body");

    // The dependency sweep must NOT cascade "y" to failed/: its dependency
    // "x" is freshly back in inbox (state "inbox" → wait), not stuck in
    // failed/ (which would read as a real terminal failure and cascade).
    await sweepDependencies(cfg);
    expect(existsSync(join(qp.inbox, "p1-y.md"))).toBe(true);
  });
});
