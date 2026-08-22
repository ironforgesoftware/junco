# Issue-as-Inbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a pre-authored ticket ride a GitHub issue verbatim — the bridge extracts a `junco-ticket`/`junco-plan` fence from a trigger-labeled issue body and queues it directly, and `junco submit --as-issue` files such an issue (parked, unlabeled, bot-authored).

**Architecture:** Two additive pieces. (1) The labeled-issue sweep in `src/githubInbox.ts` gains a fence check between the existing ask branch and the planner fallback, reusing `buildExecutionTicket` / `dispatchPlanSet` — the exact materializers the plan-comment approval path already uses. (2) A new `src/submitAsIssue.ts` module (called from the `submit` branch of `cli.ts`) validates a local ticket, wraps its body in a fence, and files it as an unlabeled issue via the bot account. No new config keys; the existing label-vouch machinery (edited-after-label refusal, `verifyLabelApplier`) covers the new door untouched.

**Tech Stack:** TypeScript (Node ≥ 22.19, ESM/NodeNext, strict), vitest, zod, `gh` CLI via the `gh()` seam in `src/git.ts`.

**Spec:** `docs/superpowers/specs/2026-08-21-issue-as-inbox-design.md` (committed in Task 1 — read it first).

## Global Constraints

- **No AI attribution in commits** — no `Co-Authored-By: Claude`, no "Generated with" lines. Amend them away if a tool appends one.
- Conventional commits (`feat:`, `fix:`, `docs:`, `chore:`), suite green at every commit.
- No new dependencies. No new config keys.
- Run `npx prettier --write` on every touched file before each commit (prettier may reformat between read and edit — re-read before editing).
- Vitest exit-code trap: never pipe vitest into a filter. Capture: `npx vitest run tests/<f>.test.ts > /tmp/out 2>&1; echo "exit: $?"`.
- Working directory for ALL tasks: `~/Development/junco/worktrees-manual/issue-as-inbox` (branch `feat/issue-as-inbox`, already created, `npm ci` done). NEVER touch the main checkout, `~/.junco`, or `tickets/` — the repo doubles as the maintainer's live runtime.
- Frontmatter is machine-owned on the bridge: nothing extracted from an issue may set `repo:`/`workdir:`/`tools:`/network rails. `buildExecutionTicket` and `dispatchPlanSet` already enforce this — do not add a path that bypasses them.
- Deviation from spec, agreed during planning: the spec names a `queueFromFence()` helper to factor out; the codebase already has the factored pieces (`buildExecutionTicket`, `dispatchPlanSet`). Do NOT introduce a new helper — reuse those.

---

### Task 1: Commit spec + plan docs

**Files:**
- Already present (untracked): `docs/superpowers/specs/2026-08-21-issue-as-inbox-design.md`, `docs/superpowers/plans/2026-08-21-issue-as-inbox.md`

**Interfaces:** none — docs only.

- [ ] **Step 1: Commit**

```bash
git add docs/superpowers/specs/2026-08-21-issue-as-inbox-design.md docs/superpowers/plans/2026-08-21-issue-as-inbox.md
git commit -m "docs: issue-as-inbox spec and implementation plan"
```

---

### Task 2: Bridge — `junco-ticket` fence door in the labeled sweep

**Files:**
- Modify: `src/githubInbox.ts` — the labeled-issue dispatch block (search for `const isAsk = issue.labels.some`; currently ~line 1025, inside `pollGithubInbox`'s per-issue loop, AFTER the edited-after-label guard)
- Test: `tests/githubInbox.test.ts` — inside the existing `describe("pollGithubInbox", ...)`

**Interfaces:**
- Consumes (all already exported/in-module): `extractPlanBody(text): string | null`, `buildExecutionTicket(issueNumber, repo, planBody): {id, content}`, `issueToTicket`, `buildPlanningTicket`, `fetchParent`, `ticketInFlight`, lifecycle labels `ll.queued`/`ll.planning`.
- Produces: sweep behavior — a trigger-labeled, vouched issue whose body contains a ```` ```junco-ticket ```` fence queues an execution ticket immediately (state label `ll.queued`), skipping the planner. Ask label still wins over a fence. Task 3 builds directly on this block's shape.

- [ ] **Step 1: Write the failing tests**

Add to `describe("pollGithubInbox", ...)` in `tests/githubInbox.test.ts`. Reuse the exact fixture options (`issues`, `events`, `permission`, `lastEditedAt`, `parent`) from the neighboring test that asserts a plan ticket is dispatched for a trigger-labeled issue — copy its `makeFakes({...})` arguments and its `pollGithubInbox(...)` call verbatim, changing only the issue body and the assertions. The issue literal must match the field shape the neighboring tests use (number, title, body, labels array of `{name}`).

```ts
it("queues a junco-ticket fence from the issue body verbatim, skipping the planner", async () => {
  const fenceBody = "# Do the thing\n\n## Tasks\n\n- do it\n";
  const body = "Parked ticket.\n\n```junco-ticket\n" + fenceBody + "```\n";
  // makeFakes/pollGithubInbox args: copied from the neighboring
  // plan-dispatch test, with the issue body replaced by `body`.
  const f = makeFakes({ issues: [/* same shape, body */], events: /* same */, lastEditedAt: "null" });
  // ... pollGithubInbox call as in the neighboring test ...
  expect(f.submitted).toHaveLength(1);
  const t = f.submitted[0];
  // Execution ticket, not a planning ticket: body is the fence content verbatim.
  expect(t.content).toContain("# Do the thing");
  expect(t.content).not.toContain("READ-ONLY");         // planner-prompt marker absent
  expect(t.content).toContain("kind: pr");
  expect(t.idHint).toMatch(/^gh-/);
  // State label is queued, not planning.
  const editCalls = f.calls.filter((c) => c[0] === "issue" && c[1] === "edit");
  expect(editCalls.some((c) => c.includes("--add-label") && c.includes("junco:queued"))).toBe(true);
  expect(editCalls.some((c) => c.join(" ").includes("planning"))).toBe(false);
});

it("ask label wins over a junco-ticket fence (prose ask ticket, fence not extracted)", async () => {
  const body = "Please explain X.\n\n```junco-ticket\n# Sneaky\n```\n";
  // Same fixture as the neighboring ASK-label dispatch test, body replaced.
  // ...
  expect(f.submitted).toHaveLength(1);
  expect(f.submitted[0].content).toContain("Please explain X.");
  expect(f.submitted[0].content).toContain("workdir:");   // ask rails, not repo:
});

it("no fence still routes to the planner (regression)", async () => {
  // Identical to the existing plan-dispatch test's fixture with a plain prose
  // body; assert the submitted ticket contains the planner-prompt marker text
  // (e.g. "kind: plan" in frontmatter) exactly as that test already does.
});

it("refuses a fence body edited after the trigger label (re-vouch guard covers the fence door)", async () => {
  // Same fence body as the first test, but with the fixture's lastEditedAt
  // set AFTER the label-event timestamp (copy how the existing
  // edited-after-label test constructs that mismatch). Assert:
  expect(f.submitted).toHaveLength(0);
});
```

Replace the `junco:queued` literal with the actual queued lifecycle label string used elsewhere in the file (derived from the trigger label — check `lifecycleLabels` in `src/githubInbox.ts` and reuse whatever constant/string the neighboring tests assert).

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npx vitest run tests/githubInbox.test.ts > /tmp/t2.out 2>&1; echo "exit: $?"` — expect the two new tests FAIL (fence body currently routes to the planner: content contains the planner prompt, label is planning). The regression test should already pass.

- [ ] **Step 3: Implement the fence branch**

In the labeled-issue dispatch block of `src/githubInbox.ts`, replace:

```ts
const isAsk = issue.labels.some((l) => l.name === cfg.github.askLabel);
const parent = isAsk ? null : await fetchParent(cfg, repo.nwo, issue.number, ghFn);
const t = isAsk
  ? issueToTicket(issue, repo, cfg, null)
  : buildPlanningTicket(issue, repo, cfg, parent);
const stateLabel = isAsk ? ll.queued : ll.planning;
```

with:

```ts
const isAsk = issue.labels.some((l) => l.name === cfg.github.askLabel);
// Issue-as-inbox door (spec 2026-08-21): a vouched body carrying a
// junco-ticket fence queues verbatim — the planner is only the fence
// PRODUCER for issues that arrive without one. Ask wins over a fence
// (ask rails are prose-in, read-only). The edited-after-label guard
// above vouches the body this fence is read from.
const fenceTicket = isAsk ? null : extractPlanBody(issue.body ?? "");
const parent =
  isAsk || fenceTicket !== null ? null : await fetchParent(cfg, repo.nwo, issue.number, ghFn);
const t = isAsk
  ? issueToTicket(issue, repo, cfg, null)
  : fenceTicket !== null
    ? buildExecutionTicket(issue.number, repo, fenceTicket)
    : buildPlanningTicket(issue, repo, cfg, parent);
const stateLabel = isAsk || fenceTicket !== null ? ll.queued : ll.planning;
```

Also extend the `kind:` value in the trailing `log.info("github bridge: dispatched issue", ...)` call from `isAsk ? "ask" : "plan"` to `isAsk ? "ask" : fenceTicket !== null ? "fence" : "plan"`.

- [ ] **Step 4: Run the file's tests — all pass**

Run: `npx vitest run tests/githubInbox.test.ts > /tmp/t2b.out 2>&1; echo "exit: $?"` — expect exit 0.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/githubInbox.ts tests/githubInbox.test.ts
git add src/githubInbox.ts tests/githubInbox.test.ts
git commit -m "feat(bridge): queue a junco-ticket fence from a vouched issue body verbatim"
```

---

### Task 3: Bridge — `junco-plan` fence door (plan sets from an issue body)

**Files:**
- Modify: `src/githubInbox.ts` — same block as Task 2, plus reuse of the failure-comment pattern from the plan-set APPROVAL branch (search `dispatchPlanSet(` — the earlier occurrence, inside the plan-comment approval path)
- Test: `tests/githubInbox.test.ts`

**Interfaces:**
- Consumes: `extractPlanSetBody(text): string | null`, `dispatchPlanSet(cfg, repo, issueNumber, setBody, isoNow): {ok: true} | {ok: false, errors: string[]}` (import already present), `guardOrQueue`, `postIssueComment`, `ll.failed`/`ll.queued`.
- Produces: a vouched issue body carrying a ```` ```junco-plan ```` fence (with `planSets.enabled`) compiles to a ticket set at label time; compile failure flips to `ll.failed` with a comment; `planSets.enabled: false` falls through to Task 2's `junco-ticket` check and then the planner.

- [ ] **Step 1: Write the failing tests**

Fixture note: the `pollGithubInbox` tests build `cfg` from a shared literal — find how the existing plan-set approval tests enable `planSets` (search `planSets` in the test file) and reuse that config shape.

```ts
it("compiles a junco-plan fence from the issue body when plan sets are enabled", async () => {
  const body =
    "```junco-plan\nversion: 1\ntasks:\n  - id: t-one\n    title: Do one\n    description: |\n      Self-contained.\n    acceptance:\n      - done\n```\n";
  // vouched-dispatch fixture as in Task 2, cfg with planSets.enabled true
  // ...
  // dispatchPlanSet submits child tickets through submitFn:
  expect(f.submitted.length).toBeGreaterThan(0);
  const editCalls = f.calls.filter((c) => c[0] === "issue" && c[1] === "edit");
  expect(editCalls.some((c) => c.includes("--add-label") && c.includes(/* queued label */))).toBe(true);
});

it("posts a failure comment and junco:failed when the issue-body plan fence does not compile", async () => {
  const body = "```junco-plan\nversion: 1\ntasks: []\n```\n";  // zero tasks = compile error
  // ...
  expect(f.submitted).toHaveLength(0);
  const editCalls = f.calls.filter((c) => c[0] === "issue" && c[1] === "edit");
  expect(editCalls.some((c) => c.includes("--add-label") && c.includes(/* failed label */))).toBe(true);
  const commentCalls = f.calls.filter((c) => c[0] === "issue" && c[1] === "comment");
  expect(commentCalls.length).toBe(1);
});

it("ignores a junco-plan fence when plan sets are disabled (falls through to the planner)", async () => {
  // same body as the first test, cfg with planSets.enabled false;
  // assert the submitted ticket is a PLANNING ticket (same assertion as
  // Task 2's regression test).
});
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npx vitest run tests/githubInbox.test.ts > /tmp/t3.out 2>&1; echo "exit: $?"` — the three new tests FAIL (plan fence currently routes to the planner).

- [ ] **Step 3: Implement the plan-set door**

Insert BEFORE the `fenceTicket` line from Task 2:

```ts
// junco-plan fence: a multi-task set dispatches through the plan-set
// compiler, mirroring the approval-comment door. Checked before the
// single-ticket fence, same precedence as the comment path. Gated on
// planSets.enabled exactly like that path — disabled, the fence is
// invisible and the issue falls through to the planner.
const fenceSet = isAsk || !cfg.planSets.enabled ? null : extractPlanSetBody(issue.body ?? "");
if (fenceSet !== null) {
  const dr = dispatchPlanSet(cfg, repo, issue.number, fenceSet, new Date().toISOString());
  if (!dr.ok) {
    const errList = dr.errors.map((e) => `- ${e}`).join("\n");
    const failureComment =
      `**Junco could not compile this plan set** — nothing was dispatched.\n\n${errList}\n\n` +
      `_Remove the \`${ll.failed}\` label and re-apply the \`${cfg.github.triggerLabel}\` label to retry._\n`;
    const failId = `${repo.nwo}#${issue.number}`;
    await guardOrQueue(
      cfg,
      "issue plan set failure labels",
      failId,
      { kind: "labels", nwo: repo.nwo, issue: issue.number, add: [ll.failed], remove: [] },
      async () => {
        await ghFn(
          cfg,
          ["issue", "edit", String(issue.number), "--repo", repo.nwo, "--add-label", ll.failed],
          { timeoutMs: GH_TIMEOUT, retryNetwork: true },
        );
      },
    );
    await guardOrQueue(
      cfg,
      "issue plan set failure comment",
      failId,
      { kind: "comment", nwo: repo.nwo, issue: issue.number, body: failureComment },
      () => postIssueComment(cfg, repo.nwo, issue.number, failureComment, ghFn),
    );
    continue;
  }
  await ghFn(
    cfg,
    ["issue", "edit", String(issue.number), "--repo", repo.nwo, "--add-label", ll.queued],
    { timeoutMs: GH_TIMEOUT, retryNetwork: true },
  );
  bridged++;
  log.info("github bridge: issue-body plan set dispatched", { nwo: repo.nwo, issue: issue.number });
  continue;
}
```

Match the exact `cfg.github.triggerLabel` field name and `guardOrQueue` signature against their existing uses in this file — copy the shapes from the approval-branch plan-set code, changing only the label sets (no `plan-ready`/`approved` to remove here) and the retry sentence.

- [ ] **Step 4: Run the file's tests — all pass**

Run: `npx vitest run tests/githubInbox.test.ts > /tmp/t3b.out 2>&1; echo "exit: $?"` — exit 0.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/githubInbox.ts tests/githubInbox.test.ts
git add src/githubInbox.ts tests/githubInbox.test.ts
git commit -m "feat(bridge): compile a junco-plan fence from a vouched issue body"
```

---

### Task 4: `junco submit --as-issue` — single ticket

**Files:**
- Create: `src/submitAsIssue.ts`
- Create: `tests/submitAsIssue.test.ts`
- Modify: `src/cli.ts` — add `"as-issue": { type: "boolean", default: false }` to the `parseCli` options block, and an early branch in the `submit` handler (before the `--plan` branch) delegating to the new module.

**Interfaces:**
- Consumes: `parseTicket(path, content)` from `./ticketSchema.js` (returns `.frontmatter` record incl. `pr_title`, `.body`); `resolveWatchedRepos(cfg)` from `./watchlist.js` (bridge-poll set — external entries already excluded); `withBotAuth(cfg)` + error paths from `./ghAuth.js`; `createIssueLive(cfg, nwo, title, bodyText, labels, ghFn)` from `./assessFiling.js`; `gh` from `./git.js`.
- Produces: `export async function submitAsIssue(cfg: Config, fileArg: string, content: string, opts: { plan: boolean; repoFlag?: string }, deps?: { ghFn?: typeof gh; printFn?: (s: string) => void; errFn?: (s: string) => void }): Promise<number>` (exit code). Also `export function wrapInFence(tag: string, body: string): string` — Task 5 reuses both.

- [ ] **Step 1: Write the failing tests**

`tests/submitAsIssue.test.ts` — DI fakes only, no network. Build `cfg` with `makeConfig` from `tests/helpers/config.ts`, overriding: `github: { ...enabled: true, repos: [{ nwo: "acme/api", path: <tmp repo dir> }] }`, `botAccount: { enabled: true, configDir: <tmp dir> }`. Note `withBotAuth` shells out to verify the login — stub it at the module seam instead: design `submitAsIssue` to take `deps.withBotAuthFn ?? withBotAuth` and pass a fake in tests (`async (c) => ({ ...c, ghAuth: { configDir: "/x", credentialHelper: "" } as never })`).

```ts
const TICKET = `---
id: add-x
repo: ${JSON.stringify(REPO_PATH)}
pr_title: "Add X"
timeout_minutes: 60
---

# Add X

## Tasks

- add it

\`\`\`bash
echo has a code fence
\`\`\`
`;

it("files a parked, unlabeled issue wrapping the ticket body in a junco-ticket fence", async () => {
  const calls: string[][] = [];
  const ghFn = async (_c: unknown, args: string[]) => {
    calls.push(args);
    if (args[0] === "issue" && args[1] === "create")
      return { code: 0, stdout: "https://github.com/acme/api/issues/9\n", stderr: "" };
    throw new Error(`unhandled: ${args.join(" ")}`);
  };
  const out: string[] = [];
  const code = await submitAsIssue(cfg, "t.md", TICKET, { plan: false }, {
    ghFn: ghFn as never, printFn: (s) => out.push(s), errFn: () => {}, withBotAuthFn: fakeBotAuth,
  });
  expect(code).toBe(0);
  const create = calls.find((c) => c[0] === "issue" && c[1] === "create")!;
  expect(create).toContain("--repo");
  expect(create).toContain("acme/api");
  expect(create.join(" ")).toContain("Add X");             // pr_title becomes the issue title
  expect(create.join(" ")).not.toContain("--label");        // parked: no labels, ever
  // Body round-trips: the fence wrapper must survive extractPlanBody.
  const bodyFile = create[create.indexOf("--body-file") + 1];
  const posted = readFileSync(bodyFile, "utf8");            // see note below
  const extracted = extractPlanBody(posted);
  expect(extracted).toContain("# Add X");
  expect(extracted).toContain("echo has a code fence");     // inner ``` fence survived
  expect(posted).toContain("<!-- junco:as-issue -->");
  expect(out.join("")).toContain("issues/9");
  expect(out.join("")).toContain(cfg.github.triggerLabel);  // launch instruction names the label
});
```

Body-file note: `createIssueLive` writes the body to a temp file and deletes its temp dir in a `finally` — the test cannot read it after the call. Instead have the fake `ghFn` capture the file CONTENT at call time (read it inside the fake, stash into a variable) and assert on that.

Refusal tests (each: expect non-zero return, message on `errFn`, and NO `issue create` call):

```ts
it("refuses when the ticket's repo is not bridge-watched", ...);      // repo: /elsewhere
it("refuses when github integration is disabled", ...);               // cfg github.enabled false
it("refuses when the bot account is disabled", ...);                  // botAccount.enabled false
it("refuses an invalid ticket (parseTicket throws)", ...);            // content "not a ticket"
it("warns that discarded frontmatter keys will not survive", ...);    // timeout_minutes present →
                                                                      // errFn output mentions it
```

Fence-length test — a body containing a ```` ``` ```` run must be wrapped in a LONGER fence:

```ts
it("wraps with a fence longer than any backtick run in the body", () => {
  const wrapped = wrapInFence("junco-ticket", "x\n````\ny\n````\nz");
  expect(wrapped.startsWith("`````junco-ticket\n")).toBe(true);
  expect(extractPlanBody(wrapped)).toContain("````");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/submitAsIssue.test.ts > /tmp/t4.out 2>&1; echo "exit: $?"` — FAIL: module does not exist.

- [ ] **Step 3: Implement `src/submitAsIssue.ts`**

```ts
/**
 * `junco submit --as-issue` — file a locally-authored ticket as a PARKED,
 * UNLABELED GitHub issue (spec docs/superpowers/specs/2026-08-21-issue-as-
 * inbox-design.md). The bot authors; only a human's trigger label launches.
 * Frontmatter is machine-owned at extraction time (buildExecutionTicket), so
 * everything except id/repo/pr_title is discarded here — loudly.
 */
import { readFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { Config } from "./types.js";
import { parseTicket } from "./ticketSchema.js";
import { resolveWatchedRepos } from "./watchlist.js";
import { withBotAuth } from "./ghAuth.js";
import { createIssueLive } from "./assessFiling.js";
import { gh } from "./git.js";
import { expandHome } from "./config.js";   // match the actual export site (grep expandHome)

const CARRIED_KEYS = new Set(["id", "repo", "pr_title"]);

/** Wrap `body` in a fence longer than any backtick run inside it, so the
 * bridge's extractFencedBlock round-trips bodies that contain code fences. */
export function wrapInFence(tag: string, body: string): string {
  const longest = Math.max(2, ...[...body.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${tag}\n${body.trimEnd()}\n${fence}`;
}

function firstHeading(body: string): string | null {
  const m = /^#\s+(.+)$/m.exec(body);
  return m ? m[1].trim() : null;
}

export async function submitAsIssue(
  cfg: Config,
  fileArg: string,
  content: string,
  opts: { plan: boolean; repoFlag?: string },
  deps: {
    ghFn?: typeof gh;
    printFn?: (s: string) => void;
    errFn?: (s: string) => void;
    withBotAuthFn?: typeof withBotAuth;
  } = {},
): Promise<number> {
  const ghFn = deps.ghFn ?? gh;
  const print = deps.printFn ?? ((s: string) => process.stdout.write(s));
  const err = deps.errFn ?? ((s: string) => process.stderr.write(s));
  const withBotAuthFn = deps.withBotAuthFn ?? withBotAuth;

  if (!cfg.github.enabled) {
    err("junco submit --as-issue: GitHub integration is disabled (github.enabled)\n");
    return 1;
  }
  if (!cfg.botAccount.enabled) {
    err(
      "junco submit --as-issue: requires the bot account (botAccount.enabled) — " +
        "the bot authors the parked issue; a human's trigger label launches it. Run: junco auth login\n",
    );
    return 1;
  }
  // ... single-ticket path (opts.plan handled in Task 5):
  let parsed;
  try {
    parsed = parseTicket(fileArg, content);
  } catch (e) {
    err(`junco submit --as-issue: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
  const repoRaw = parsed.frontmatter.repo;
  if (typeof repoRaw !== "string" || repoRaw === "") {
    err("junco submit --as-issue: ticket needs a repo: frontmatter path\n");
    return 1;
  }
  const target = safeRealpath(resolve(expandHome(repoRaw)));
  const watched = resolveWatchedRepos(cfg).find((r) => safeRealpath(resolve(r.path)) === target);
  if (!watched) {
    err(
      `junco submit --as-issue: ${repoRaw} is not a bridge-watched repo — the parked issue could ` +
        "never launch. Watch the repo (github.repos / junco watch) or submit locally instead.\n",
    );
    return 1;
  }
  const discarded = Object.keys(parsed.frontmatter).filter((k) => !CARRIED_KEYS.has(k));
  if (discarded.length > 0) {
    err(
      `junco submit --as-issue: warning — frontmatter is machine-owned on the issue route; ` +
        `discarded: ${discarded.join(", ")}\n`,
    );
  }
  const body = parsed.body.trim();
  const title =
    (typeof parsed.frontmatter.pr_title === "string" && parsed.frontmatter.pr_title) ||
    firstHeading(body) ||
    parsed.id;
  const issueBody =
    `_Parked junco ticket — apply the \`${cfg.github.triggerLabel}\` label to queue it._\n\n` +
    wrapInFence("junco-ticket", body) +
    "\n\n<!-- junco:as-issue -->\n";
  const cfgBot = await withBotAuthFn(cfg);          // throws the actionable auth message
  const url = await createIssueLive(cfgBot, watched.nwo, title, issueBody, [], ghFn);
  if (url === null) {
    err("junco submit --as-issue: gh issue create failed (see log)\n");
    return 1;
  }
  print(`parked as issue: ${url}\n`);
  print(`apply label '${cfg.github.triggerLabel}' to queue\n`);
  return 0;
}

function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}
```

Adjust the import sites to reality (grep before writing): `expandHome`'s home module, `parseTicket`'s exact return field names (`parsed.frontmatter.pr_title`, `parsed.body`, `parsed.id` — verify against `src/ticketSchema.ts` and existing callers such as `cli.ts`'s dangling-edge warning block), and `Config`'s `github.triggerLabel` field name. `readFileSync` is only needed if the implementation ends up reading anything — drop unused imports.

Wire `cli.ts`: in `parseCli` options add `"as-issue": { type: "boolean", default: false },`; in the `submit` handler, after `content` is loaded and BEFORE the `values.plan === true` branch:

```ts
if (values["as-issue"] === true && values.plan !== true) {
  if (fileArg === "-") {
    process.stderr.write("Usage: junco submit --as-issue <file> (stdin not supported)\n");
    return 2;
  }
  return await submitAsIssue(cfg, fileArg, content, { plan: false });
}
```

- [ ] **Step 4: Run the tests — pass; run the neighboring suites**

Run: `npx vitest run tests/submitAsIssue.test.ts tests/cli.test.ts > /tmp/t4b.out 2>&1; echo "exit: $?"` — exit 0 (if `tests/cli.test.ts` does not exist, run whichever test file covers `cli.ts` — `ls tests | grep -i cli`).

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/submitAsIssue.ts src/cli.ts tests/submitAsIssue.test.ts
git add src/submitAsIssue.ts src/cli.ts tests/submitAsIssue.test.ts
git commit -m "feat(cli): junco submit --as-issue files a parked fence issue via the bot"
```

---

### Task 5: `--as-issue --plan` — parked plan-set issue

**Files:**
- Modify: `src/submitAsIssue.ts` (the `opts.plan` path), `src/cli.ts` (route `--as-issue --plan` before the local `--plan` branch)
- Test: `tests/submitAsIssue.test.ts`

**Interfaces:**
- Consumes: `extractPlanSetBody` (from `./githubInbox.js` — cli.ts already imports it), `parsePlanSet` and `slugifyId` (grep `src/cli.ts` imports for their module homes — reuse the exact same validation the local `--plan` branch runs), `wrapInFence` from Task 4.
- Produces: `junco submit --as-issue --plan <file> --repo <path>` files a parked issue whose body wraps the validated `junco-plan` fence; Task 3's bridge door compiles it at label time.

- [ ] **Step 1: Write the failing tests**

```ts
const PLAN_DOC = "```junco-plan\nversion: 1\ntasks:\n  - id: t-one\n    title: Do one\n    description: |\n      Self-contained.\n    acceptance:\n      - done\n```\n";

it("files a parked issue wrapping a validated junco-plan fence", async () => {
  // cfg: planSets.enabled true, repoFlag = REPO_PATH (watched)
  const code = await submitAsIssue(cfg, "plan.md", PLAN_DOC, { plan: true, repoFlag: REPO_PATH }, fakes);
  expect(code).toBe(0);
  // captured body (same ghFn capture trick as Task 4):
  expect(extractPlanSetBody(capturedBody)).toContain("t-one");
  expect(capturedBody).toContain("<!-- junco:as-issue -->");
});

it("refuses --plan when planSets are disabled", async () => { /* enabled: false → code 1, no create call */ });
it("refuses --plan without --repo", async () => { /* code 2 */ });
it("refuses --plan when the fence does not validate", async () => { /* tasks: [] → code 1, errors on errFn */ });
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npx vitest run tests/submitAsIssue.test.ts > /tmp/t5.out 2>&1; echo "exit: $?"` — the four new tests FAIL.

- [ ] **Step 3: Implement**

In `submitAsIssue`, branch on `opts.plan` after the shared `github.enabled`/`botAccount` gates:

```ts
if (opts.plan) {
  if (!cfg.planSets.enabled) {
    err("junco submit --as-issue --plan: plan sets are disabled — set planSets.enabled\n");
    return 1;
  }
  if (!opts.repoFlag) {
    err("Usage: junco submit --as-issue --plan <file> --repo <path>\n");
    return 2;
  }
  const fence = extractPlanSetBody(content);
  if (fence === null) {
    err(`junco submit --as-issue: no junco-plan fence found in '${fileArg}'\n`);
    return 1;
  }
  const parsedPlan = parsePlanSet(fence, { maxTasks: cfg.planSets.maxTasks });
  if (!parsedPlan.ok) {
    for (const e of parsedPlan.errors) err(`junco submit --as-issue: plan error: ${e}\n`);
    return 1;
  }
  const target = safeRealpath(resolve(expandHome(opts.repoFlag)));
  const watched = resolveWatchedRepos(cfg).find((r) => safeRealpath(resolve(r.path)) === target);
  if (!watched) {
    err(`junco submit --as-issue: ${opts.repoFlag} is not a bridge-watched repo\n`);
    return 1;
  }
  const planId = "plan-" + slugifyId(basename(fileArg).replace(/\.md$/, ""));
  const issueBody =
    `_Parked junco plan set — apply the \`${cfg.github.triggerLabel}\` label to compile and queue it._\n\n` +
    wrapInFence("junco-plan", fence) +
    "\n\n<!-- junco:as-issue -->\n";
  const cfgBot = await withBotAuthFn(cfg);
  const url = await createIssueLive(cfgBot, watched.nwo, `plan set: ${planId}`, issueBody, [], ghFn);
  if (url === null) {
    err("junco submit --as-issue: gh issue create failed (see log)\n");
    return 1;
  }
  print(`parked as issue: ${url}\n`);
  print(`apply label '${cfg.github.triggerLabel}' to queue\n`);
  return 0;
}
```

In `cli.ts`, change the Task 4 guard from `values.plan !== true` to routing BOTH: `if (values["as-issue"] === true) { ...; return await submitAsIssue(cfg, fileArg, content, { plan: values.plan === true, repoFlag: values.repo as string | undefined }); }` placed BEFORE the existing local `--plan` branch (so `--as-issue --plan` never reaches the local compiler).

- [ ] **Step 4: Run — pass**

Run: `npx vitest run tests/submitAsIssue.test.ts > /tmp/t5b.out 2>&1; echo "exit: $?"` — exit 0.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/submitAsIssue.ts src/cli.ts tests/submitAsIssue.test.ts
git add src/submitAsIssue.ts src/cli.ts tests/submitAsIssue.test.ts
git commit -m "feat(cli): --as-issue --plan parks a plan-set fence issue"
```

---

### Task 6: Docs, help text, full gate, PR

**Files:**
- Modify: `skills/junco-dispatch/SKILL.md` — destination choice + issue-route expectations (REWRITE the local-only framing where it appears; do not append a contradicting section). Add: a "Destination" step in the dispatch procedure (inbox default; "park on github" / "junco as issue:" phrases → `junco submit --as-issue`; expectations text: nothing runs until a human applies the trigger label, phone-friendly); one contrast sentence in the "Linked tracking issue" section (issue-as-artifact vs issue-as-queue-entry).
- Modify: `ARCHITECTURE.md` — the bridge section's dispatch description becomes the three-door precedence list (ask → fence [junco-plan before junco-ticket, planSets-gated] → planner).
- Modify: `src/cli.ts` — help text: add `--as-issue` under submit (`submit --as-issue <file>  Park the ticket as an unlabeled GitHub issue (bot-authored; a human's trigger label queues it)` and the `--as-issue --plan` form).
- Modify: `CHANGELOG.md` — Added entry under Unreleased (Keep a Changelog).

**Interfaces:** none — docs/help only.

- [ ] **Step 1: Make the edits** (grep SKILL.md for "local" framing sentences flagged by the spec's lean-review section; keep each edit minimal and consistent with the spec's tables)

- [ ] **Step 2: Full gate**

```bash
npm run lint && npm run format:check && npm run typecheck && npm run build && npm test > /tmp/gate.out 2>&1; echo "gate exit: $?"
```

Expected: exit 0. Fix anything red before proceeding (fix code, not tests, unless a test is genuinely stale).

- [ ] **Step 3: Commit docs**

```bash
npx prettier --write skills/junco-dispatch/SKILL.md ARCHITECTURE.md CHANGELOG.md src/cli.ts
git add skills/junco-dispatch/SKILL.md ARCHITECTURE.md CHANGELOG.md src/cli.ts
git commit -m "docs: issue-as-inbox — skill destination choice, bridge precedence, help text"
```

- [ ] **Step 4: Push and open a draft PR**

```bash
git push -u origin feat/issue-as-inbox
gh pr create --draft --title "feat: issue-as-inbox — verbatim fence dispatch through the GitHub bridge" \
  --body "Implements docs/superpowers/specs/2026-08-21-issue-as-inbox-design.md — see the spec for the invariant, gates table, and trust analysis. No new config keys. No AI attribution."
```

(PR body: summarize the three doors and the `--as-issue` contract in your own words from the spec; do NOT include any AI-attribution footer.)
