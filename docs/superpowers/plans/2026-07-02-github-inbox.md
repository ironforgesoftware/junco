# GitHub-Integrated Inbox Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bridge trigger-labeled GitHub issues into the existing Junco inbox as ordinary tickets, and report results back to the issue (label lifecycle + one comment), per the approved spec at `docs/superpowers/specs/2026-07-02-github-inbox-design.md`.

**Architecture:** Two new modules — `src/githubInbox.ts` (poll labeled issues → verify labeler permission → materialize ticket files via `submitTicket`) and `src/githubReport.ts` (a `TicketReporter` implementation that flips lifecycle labels and posts one finalize comment). A small `TicketReporter` seam threads through `executeClaimed`; `runPrFlow`/`finalize` grow structured returns so the reporter has status/PR-URL/summary. Queue semantics are untouched; `[github] enabled=false` (default) means zero `gh` calls.

**Tech Stack:** TypeScript (Node ≥22.19, ESM/NodeNext, strict), vitest, zod, `gh` CLI via the existing `gh()` wrapper in `src/git.ts`.

## Global Constraints

- **No AI attribution, ever:** no `Co-Authored-By: Claude` trailers, no "Generated with Claude Code" lines in commits or PRs.
- **Exact-pinned deps only** — this plan adds NO new dependencies.
- **`src/ticketSchema.ts` is a stable public contract** — additive changes only; never widen the Q&A read-only default.
- **Never import the Pi SDK at module top level** — none of the new modules touch the SDK.
- **Every side effect behind an injectable `deps` seam** — bridge and reporter take `ghFn`/`gitFn`/`submitFn` deps; tests never touch the network.
- **Vitest exit-code trap:** never pipe vitest into a filter. Run `npx vitest run <file> > /tmp/out 2>&1; echo "exit: $?"` and read `/tmp/out`.
- **Prettier before every commit:** `npx prettier --write <touched files>`; re-read files before editing if a linter touched them.
- **Config fixture gotcha:** Task 1 adds `Config.github`; EVERY test file that builds a full `Config` literal must gain the new key (18 files, enumerated in Task 1). Misses fail at RUNTIME, not compile time.
- **Stack-agnostic shipped surface:** wizard/template/README text says "inference endpoint", never a personal server; no personal-setup strings.
- **Live-runtime rule:** never run `junco start` in this repo; never touch `config.toml`, `tickets/`, `worktrees/` at the repo root.
- Suite green at every commit; conventional commits on branch `feat/github-inbox`.

---

### Task 1: Config — `[github]` section + fixture sweep

**Files:**

- Modify: `src/types.ts` (after the `ModelConfig` interface, ~line 36)
- Modify: `src/config.ts` (TomlSchema ~line 211, loadConfig return ~line 282)
- Test: `tests/config.test.ts`
- Modify (fixture sweep, one key each): `tests/cli.test.ts`, `tests/critic.test.ts`, `tests/config.test.ts`, `tests/daemon.test.ts`, `tests/dispatch.test.ts`, `tests/doctor.test.ts`, `tests/listCmd.test.ts`, `tests/health.test.ts`, `tests/orphans.test.ts`, `tests/prFlow.test.ts`, `tests/requeue.test.ts`, `tests/statusCmd.test.ts`, `tests/pr.test.ts`, `tests/retryCmd.test.ts`, `tests/verify.test.ts`, `tests/repo.test.ts`, `tests/runOnce.test.ts`, `tests/worktree.test.ts`

**Interfaces:**

- Produces: `GithubRepoMapping { nwo: string; path: string }`, `GithubConfig { enabled: boolean; triggerLabel: string; askLabel: string; pollIntervalSeconds: number; repos: GithubRepoMapping[] }`, and `Config.github: GithubConfig`. All later tasks read `cfg.github.*`.

- [ ] **Step 1: Write the failing tests** — append to `tests/config.test.ts` (follow the file's existing temp-file pattern; if it has a helper that writes TOML + calls `loadConfig`, reuse it, else use this self-contained form):

```ts
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("[github] config section", () => {
  function load(toml: string) {
    const dir = mkdtempSync(join(tmpdir(), "junco-ghcfg-"));
    const p = join(dir, "config.toml");
    writeFileSync(p, toml, "utf8");
    try {
      return loadConfig(p);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("defaults: disabled, junco labels, 60s poll, no repos", () => {
    const cfg = load(`vault_root = "/tmp/v"\n`);
    expect(cfg.github).toEqual({
      enabled: false,
      triggerLabel: "junco",
      askLabel: "junco:ask",
      pollIntervalSeconds: 60,
      repos: [],
    });
  });

  it("parses repos and derives ask_label from a custom trigger", () => {
    const cfg = load(
      `vault_root = "/tmp/v"\n[github]\nenabled = true\ntrigger_label = "bot"\n` +
        `[[github.repos]]\nnwo = "acme/api"\npath = "~/code/api"\n`,
    );
    expect(cfg.github.enabled).toBe(true);
    expect(cfg.github.askLabel).toBe("bot:ask");
    expect(cfg.github.repos).toHaveLength(1);
    expect(cfg.github.repos[0].nwo).toBe("acme/api");
    expect(cfg.github.repos[0].path.startsWith("/")).toBe(true); // ~ expanded
  });

  it("rejects a malformed nwo", () => {
    expect(() =>
      load(`vault_root = "/tmp/v"\n[github]\n[[github.repos]]\nnwo = "no-slash"\npath = "/x"\n`),
    ).toThrow(/owner\/repo/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/config.test.ts > /tmp/out 2>&1; echo "exit: $?"`
Expected: FAIL (exit 1) — `cfg.github` is undefined.

- [ ] **Step 3: Implement.** In `src/types.ts`, after `ModelConfig` (before `export interface Config`):

```ts
/** One watched GitHub repo: name-with-owner and its local clone. */
export interface GithubRepoMapping {
  nwo: string; // "owner/repo"
  path: string; // local clone path (expanded)
}
/** `[github]` — the issues→inbox bridge. Disabled by default (zero gh calls). */
export interface GithubConfig {
  enabled: boolean;
  triggerLabel: string; // approval label; lifecycle labels derive from it
  askLabel: string; // routes an issue to the read-only Q&A path
  pollIntervalSeconds: number; // bridge sweep cadence (independent of worker poll)
  repos: GithubRepoMapping[];
}
```

and inside `Config` (after `transcriptsEnabled: boolean;`):

```ts
// GitHub-integrated inbox mode (issues → tickets bridge). See githubInbox.ts.
github: GithubConfig;
```

In `src/config.ts`, add to `TomlSchema` (after the `observability` block, before the closing `})`):

```ts
  github: z
    .object({
      enabled: z.boolean().default(false),
      trigger_label: z.string().min(1).default("junco"),
      ask_label: z.string().min(1).optional(),
      poll_interval_seconds: z.number().min(5).default(60),
      repos: z
        .array(
          z.object({
            nwo: z
              .string()
              .regex(/^[\w.-]+\/[\w.-]+$/, "github.repos[].nwo must be owner/repo"),
            path: z.string().min(1),
          }),
        )
        .default([]),
    })
    .default({}),
```

and to the `loadConfig` return object (after `transcriptsEnabled`):

```ts
    github: {
      enabled: d.github.enabled,
      triggerLabel: d.github.trigger_label,
      askLabel: d.github.ask_label ?? `${d.github.trigger_label}:ask`,
      pollIntervalSeconds: d.github.poll_interval_seconds,
      repos: d.github.repos.map((r) => ({ nwo: r.nwo, path: expandHome(r.path) })),
    },
```

- [ ] **Step 4: Fixture sweep.** In EACH of the 18 test files listed above, find the full-`Config`-literal helper (search for `juncoSubdir:` — exactly one per file) and add after the last existing key of the literal:

```ts
    github: { enabled: false, triggerLabel: "junco", askLabel: "junco:ask", pollIntervalSeconds: 60, repos: [] },
```

Verify the sweep is complete: `grep -L "github:" $(grep -ln "juncoSubdir:" tests/*.ts)` must print nothing.

- [ ] **Step 5: Full suite + gate**

Run: `npx vitest run > /tmp/out 2>&1; echo "exit: $?"` — expected exit 0.
Run: `npm run build > /tmp/out 2>&1; echo "exit: $?"` — expected exit 0 (a missed fixture in `src/` would fail here; missed test fixtures fail in vitest).

- [ ] **Step 6: Commit**

```bash
npx prettier --write src/types.ts src/config.ts tests/config.test.ts
git add -A src tests && git commit -m "feat(config): [github] bridge section — enabled flag, labels, poll cadence, repo mappings"
```

---

### Task 2: Ticket schema — additive `github` + `workdir` fields

**Files:**

- Modify: `src/types.ts` (Ticket interface, ~line 113)
- Modify: `src/ticket.ts` (parseTicket return, ~line 38)
- Modify: `src/ticketSchema.ts` (properties map)
- Test: `tests/ticket.test.ts`, `tests/ticketSchema.test.ts`

**Interfaces:**

- Produces: `TicketGithub { nwo: string; issue: number; kind: "pr" | "ask" }`; `Ticket.github: TicketGithub | null`; `Ticket.workdir: string | null`. Consumed by Tasks 5–10.

- [ ] **Step 1: Failing tests.** Append to `tests/ticket.test.ts`:

```ts
it("parses a github provenance block and workdir", () => {
  const t = parseTicket(
    "/q/a.md",
    `---\nid: gh-acme-api-42\nworkdir: /tmp/clone\ngithub:\n  nwo: acme/api\n  issue: 42\n  kind: ask\n---\nbody`,
  );
  expect(t.github).toEqual({ nwo: "acme/api", issue: 42, kind: "ask" });
  expect(t.workdir).toBe("/tmp/clone");
});

it("defaults github/workdir to null and rejects malformed blocks", () => {
  expect(parseTicket("/q/a.md", "---\nid: x\n---\nbody").github).toBeNull();
  expect(parseTicket("/q/a.md", "---\nid: x\n---\nbody").workdir).toBeNull();
  const bad = parseTicket(
    "/q/a.md",
    `---\nid: x\nworkdir: ""\ngithub:\n  nwo: acme/api\n  issue: -1\n  kind: pr\n---\nbody`,
  );
  expect(bad.github).toBeNull(); // negative issue number
  expect(bad.workdir).toBeNull(); // empty string
  expect(
    parseTicket("/q/a.md", `---\ngithub:\n  nwo: acme/api\n  issue: 7\n  kind: nope\n---\nb`)
      .github,
  ).toBeNull(); // bad kind
});
```

Append to `tests/ticketSchema.test.ts` inside the `describeTicketSchema()` describe: add `"github"` and `"workdir"` to the `expected` fields array in the existing "documents all expected frontmatter fields" test, plus:

```ts
it("documents github and workdir with the right shapes", () => {
  const s = JSON.parse(describeTicketSchema()) as {
    properties: Record<string, Record<string, unknown>>;
  };
  expect(s.properties.github.type).toBe("object");
  expect(s.properties.workdir.type).toBe("string");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/ticket.test.ts tests/ticketSchema.test.ts > /tmp/out 2>&1; echo "exit: $?"` — expected FAIL.

- [ ] **Step 3: Implement.** `src/types.ts`, above `Ticket`:

```ts
/** Worker-managed GitHub provenance for a bridged ticket (do not set by hand). */
export interface TicketGithub {
  nwo: string;
  issue: number;
  kind: "pr" | "ask";
}
```

Inside `Ticket` (after `tools`):

```ts
/** GitHub issue this ticket was bridged from (null = local dispatch). */
github: TicketGithub | null;
/** Q&A only: directory the session runs in (read-only tools). Null = default. */
workdir: string | null;
```

`src/ticket.ts` — add before the `return`:

```ts
const ghRaw = frontmatter.github;
let github: Ticket["github"] = null;
if (ghRaw !== null && typeof ghRaw === "object" && !Array.isArray(ghRaw)) {
  const g = ghRaw as Record<string, unknown>;
  if (
    typeof g.nwo === "string" &&
    typeof g.issue === "number" &&
    Number.isInteger(g.issue) &&
    g.issue > 0 &&
    (g.kind === "pr" || g.kind === "ask")
  ) {
    github = { nwo: g.nwo, issue: g.issue, kind: g.kind };
  }
}
```

and in the returned object (after `tools`):

```ts
    github,
    workdir:
      typeof frontmatter.workdir === "string" && frontmatter.workdir.trim() !== ""
        ? frontmatter.workdir
        : null,
```

`src/ticketSchema.ts` — add to `properties` (after `tools`):

```ts
    workdir: {
      type: "string",
      description:
        "Q&A tickets only: directory the session runs in (read-only tools). Defaults to the worker's processing directory.",
    },
    github: {
      type: "object",
      description:
        "Worker-managed: provenance of a ticket bridged from a GitHub issue. Do not set by hand.",
      properties: {
        nwo: { type: "string", description: "Repository name-with-owner, e.g. acme/api." },
        issue: { type: "integer", minimum: 1, description: "Source issue number." },
        kind: { type: "string", enum: ["pr", "ask"], description: "Execution path." },
      },
    },
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/ticket.test.ts tests/ticketSchema.test.ts > /tmp/out 2>&1; echo "exit: $?"` — expected PASS. Then full suite: `npx vitest run > /tmp/out 2>&1; echo "exit: $?"` — expected exit 0.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/types.ts src/ticket.ts src/ticketSchema.ts tests/ticket.test.ts tests/ticketSchema.test.ts
git add -A src tests && git commit -m "feat(ticket): additive github provenance + workdir frontmatter fields"
```

---

### Task 3: `finalize`/`finalizePr` return `{ dst, status }`

**Files:**

- Modify: `src/finalize.ts` (finalize ~line 28, finalizePr ~line 162)
- Modify: `src/prFlow.ts` (12 `return finalizePr(...)` sites — append `.dst` for now; Task 4 replaces them)
- Modify: `src/runOnce.ts` (~line 201, the Q&A `finalize` call)
- Test: `tests/finalize.test.ts`

**Interfaces:**

- Produces: `FinalizeResult { dst: string; status: string }` (exported from `src/finalize.ts`); both `finalize()` and `finalizePr()` return it. Task 4 consumes `.status`.

- [ ] **Step 1: Failing test.** In `tests/finalize.test.ts`, update the existing assertions that treat the return as a string (search `finalize(` / `finalizePr(`): each `const dst = finalize(...)` becomes `const { dst, status } = finalize(...)`, and add one explicit new case:

```ts
it("returns the terminal status alongside dst", () => {
  // Reuse the file's existing RunResult/tmp-dir helpers for a successful run:
  // a completed Q&A result must return status "completed" and a dst under done/.
  const { dst, status } = finalize(ticketPath, okResult, dirs);
  expect(status).toBe("completed");
  expect(dst).toContain("done");
});
```

(Adapt the helper names — `okResult`, `dirs`, `ticketPath` — to the fixtures already defined in that file.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/finalize.test.ts > /tmp/out 2>&1; echo "exit: $?"` — expected FAIL (dst is a string, destructure yields undefined).

- [ ] **Step 3: Implement.** `src/finalize.ts`:

```ts
export interface FinalizeResult {
  dst: string;
  status: string;
}
```

`finalize(...)` — change signature to `: FinalizeResult` and its last lines to:

```ts
metrics.recordTask(status, result.usage, result.durationMs);
return { dst, status };
```

`finalizePr(...)` — same: `: FinalizeResult`, ending:

```ts
metrics.recordTask(status, result.usage, result.durationMs);
return { dst, status };
```

`src/prFlow.ts` — every `return finalizePr(...)` becomes `return finalizePr(...).dst;` (12 sites; keeps `runPrFlow(): Promise<string>` compiling until Task 4).

`src/runOnce.ts` Q&A path (~line 201):

```ts
const fin = finalize(claimed, result, { done: paths.done, failed: paths.failed });
log.info("finalized", { dst: fin.dst, status: fin.status });
```

(delete the old ternary status log — `fin.status` is now authoritative).

- [ ] **Step 4: Full suite**

Run: `npx vitest run > /tmp/out 2>&1; echo "exit: $?"` — expected exit 0. Fix any other test asserting on the old string return (search `= finalize(` and `= finalizePr(` in `tests/`).

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/finalize.ts src/prFlow.ts src/runOnce.ts tests/finalize.test.ts
git add -A src tests && git commit -m "refactor(finalize): return { dst, status } so callers see the terminal status"
```

---

### Task 4: `runPrFlow` returns a structured `PrFlowResult`

**Files:**

- Modify: `src/prFlow.ts` (return type + all return sites)
- Modify: `src/runOnce.ts` (~lines 145-152)
- Test: `tests/prFlow.test.ts`

**Interfaces:**

- Consumes: `FinalizeResult` from Task 3.
- Produces (exported from `src/prFlow.ts`; consumed by Tasks 7 and 10):

```ts
export interface PrFlowResult {
  dst: string;
  status: string; // terminal status, or "requeued"
  requeued: boolean;
  prUrl: string | null;
  commitCount: number;
  finalText: string; // agent's final message ("" when none)
  phaseError: string | null; // phase error or agent errorMessage, when failed
}
```

- [ ] **Step 1: Failing test.** `tests/prFlow.test.ts` has harness helpers that call `runPrFlow` and assert on a returned `dst` string. Update ONE happy-path test to destructure and assert the new shape (leave the rest asserting `.dst` mechanically):

```ts
const flow = await runPrFlow(cfg, ticket, claimedPath, ctx, deps);
expect(flow.status).toBe("completed");
expect(flow.requeued).toBe(false);
expect(flow.prUrl).toMatch(/^https:\/\//);
expect(flow.commitCount).toBeGreaterThan(0);
expect(flow.dst).toContain("done");
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/prFlow.test.ts > /tmp/out 2>&1; echo "exit: $?"` — expected FAIL.

- [ ] **Step 3: Implement.** In `src/prFlow.ts` add the `PrFlowResult` interface (exact block above, after `PrOutcome`) and two helpers after `emptyPrOutcome`:

```ts
function flowResult(
  fin: { dst: string; status: string },
  prOutcome: PrOutcome,
  result: RunResult,
  phaseError: string | null = null,
): PrFlowResult {
  return {
    dst: fin.dst,
    status: fin.status,
    requeued: false,
    prUrl: prOutcome.prUrl,
    commitCount: prOutcome.commits.length,
    finalText: result.finalText,
    phaseError: phaseError ?? result.errorMessage,
  };
}

function requeuedResult(dst: string, result: RunResult): PrFlowResult {
  return {
    dst,
    status: "requeued",
    requeued: true,
    prUrl: null,
    commitCount: 0,
    finalText: result.finalText,
    phaseError: null,
  };
}
```

Change `runPrFlow` signature to `Promise<PrFlowResult>`. Replace every Task-3 `return finalizePr(X, Y, prOutcome, opts).dst;` with `return flowResult(finalizePr(X, Y, prOutcome, opts), prOutcome, Y, <phaseError-or-null>);` — pass the same `phaseError` variable the site already passes into `finalizePr`'s opts (or `null` where none). The two requeue sites (`return rq.dst!;` at ~lines 361 and 402) become `return requeuedResult(rq.dst!, result);`.

In `src/runOnce.ts` PR path:

```ts
if (ctx) {
  const flow = await runPrFlow(cfg, next, claimed, ctx, {
    sessionFactoryFor: deps.sessionFactoryFor,
    criticSessionFactory: deps.criticSessionFactory,
    abortSignal: deps.abortSignal,
    onProgress: (p) => metrics.setTaskProgress(next.id, p),
  });
  log.info("finalized (pr-flow)", { dst: flow.dst, status: flow.status });
  return;
}
```

- [ ] **Step 4: Full suite** — `npx vitest run > /tmp/out 2>&1; echo "exit: $?"` — exit 0. Update any prFlow/runOnce tests comparing the raw return to a string path (search `await runPrFlow` in `tests/`): change to `.dst`.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/prFlow.ts src/runOnce.ts tests/prFlow.test.ts tests/runOnce.test.ts
git add -A src tests && git commit -m "refactor(prFlow): structured PrFlowResult return (status, prUrl, commitCount, finalText)"
```

---

### Task 5: Deterministic `Closes <nwo>#<n>` line in the PR body

**Files:**

- Modify: `src/prFlow.ts` (`buildPrBody`, ~line 200)
- Test: `tests/prFlow.test.ts` (buildPrBody unit tests — the function is exported)

**Interfaces:**

- Consumes: `Ticket.github` from Task 2.

- [ ] **Step 1: Failing test** (append near existing `buildPrBody` tests if present, else new describe):

```ts
describe("buildPrBody github provenance", () => {
  it("appends a Closes line for bridged pr tickets", () => {
    const t = { ...baseTicket, github: { nwo: "acme/api", issue: 42, kind: "pr" as const } };
    const body = buildPrBody(t, ctx, outcome, okResult);
    expect(body).toContain("Closes acme/api#42");
  });
  it("omits the Closes line for local tickets", () => {
    const body = buildPrBody({ ...baseTicket, github: null }, ctx, outcome, okResult);
    expect(body).not.toContain("Closes ");
  });
});
```

(Adapt `baseTicket`/`ctx`/`outcome`/`okResult` to the fixtures already in the file; any minimal Ticket/PrOutcome/RunResult literals the file builds will do.)

- [ ] **Step 2: Verify failure** — `npx vitest run tests/prFlow.test.ts > /tmp/out 2>&1; echo "exit: $?"` — FAIL.

- [ ] **Step 3: Implement.** In `buildPrBody`, immediately BEFORE the `## Run metadata` part is pushed:

```ts
// Bridged tickets: deterministic issue link so merging auto-closes the issue
// (never delegated to the prompt).
if (task.github && task.github.kind === "pr") {
  parts.push(`Closes ${task.github.nwo}#${task.github.issue}`);
}
```

- [ ] **Step 4: Verify pass + full suite** — `npx vitest run > /tmp/out 2>&1; echo "exit: $?"` — exit 0.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/prFlow.ts tests/prFlow.test.ts
git add -A src tests && git commit -m "feat(prFlow): Closes <nwo>#<n> line in PR bodies of bridged tickets"
```

---

### Task 6: Q&A `workdir` — session cwd for repo-scoped questions

**Files:**

- Modify: `src/runOnce.ts` (Q&A cwd, ~line 158; new helper + imports)
- Test: `tests/runOnce.test.ts`

**Interfaces:**

- Consumes: `Ticket.workdir` (Task 2), `cfg.allowedRepoRoots` (existing).
- Produces: Q&A sessions run with `cwd = validated workdir ?? paths.processing`. Observable through the existing `sessionFactoryFor(cfg, cwd)` seam.

- [ ] **Step 1: Failing tests** (append to `tests/runOnce.test.ts`, reusing its fake-session/`makeConfig` helpers; the seam receives `cwd` as its 2nd arg):

```ts
describe("Q&A workdir", () => {
  it("runs the session in a valid workdir", async () => {
    const wd = mkdtempSync(join(tmpdir(), "junco-wd-"));
    // write a Q&A ticket with `workdir: <wd>` into the inbox, then:
    let seenCwd = "";
    await runOnce(cfg, {
      sessionFactoryFor: (c, cwd) => {
        seenCwd = cwd;
        return fakeSessionFactory;
      },
    });
    expect(seenCwd).toBe(wd);
  });

  it("falls back to processing/ when workdir is missing or outside allowed roots", async () => {
    // ticket with workdir: /nonexistent-junco-dir → cwd must be paths.processing
    // and with cfg.allowedRepoRoots = ["/somewhere-else"] + real dir → also fallback
  });
});
```

Write the second test fully: two tickets, assert `seenCwd` equals the processing dir both times (follow the file's existing inbox-write helper).

- [ ] **Step 2: Verify failure** — `npx vitest run tests/runOnce.test.ts > /tmp/out 2>&1; echo "exit: $?"` — FAIL.

- [ ] **Step 3: Implement.** `src/runOnce.ts` — extend imports:

```ts
import { readFileSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
```

Add helper above `executeClaimed`:

```ts
/** Validate a Q&A ticket's workdir: must exist, be a directory, and (when the
 * allowed_repo_roots rail is configured) sit under one of the roots. Invalid →
 * warn + fall back to the default cwd; never fails the ticket. */
function resolveQaCwd(t: Ticket, cfg: Config, fallback: string): string {
  if (!t.workdir) return fallback;
  const wd = resolve(expandHome(t.workdir));
  let isDir = false;
  try {
    isDir = statSync(wd).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    log.warn("workdir missing or not a directory; using default cwd", { id: t.id, workdir: wd });
    return fallback;
  }
  if (cfg.allowedRepoRoots.length > 0) {
    const ok = cfg.allowedRepoRoots.some((root) => {
      const r = resolve(expandHome(root));
      return wd === r || wd.startsWith(r + sep);
    });
    if (!ok) {
      log.warn("workdir outside allowed_repo_roots; using default cwd", {
        id: t.id,
        workdir: wd,
      });
      return fallback;
    }
  }
  return wd;
}
```

Change the Q&A cwd line:

```ts
const cwd = resolveQaCwd(next, cfg, paths.processing); // Q&A: read-only tools
```

- [ ] **Step 4: Verify pass + full suite** — `npx vitest run > /tmp/out 2>&1; echo "exit: $?"` — exit 0.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/runOnce.ts tests/runOnce.test.ts
git add -A src tests && git commit -m "feat(runOnce): Q&A workdir — validated session cwd for repo-scoped questions"
```

---

### Task 7: `TicketReporter` seam through `executeClaimed`

**Files:**

- Create: `src/reporter.ts`
- Modify: `src/runOnce.ts` (`RunDeps`, `executeClaimed`)
- Test: `tests/reporter.test.ts` (new), `tests/runOnce.test.ts`

**Interfaces:**

- Produces (exported from `src/reporter.ts`; Task 10 implements it, Task 11 wires it):

```ts
export interface TicketOutcome {
  kind: "pr" | "qa";
  status: string;
  prUrl: string | null;
  finalText: string;
  failureReason: string | null;
}
export interface TicketReporter {
  onStart(ticket: Ticket): Promise<void>;
  onRequeue(ticket: Ticket): Promise<void>;
  onFinal(ticket: Ticket, outcome: TicketOutcome): Promise<void>;
}
export const NOOP_REPORTER: TicketReporter;
export function outcomeFromPrFlow(flow: PrFlowResult): TicketOutcome;
export function outcomeFromQa(status: string, result: RunResult): TicketOutcome;
```

- `RunDeps` gains `reporter?: TicketReporter`.

- [ ] **Step 1: Failing tests.** Create `tests/reporter.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { outcomeFromPrFlow, outcomeFromQa, NOOP_REPORTER } from "../src/reporter.js";
import type { PrFlowResult } from "../src/prFlow.js";
import type { RunResult } from "../src/types.js";

const flow: PrFlowResult = {
  dst: "/q/done/t.md",
  status: "completed",
  requeued: false,
  prUrl: "https://github.com/acme/api/pull/7",
  commitCount: 3,
  finalText: "Did the thing.\n\nDetails...",
  phaseError: null,
};
const qaResult: RunResult = {
  finalText: "The answer.",
  toolCalls: [],
  usage: { input: 1, output: 2, cacheRead: 0, total: 3 },
  stopReason: "end_turn",
  errorMessage: null,
  timedOut: false,
  durationMs: 1000,
  abortedByGuard: false,
};

describe("outcome mapping", () => {
  it("maps a PrFlowResult", () => {
    expect(outcomeFromPrFlow(flow)).toEqual({
      kind: "pr",
      status: "completed",
      prUrl: "https://github.com/acme/api/pull/7",
      finalText: "Did the thing.\n\nDetails...",
      failureReason: null,
    });
  });
  it("maps a Q&A result with failure reason", () => {
    const o = outcomeFromQa("failed", { ...qaResult, errorMessage: "boom" });
    expect(o).toEqual({
      kind: "qa",
      status: "failed",
      prUrl: null,
      finalText: "The answer.",
      failureReason: "boom",
    });
  });
  it("noop reporter resolves without effect", async () => {
    await expect(NOOP_REPORTER.onStart({} as never)).resolves.toBeUndefined();
  });
});
```

And in `tests/runOnce.test.ts`, a call-sequence test using the file's Q&A helpers:

```ts
describe("reporter seam", () => {
  it("fires onStart then onFinal for a completed Q&A ticket", async () => {
    const calls: string[] = [];
    const reporter = {
      onStart: async () => void calls.push("start"),
      onRequeue: async () => void calls.push("requeue"),
      onFinal: async (_t: unknown, o: { status: string }) => void calls.push(`final:${o.status}`),
    };
    // enqueue one Q&A ticket, then:
    await runOnce(cfg, { sessionFactoryFor: () => fakeSessionFactory, reporter });
    expect(calls).toEqual(["start", "final:completed"]);
  });
});
```

- [ ] **Step 2: Verify failure** — `npx vitest run tests/reporter.test.ts tests/runOnce.test.ts > /tmp/out 2>&1; echo "exit: $?"` — FAIL (module missing).

- [ ] **Step 3: Implement.** Create `src/reporter.ts`:

```ts
/**
 * TicketReporter — lifecycle feedback seam for dispatch surfaces (GitHub
 * bridge, future forges). executeClaimed is the ONLY call site; the default
 * is a no-op so local mode carries zero overhead. Implementations must be
 * best-effort: never throw, never fail a ticket.
 */

import type { Ticket, RunResult } from "./types.js";
import type { PrFlowResult } from "./prFlow.js";

export interface TicketOutcome {
  kind: "pr" | "qa";
  status: string;
  prUrl: string | null;
  finalText: string;
  failureReason: string | null;
}

export interface TicketReporter {
  /** Ticket entered execution (claimed → running). */
  onStart(ticket: Ticket): Promise<void>;
  /** Ticket went back to the inbox (transient-failure requeue). */
  onRequeue(ticket: Ticket): Promise<void>;
  /** Ticket reached a terminal state (done/ or failed/). */
  onFinal(ticket: Ticket, outcome: TicketOutcome): Promise<void>;
}

export const NOOP_REPORTER: TicketReporter = {
  onStart: () => Promise.resolve(),
  onRequeue: () => Promise.resolve(),
  onFinal: () => Promise.resolve(),
};

export function outcomeFromPrFlow(flow: PrFlowResult): TicketOutcome {
  return {
    kind: "pr",
    status: flow.status,
    prUrl: flow.prUrl,
    finalText: flow.finalText,
    failureReason: flow.phaseError,
  };
}

export function outcomeFromQa(status: string, result: RunResult): TicketOutcome {
  return {
    kind: "qa",
    status,
    prUrl: null,
    finalText: result.finalText,
    failureReason: result.errorMessage,
  };
}
```

`src/runOnce.ts` — import `{ NOOP_REPORTER, outcomeFromPrFlow, outcomeFromQa, type TicketReporter }` from `./reporter.js`; add to `RunDeps`:

```ts
  /** Lifecycle feedback (GitHub bridge). Defaults to a no-op. */
  reporter?: TicketReporter;
```

In `executeClaimed`, right after `metrics.taskStarted(next.id);`:

```ts
const reporter = deps.reporter ?? NOOP_REPORTER;
await reporter.onStart(next).catch(() => undefined);
```

PR path — after `const flow = await runPrFlow(...)`:

```ts
if (flow.requeued) await reporter.onRequeue(next).catch(() => undefined);
else await reporter.onFinal(next, outcomeFromPrFlow(flow)).catch(() => undefined);
```

Q&A requeue site (`if (rq.requeued) return;`) becomes:

```ts
if (rq.requeued) {
  await reporter.onRequeue(next).catch(() => undefined);
  return;
}
```

Q&A finalize site — after `const fin = finalize(...)`:

```ts
await reporter.onFinal(next, outcomeFromQa(fin.status, result)).catch(() => undefined);
```

- [ ] **Step 4: Verify pass + full suite** — `npx vitest run > /tmp/out 2>&1; echo "exit: $?"` — exit 0.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/reporter.ts src/runOnce.ts tests/reporter.test.ts tests/runOnce.test.ts
git add -A src tests && git commit -m "feat(runOnce): TicketReporter lifecycle seam (onStart/onRequeue/onFinal)"
```

---

### Task 8: Bridge pure helpers — labels, eligibility, url parsing, ticket conversion

**Files:**

- Create: `src/githubInbox.ts` (pure parts only; Task 9 adds the sweep)
- Test: `tests/githubInbox.test.ts` (new)

**Interfaces:**

- Produces (exported; consumed by Tasks 9, 10, 12):

```ts
export interface GhIssue {
  number: number;
  title: string;
  body: string | null;
  labels: { name: string }[];
}
export interface LifecycleLabels {
  queued: string;
  working: string;
  done: string;
  failed: string;
  denied: string;
}
export function lifecycleLabels(trigger: string): LifecycleLabels;
export function isEligible(issue: GhIssue, trigger: string): boolean;
export function nwoFromRemoteUrl(url: string): string | null;
export function issueToTicket(
  issue: GhIssue,
  repo: GithubRepoMapping,
  cfg: Config,
  parent: { title: string; body: string | null } | null,
): { id: string; content: string };
```

- [ ] **Step 1: Failing tests.** Create `tests/githubInbox.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  lifecycleLabels,
  isEligible,
  nwoFromRemoteUrl,
  issueToTicket,
  type GhIssue,
} from "../src/githubInbox.js";
import { parseTicket } from "../src/ticket.js";
import type { Config } from "../src/types.js";

// Minimal Config for conversion tests — only the fields issueToTicket reads.
const cfg = {
  github: {
    enabled: true,
    triggerLabel: "junco",
    askLabel: "junco:ask",
    pollIntervalSeconds: 60,
    repos: [],
  },
} as unknown as Config;
const repo = { nwo: "acme/api", path: "/home/u/code/api" };
const issue = (labels: string[], over: Partial<GhIssue> = {}): GhIssue => ({
  number: 42,
  title: "Add rate limiting",
  body: "Sliding window on /upload.",
  labels: labels.map((name) => ({ name })),
  ...over,
});

describe("lifecycleLabels", () => {
  it("derives all five from the trigger", () => {
    expect(lifecycleLabels("bot")).toEqual({
      queued: "bot:queued",
      working: "bot:working",
      done: "bot:done",
      failed: "bot:failed",
      denied: "bot:denied",
    });
  });
});

describe("isEligible", () => {
  it("requires the trigger label", () => {
    expect(isEligible(issue(["bug"]), "junco")).toBe(false);
    expect(isEligible(issue(["junco"]), "junco")).toBe(true);
  });
  it("excludes every lifecycle label", () => {
    for (const l of [
      "junco:queued",
      "junco:working",
      "junco:done",
      "junco:failed",
      "junco:denied",
    ]) {
      expect(isEligible(issue(["junco", l]), "junco")).toBe(false);
    }
  });
});

describe("nwoFromRemoteUrl", () => {
  it.each([
    ["https://github.com/acme/api.git", "acme/api"],
    ["https://github.com/acme/api", "acme/api"],
    ["git@github.com:acme/api.git", "acme/api"],
    ["ssh://git@github.com/acme/api", "acme/api"],
  ])("%s → %s", (url, nwo) => expect(nwoFromRemoteUrl(url)).toBe(nwo));
  it("returns null for non-github urls", () => {
    expect(nwoFromRemoteUrl("https://gitlab.com/a/b.git")).toBeNull();
  });
});

describe("issueToTicket", () => {
  it("pr ticket: repo + pr_title + github block, round-trips through parseTicket", () => {
    const t = issueToTicket(issue(["junco"]), repo, cfg, null);
    expect(t.id).toBe("gh-acme-api-42");
    const parsed = parseTicket(`/in/${t.id}.md`, t.content);
    expect(parsed.hasRepo).toBe(true);
    expect(parsed.frontmatter.repo).toBe("/home/u/code/api");
    expect(parsed.frontmatter.pr_title).toBe("Add rate limiting");
    expect(parsed.github).toEqual({ nwo: "acme/api", issue: 42, kind: "pr" });
    expect(parsed.body).toContain("# Add rate limiting");
    expect(parsed.body).toContain("Sliding window on /upload.");
  });
  it("ask ticket: workdir instead of repo", () => {
    const t = issueToTicket(issue(["junco", "junco:ask"]), repo, cfg, null);
    const parsed = parseTicket(`/in/${t.id}.md`, t.content);
    expect(parsed.hasRepo).toBe(false);
    expect(parsed.workdir).toBe("/home/u/code/api");
    expect(parsed.github?.kind).toBe("ask");
  });
  it("quotes YAML-hostile titles safely", () => {
    const t = issueToTicket(
      issue(["junco"], { title: `Fix: "it's broken" — #1 [urgent]` }),
      repo,
      cfg,
      null,
    );
    const parsed = parseTicket(`/in/${t.id}.md`, t.content);
    expect(parsed.frontmatter.pr_title).toBe(`Fix: "it's broken" — #1 [urgent]`);
  });
  it("appends parent context as a marked background section", () => {
    const t = issueToTicket(issue(["junco"]), repo, cfg, {
      title: "Uploads are slow",
      body: "Users report 30s uploads.",
    });
    expect(t.content).toContain("## Context: parent issue");
    expect(t.content).toContain("Uploads are slow");
    expect(t.content).toContain("_Background only");
  });
});
```

- [ ] **Step 2: Verify failure** — `npx vitest run tests/githubInbox.test.ts > /tmp/out 2>&1; echo "exit: $?"` — FAIL (module missing).

- [ ] **Step 3: Implement.** Create `src/githubInbox.ts`:

```ts
/**
 * GitHub → inbox bridge (dispatch side of GitHub-integrated mode).
 *
 * Pure helpers here; the sweep (pollGithubInbox) lands with the sweep task.
 * Design: docs/superpowers/specs/2026-07-02-github-inbox-design.md.
 * Issues are SNAPSHOTS: the labeled body is copied once into an ordinary
 * ticket; the existing queue machinery runs unchanged from there.
 */

import type { Config, GithubRepoMapping } from "./types.js";

/** Shape of `gh issue list --json number,title,body,labels`. */
export interface GhIssue {
  number: number;
  title: string;
  body: string | null;
  labels: { name: string }[];
}

export interface LifecycleLabels {
  queued: string;
  working: string;
  done: string;
  failed: string;
  denied: string;
}

/** Lifecycle label names derive from the trigger label. */
export function lifecycleLabels(trigger: string): LifecycleLabels {
  return {
    queued: `${trigger}:queued`,
    working: `${trigger}:working`,
    done: `${trigger}:done`,
    failed: `${trigger}:failed`,
    denied: `${trigger}:denied`,
  };
}

/** Eligible = trigger label present AND no lifecycle label. Re-dispatch = the
 * operator removes the lifecycle label and leaves the trigger on. */
export function isEligible(issue: GhIssue, trigger: string): boolean {
  const names = new Set(issue.labels.map((l) => l.name));
  if (!names.has(trigger)) return false;
  const ll = lifecycleLabels(trigger);
  return ![ll.queued, ll.working, ll.done, ll.failed, ll.denied].some((n) => names.has(n));
}

/** Parse owner/repo out of a github.com remote URL (https or ssh). Null when
 * the URL is not a github remote — the origin cross-check fails closed on it. */
export function nwoFromRemoteUrl(url: string): string | null {
  const u = url.trim();
  const m =
    /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(u) ??
    /^(?:ssh:\/\/)?git@github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(u);
  return m ? `${m[1]}/${m[2]}` : null;
}

/** Convert an eligible issue into a Junco ticket file (id + full content).
 * JSON.stringify produces valid YAML double-quoted scalars — titles and paths
 * with quotes/colons round-trip through parseTicket. */
export function issueToTicket(
  issue: GhIssue,
  repo: GithubRepoMapping,
  cfg: Config,
  parent: { title: string; body: string | null } | null,
): { id: string; content: string } {
  const [owner, name] = repo.nwo.split("/");
  const slug = (s: string): string => s.replace(/[^A-Za-z0-9._-]+/g, "-");
  const id = `gh-${slug(owner)}-${slug(name)}-${issue.number}`;
  const kind = issue.labels.some((l) => l.name === cfg.github.askLabel) ? "ask" : "pr";

  const fm: string[] = ["---", `id: ${id}`];
  if (kind === "pr") {
    fm.push(`repo: ${JSON.stringify(repo.path)}`);
    fm.push(`pr_title: ${JSON.stringify(issue.title)}`);
  } else {
    fm.push(`workdir: ${JSON.stringify(repo.path)}`);
  }
  fm.push(
    "github:",
    `  nwo: ${JSON.stringify(repo.nwo)}`,
    `  issue: ${issue.number}`,
    `  kind: ${kind}`,
    "---",
  );

  const parts: string[] = [`# ${issue.title}`];
  const body = (issue.body ?? "").trim();
  if (body) parts.push(body);
  if (parent) {
    const pBody = (parent.body ?? "").trim();
    parts.push(
      "## Context: parent issue\n\n" +
        "_Background only — the instruction is the body above._\n\n" +
        `**${parent.title}**` +
        (pBody ? `\n\n${pBody}` : ""),
    );
  }
  return { id, content: fm.join("\n") + "\n\n" + parts.join("\n\n") + "\n" };
}
```

- [ ] **Step 4: Verify pass + full suite** — `npx vitest run > /tmp/out 2>&1; echo "exit: $?"` — exit 0.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/githubInbox.ts tests/githubInbox.test.ts
git add -A src tests && git commit -m "feat(github): bridge pure helpers — lifecycle labels, eligibility, url parsing, issue→ticket"
```

---

### Task 9: `pollGithubInbox` — the sweep

**Files:**

- Modify: `src/githubInbox.ts` (append sweep machinery)
- Test: `tests/githubInbox.test.ts` (append)

**Interfaces:**

- Consumes: Task 8 helpers, `submitTicket` from `src/dispatch.ts`, `gh`/`git` wrappers from `src/git.ts`.
- Produces (consumed by Task 11):

```ts
export interface BridgeState {
  labelsEnsured: Set<string>;
  originOk: Map<string, boolean>;
}
export function newBridgeState(): BridgeState;
export interface BridgeDeps {
  ghFn?: typeof gh;
  gitFn?: typeof git;
  submitFn?: (cfg: Config, content: string, opts?: { idHint?: string }) => string;
}
export async function pollGithubInbox(
  cfg: Config,
  state: BridgeState,
  deps?: BridgeDeps,
): Promise<number>; // tickets bridged this sweep
```

- [ ] **Step 1: Failing tests.** Append to `tests/githubInbox.test.ts` a DI-fake harness. The fake `ghFn` dispatches on argv and records calls; the fake `gitFn` answers the origin probe:

```ts
import { pollGithubInbox, newBridgeState } from "../src/githubInbox.js";
import type { CmdResult } from "../src/git.js";

type Call = string[];
function makeFakes(opts: {
  issues?: unknown[];
  events?: string; // NDJSON lines from the --jq filter
  permission?: string;
  parent?: string; // "" | "null" | JSON
  origin?: string;
  failList?: boolean;
}) {
  const calls: Call[] = [];
  const ok = (stdout: string): CmdResult => ({ code: 0, stdout, stderr: "" });
  const ghFn = async (_c: unknown, args: string[]): Promise<CmdResult> => {
    calls.push(args);
    if (args[0] === "issue" && args[1] === "list") {
      if (opts.failList) throw new Error("api down");
      return ok(JSON.stringify(opts.issues ?? []));
    }
    if (args[0] === "label") return ok("");
    if (args[0] === "issue" && args[1] === "edit") return ok("");
    if (args[0] === "api" && args[1] === "graphql") return ok(opts.parent ?? "null");
    if (args[0] === "api" && String(args[2] ?? args[1]).includes("/events"))
      return ok(opts.events ?? "");
    if (args[0] === "api" && String(args[1]).includes("/permission"))
      return ok(opts.permission ?? "write");
    throw new Error(`unhandled gh argv: ${args.join(" ")}`);
  };
  const gitFn = async (_c: unknown, args: string[]): Promise<CmdResult> => {
    calls.push(["git", ...args]);
    return ok(opts.origin ?? "https://github.com/acme/api.git");
  };
  const submitted: { content: string; idHint?: string }[] = [];
  const submitFn = (_c: unknown, content: string, o?: { idHint?: string }): string => {
    submitted.push({ content, idHint: o?.idHint });
    return "/inbox/x.md";
  };
  return { ghFn, gitFn, submitFn, calls, submitted };
}

const bridgeCfg = {
  ...cfg,
  github: { ...cfg.github, repos: [{ nwo: "acme/api", path: "/home/u/code/api" }] },
} as Config;
const rawIssue = {
  number: 42,
  title: "Add rate limiting",
  body: "Body.",
  labels: [{ name: "junco" }],
};
const labeledEvent = `{"actor":"alice","label":"junco"}`;

describe("pollGithubInbox", () => {
  it("bridges an eligible issue: submit then queued label", async () => {
    const f = makeFakes({ issues: [rawIssue], events: labeledEvent, permission: "write" });
    const n = await pollGithubInbox(bridgeCfg, newBridgeState(), f as never);
    expect(n).toBe(1);
    expect(f.submitted).toHaveLength(1);
    expect(f.submitted[0].content).toContain('nwo: "acme/api"');
    const editIdx = f.calls.findIndex((c) => c[0] === "issue" && c[1] === "edit");
    expect(f.calls[editIdx]).toContain("junco:queued");
  });

  it("denies without write permission: denied label, no submit", async () => {
    const f = makeFakes({ issues: [rawIssue], events: labeledEvent, permission: "read" });
    const n = await pollGithubInbox(bridgeCfg, newBridgeState(), f as never);
    expect(n).toBe(0);
    expect(f.submitted).toHaveLength(0);
    const edit = f.calls.find((c) => c[0] === "issue" && c[1] === "edit");
    expect(edit).toContain("junco:denied");
  });

  it("fail-closed: events API error → no submit, no label", async () => {
    const f = makeFakes({ issues: [rawIssue], permission: "write" });
    // events: "" → no labeled event found → unverified → skip
    const n = await pollGithubInbox(bridgeCfg, newBridgeState(), f as never);
    expect(n).toBe(0);
    expect(f.submitted).toHaveLength(0);
    expect(f.calls.find((c) => c[0] === "issue" && c[1] === "edit")).toBeUndefined();
  });

  it("duplicate submit still applies the queued label", async () => {
    const f = makeFakes({ issues: [rawIssue], events: labeledEvent });
    const throwingSubmit = (): string => {
      throw new Error("ticket already queued: /inbox/gh-acme-api-42.md");
    };
    const n = await pollGithubInbox(bridgeCfg, newBridgeState(), {
      ...f,
      submitFn: throwingSubmit,
    } as never);
    expect(n).toBe(1);
    expect(f.calls.find((c) => c[1] === "edit" && c.includes("junco:queued"))).toBeDefined();
  });

  it("origin mismatch disables the repo: no issue list call", async () => {
    const f = makeFakes({ issues: [rawIssue], origin: "https://github.com/other/thing.git" });
    const n = await pollGithubInbox(bridgeCfg, newBridgeState(), f as never);
    expect(n).toBe(0);
    expect(f.calls.find((c) => c[0] === "issue" && c[1] === "list")).toBeUndefined();
  });

  it("a repo-level list failure is contained (returns 0, no throw)", async () => {
    const f = makeFakes({ failList: true });
    await expect(pollGithubInbox(bridgeCfg, newBridgeState(), f as never)).resolves.toBe(0);
  });

  it("includes parent context when the issue is a sub-issue", async () => {
    const f = makeFakes({
      issues: [rawIssue],
      events: labeledEvent,
      parent: `{"title":"Uploads are slow","body":"30s uploads."}`,
    });
    await pollGithubInbox(bridgeCfg, newBridgeState(), f as never);
    expect(f.submitted[0].content).toContain("## Context: parent issue");
  });
});
```

- [ ] **Step 2: Verify failure** — `npx vitest run tests/githubInbox.test.ts > /tmp/out 2>&1; echo "exit: $?"` — FAIL.

- [ ] **Step 3: Implement.** Append to `src/githubInbox.ts` (new imports at top: `import { gh, git, type CmdResult } from "./git.js";`, `import { submitTicket } from "./dispatch.js";`, `import { log } from "./logging.js";`):

```ts
// ---------------------------------------------------------------------------
// Sweep — poll watched repos, verify, materialize tickets, mark queued.
// ---------------------------------------------------------------------------

export interface BridgeState {
  /** nwo set whose lifecycle labels were ensured this process. */
  labelsEnsured: Set<string>;
  /** nwo → origin-check verdict (a mismatch disables the repo this process). */
  originOk: Map<string, boolean>;
}

export function newBridgeState(): BridgeState {
  return { labelsEnsured: new Set(), originOk: new Map() };
}

export interface BridgeDeps {
  ghFn?: typeof gh;
  gitFn?: typeof git;
  submitFn?: (cfg: Config, content: string, opts?: { idHint?: string }) => string;
}

const GH_TIMEOUT = 60_000;
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const LABEL_SPECS: ReadonlyArray<[keyof LifecycleLabels, string, string]> = [
  ["queued", "FBCA04", "junco: queued for the worker"],
  ["working", "1D76DB", "junco: worker is on it"],
  ["done", "0E8A16", "junco: finished — see the closing comment"],
  ["failed", "B60205", "junco: failed — see the closing comment"],
  ["denied", "5319E7", "junco: trigger label applied without write permission"],
];

async function originOkFor(
  cfg: Config,
  repo: GithubRepoMapping,
  state: BridgeState,
  gitFn: typeof git,
): Promise<boolean> {
  const cached = state.originOk.get(repo.nwo);
  if (cached !== undefined) return cached;
  let ok = false;
  try {
    const r = await gitFn(cfg, ["-C", repo.path, "remote", "get-url", "origin"], { check: false });
    const actual = r.code === 0 ? nwoFromRemoteUrl(r.stdout.trim()) : null;
    ok = actual !== null && actual.toLowerCase() === repo.nwo.toLowerCase();
    if (!ok) {
      log.error("github bridge: mapped path origin does not match nwo; repo disabled this run", {
        nwo: repo.nwo,
        path: repo.path,
        actual,
      });
    }
  } catch (e) {
    log.error("github bridge: origin check failed; repo disabled this run", {
      nwo: repo.nwo,
      error: errMsg(e),
    });
  }
  state.originOk.set(repo.nwo, ok);
  return ok;
}

async function ensureLabels(
  cfg: Config,
  nwo: string,
  state: BridgeState,
  ghFn: typeof gh,
): Promise<void> {
  if (state.labelsEnsured.has(nwo)) return;
  const ll = lifecycleLabels(cfg.github.triggerLabel);
  for (const [key, color, description] of LABEL_SPECS) {
    // --force = create-or-update, idempotent.
    await ghFn(
      cfg,
      [
        "label",
        "create",
        ll[key],
        "--repo",
        nwo,
        "--color",
        color,
        "--description",
        description,
        "--force",
      ],
      { timeoutMs: GH_TIMEOUT, retryNetwork: true },
    );
  }
  state.labelsEnsured.add(nwo);
}

/** Who last applied the trigger label, and may they dispatch? Fail-closed:
 * any verification error → "unverified" (skip this sweep, retry next). */
async function verifyLabeler(
  cfg: Config,
  nwo: string,
  issueNumber: number,
  ghFn: typeof gh,
): Promise<"ok" | "denied" | "unverified"> {
  try {
    const ev = await ghFn(
      cfg,
      [
        "api",
        "--paginate",
        `repos/${nwo}/issues/${issueNumber}/events`,
        "--jq",
        '.[] | select(.event == "labeled") | {actor: .actor.login, label: .label.name}',
      ],
      { timeoutMs: GH_TIMEOUT, retryNetwork: true },
    );
    const events = ev.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { actor: string; label: string });
    const last = [...events].reverse().find((l) => l.label === cfg.github.triggerLabel);
    if (!last) return "unverified";
    const perm = await ghFn(
      cfg,
      ["api", `repos/${nwo}/collaborators/${last.actor}/permission`, "--jq", ".permission"],
      { timeoutMs: GH_TIMEOUT, retryNetwork: true },
    );
    const p = perm.stdout.trim();
    // The legacy permission field maps maintain→write, so admin|write covers it.
    return p === "admin" || p === "write" ? "ok" : "denied";
  } catch (e) {
    log.warn("github bridge: labeler verification failed; skipping issue this sweep", {
      nwo,
      issue: issueNumber,
      error: errMsg(e),
    });
    return "unverified";
  }
}

/** Sub-issue parent lookup (GraphQL `parent` field). Non-fatal: null on any error. */
async function fetchParent(
  cfg: Config,
  nwo: string,
  issueNumber: number,
  ghFn: typeof gh,
): Promise<{ title: string; body: string | null } | null> {
  const [owner, name] = nwo.split("/");
  try {
    const r = await ghFn(
      cfg,
      [
        "api",
        "graphql",
        "-f",
        "query=query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){parent{title body}}}}",
        "-f",
        `owner=${owner}`,
        "-f",
        `name=${name}`,
        "-F",
        `number=${issueNumber}`,
        "--jq",
        ".data.repository.issue.parent",
      ],
      { timeoutMs: GH_TIMEOUT, retryNetwork: true },
    );
    const out = r.stdout.trim();
    if (!out || out === "null") return null;
    const p = JSON.parse(out) as { title?: unknown; body?: unknown };
    return typeof p.title === "string"
      ? { title: p.title, body: typeof p.body === "string" ? p.body : null }
      : null;
  } catch {
    return null; // background context only — never blocks dispatch
  }
}

/**
 * One bridge sweep across all configured repos. Failures are contained at the
 * repo and issue level — the queue never depends on GitHub being up. Ordering
 * per issue: submit BEFORE label, so a crash between the two self-heals (the
 * next sweep re-submits, hits the duplicate guard, and re-applies the label).
 */
export async function pollGithubInbox(
  cfg: Config,
  state: BridgeState,
  deps: BridgeDeps = {},
): Promise<number> {
  const ghFn = deps.ghFn ?? gh;
  const gitFn = deps.gitFn ?? git;
  const submitFn = deps.submitFn ?? submitTicket;
  const trigger = cfg.github.triggerLabel;
  const ll = lifecycleLabels(trigger);
  let bridged = 0;

  for (const repo of cfg.github.repos) {
    try {
      if (!(await originOkFor(cfg, repo, state, gitFn))) continue;
      await ensureLabels(cfg, repo.nwo, state, ghFn);
      const list = await ghFn(
        cfg,
        [
          "issue",
          "list",
          "--repo",
          repo.nwo,
          "--label",
          trigger,
          "--state",
          "open",
          "--limit",
          "100",
          "--json",
          "number,title,body,labels",
        ],
        { timeoutMs: GH_TIMEOUT, retryNetwork: true },
      );
      const issues = (JSON.parse(list.stdout) as GhIssue[]).filter((i) => isEligible(i, trigger));

      for (const issue of issues) {
        try {
          const verdict = await verifyLabeler(cfg, repo.nwo, issue.number, ghFn);
          if (verdict === "unverified") continue; // fail-closed; retry next sweep
          if (verdict === "denied") {
            await ghFn(
              cfg,
              ["issue", "edit", String(issue.number), "--repo", repo.nwo, "--add-label", ll.denied],
              { timeoutMs: GH_TIMEOUT, retryNetwork: true },
            );
            log.warn("github bridge: trigger label applied without write permission", {
              nwo: repo.nwo,
              issue: issue.number,
            });
            continue;
          }
          const parent = await fetchParent(cfg, repo.nwo, issue.number, ghFn);
          const t = issueToTicket(issue, repo, cfg, parent);
          try {
            submitFn(cfg, t.content, { idHint: t.id });
          } catch (e) {
            if (!errMsg(e).includes("already queued")) throw e;
            log.info("github bridge: ticket already queued; re-marking", { id: t.id });
          }
          await ghFn(
            cfg,
            ["issue", "edit", String(issue.number), "--repo", repo.nwo, "--add-label", ll.queued],
            { timeoutMs: GH_TIMEOUT, retryNetwork: true },
          );
          bridged++;
          log.info("github bridge: dispatched issue", {
            nwo: repo.nwo,
            issue: issue.number,
            id: t.id,
          });
        } catch (e) {
          log.warn("github bridge: issue skipped", {
            nwo: repo.nwo,
            issue: issue.number,
            error: errMsg(e),
          });
        }
      }
    } catch (e) {
      log.warn("github bridge: repo sweep failed; queue unaffected", {
        nwo: repo.nwo,
        error: errMsg(e),
      });
    }
  }
  return bridged;
}
```

Note: `GithubRepoMapping` import from `./types.js` was added in Task 8's header — verify it's there.

- [ ] **Step 4: Verify pass + full suite** — `npx vitest run > /tmp/out 2>&1; echo "exit: $?"` — exit 0.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/githubInbox.ts tests/githubInbox.test.ts
git add -A src tests && git commit -m "feat(github): pollGithubInbox sweep — permission gate, origin check, parent context, submit-then-label"
```

---

### Task 10: GitHub reporter — labels + the one comment

**Files:**

- Create: `src/githubReport.ts`
- Test: `tests/githubReport.test.ts` (new)

**Interfaces:**

- Consumes: `TicketReporter`/`TicketOutcome` (Task 7), `lifecycleLabels` (Task 8), `TERMINAL_DONE_STATUSES` (existing), `gh` wrapper.
- Produces (consumed by Task 11):

```ts
export const COMMENT_LIMIT = 60_000;
export function buildFinalComment(ticket: Ticket, outcome: TicketOutcome): string;
export interface GithubReporterDeps {
  ghFn?: typeof gh;
}
export function makeGithubReporter(cfg: Config, deps?: GithubReporterDeps): TicketReporter;
```

- [ ] **Step 1: Failing tests.** Create `tests/githubReport.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildFinalComment, makeGithubReporter, COMMENT_LIMIT } from "../src/githubReport.js";
import type { TicketOutcome } from "../src/reporter.js";
import type { Ticket, Config } from "../src/types.js";
import type { CmdResult } from "../src/git.js";

const ticket = (github: Ticket["github"]): Ticket =>
  ({
    path: "/q/t.md",
    id: "gh-acme-api-42",
    priority: "normal",
    timeoutSeconds: 60,
    body: "b",
    frontmatter: {},
    hasRepo: true,
    notBefore: null,
    retryCount: 0,
    tools: null,
    github,
    workdir: null,
  }) as Ticket;
const gt = { nwo: "acme/api", issue: 42, kind: "pr" as const };
const out = (o: Partial<TicketOutcome>): TicketOutcome => ({
  kind: "pr",
  status: "completed",
  prUrl: "https://github.com/acme/api/pull/7",
  finalText: "Implemented the limiter.\n\nMore detail here.",
  failureReason: null,
  ...o,
});
const cfg = {
  ghBin: "gh",
  github: {
    enabled: true,
    triggerLabel: "junco",
    askLabel: "junco:ask",
    pollIntervalSeconds: 60,
    repos: [],
  },
} as unknown as Config;

describe("buildFinalComment", () => {
  it("pr success: link + first-paragraph summary", () => {
    const c = buildFinalComment(ticket(gt), out({}));
    expect(c).toContain("Opened https://github.com/acme/api/pull/7");
    expect(c).toContain("Implemented the limiter.");
    expect(c).not.toContain("More detail here."); // only the first paragraph
  });
  it("partial salvage is called out explicitly", () => {
    const c = buildFinalComment(ticket(gt), out({ status: "timeout_partial" }));
    expect(c).toContain("Partial run");
  });
  it("pr failure: reason + transcript pointer", () => {
    const c = buildFinalComment(
      ticket(gt),
      out({ status: "failed", prUrl: null, failureReason: "push exploded" }),
    );
    expect(c).toContain("failed");
    expect(c).toContain("push exploded");
    expect(c).toContain("transcript");
  });
  it("qa success: the answer is the comment", () => {
    const c = buildFinalComment(
      ticket({ ...gt, kind: "ask" }),
      out({ kind: "qa", prUrl: null, finalText: "The answer is 42." }),
    );
    expect(c).toContain("The answer is 42.");
  });
  it("truncates at the comment limit with a note", () => {
    const c = buildFinalComment(
      ticket({ ...gt, kind: "ask" }),
      out({ kind: "qa", prUrl: null, finalText: "x".repeat(70_000) }),
    );
    expect(c.length).toBeLessThanOrEqual(COMMENT_LIMIT + 200);
    expect(c).toContain("truncated");
  });
});

describe("makeGithubReporter", () => {
  function fakeGh() {
    const calls: string[][] = [];
    const ghFn = async (_c: unknown, args: string[]): Promise<CmdResult> => {
      calls.push(args);
      return { code: 0, stdout: "", stderr: "" };
    };
    return { ghFn, calls };
  }

  it("onStart flips queued→working", async () => {
    const f = fakeGh();
    await makeGithubReporter(cfg, f as never).onStart(ticket(gt));
    expect(f.calls[0]).toEqual(
      expect.arrayContaining([
        "issue",
        "edit",
        "42",
        "--repo",
        "acme/api",
        "--add-label",
        "junco:working",
        "--remove-label",
        "junco:queued",
      ]),
    );
  });

  it("onFinal comments first, then flips to done for TERMINAL_DONE statuses", async () => {
    const f = fakeGh();
    await makeGithubReporter(cfg, f as never).onFinal(ticket(gt), out({ status: "completed" }));
    expect(f.calls[0][0]).toBe("issue");
    expect(f.calls[0][1]).toBe("comment");
    expect(f.calls[1]).toEqual(expect.arrayContaining(["--add-label", "junco:done"]));
  });

  it("onFinal flips to failed for non-done statuses", async () => {
    const f = fakeGh();
    await makeGithubReporter(cfg, f as never).onFinal(
      ticket(gt),
      out({ status: "failed", prUrl: null }),
    );
    expect(f.calls[1]).toEqual(expect.arrayContaining(["--add-label", "junco:failed"]));
  });

  it("ignores local tickets (github: null) — zero gh calls", async () => {
    const f = fakeGh();
    const r = makeGithubReporter(cfg, f as never);
    await r.onStart(ticket(null));
    await r.onFinal(ticket(null), out({}));
    expect(f.calls).toHaveLength(0);
  });

  it("never throws when gh fails", async () => {
    const ghFn = async (): Promise<CmdResult> => {
      throw new Error("network sad");
    };
    const r = makeGithubReporter(cfg, { ghFn } as never);
    await expect(r.onFinal(ticket(gt), out({}))).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Verify failure** — `npx vitest run tests/githubReport.test.ts > /tmp/out 2>&1; echo "exit: $?"` — FAIL.

- [ ] **Step 3: Implement.** Create `src/githubReport.ts`:

```ts
/**
 * GitHub reporter — the feedback side of GitHub-integrated mode.
 *
 * Lifecycle labels are flipped silently; exactly ONE comment lands at
 * finalize (PR link + summary | the Q&A answer | the failure reason).
 * Everything is best-effort: a lost comment or stale label is cosmetic —
 * local done//failed/ and the PR itself are the source of truth.
 */

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TERMINAL_DONE_STATUSES, type Config, type Ticket, type TicketGithub } from "./types.js";
import type { TicketReporter, TicketOutcome } from "./reporter.js";
import { lifecycleLabels } from "./githubInbox.js";
import { gh } from "./git.js";
import { log } from "./logging.js";

/** GitHub's hard cap is 65,536 chars; leave headroom for the truncation note. */
export const COMMENT_LIMIT = 60_000;

const GH_TIMEOUT = 60_000;
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function firstParagraph(text: string, cap = 600): string {
  const p =
    text
      .trim()
      .split(/\n\s*\n/)[0]
      ?.trim() ?? "";
  return p.length > cap ? p.slice(0, cap) + "…" : p;
}

export function buildFinalComment(ticket: Ticket, outcome: TicketOutcome): string {
  const parts: string[] = [];
  const done = TERMINAL_DONE_STATUSES.has(outcome.status);

  if (outcome.kind === "qa") {
    if (done) {
      parts.push(outcome.finalText.trim() || "_(no answer text)_");
    } else {
      parts.push(`**Junco could not answer this ticket** (status: \`${outcome.status}\`).`);
      if (outcome.failureReason) parts.push(`> ${outcome.failureReason.slice(0, 1000)}`);
      parts.push(
        `_Transcript on the worker host: \`transcripts/${ticket.id}.jsonl\` under the state dir._`,
      );
    }
  } else if (outcome.prUrl) {
    parts.push(`Opened ${outcome.prUrl}`);
    if (outcome.status === "timeout_partial" || outcome.status === "aborted_partial") {
      parts.push(
        "> ⚠️ **Partial run.** The session was cut off mid-work; commits made before the " +
          "cutoff were salvaged into the PR. Review for completeness.",
      );
    }
    const summary = firstParagraph(outcome.finalText);
    if (summary) parts.push(summary);
  } else if (done) {
    parts.push(`Finished with status \`${outcome.status}\` — no pull request was needed.`);
  } else {
    parts.push(`**Junco failed to produce a pull request** (status: \`${outcome.status}\`).`);
    if (outcome.failureReason) parts.push(`> ${outcome.failureReason.slice(0, 1000)}`);
    parts.push(
      `_Transcript on the worker host: \`transcripts/${ticket.id}.jsonl\` under the state dir._`,
    );
  }

  let out = parts.join("\n\n") + "\n";
  if (out.length > COMMENT_LIMIT) {
    out =
      out.slice(0, COMMENT_LIMIT) +
      "\n\n_… truncated — full text is in the finalized ticket file on the worker host._\n";
  }
  return out;
}

export interface GithubReporterDeps {
  ghFn?: typeof gh;
}

export function makeGithubReporter(cfg: Config, deps: GithubReporterDeps = {}): TicketReporter {
  const ghFn = deps.ghFn ?? gh;
  const ll = lifecycleLabels(cfg.github.triggerLabel);

  const swap = async (g: TicketGithub, add: string, remove: string): Promise<void> => {
    await ghFn(
      cfg,
      [
        "issue",
        "edit",
        String(g.issue),
        "--repo",
        g.nwo,
        "--add-label",
        add,
        "--remove-label",
        remove,
      ],
      { timeoutMs: GH_TIMEOUT, retryNetwork: true },
    );
  };
  const guard = async (label: string, id: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (e) {
      // Best-effort by contract: a stale label/lost comment is cosmetic.
      log.warn(`github reporter: ${label} failed (issue state on GitHub may be stale)`, {
        id,
        error: errMsg(e),
      });
    }
  };

  return {
    async onStart(t: Ticket): Promise<void> {
      if (!t.github) return;
      const g = t.github;
      await guard("onStart", t.id, () => swap(g, ll.working, ll.queued));
    },
    async onRequeue(t: Ticket): Promise<void> {
      if (!t.github) return;
      const g = t.github;
      await guard("onRequeue", t.id, () => swap(g, ll.queued, ll.working));
    },
    async onFinal(t: Ticket, outcome: TicketOutcome): Promise<void> {
      if (!t.github) return;
      const g = t.github;
      // Comment first — it is the valuable artifact; the label is cosmetic.
      await guard("final comment", t.id, async () => {
        const body = buildFinalComment(t, outcome);
        const dir = mkdtempSync(join(tmpdir(), "junco-ghc-"));
        const file = join(dir, "comment.md");
        writeFileSync(file, body, "utf8");
        try {
          await ghFn(
            cfg,
            ["issue", "comment", String(g.issue), "--repo", g.nwo, "--body-file", file],
            { timeoutMs: GH_TIMEOUT, retryNetwork: true },
          );
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });
      const done = TERMINAL_DONE_STATUSES.has(outcome.status);
      await guard("final labels", t.id, () => swap(g, done ? ll.done : ll.failed, ll.working));
    },
  };
}
```

- [ ] **Step 4: Verify pass + full suite** — `npx vitest run > /tmp/out 2>&1; echo "exit: $?"` — exit 0.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/githubReport.ts tests/githubReport.test.ts
git add -A src tests && git commit -m "feat(github): reporter — lifecycle label flips + the one finalize comment"
```

---

### Task 11: Daemon wiring + bridge metrics

**Files:**

- Modify: `src/metrics.ts` (snapshot + recorders)
- Modify: `src/daemon.ts` (mainLoop + runScheduler)
- Modify: `src/cli.ts` IF `run-once`/`start` call `runOnce`/`executeClaimed` directly (verify with `grep -n "runOnce\|mainLoop" src/cli.ts src/service.ts` — wire `reporter` the same way wherever RunDeps are built)
- Test: `tests/metrics.test.ts`, `tests/daemon.test.ts`

**Interfaces:**

- Consumes: `pollGithubInbox`/`newBridgeState` (Task 9), `makeGithubReporter` (Task 10), `RunDeps.reporter` (Task 7).
- Produces: `MainLoopDeps.bridgeSweepFn?: (cfg: Config) => Promise<number>`; `SchedulerDeps.maybeBridgeSweepFn?: () => Promise<void>`; `SchedulerDeps.reporter?: TicketReporter`; metrics fields `bridgeSweeps`, `lastBridgeSweepAt`, `ticketsBridged`, `bridgeErrors` + `recordBridgeSweep(bridged: number)` / `recordBridgeError()`.

- [ ] **Step 1: Failing metrics tests** (append to `tests/metrics.test.ts`):

```ts
describe("bridge metrics", () => {
  it("records sweeps, bridged counts, and errors", () => {
    const m = new RunMetrics(() => new Date("2026-07-02T00:00:00Z"));
    m.recordBridgeSweep(2);
    m.recordBridgeSweep(0);
    m.recordBridgeError();
    const s = m.snapshot();
    expect(s.bridgeSweeps).toBe(2);
    expect(s.ticketsBridged).toBe(2);
    expect(s.bridgeErrors).toBe(1);
    expect(s.lastBridgeSweepAt).toBe("2026-07-02T00:00:00.000Z");
  });
  it("reset clears bridge fields", () => {
    const m = new RunMetrics();
    m.recordBridgeSweep(1);
    m.reset();
    expect(m.snapshot().bridgeSweeps).toBe(0);
    expect(m.snapshot().ticketsBridged).toBe(0);
  });
});
```

- [ ] **Step 2: Failing daemon tests** (append to `tests/daemon.test.ts`, using its existing `makeConfig`/tick-sleep helpers — remember the macrotask-starvation gotcha: fake sleeps must `await new Promise((r) => setTimeout(r, 1))`):

```ts
describe("github bridge wiring", () => {
  it("enabled=false: injected bridgeSweepFn is never called", async () => {
    let sweeps = 0;
    const cfg = makeConfig(); // github.enabled false in fixtures
    const stop = new StopFlag();
    await mainLoop(
      cfg,
      stop,
      { once: true },
      {
        ...quietDeps,
        runOnceFn: async () => {
          stop.requestStop();
          return false;
        },
        bridgeSweepFn: async () => {
          sweeps++;
          return 0;
        },
      },
    );
    expect(sweeps).toBe(0);
  });

  it("enabled=true: sweeps on the first poll and throttles within the interval", async () => {
    let sweeps = 0;
    let polls = 0;
    const cfg = {
      ...makeConfig(),
      github: {
        enabled: true,
        triggerLabel: "junco",
        askLabel: "junco:ask",
        pollIntervalSeconds: 3600,
        repos: [],
      },
    };
    const stop = new StopFlag();
    await mainLoop(
      cfg,
      stop,
      {},
      {
        ...quietDeps,
        runOnceFn: async () => {
          polls++;
          if (polls >= 3) stop.requestStop();
          return true; // handled → loop continues without sleeping
        },
        bridgeSweepFn: async () => {
          sweeps++;
          return 0;
        },
      },
    );
    expect(polls).toBe(3);
    expect(sweeps).toBe(1); // 3600s interval → only the first iteration sweeps
  });

  it("a sweep error does not crash the loop", async () => {
    const cfg = {
      ...makeConfig(),
      github: {
        enabled: true,
        triggerLabel: "junco",
        askLabel: "junco:ask",
        pollIntervalSeconds: 60,
        repos: [],
      },
    };
    const stop = new StopFlag();
    await expect(
      mainLoop(
        cfg,
        stop,
        { once: true },
        {
          ...quietDeps,
          runOnceFn: async () => {
            stop.requestStop();
            return false;
          },
          bridgeSweepFn: async () => {
            throw new Error("github down");
          },
        },
      ),
    ).resolves.toBeUndefined();
  });
});
```

(`quietDeps` = whatever the file already uses to stub `recoverOrphansFn`/`pruneFn`/`waitForEndpointFn`/`mkdirs`/`startHealthServerFn`/`sleep`; reuse its established helper.)

- [ ] **Step 3: Verify failure** — `npx vitest run tests/metrics.test.ts tests/daemon.test.ts > /tmp/out 2>&1; echo "exit: $?"` — FAIL.

- [ ] **Step 4: Implement metrics.** `src/metrics.ts` — add private fields:

```ts
  private _bridgeSweeps = 0;
  private _ticketsBridged = 0;
  private _bridgeErrors = 0;
  private _lastBridgeSweepAt: Date | null = null;
```

methods (after `recordPoll`):

```ts
  /** A bridge sweep completed; `bridged` = tickets materialized this sweep. */
  recordBridgeSweep(bridged: number): void {
    this._bridgeSweeps++;
    this._ticketsBridged += bridged;
    this._lastBridgeSweepAt = this._now();
  }

  /** A bridge sweep failed (queue unaffected). */
  recordBridgeError(): void {
    this._bridgeErrors++;
  }
```

`MetricsSnapshot` + `snapshot()` + `reset()` gain the four fields (`bridgeSweeps: number; lastBridgeSweepAt: string | null; ticketsBridged: number; bridgeErrors: number`), following the existing patterns exactly.

- [ ] **Step 5: Implement daemon.** `src/daemon.ts` — imports:

```ts
import { pollGithubInbox, newBridgeState } from "./githubInbox.js";
import { makeGithubReporter } from "./githubReport.js";
import type { TicketReporter } from "./reporter.js";
```

`MainLoopDeps` gains:

```ts
  /** Bridge sweep override (tests). Only consulted when cfg.github.enabled. */
  bridgeSweepFn?: (cfg: Config) => Promise<number>;
```

`SchedulerDeps` gains:

```ts
  maybeBridgeSweepFn?: () => Promise<void>;
  reporter?: TicketReporter;
```

In `runScheduler`, thread the reporter into the default executeFn and call the sweep at the top of the loop:

```ts
const executeFn =
  deps.executeFn ??
  ((c: Config, w: ClaimedWork) =>
    executeClaimed(c, w, { abortSignal: stopFlag.forceSignal, reporter: deps.reporter }));
```

and immediately after `metrics.recordPoll();`:

```ts
if (deps.maybeBridgeSweepFn) await deps.maybeBridgeSweepFn();
```

In `mainLoop`, before the `runOnceFn` default is built:

```ts
// GitHub bridge (issues → inbox) + reporter (labels/comment back). Gated on
// cfg.github.enabled: disabled = zero gh calls, local behavior unchanged.
const reporter = cfg.github.enabled ? makeGithubReporter(cfg) : undefined;
const bridgeSweepFn = cfg.github.enabled ? (deps.bridgeSweepFn ?? defaultBridgeSweep()) : null;
let lastSweepMs = -Infinity;
const monoMs = (): number => Number(process.hrtime.bigint() / 1_000_000n);
const maybeBridgeSweep = async (): Promise<void> => {
  if (!bridgeSweepFn) return;
  if (monoMs() - lastSweepMs < cfg.github.pollIntervalSeconds * 1000) return;
  lastSweepMs = monoMs();
  try {
    metrics.recordBridgeSweep(await bridgeSweepFn(cfg));
  } catch (e) {
    metrics.recordBridgeError();
    log.warn("github bridge sweep failed; queue unaffected", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
};
```

Change the `runOnceFn` default to include the reporter:

```ts
const runOnceFn =
  deps.runOnceFn ??
  ((c: Config) =>
    runOnce(c, {
      readyFn: () => endpointReachable(c),
      abortSignal: stopFlag.forceSignal,
      reporter,
    }));
```

Serial loop — right after `metrics.recordPoll();`:

```ts
await maybeBridgeSweep();
```

Scheduler call — pass the new deps:

```ts
await runScheduler(cfg, stopFlag, opts, {
  claimFn: deps.claimFn,
  executeFn: deps.executeFn,
  sleep: deps.sleep,
  readyFn: () => endpointReachable(cfg),
  maybeBridgeSweepFn: maybeBridgeSweep,
  reporter,
});
```

Module-level helper (bottom of daemon.ts):

```ts
/** Default bridge sweep: process-lifetime state (label/origin caches) in a closure. */
function defaultBridgeSweep(): (cfg: Config) => Promise<number> {
  const state = newBridgeState();
  return (cfg: Config) => pollGithubInbox(cfg, state);
}
```

Check `src/cli.ts` / `src/service.ts`: `grep -n "runOnce(\|mainLoop(" src/cli.ts src/service.ts`. Wherever `runOnce(` is called directly with RunDeps (e.g. a `run-once` command bypassing mainLoop), add `reporter: cfg.github.enabled ? makeGithubReporter(cfg) : undefined` to its deps.

- [ ] **Step 6: Verify pass + full suite** — `npx vitest run > /tmp/out 2>&1; echo "exit: $?"` — exit 0. If any health/healthServer test asserts an exact snapshot key set, add the four bridge fields there.

- [ ] **Step 7: Commit**

```bash
npx prettier --write src/metrics.ts src/daemon.ts src/cli.ts src/service.ts tests/metrics.test.ts tests/daemon.test.ts
git add -A src tests && git commit -m "feat(daemon): throttled github bridge sweep + reporter wiring + bridge metrics"
```

---

### Task 12: Observability & setup — doctor checks, status line, config template

**Files:**

- Modify: `src/doctor.ts` (new check block after check 7)
- Modify: `src/statusCmd.ts` (bridge line in detailLines)
- Modify: `src/wizard.ts` (`renderConfigToml` — commented `[github]` example)
- Test: `tests/doctor.test.ts`, `tests/statusCmd.test.ts`, `tests/wizard.test.ts`

**Interfaces:**

- Consumes: `nwoFromRemoteUrl` (Task 8), `cfg.github` (Task 1), bridge metrics fields (Task 11).

- [ ] **Step 1: Failing tests.**

`tests/doctor.test.ts` (follow its existing fake-`execFn`/`loadConfigFn` harness):

```ts
describe("github checks", () => {
  it("warns when enabled with no repos", async () => {
    // loadConfigFn returns a cfg with github.enabled=true, repos: []
    // assert the printed output contains "⚠ github" and "no repos configured"
  });
  it("fails a repo whose origin does not match the nwo", async () => {
    // execFn: git remote get-url origin → https://github.com/other/thing.git
    // assert output contains "✗ github repo acme/api"
  });
  it("passes a matching repo", async () => {
    // execFn: origin → https://github.com/acme/api.git ; gh repo view → code 0
    // assert output contains "✓ github repo acme/api"
  });
});
```

Write these fully against the file's existing harness (it drives `runDoctor(configPath, deps)` with a `printFn` capture — mirror the style of its existing cases).

`tests/statusCmd.test.ts`: extend the existing fake-fetch happy-path test's metrics payload with `bridgeSweeps: 5, ticketsBridged: 2, bridgeErrors: 1, lastBridgeSweepAt: "2026-07-02T00:00:00.000Z"` and assert the printed output contains `bridge:    5 sweeps · 2 bridged · 1 errors`.

`tests/wizard.test.ts`:

```ts
it("config template includes a commented [github] example", () => {
  const toml = renderConfigToml(answers); // reuse the file's existing answers fixture
  expect(toml).toContain("# [github]");
  expect(toml).toContain('# trigger_label = "junco"');
  expect(toml).toContain("# [[github.repos]]");
});
```

- [ ] **Step 2: Verify failure** — `npx vitest run tests/doctor.test.ts tests/statusCmd.test.ts tests/wizard.test.ts > /tmp/out 2>&1; echo "exit: $?"` — FAIL.

- [ ] **Step 3: Implement doctor.** In `src/doctor.ts`, import `nwoFromRemoteUrl` from `./githubInbox.js`, and after check 7 (dirs) add:

```ts
// 7b. github bridge (only when enabled)
if (cfg.github.enabled) {
  if (cfg.github.repos.length === 0) {
    report("warn", "github", "enabled but no repos configured — the bridge will idle");
  }
  for (const repo of cfg.github.repos) {
    const origin = await execFn(cfg.gitBin, ["-C", repo.path, "remote", "get-url", "origin"]);
    const actual = origin.code === 0 ? nwoFromRemoteUrl(origin.stdout.trim()) : null;
    if (actual === null || actual.toLowerCase() !== repo.nwo.toLowerCase()) {
      report(
        "fail",
        `github repo ${repo.nwo}`,
        origin.code !== 0
          ? `${repo.path} is not a git clone (or has no origin)`
          : `origin is ${actual ?? origin.stdout.trim()}, expected ${repo.nwo}`,
      );
      continue;
    }
    const view = await execFn(cfg.ghBin, ["repo", "view", repo.nwo, "--json", "name"]);
    report(
      view.code === 0 ? "ok" : "fail",
      `github repo ${repo.nwo}`,
      view.code === 0 ? repo.path : "not reachable via gh (auth? spelling?)",
    );
  }
}
```

- [ ] **Step 4: Implement status.** In `src/statusCmd.ts`, after the `last task:` line in `detailLines`, append conditionally:

```ts
if (Number(m.bridgeSweeps ?? 0) > 0 || Number(m.bridgeErrors ?? 0) > 0) {
  detailLines.push(
    `bridge:    ${m.bridgeSweeps} sweeps · ${m.ticketsBridged} bridged · ${m.bridgeErrors} errors`,
  );
}
```

- [ ] **Step 5: Implement wizard template.** In `src/wizard.ts` `renderConfigToml`, push before the returned string is assembled (at the end of the `lines` construction):

```ts
lines.push(
  "",
  "# --- GitHub-integrated mode (optional) -------------------------------------",
  "# Bridge trigger-labeled GitHub issues into the inbox and report results",
  "# back to the issue. Uses your existing `gh` auth. Docs: README → GitHub mode.",
  "# [github]",
  "# enabled = true",
  '# trigger_label = "junco"   # label = the approval; review issues before labeling',
  "# poll_interval_seconds = 60",
  "#",
  "# [[github.repos]]",
  '# nwo  = "owner/repo"',
  '# path = "~/code/repo"      # local clone; origin must point at nwo',
);
```

- [ ] **Step 6: Verify pass + full suite** — `npx vitest run > /tmp/out 2>&1; echo "exit: $?"` — exit 0.

- [ ] **Step 7: Commit**

```bash
npx prettier --write src/doctor.ts src/statusCmd.ts src/wizard.ts tests/doctor.test.ts tests/statusCmd.test.ts tests/wizard.test.ts
git add -A src tests && git commit -m "feat(observability): doctor github checks, status bridge line, config template example"
```

---

### Task 13: Documentation

**Files:**

- Modify: `README.md` (new "GitHub-integrated mode" section after the configuration docs)
- Modify: `ARCHITECTURE.md` (module map + queue data-flow: bridge + reporter)
- Modify: `CHANGELOG.md` (Unreleased → Added)

**Interfaces:** none (prose).

- [ ] **Step 1: README.** Add a section covering, in this order: what it is (labeled issues → tickets → PR → one comment back); the config block (same TOML as the wizard template, uncommented); the trust model ("the label is the approval — review the issue before labeling; Junco verifies the labeler has write access"); the lifecycle labels table (`junco:queued/working/done/failed/denied`) and re-dispatch semantics (remove the lifecycle label); the `junco:ask` Q&A path; the report→task-sub-issue→label team workflow (recommended pattern, parent context is included automatically); the snapshot caveat (issue edits after dispatch don't propagate); coexistence with the local inbox and that `enabled=false` means zero GitHub calls. Keep every sentence stack-agnostic ("inference endpoint").

- [ ] **Step 2: ARCHITECTURE.md.** Add `githubInbox.ts`, `githubReport.ts`, `reporter.ts` to the module map with one-line responsibilities, and extend the ticket-lifecycle diagram with the bridge entry edge (issue → inbox) and the reporter exit edge (finalize → comment/labels). Mention the submit-before-label crash-heal ordering and that reporter calls live only in `executeClaimed`.

- [ ] **Step 3: CHANGELOG.md** — under `## [Unreleased]` → `### Added`:

```markdown
- GitHub-integrated inbox mode: trigger-labeled issues become tickets (permission-verified,
  fail-closed), lifecycle labels + a single finalize comment report back, `junco:ask` routes
  to read-only Q&A, sub-issue parent context is attached automatically. `[github]` config
  section; `doctor`/`status`/`/health` cover the bridge. Local mode is untouched (default off).
- Ticket schema (additive): `github` provenance block and Q&A `workdir`.
```

- [ ] **Step 4: Full gate**

Run: `npm run lint && npm run format:check && npm run build && npm test > /tmp/out 2>&1; echo "exit: $?"` — exit 0.

- [ ] **Step 5: Commit**

```bash
npx prettier --write README.md ARCHITECTURE.md CHANGELOG.md
git add README.md ARCHITECTURE.md CHANGELOG.md && git commit -m "docs: GitHub-integrated mode — setup, trust model, lifecycle, architecture"
```

---

### Task 14: Final gate + branch review

- [ ] **Step 1: Full gate on a clean tree**

Run: `npm run lint && npm run format:check && npm run build && npm test > /tmp/out 2>&1; echo "exit: $?"` — expected exit 0; `git status --short` empty.

- [ ] **Step 2: Review the branch diff** — `git log --oneline main..HEAD` (expect ~13 commits) and `git diff main --stat`. Confirm: no AI attribution in any commit (`git log main..HEAD --format=%B | grep -i "claude\|generated with"` → empty), no new dependencies (`git diff main -- package.json` → version-only or empty), ticket schema changes additive only.

- [ ] **Step 3: Report** completion to the maintainer with the branch name and a summary. Do NOT merge, push, tag, or release — the release HOLD applies; pushing the feature branch or opening a PR happens only on explicit instruction.
