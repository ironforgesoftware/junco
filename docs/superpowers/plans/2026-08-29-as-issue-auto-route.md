# `--as-issue` auto-route Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the junco-dispatch skill route a ticket to a parked GitHub issue by default whenever the target repo is bridge-watched, and make `junco submit --as-issue` accept the operator's own checkout of a watched repo (matched by its `origin`), so that default actually works.

**Architecture:** PR #303 (spec `docs/superpowers/specs/2026-08-21-issue-as-inbox-design.md`) shipped the door: `junco submit --as-issue` files a parked, unlabeled, bot-authored issue whose body carries a `junco-ticket` fence; the bridge sweep queues that fence verbatim once a human applies the trigger label. Two gaps remain. (1) `submitAsIssue.ts` resolves the ticket's `repo:` against the watchlist **by path only**, but the watchlist maps an `owner/repo` to junco's managed clone (`<dataDir>/cache/clones/watched/<owner>/<repo>`), while the skill authors `repo:` as the user's working checkout — so a skill-authored ticket is refused as "not a bridge-watched repo". Fix: fall back to matching by the checkout's `origin` remote (`git remote get-url origin` → `nwoFromRemoteUrl` → case-insensitive nwo match). (2) The skill only takes the issue route on an explicit phrase; this plan makes it the default when GitHub integration + the bot account are on and the repo is watched, with `junco-local:` as the opt-out. Plus the `docs/github-mode.md` paragraph the merged PR never added. Prose rule for every Markdown this plan touches: write fence names as `junco-ticket` / `junco-plan` in single backticks — a literal triple backtick mid-sentence opens an inline code span and prettier mangles the paragraph.

**Tech Stack:** TypeScript (Node ≥ 22.19, ESM/NodeNext, strict), vitest, prettier (100 cols), eslint (type-aware). Skill files are Markdown consumed verbatim by agent harnesses.

**Spec:** `docs/superpowers/specs/2026-08-21-issue-as-inbox-design.md` (merged design), plus these session decisions: (a) auto-route to the issue destination when the repo is watched, opt-out via `junco-local:`; (b) execution frontmatter stays machine-built — no `timeout_minutes`/`priority` pass-through from issue text (the CLI's existing "discarded:" warning is the operator signal).

## Global Constraints

- Every side effect goes behind an injectable `deps` seam (`SubmitAsIssueDeps`); tests never shell out to real `git`/`gh` — pass fakes.
- `src/ticketSchema.ts` is untouched (no new frontmatter keys).
- No new config keys.
- Frontmatter on the issue route stays machine-built by the bridge (`buildExecutionTicket`); nothing from issue text.
- Skill text is stack-agnostic: `tests/skill.test.ts` fails on any of `omp|omlx|launchd|vault|pi|qwen|openai|gpt|ollama|llama|mlx` as a whole word.
- Prettier at 100 cols: run `npx prettier --write <files>` before every commit (Markdown included).
- Conventional commits; **no AI attribution** (no `Co-Authored-By: Claude`, no "Generated with" lines) — amend any auto-appended trailer away.
- Suite green at every commit; run the full gate (`npm run lint && npm run format:check && npm run typecheck && npm run build && npm test`) before declaring the plan done. Capture vitest's exit code explicitly (`npx vitest run > /tmp/out 2>&1; echo "exit: $?"`), never through a pipe.
- Work in this worktree only (`.claude/worktrees/skill-auto-issue-route`, branch `feat/skill-auto-issue-route`). Never touch the main checkout, `config.json`, `tickets/`, `worktrees/`, or the live `~/.junco` tree.

---

### Task 1: `--as-issue` accepts a checkout whose `origin` is a watched repo

**Files:**

- Modify: `src/submitAsIssue.ts` (imports at top; `SubmitAsIssueDeps` ~line 37; the `--plan` branch's watched lookup ~line 104; the ticket branch's watched lookup ~line 160)
- Test: `tests/submitAsIssue.test.ts`

**Interfaces:**

- Consumes: `git` and `CmdResult` from `src/git.ts` (`git(cfg, args, { cwd, timeoutMs, check })` → `Promise<CmdResult>`; with `check: false` a non-zero exit RETURNS `{ code, stdout, stderr }` instead of throwing; a missing `cwd` still REJECTS with `GitOpError`), `nwoFromRemoteUrl(url): string | null` from `src/githubInbox.ts`, `resolveWatchedRepos(cfg): GithubRepoMapping[]` (already excludes `external: true` entries), `canonPath(p)` from `src/unwatchCmd.ts`.
- Produces: `SubmitAsIssueDeps.gitFn?: typeof git` (new optional seam, default the real `git`); exported `findWatchedForPath(cfg, target, gitFn): Promise<GithubRepoMapping | null>` (Task 2's docs and Task 3 refer to this behavior, not the function).

- [ ] **Step 1: Write the failing tests**

Add a `fakeGit` helper near the other fakes (after `fakeBotAuth`, before `DEFAULT_GITHUB`) in `tests/submitAsIssue.test.ts`:

```ts
/** Fake `git` seam: answers `remote get-url origin` with `originUrl` (or
 * throws when null — a non-repo path), and records every call. */
function fakeGit(originUrl: string | null, calls: { args: string[]; cwd?: string }[] = []) {
  const fn = async (_c: unknown, args: string[], opts?: { cwd?: string }) => {
    calls.push({ args, cwd: opts?.cwd });
    if (originUrl === null) throw new Error("fatal: not a git repository");
    if (args[0] === "remote" && args[1] === "get-url") {
      return { code: 0, stdout: `${originUrl}\n`, stderr: "" };
    }
    throw new Error(`unhandled git: ${args.join(" ")}`);
  };
  return { fn: fn as never, calls };
}
```

Then add these four cases inside `describe("submitAsIssue", ...)` (after the existing "refuses when the ticket's repo is not bridge-watched" test):

```ts
it("files on the watched owner/repo when repo: is a checkout whose origin matches (case-insensitive)", async () => {
  const cfg = baseCfg();
  const checkout = "/sbxroot/checkouts/api"; // NOT the watched clone path
  const ticket = TICKET.replace(JSON.stringify(REPO_PATH), JSON.stringify(checkout));
  const calls: string[][] = [];
  const ghFn = async (_c: unknown, args: string[]) => {
    calls.push(args);
    if (args[0] === "issue" && args[1] === "create") {
      return { code: 0, stdout: "https://github.com/acme/api/issues/12\n", stderr: "" };
    }
    throw new Error(`unhandled: ${args.join(" ")}`);
  };
  const git = fakeGit("https://github.com/Acme/API.git");
  const out: string[] = [];
  const code = await submitAsIssue(
    cfg,
    "t.md",
    ticket,
    { plan: false },
    {
      ghFn: ghFn as never,
      gitFn: git.fn,
      printFn: (s) => out.push(s),
      errFn: () => {},
      withBotAuthFn: fakeBotAuth,
    },
  );

  expect(code).toBe(0);
  // origin was read in the ticket's checkout, not the watched clone
  expect(git.calls[0]?.args.slice(0, 3)).toEqual(["remote", "get-url", "origin"]);
  expect(git.calls[0]?.cwd).toBe(checkout);
  const create = calls.find((c) => c[0] === "issue" && c[1] === "create")!;
  expect(create).toContain("acme/api"); // the WATCHED nwo, not the origin's casing
  expect(out.join("")).toContain("issues/12");
});

it("does not read origin when repo: already IS a watched clone path", async () => {
  const cfg = baseCfg();
  const git = fakeGit("https://github.com/acme/api.git");
  const ghFn = async (_c: unknown, args: string[]) => {
    if (args[0] === "issue" && args[1] === "create") {
      return { code: 0, stdout: "https://github.com/acme/api/issues/13\n", stderr: "" };
    }
    throw new Error(`unhandled: ${args.join(" ")}`);
  };
  const code = await submitAsIssue(
    cfg,
    "t.md",
    TICKET,
    { plan: false },
    {
      ghFn: ghFn as never,
      gitFn: git.fn,
      printFn: () => {},
      errFn: () => {},
      withBotAuthFn: fakeBotAuth,
    },
  );
  expect(code).toBe(0);
  expect(git.calls).toHaveLength(0);
});

it("refuses when the checkout's origin is not a watched owner/repo", async () => {
  const cfg = baseCfg();
  const ticket = TICKET.replace(
    JSON.stringify(REPO_PATH),
    JSON.stringify("/sbxroot/checkouts/other"),
  );
  const calls: string[][] = [];
  const ghFn = async (_c: unknown, args: string[]) => {
    calls.push(args);
    throw new Error(`unhandled: ${args.join(" ")}`);
  };
  const errs: string[] = [];
  const code = await submitAsIssue(
    cfg,
    "t.md",
    ticket,
    { plan: false },
    {
      ghFn: ghFn as never,
      gitFn: fakeGit("https://github.com/someone/else.git").fn,
      printFn: () => {},
      errFn: (s) => errs.push(s),
      withBotAuthFn: fakeBotAuth,
    },
  );
  expect(code).toBe(1);
  expect(errs.join("")).toContain("not a bridge-watched repo");
  expect(errs.join("")).toContain("origin"); // the refusal names the second route it tried
  expect(calls.some((c) => c[0] === "issue" && c[1] === "create")).toBe(false);
});

it("refuses when origin cannot be read (repo: is not a git checkout)", async () => {
  const cfg = baseCfg();
  const ticket = TICKET.replace(JSON.stringify(REPO_PATH), JSON.stringify("/sbxroot/not-a-repo"));
  const calls: string[][] = [];
  const ghFn = async (_c: unknown, args: string[]) => {
    calls.push(args);
    throw new Error(`unhandled: ${args.join(" ")}`);
  };
  const errs: string[] = [];
  const code = await submitAsIssue(
    cfg,
    "t.md",
    ticket,
    { plan: false },
    {
      ghFn: ghFn as never,
      gitFn: fakeGit(null).fn,
      printFn: () => {},
      errFn: (s) => errs.push(s),
      withBotAuthFn: fakeBotAuth,
    },
  );
  expect(code).toBe(1);
  expect(errs.join("")).toContain("not a bridge-watched repo");
  expect(calls.some((c) => c[0] === "issue" && c[1] === "create")).toBe(false);
});
```

And one case inside `describe("submitAsIssue --as-issue --plan ...", ...)` (after "files a parked issue wrapping a validated junco-plan fence"):

```ts
it("--plan --repo accepts a checkout whose origin is a watched repo", async () => {
  const cfg = planCfg();
  const calls: string[][] = [];
  const ghFn = async (_c: unknown, args: string[]) => {
    calls.push(args);
    if (args[0] === "issue" && args[1] === "create") {
      return { code: 0, stdout: "https://github.com/acme/api/issues/14\n", stderr: "" };
    }
    throw new Error(`unhandled: ${args.join(" ")}`);
  };
  const git = fakeGit("git@github.com:acme/api.git");
  const code = await submitAsIssue(
    cfg,
    "plan.md",
    PLAN_DOC,
    { plan: true, repoFlag: "/sbxroot/checkouts/api" },
    {
      ghFn: ghFn as never,
      gitFn: git.fn,
      printFn: () => {},
      errFn: () => {},
      withBotAuthFn: fakeBotAuth,
    },
  );
  expect(code).toBe(0);
  expect(git.calls[0]?.cwd).toBe("/sbxroot/checkouts/api");
  const create = calls.find((c) => c[0] === "issue" && c[1] === "create")!;
  expect(create).toContain("acme/api");
});
```

Finally make the three PRE-EXISTING refusal tests hermetic (they currently pass no `gitFn`, which after this task would spawn the real `git` in a nonexistent cwd). In each of "refuses when the ticket's repo is not bridge-watched", "refuses when the ticket's repo matches only an unowned (external) watchlist entry", and "refuses --plan when --repo is not a bridge-watched repo", add `gitFn: fakeGit(null).fn,` to the deps object passed to `submitAsIssue`. For the external-entry test the origin COULD plausibly resolve, so use `gitFn: fakeGit("https://github.com/acme/external.git").fn` there instead — that proves an origin matching only an `external: true` entry is still refused (resolveWatchedRepos excludes it).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/submitAsIssue.test.ts`
Expected: the five new cases FAIL — the two "accepts a checkout" cases with "not a bridge-watched repo" in `errs`/non-zero code, the "does not read origin" case passes trivially today (fine), the two new refusals fail on `toContain("origin")` / typecheck of the unknown `gitFn` key. Pre-existing cases still pass.

- [ ] **Step 3: Implement the origin fallback**

In `src/submitAsIssue.ts`:

Change the imports:

```ts
import type { Config, GithubRepoMapping } from "./types.js";
import { gh, git } from "./git.js";
import { extractPlanSetBody, nwoFromRemoteUrl } from "./githubInbox.js";
```

(keep every other existing import unchanged).

Add `gitFn` to the deps seam:

```ts
export interface SubmitAsIssueDeps {
  ghFn?: typeof gh;
  /** `git remote get-url origin` in the ticket's repo — the second route
   * findWatchedForPath tries. Default: the real `git`. */
  gitFn?: typeof git;
  printFn?: (s: string) => void;
  errFn?: (s: string) => void;
  /** Resolve (and attach) the bot's GitHub auth context onto Config. Typed
   * monomorphically over Config (mirrors cli.ts's withBotAuthFn: the real
   * withBotAuth is generic over `C extends Pick<Config, "botAccount" |
   * "ghBin">`, which this narrower shape still satisfies). Default: the real
   * withBotAuth. */
  withBotAuthFn?: (cfg: Config) => Promise<Config>;
}
```

Add the helper right after `firstHeading`:

```ts
/**
 * Resolve a local path to its bridge-watched entry. Two routes: the path IS
 * a watched clone (the bridge's own managed clone, `github.repos[].path` or
 * the watchlist), or the path is the operator's OWN checkout of a watched
 * repo — its `origin` remote names a watched `owner/repo`. The second route
 * is the junco-dispatch case: the skill stamps `repo:` with the working
 * checkout, while the watchlist points at `<dataDir>/cache/clones/watched/…`,
 * so a path-only match refused every skill-authored ticket. Matching is
 * case-insensitive on the nwo (GitHub owner/repo names are). External
 * (fork-PR) entries are already excluded by resolveWatchedRepos. Any failure
 * reading `origin` (not a git checkout, no remote, non-GitHub URL) is simply
 * "no match" — the caller's refusal explains both routes.
 */
export async function findWatchedForPath(
  cfg: Config,
  target: string,
  gitFn: typeof git,
): Promise<GithubRepoMapping | null> {
  const watched = resolveWatchedRepos(cfg);
  const byPath = watched.find((r) => canonPath(r.path) === target);
  if (byPath) return byPath;
  let nwo: string | null = null;
  try {
    const r = await gitFn(cfg, ["remote", "get-url", "origin"], {
      cwd: target,
      timeoutMs: 10_000,
      check: false,
    });
    nwo = r.code === 0 ? nwoFromRemoteUrl(r.stdout.trim()) : null;
  } catch {
    nwo = null;
  }
  if (nwo === null) return null;
  const want = nwo.toLowerCase();
  return watched.find((r) => r.nwo.toLowerCase() === want) ?? null;
}
```

In `submitAsIssue`, read the seam next to the others:

```ts
const gitFn = deps.gitFn ?? git;
```

Replace the `--plan` branch's lookup (`const target = canonPath(expandHome(opts.repoFlag)); const watched = resolveWatchedRepos(cfg).find(...)` and its refusal) with:

```ts
const target = canonPath(expandHome(opts.repoFlag));
const watched = await findWatchedForPath(cfg, target, gitFn);
if (!watched) {
  err(
    `junco submit --as-issue: ${opts.repoFlag} is not a bridge-watched repo — neither a watched ` +
      "clone path nor a checkout whose origin is a watched owner/repo\n",
  );
  return 1;
}
```

Replace the ticket branch's lookup and refusal with:

```ts
const target = canonPath(expandHome(repoRaw));
const watched = await findWatchedForPath(cfg, target, gitFn);
if (!watched) {
  err(
    `junco submit --as-issue: ${repoRaw} is not a bridge-watched repo — neither a watched clone ` +
      "path nor a checkout whose origin is a watched owner/repo, so the parked issue could never " +
      "launch. Watch the repo (github.repos / junco watch) or submit locally instead.\n",
  );
  return 1;
}
```

Also update the module docblock's second sentence to mention the second route: after "The bot authors; only a human's trigger label launches." add "The target repo is matched by watched clone path OR by the checkout's `origin` (findWatchedForPath)."

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/submitAsIssue.test.ts`
Expected: PASS (24 tests: 19 existing + 5 new).

- [ ] **Step 5: Lint, format, typecheck**

Run: `npx prettier --write src/submitAsIssue.ts tests/submitAsIssue.test.ts && npm run lint && npm run typecheck`
Expected: clean. If eslint complains about the `as never` casts in tests, that matches the existing casts in the file — leave them.

- [ ] **Step 6: Commit**

```bash
git add src/submitAsIssue.ts tests/submitAsIssue.test.ts
git commit -m "fix(submit): --as-issue matches a watched repo by the checkout's origin, not only by path"
```

Verify with `git log -1 --format=%B` that the message carries no `Co-Authored-By` trailer; if one was appended, `git commit --amend` it away.

---

### Task 2: Skill auto-routes to the parked issue when the repo is watched

**Files:**

- Modify: `skills/junco-dispatch/SKILL.md` (frontmatter `description:` line 3; intro paragraph line 8; "Dispatch procedure" → "Interactive mode" step 2 "Destination" and step 4's issue-destination refusal sentence; the "Batch mode" lead paragraph)
- Test: `tests/skill.test.ts`

**Interfaces:**

- Consumes: the CLI probes `junco config get github.enabled` / `junco config get botAccount.enabled` (each prints a bare JSON value — `true`/`false` — and exits 0), `junco doctor` (prints one `✓ github repo <owner/repo> — <path>` line per watched repo), `gh repo view <path> --json nameWithOwner -q .nameWithOwner`, and Task 1's `--as-issue` (which now accepts the checkout path as `repo:`).
- Produces: the trigger `junco-local:` (forces the inbox) and the phrase family "to the inbox" / "local inbox" as an opt-out; Task 3's docs describe this rule.

- [ ] **Step 1: Write the failing test**

Append to `describe("junco-dispatch SKILL.md", ...)` in `tests/skill.test.ts`:

```ts
it("auto-routes to the parked-issue destination when the repo is bridge-watched", () => {
  // The route probe is a CLI contract — pin the exact commands the skill runs.
  expect(SKILL).toContain("junco config get github.enabled");
  expect(SKILL).toContain("junco config get botAccount.enabled");
  expect(SKILL).toContain("junco submit --as-issue");
  // The opt-out trigger and phrase.
  expect(SKILL).toContain("junco-local:");
  expect(SKILL).toContain("to the inbox");
  // The old "only on an explicit phrase" rule is gone.
  expect(SKILL).not.toContain("Otherwise stay on the inbox default without asking");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/skill.test.ts`
Expected: FAIL on `toContain("junco config get github.enabled")` (and the `not.toContain` line).

- [ ] **Step 3: Rewrite the skill's destination rule**

In `skills/junco-dispatch/SKILL.md`:

(a) Frontmatter `description:` — replace the clause `and submits it to the configured inbox — or, on request, as a parked GitHub issue — for the local agent to execute.` with:

```
and submits it — as a parked GitHub issue when the target repo is bridge-watched and the bot account is on, otherwise to the configured inbox — for the local agent to execute.
```

(b) Intro paragraph (the one beginning `Package a unit of work into a plan-shaped markdown file`) — replace the sentences from `The default destination is the configured inbox via \`junco submit\`.`through`— see "Dispatch procedure" below.` with:

```
The destination is decided by a probe, not a phrase: when GitHub integration and the bot account are both on and the target repo is bridge-watched, the ticket is filed as a parked, unlabeled GitHub issue via `junco submit --as-issue`; otherwise it goes to the configured inbox via `junco submit`. A `junco-local:` trigger, or a brief that says "to the inbox" / "local inbox", forces the inbox; "park it on github" / "junco as issue: …" / "dispatch as issue" forces the issue destination even when the probe would not pick it (the CLI's refusal then says why it cannot). See "Dispatch procedure" below.
```

(c) Interactive mode, step 2 — replace the whole step with (the outer 4-backtick fence is the plan's; the inner 3-backtick fence is part of the skill text):

````
2. **Destination — probe, then decide.** Run, in the target repo:

   ```
   junco config get github.enabled
   junco config get botAccount.enabled
   gh repo view <repo-path> --json nameWithOwner -q .nameWithOwner
   junco doctor
   ```

   Pick the **issue destination** when the first two print `true` AND `junco doctor` lists the repo's `owner/repo` on a `github repo <owner/repo>` line (the bridge only sweeps watched repos — an unwatched repo's parked issue would never launch). Otherwise pick the **inbox**. Overrides, in priority order: a `junco-local:` trigger or a brief that says "to the inbox" / "local inbox" forces the inbox; "park it on github", "junco as issue: …", "dispatch as issue" forces the issue destination (if the probe disagrees, still run `--as-issue` and surface its refusal — it names the missing precondition). Say which destination you picked and why in one line before the preview. Leave `repo:` as the working checkout — `--as-issue` matches it to the watched repo by the checkout's `origin`.
````

(d) Interactive mode, step 4, issue-destination paragraph — replace the sentence `Refuses if the repo isn't bridge-watched or the bot account isn't enabled — surface the printed error and offer to fall back to the inbox instead.` with:

```
Refuses if GitHub integration or the bot account is off, or if `repo:` is neither a watched clone path nor a checkout whose `origin` is a watched `owner/repo` — surface the printed error and offer to fall back to the inbox instead. It also warns which frontmatter it discarded (`timeout_minutes`, `priority`, `draft`, `labels` do not survive this route — the bridge builds execution frontmatter itself; the daemon's `worker.defaultTimeoutMinutes` applies); relay that warning verbatim.
```

(e) Batch mode lead paragraph — replace `Batch mode is inbox-only — its own Submit step hardcodes \`junco submit <tempfile>\`, so an "as issue" phrase in a \`junco-batch:\` prompt is not supported; route that case through interactive mode instead:` with:

```
Batch mode is inbox-only — it skips the destination probe and its own Submit step hardcodes `junco submit <tempfile>`, so neither the auto-route nor an "as issue" phrase applies to a `junco-batch:` prompt; route that case through interactive mode instead:
```

Do not touch the "Linked tracking issue" section — its contrast sentence stays true.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/skill.test.ts`
Expected: PASS (all cases, including the stack-agnostic regex — re-read your new text for the banned words; `gh`, `junco`, `GitHub` are fine).

- [ ] **Step 5: Format and commit**

```bash
npx prettier --write skills/junco-dispatch/SKILL.md tests/skill.test.ts
npx vitest run tests/skill.test.ts
git add skills/junco-dispatch/SKILL.md tests/skill.test.ts
git commit -m "feat(skill): route to a parked GitHub issue by default when the repo is bridge-watched"
```

Check the message for an auto-appended `Co-Authored-By` trailer; amend it away if present.

---

### Task 3: Document the parked-issue door and the new defaults

**Files:**

- Modify: `docs/github-mode.md` (insert a subsection after the paragraph beginning `**Questions skip planning.**`)
- Modify: `CHANGELOG.md` (the `[Unreleased] → Added` bullet beginning `` - `junco submit --as-issue <file>` ``; add one `Changed` bullet)
- Modify: `ARCHITECTURE.md` (the `submitAsIssue.ts` module-map row, ~line 224)

**Interfaces:**

- Consumes: Task 1's origin matching; Task 2's route rule and `junco-local:` opt-out.
- Produces: nothing code-facing.

- [ ] **Step 1: Add the github-mode subsection**

In `docs/github-mode.md`, directly after the paragraph that begins `**Questions skip planning.**` (and before `**Lifecycle labels**`), insert:

```markdown
**Pre-authored tickets skip planning too.** A ticket you (or the `junco-dispatch` skill) already wrote can enter through the issue surface without being re-planned: `junco submit --as-issue <ticket.md>` files it as a **parked, unlabeled** issue — bot-authored (`botAccount.enabled` required) — whose body carries the ticket inside a `junco-ticket` fence. Nothing happens until a write+ collaborator applies the trigger label; on the next sweep the bridge extracts the fence and queues it **verbatim** as the execution ticket, straight to `junco:queued` — no planning session, no `junco:plan-ready`, and `requireApproval` does not apply (the label _is_ the approval, and the same edited-after-label check guards it). Frontmatter is still machine-built by the bridge, so a parked ticket's `timeout_minutes`, `priority`, `draft` and `labels` do not carry over — `--as-issue` prints which keys it discarded; `worker.defaultTimeoutMinutes` applies. The ticket's `repo:` may be either the watched clone path or your own checkout of a watched repo (matched by its `origin`). With `planSets.enabled`, `--as-issue --plan <file> --repo <path>` parks a `junco-plan` fence the same way, and the bridge compiles it on labeling. The `junco-dispatch` skill takes this route by default whenever GitHub integration and the bot account are on and the target repo is watched; a `junco-local:` trigger keeps a dispatch on the local inbox.
```

- [ ] **Step 2: Update the changelog**

In `CHANGELOG.md` under `## [Unreleased]` → `### Added`, replace the final sentence of the `` `junco submit --as-issue <file>` `` bullet — `The \`junco-dispatch\` skill's preview gate offers this as an explicit destination choice ("park it on github" / "junco as issue: …" / "dispatch as issue"), alongside the existing inbox default.` — with:

```
The ticket's `repo:` may be the watched clone path or the operator's own checkout of a watched repo (matched by its `origin`). The `junco-dispatch` skill takes this route by default whenever GitHub integration and the bot account are on and the target repo is bridge-watched (`junco-local:` forces the inbox; "park it on github" / "junco as issue: …" / "dispatch as issue" force the issue).
```

- [ ] **Step 3: Update the architecture row**

In `ARCHITECTURE.md`, in the `submitAsIssue.ts` row, replace `on a bridge-watched repo — the issue-destination alternative` with `on a bridge-watched repo (matched by watched clone path or by the checkout's \`origin\` — \`findWatchedForPath\`) — the issue-destination alternative`.

- [ ] **Step 4: Format, verify, commit**

```bash
npx prettier --write docs/github-mode.md CHANGELOG.md ARCHITECTURE.md
npm run format:check
git add docs/github-mode.md CHANGELOG.md ARCHITECTURE.md
git commit -m "docs: parked-issue door in github-mode; --as-issue origin matching; skill auto-route"
```

Check for and amend away any `Co-Authored-By` trailer.

---

### Task 4: Full gate

- [ ] **Step 1: Run the whole gate and capture exit codes**

```bash
npm run lint && npm run format:check && npm run typecheck && npm run build
npx vitest run > /tmp/junco-gate.out 2>&1; echo "vitest exit: $?"; tail -6 /tmp/junco-gate.out
```

Expected: every command exits 0; vitest summary shows all files passed.

- [ ] **Step 2: Confirm no AI attribution anywhere on the branch**

```bash
git log origin/main..HEAD --format=%B | grep -i -c "co-authored-by\|generated with" ; echo "(expect 0)"
```

Expected: `0`. If not, interactive-rebase-free fix: `git commit --amend` for the tip, or re-commit the offending ones.
