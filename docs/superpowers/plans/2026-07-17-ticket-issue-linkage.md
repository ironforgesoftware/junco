# Dispatcher-Requested Tracking Issues (`github_request`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A locally dispatched PR-flow ticket can carry `github_request: { create_issue: true }`; at claim time the worker creates a GitHub tracking issue (under its own gh identity — the bot account when configured) on the clone's origin repo, stamps the worker-managed `github:` provenance block itself, and the existing pipeline then links the PR (`Closes owner/repo#N`) and posts lifecycle feedback.

**Architecture:** Ticket-first flow. The dispatcher (e.g. the junco-dispatch skill) never touches `gh` and never writes `github:` — it writes a *request*; the worker fulfills it in `executeClaimed` (new module `src/githubIssueRequest.ts`) after the repo context is derived and before `runPrFlow`, so `makePrBody`'s existing `Closes` line (`src/prFlow.ts:299-302`) and the reporter (`src/githubReport.ts`) see stamped provenance with **zero changes to either**. Fulfillment is best-effort (failure → warn, ticket runs unlinked) and crash/requeue-safe (provenance is persisted into the claimed ticket file; a re-parse sees `github:` and skips re-creation).

**Tech Stack:** TypeScript (Node ≥ 22.19, ESM/NodeNext, strict), vitest, existing seams only — `gh`/`git` from `src/git.ts` (bot auth env injected automatically via `cfg.ghAuth`), `createIssueLive` from `src/assessFiling.ts`, `nwoFromRemoteUrl` from `src/githubInbox.ts`, `upsertFrontmatterKey` from `src/requeue.ts`.

## Global Constraints

- Branch: `feat/issue-linkage` off `origin/main`, in a fresh worktree (superpowers:using-git-worktrees). The main checkout stays parked on `main`.
- `src/ticketSchema.ts` is the stable public contract — **additive changes only**. `github:` stays documented as worker-managed; `github_request` is the dispatcher-settable surface.
- Never import the Pi SDK at module top level in `src/` (not needed here; keep it that way).
- Every side effect behind an injectable `*Deps` seam; tests never touch the network — fake `ghFn`/`gitFn`/fs functions.
- No new dependencies. No new `Config` fields (⇒ no `configLevers` entry, no test-fixture churn in `makeConfig`/`cfg()` helpers).
- Conventional commits; suite green at every commit; **no AI attribution trailers** (subagent commits auto-append `Co-Authored-By: Claude` — amend it away).
- Full gate before claiming done: `npm run lint && npm run format:check && npm run typecheck && npm run build && npm test`. Vitest exit-code trap: capture status explicitly, never pipe into a filter.
- `npm run typecheck` (eslint tsconfig, covers `tests/`) has ~57 pre-existing errors on main — the bar is **no NEW errors**.
- Packaged skill text stays stack-agnostic (no personal-setup strings).
- Run `npx prettier --write` on touched files before each commit.

**Behavioral decisions (settled during design — do not relitigate):**

- Fulfillment runs in `executeClaimed` *before* `runPrFlow`, which means before plan-lint (which runs inside the flow). A ticket that later fails lint has already created its issue — acceptable: the reporter's terminal comment records the failure on that issue, which is exactly what a tracking record is for.
- Fork-push tickets (`ctx.pushRemote !== "origin"`) are **skipped**: repos the operator does not control get no outward-facing writes beyond the PR itself (same rule as the reporter's `external` guard).
- Q&A / assess / analyze tickets never fulfill (the call site is inside the `hasRepo`/`ctx` branch, which those flavors never reach).
- After a successful stamp, `reporter.onStart` is invoked once more: the first invocation (top of `executeClaimed`) saw `github: null` and no-opped; the re-call flips the fresh issue to the `working` lifecycle label when GitHub mode is on. Reporter is best-effort by contract.
- Issue body = one intro line + ticket body, capped at 60,000 chars (GitHub caps at 65,536).

---

### Task 1: Ticket contract — parse `github_request`

**Files:**
- Modify: `src/types.ts` (Ticket interface, after the `github` field at `src/types.ts:227`)
- Modify: `src/ticket.ts` (`parseTicket`, after the `analyze` parsing block)
- Modify: `src/ticketSchema.ts` (new `github_request` property after the `github` property; one-sentence description tweak on `github`)
- Test: `tests/ticket.test.ts`, `tests/ticketSchema.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `Ticket.githubRequest: { createIssue: boolean } | null` — read by Task 2 (guard) and Task 3 (call-site gate). Frontmatter spelling: `github_request: { create_issue: true }`.

- [ ] **Step 1: Write the failing tests**

Append to the `describe("parseTicket", ...)` block in `tests/ticket.test.ts`:

```ts
  it("parses github_request.create_issue: true", () => {
    const md = `---\nid: t7\nrepo: /x\ngithub_request:\n  create_issue: true\n---\nb`;
    expect(parseTicket("/in/t7.md", md).githubRequest).toEqual({ createIssue: true });
  });

  it("defaults githubRequest to null when absent; non-true create_issue parses false", () => {
    expect(parseTicket("/in/t8.md", `---\nid: t8\n---\nb`).githubRequest).toBeNull();
    const md = `---\nid: t9\ngithub_request:\n  create_issue: "yes"\n---\nb`;
    expect(parseTicket("/in/t9.md", md).githubRequest).toEqual({ createIssue: false });
    expect(parseTicket("/in/t10.md", `---\nid: t10\ngithub_request: banana\n---\nb`).githubRequest).toBeNull();
  });
```

Append to `tests/ticketSchema.test.ts` (mirror the existing cast idiom at its line 20):

```ts
  it("documents github_request as a dispatcher-settable mapping with create_issue", () => {
    const props = TICKET_FRONTMATTER_JSON_SCHEMA.properties as Record<
      string,
      { type?: string; description?: string; properties?: Record<string, { type?: string }> }
    >;
    expect(props.github_request).toBeDefined();
    expect(props.github_request.type).toBe("object");
    expect(props.github_request.properties?.create_issue?.type).toBe("boolean");
    // The request surface must say who fulfills it — the worker, not the dispatcher.
    expect(props.github_request.description).toMatch(/worker/i);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/ticket.test.ts tests/ticketSchema.test.ts > /tmp/t1.out 2>&1; echo "exit: $?"; tail -20 /tmp/t1.out`
Expected: `exit: 1`, failures mentioning `githubRequest` (property does not exist) and `github_request` undefined.

- [ ] **Step 3: Implement**

`src/types.ts` — add to the `Ticket` interface directly under the `github` field:

```ts
  /** Dispatcher-authored request block (`github_request:`). Trusted local
   * dispatchers may ask the worker to create a tracking issue at claim time;
   * the worker fulfills it and stamps `github:` provenance itself, keeping
   * that block worker-managed (githubIssueRequest.ts). Null = no request. */
  githubRequest: { createIssue: boolean } | null;
```

`src/ticket.ts` — add after the `analyze` parsing block, and thread into the returned object next to `github`:

```ts
  const reqRaw = frontmatter.github_request;
  let githubRequest: Ticket["githubRequest"] = null;
  if (reqRaw !== null && typeof reqRaw === "object" && !Array.isArray(reqRaw)) {
    // Strict-true like `network:` — anything else is a documented no.
    githubRequest = { createIssue: (reqRaw as Record<string, unknown>).create_issue === true };
  }
```

…and add `githubRequest,` to the return literal (next to `github,`).

`src/ticketSchema.ts` — insert after the closing brace of the `github` property:

```ts
    github_request: {
      type: "object",
      description:
        "Dispatcher-settable request: ask the worker to create a GitHub tracking issue for this ticket at claim time and link the resulting pull request to it (the PR body gains `Closes owner/repo#N`, so merging closes the issue). The worker creates the issue on the clone's origin repo under its own gh identity (the bot account when configured) and then stamps the worker-managed `github:` provenance block itself — dispatchers never write `github:` by hand. Best-effort: if the issue cannot be created (offline, no permission, non-GitHub origin) the ticket still runs, unlinked. Ignored on fork-push tickets (`push_remote: fork`) and on Q&A/assess/analyze tickets.",
      properties: {
        create_issue: {
          type: "boolean",
          description: "Set true to request tracking-issue creation.",
        },
      },
    },
```

…and amend the `github` property's description (append one sentence, keep the rest verbatim): `"Worker-managed: provenance of a ticket bridged from a GitHub issue. Do not set by hand — to request a linked issue on a local dispatch, see github_request."`

- [ ] **Step 4: Run tests to verify they pass, then sweep for Ticket-literal fixtures**

Run: `npx vitest run tests/ticket.test.ts tests/ticketSchema.test.ts > /tmp/t1.out 2>&1; echo "exit: $?"`
Expected: `exit: 0`.

Then: `npm run typecheck > /tmp/tc.out 2>&1; echo "exit: $?"; grep -c "error TS" /tmp/tc.out`
Any test file that builds a full `Ticket` object literal now misses `githubRequest` — add `githubRequest: null,` to each flagged literal (compare against main's baseline of ~57 pre-existing errors; the bar is no NEW errors). Likely candidates: `tests/githubReport.test.ts`, `tests/prFlow.test.ts` helpers — but trust the compiler output, not this list.

- [ ] **Step 5: Full suite + commit**

Run: `npx vitest run > /tmp/all.out 2>&1; echo "exit: $?"`
Expected: `exit: 0`.

```bash
npx prettier --write src/types.ts src/ticket.ts src/ticketSchema.ts tests/ticket.test.ts tests/ticketSchema.test.ts
git add -A && git commit -m "feat(ticket): parse dispatcher-authored github_request frontmatter"
```

---

### Task 2: Fulfillment module — `src/githubIssueRequest.ts`

**Files:**
- Create: `src/githubIssueRequest.ts`
- Test: `tests/githubIssueRequest.test.ts` (new)

**Interfaces:**
- Consumes: `Ticket.githubRequest` (Task 1); `git`/`gh` + `CmdResult` from `src/git.ts`; `nwoFromRemoteUrl` from `src/githubInbox.ts`; `createIssueLive(cfg, nwo, title, bodyText, labels, ghFn): Promise<string | null>` from `src/assessFiling.ts`; `upsertFrontmatterKey(content, key, value)` from `src/requeue.ts`; `parseTicket` from `src/ticket.ts`; `RepoContext` from `src/repoContext.ts` (fields used: `repo`, `pushRemote`, `prTitle`).
- Produces: `fulfillIssueRequest(cfg: Config, ticket: Ticket, ctx: RepoContext, claimedPath: string, deps?: IssueRequestDeps): Promise<TicketGithub | null>` — Task 3's seam. Returns the stamped meta (`{ nwo, issue, kind: "pr", external: false }`) or `null` for every skip/failure path. **Never throws.**

- [ ] **Step 1: Write the failing tests**

Create `tests/githubIssueRequest.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { fulfillIssueRequest } from "../src/githubIssueRequest.js";
import type { IssueRequestDeps } from "../src/githubIssueRequest.js";
import { parseTicket } from "../src/ticket.js";
import type { Config } from "../src/types.js";
import type { RepoContext } from "../src/repoContext.js";

// Only ghBin/gitBin are dereferenced through the injected fns — a cast keeps
// this fixture-free (same idiom as tests/assessFiling.test.ts).
const CFG = { ghBin: "gh", gitBin: "git" } as unknown as Config;

const TICKET_MD = [
  "---",
  "id: tk-1",
  "repo: /sbxroot/clone",
  'pr_title: "Fix the flux capacitor"',
  "github_request:",
  "  create_issue: true",
  "---",
  "# Fix the flux capacitor",
  "Body text.",
].join("\n");

function ctx(overrides: Partial<RepoContext> = {}): RepoContext {
  return {
    repo: "/sbxroot/clone",
    baseBranch: "main",
    branchName: "junco/tk-1",
    draft: true,
    prTitle: "Fix the flux capacitor",
    labels: [],
    reviewers: [],
    amendsPr: null,
    pushRemote: "origin",
    forkNwo: null,
    ...overrides,
  };
}

function harness(opts: { originUrl?: string; issueUrl?: string | null; ghThrows?: boolean } = {}) {
  const ghCalls: string[][] = [];
  const files = new Map<string, string>([["/claim/tk-1.md", TICKET_MD]]);
  const deps = {
    gitFn: (_cfg: unknown, _args: string[]) =>
      Promise.resolve({
        code: 0,
        stdout: (opts.originUrl ?? "git@github.com:acme/api.git") + "\n",
        stderr: "",
      }),
    ghFn: (_cfg: unknown, args: string[]) => {
      ghCalls.push(args);
      if (opts.ghThrows) return Promise.reject(new Error("gh: connect: network is unreachable"));
      return Promise.resolve({
        code: 0,
        stdout:
          opts.issueUrl === null ? "" : (opts.issueUrl ?? "https://github.com/acme/api/issues/41") + "\n",
        stderr: "",
      });
    },
    readFileFn: (p: string) => files.get(p) ?? "",
    writeFileFn: (p: string, c: string) => void files.set(p, c),
  };
  return { ghCalls, files, deps: deps as unknown as IssueRequestDeps };
}

function ticketOf(md: string = TICKET_MD) {
  return parseTicket("/claim/tk-1.md", md);
}

describe("fulfillIssueRequest", () => {
  it("creates the issue, stamps github: provenance into the claimed file, returns the meta", async () => {
    const h = harness();
    const t = ticketOf();
    const meta = await fulfillIssueRequest(CFG, t, ctx(), "/claim/tk-1.md", h.deps);
    expect(meta).toEqual({ nwo: "acme/api", issue: 41, kind: "pr", external: false });
    expect(h.ghCalls).toHaveLength(1);
    expect(h.ghCalls[0].slice(0, 2)).toEqual(["issue", "create"]);
    expect(h.ghCalls[0]).toContain("acme/api");
    expect(h.ghCalls[0]).toContain("Fix the flux capacitor");
    // The stamp must round-trip through the real parser.
    const reparsed = parseTicket("/claim/tk-1.md", h.files.get("/claim/tk-1.md")!);
    expect(reparsed.github).toEqual({ nwo: "acme/api", issue: 41, kind: "pr", external: false });
  });

  it("skips without a gh call when there is no request or github: is already present", async () => {
    const h = harness();
    const noReq = ticketOf(TICKET_MD.replace(/github_request:\n  create_issue: true\n/, ""));
    expect(await fulfillIssueRequest(CFG, noReq, ctx(), "/claim/tk-1.md", h.deps)).toBeNull();
    // BOTH blocks present: the request survives, but existing provenance wins.
    const bridged = ticketOf(
      TICKET_MD.replace(
        "github_request:",
        'github: {nwo: "acme/api", issue: 3, kind: pr}\ngithub_request:',
      ),
    );
    expect(await fulfillIssueRequest(CFG, bridged, ctx(), "/claim/tk-1.md", h.deps)).toBeNull();
    expect(h.ghCalls).toHaveLength(0);
  });

  it("skips fork-push tickets — no outward writes to repos the operator does not control", async () => {
    const h = harness();
    const meta = await fulfillIssueRequest(CFG, ticketOf(), ctx({ pushRemote: "fork" }), "/claim/tk-1.md", h.deps);
    expect(meta).toBeNull();
    expect(h.ghCalls).toHaveLength(0);
  });

  it("returns null (never throws) on a non-GitHub origin, a gh failure, and an unparseable issue URL", async () => {
    const bad = harness({ originUrl: "https://gitlab.com/acme/api.git" });
    expect(await fulfillIssueRequest(CFG, ticketOf(), ctx(), "/claim/tk-1.md", bad.deps)).toBeNull();
    expect(bad.ghCalls).toHaveLength(0);

    const down = harness({ ghThrows: true });
    expect(await fulfillIssueRequest(CFG, ticketOf(), ctx(), "/claim/tk-1.md", down.deps)).toBeNull();

    const weird = harness({ issueUrl: null });
    expect(await fulfillIssueRequest(CFG, ticketOf(), ctx(), "/claim/tk-1.md", weird.deps)).toBeNull();
    // No stamp on any failure path.
    expect(weird.files.get("/claim/tk-1.md")).toBe(TICKET_MD);
  });

  it("keeps the in-memory link when the frontmatter is malformed (stamp cannot round-trip)", async () => {
    const h = harness();
    // A tab inside the block makes YAML parse fail → parseTicket falls back to
    // no-frontmatter → upsert result re-parses with github: null (#108 class).
    const broken = "---\nid: tk-1\nrepo: /sbxroot/clone\n\tbad: indent\ngithub_request:\n  create_issue: true\n---\nBody.";
    h.files.set("/claim/tk-1.md", broken);
    const t = { ...ticketOf(), githubRequest: { createIssue: true } };
    const meta = await fulfillIssueRequest(CFG, t, ctx(), "/claim/tk-1.md", h.deps);
    expect(meta).toEqual({ nwo: "acme/api", issue: 41, kind: "pr", external: false });
    expect(h.files.get("/claim/tk-1.md")).toBe(broken); // not persisted, not corrupted
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/githubIssueRequest.test.ts > /tmp/t2.out 2>&1; echo "exit: $?"; tail -5 /tmp/t2.out`
Expected: `exit: 1` — module `../src/githubIssueRequest.js` not found.

- [ ] **Step 3: Implement `src/githubIssueRequest.ts`**

```ts
/**
 * Dispatcher-requested issue linkage (`github_request:` frontmatter).
 *
 * A trusted local dispatcher (e.g. the junco-dispatch skill) may ask the
 * worker to create a tracking issue for a PR-flow ticket:
 *
 *   github_request:
 *     create_issue: true
 *
 * executeClaimed calls fulfillIssueRequest() after deriving the repo context
 * and BEFORE runPrFlow: the worker — under its own gh identity (the bot
 * account when configured; git.ts injects ghAuthEnv) — creates the issue on
 * the clone's origin repo, then stamps the regular worker-managed `github:`
 * provenance block into the claimed ticket file. Downstream needs no changes:
 * makePrBody adds `Closes nwo#N` (prFlow.ts) and the reporter posts lifecycle
 * feedback (githubReport.ts) off the stamped block. The on-disk stamp makes a
 * crash/requeue re-parse the link instead of double-creating.
 *
 * Everything here is BEST-EFFORT: every failure logs a warning and returns
 * null — the ticket still runs, just without issue linkage. Fork-push tickets
 * are skipped outright: repos the operator does not control get no
 * outward-facing writes beyond the PR itself (reporter `external` parity).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { git, gh } from "./git.js";
import { nwoFromRemoteUrl } from "./githubInbox.js";
import { createIssueLive } from "./assessFiling.js";
import { upsertFrontmatterKey } from "./requeue.js";
import { parseTicket } from "./ticket.js";
import { log } from "./logging.js";
import type { Config, Ticket, TicketGithub } from "./types.js";
import type { RepoContext } from "./repoContext.js";

/** GitHub caps issue bodies at 65,536 chars; stay under with margin. */
const MAX_ISSUE_BODY = 60_000;

export interface IssueRequestDeps {
  gitFn?: typeof git;
  ghFn?: typeof gh;
  readFileFn?: (p: string) => string;
  writeFileFn?: (p: string, content: string) => void;
}

/** First `# ` heading, for the issue title when pr_title is absent. */
function firstHeading(body: string): string | null {
  const m = /^#\s+(.+)$/m.exec(body);
  return m ? m[1].trim() : null;
}

export async function fulfillIssueRequest(
  cfg: Config,
  ticket: Ticket,
  ctx: RepoContext,
  claimedPath: string,
  deps: IssueRequestDeps = {},
): Promise<TicketGithub | null> {
  const gitFn = deps.gitFn ?? git;
  const ghFn = deps.ghFn ?? gh;
  const readFileFn = deps.readFileFn ?? ((p: string) => readFileSync(p, "utf8"));
  const writeFileFn = deps.writeFileFn ?? ((p: string, c: string) => writeFileSync(p, c, "utf8"));

  if (!ticket.githubRequest?.createIssue) return null;
  // Already linked: a bridge/dispatch ticket, or a requeue after a prior
  // successful fulfillment (the stamp below survives on disk).
  if (ticket.github) return null;
  if (ctx.pushRemote !== "origin") {
    log.warn("github_request: fork-push ticket — skipping issue creation", { id: ticket.id });
    return null;
  }

  let nwo: string | null = null;
  try {
    const remote = await gitFn(cfg, ["remote", "get-url", "origin"], { cwd: ctx.repo });
    nwo = remote.code === 0 ? nwoFromRemoteUrl(remote.stdout.trim()) : null;
  } catch (e) {
    log.warn("github_request: could not read origin remote — ticket runs unlinked", {
      id: ticket.id,
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
  if (!nwo) {
    log.warn("github_request: origin is not a parseable GitHub repo — skipping", { id: ticket.id });
    return null;
  }

  const title = ctx.prTitle ?? firstHeading(ticket.body) ?? ticket.id;
  const intro =
    "_Tracking issue created by junco for ticket `" +
    ticket.id +
    "`. A pull request will follow and close this issue on merge._";
  const body = intro + "\n\n" + ticket.body.trim().slice(0, MAX_ISSUE_BODY);

  let url: string | null = null;
  try {
    url = await createIssueLive(cfg, nwo, title, body, [], ghFn);
  } catch (e) {
    log.warn("github_request: issue creation failed — ticket runs unlinked", {
      id: ticket.id,
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
  const m = url ? /\/issues\/(\d+)(?:[/?#].*)?$/.exec(url.trim()) : null;
  if (!m) {
    log.warn("github_request: could not parse created issue URL — ticket runs unlinked", {
      id: ticket.id,
      url,
    });
    return null;
  }
  const meta: TicketGithub = { nwo, issue: Number(m[1]), kind: "pr", external: false };

  // Persist provenance so a crash/requeue never double-creates (requeueTicket
  // carries the claimed file's content back to inbox/). Defensive re-parse
  // mirrors requeueTicket (#108): malformed frontmatter accepts the textual
  // upsert but re-parses github: null — keep the in-memory link for THIS run
  // and leave the file untouched.
  try {
    const stampValue = `{nwo: ${JSON.stringify(meta.nwo)}, issue: ${meta.issue}, kind: pr}`;
    const stamped = upsertFrontmatterKey(readFileFn(claimedPath), "github", stampValue);
    if (parseTicket(claimedPath, stamped).github) writeFileFn(claimedPath, stamped);
    else
      log.warn(
        "github_request: malformed frontmatter — provenance not persisted (a requeue may double-create)",
        { id: ticket.id },
      );
  } catch (e) {
    log.warn("github_request: could not stamp provenance into the claimed ticket", {
      id: ticket.id,
      error: e instanceof Error ? e.message : String(e),
    });
  }

  log.info("github_request: created tracking issue", { id: ticket.id, nwo, issue: meta.issue, url });
  return meta;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/githubIssueRequest.test.ts > /tmp/t2.out 2>&1; echo "exit: $?"`
Expected: `exit: 0`. If the malformed-frontmatter test fails on the fixture (YAML tab behavior), verify the broken fixture actually re-parses with `github: null` via a quick `parseTicket` REPL check and adjust the fixture (any frontmatter that survives `upsertFrontmatterKey` textually but fails YAML parse works — e.g. an unclosed quote `bad: "x`).

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/githubIssueRequest.ts tests/githubIssueRequest.test.ts
git add src/githubIssueRequest.ts tests/githubIssueRequest.test.ts
git commit -m "feat(github): claim-time tracking-issue fulfillment for github_request tickets"
```

---

### Task 3: Wire fulfillment into `executeClaimed`

**Files:**
- Modify: `src/runOnce.ts` (`RunDeps` interface; the `if (next.hasRepo)` branch of `executeClaimed`, currently `src/runOnce.ts:283-308`)
- Test: `tests/runOnce.test.ts`

**Interfaces:**
- Consumes: `fulfillIssueRequest` (Task 2), `Ticket.githubRequest` (Task 1).
- Produces: `RunDeps.fulfillIssueRequestFn?: typeof fulfillIssueRequest` (test seam, peer of `assessFlowFn`). Behavior: for a PR-flow ticket with an unfulfilled request, `next.github` is stamped before `runPrFlow` reads it, and `reporter.onStart` is re-invoked once with the linked ticket.

- [ ] **Step 1: Write the failing tests**

Append to `tests/runOnce.test.ts` (reuse the file's existing imports: `runOnce`, `cfg`, `fakeFactory`, `mkdtempSync`, `tmpdir`, `join`, `mkdirSync`, `writeFileSync`; add `import type { Ticket, TicketGithub } from "../src/types.js";` if not present):

```ts
describe("github_request fulfillment wiring", () => {
  const STAMP: TicketGithub = { nwo: "acme/api", issue: 7, kind: "pr", external: false };

  function seed(root: string, frontmatterExtra: string): void {
    const j = join(root, "Junco");
    ["inbox", "processing", "done", "failed"].forEach((d) =>
      mkdirSync(join(j, d), { recursive: true }),
    );
    writeFileSync(
      join(j, "inbox", "t.md"),
      `---\nid: t\nrepo: ${join(root, "no-such-repo")}\n${frontmatterExtra}---\n# T\nbody\n`,
      "utf8",
    );
  }

  it("fulfills for a PR-flow ticket: stamp lands on the ticket, reporter restarts with the link", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-run-"));
    seed(root, "github_request:\n  create_issue: true\n");
    const seen: Ticket[] = [];
    const starts: Array<string | null> = [];
    await runOnce(cfg(root), {
      sessionFactoryFor: () => fakeFactory(),
      fulfillIssueRequestFn: (_c, ticket) => {
        seen.push(ticket);
        return Promise.resolve(STAMP);
      },
      reporter: {
        onStart: (t) => {
          starts.push(t.github ? `${t.github.nwo}#${t.github.issue}` : null);
          return Promise.resolve();
        },
        onRequeue: () => Promise.resolve(),
        onFinal: () => Promise.resolve(),
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].github).toEqual(STAMP); // stamped before the flow consumed it
    expect(starts).toEqual([null, "acme/api#7"]); // pre-fulfillment no-op, then the linked re-call
  });

  it("does not fulfill for Q&A tickets or when github: provenance already exists", async () => {
    const qaRoot = mkdtempSync(join(tmpdir(), "junco-run-"));
    const j = join(qaRoot, "Junco");
    ["inbox", "processing", "done", "failed"].forEach((d) =>
      mkdirSync(join(j, d), { recursive: true }),
    );
    writeFileSync(
      join(j, "inbox", "q.md"),
      "---\nid: q\ngithub_request:\n  create_issue: true\n---\nq\n",
      "utf8",
    );
    let calls = 0;
    await runOnce(cfg(qaRoot), {
      sessionFactoryFor: () => fakeFactory(),
      fulfillIssueRequestFn: () => {
        calls += 1;
        return Promise.resolve(STAMP);
      },
    });
    expect(calls).toBe(0);

    const linkedRoot = mkdtempSync(join(tmpdir(), "junco-run-"));
    seed(linkedRoot, 'github: {nwo: "acme/api", issue: 3, kind: pr}\ngithub_request:\n  create_issue: true\n');
    await runOnce(cfg(linkedRoot), {
      sessionFactoryFor: () => fakeFactory(),
      fulfillIssueRequestFn: () => {
        calls += 1;
        return Promise.resolve(STAMP);
      },
    });
    expect(calls).toBe(0);
  });
});
```

Note: the PR flow itself fails on the nonexistent repo path and requeues/fails the ticket — irrelevant here; these tests assert only the seam ordering and gating, which is exactly what this task adds.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/runOnce.test.ts > /tmp/t3.out 2>&1; echo "exit: $?"; grep -A2 "github_request" /tmp/t3.out | head -20`
Expected: `exit: 1` — `fulfillIssueRequestFn` is not a known `RunDeps` property (TS/object-literal error at runtime via vitest is fine: the fake is never called, `seen` stays empty).

- [ ] **Step 3: Implement**

`src/runOnce.ts` — add the import:

```ts
import { fulfillIssueRequest } from "./githubIssueRequest.js";
```

Add to `RunDeps` (after `analyzeFlowFn`):

```ts
  // Issue-linkage fulfillment (github_request frontmatter): tests inject a
  // fake; production defaults to the real fulfillIssueRequest.
  fulfillIssueRequestFn?: typeof fulfillIssueRequest;
```

In `executeClaimed`, inside `if (next.hasRepo) { ... if (ctx) { ... } }`, immediately after `const ctx = deriveRepoContext(...)` and its `if (ctx) {` line, before `const flow = await runPrFlow(...)`:

```ts
          // Dispatcher-requested issue linkage: fulfilled here — after the
          // repo context exists, before runPrFlow reads task.github — so the
          // PR body's Closes line and the reporter both see the stamped
          // provenance. Best-effort: null leaves the ticket unlinked. The
          // reporter re-call is the queued→working flip the top-of-function
          // onStart skipped while github was still null.
          if (next.githubRequest?.createIssue && !next.github) {
            const fulfillFn = deps.fulfillIssueRequestFn ?? fulfillIssueRequest;
            const stamped = await fulfillFn(cfg, next, ctx, claimed);
            if (stamped) {
              next.github = stamped;
              await reporter.onStart(next).catch(() => undefined);
            }
          }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/runOnce.test.ts > /tmp/t3.out 2>&1; echo "exit: $?"`
Expected: `exit: 0`.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/runOnce.ts tests/runOnce.test.ts
git add src/runOnce.ts tests/runOnce.test.ts
git commit -m "feat(worker): fulfill github_request at claim time, ahead of the PR flow"
```

---

### Task 4: Plan-lint advisory — `github_request_scope`

**Files:**
- Modify: `src/planLint.ts` (new check function; register in `lintTicket` at `src/planLint.ts:530`; add one line to the "Rules enforced" header comment)
- Test: `tests/planLint.test.ts`

**Interfaces:**
- Consumes: frontmatter record (already threaded into `lintTicket`).
- Produces: warning-severity violations, rule id `github_request_scope`. Warnings never block (`LintResult.ok` ignores them) — this is authoring feedback in the transcript, not a gate.

- [ ] **Step 1: Write the failing tests**

Append to `tests/planLint.test.ts` (reuse its existing `VALID_BODY` / `VALID_FM` fixtures):

```ts
describe("github_request_scope", () => {
  it("warns (never errors) when github_request rides a fork-push ticket", () => {
    const fm = { ...VALID_FM, push_remote: "fork", github_request: { create_issue: true } };
    const result = lintTicket(VALID_BODY, fm, { checkLabels: false });
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => w.rule === "github_request_scope")).toBe(true);
  });

  it("warns when the ticket already carries a github: block", () => {
    const fm = {
      ...VALID_FM,
      github: { nwo: "acme/api", issue: 3, kind: "pr" },
      github_request: { create_issue: true },
    };
    const result = lintTicket(VALID_BODY, fm, { checkLabels: false });
    expect(result.warnings.some((w) => w.rule === "github_request_scope")).toBe(true);
  });

  it("warns on a non-mapping github_request, stays silent on a well-scoped one and on absence", () => {
    const bad = lintTicket(VALID_BODY, { ...VALID_FM, github_request: true }, { checkLabels: false });
    expect(bad.warnings.some((w) => w.rule === "github_request_scope")).toBe(true);
    const good = lintTicket(
      VALID_BODY,
      { ...VALID_FM, github_request: { create_issue: true } },
      { checkLabels: false },
    );
    expect(good.violations.some((v) => v.rule === "github_request_scope")).toBe(false);
    const absent = lintTicket(VALID_BODY, VALID_FM, { checkLabels: false });
    expect(absent.violations.some((v) => v.rule === "github_request_scope")).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/planLint.test.ts > /tmp/t4.out 2>&1; echo "exit: $?"`
Expected: `exit: 1` — no `github_request_scope` violations produced.

- [ ] **Step 3: Implement**

Add to `src/planLint.ts` (alongside the other check functions):

```ts
// ---------------------------------------------------------------------------
// Check: github_request scoped where fulfillment can actually happen
// ---------------------------------------------------------------------------

function checkGithubRequestScope(frontmatter: Record<string, unknown>): LintViolation[] {
  const req = frontmatter.github_request;
  if (req === undefined || req === null) return [];
  const warn = (message: string): LintViolation => ({
    rule: "github_request_scope",
    severity: "warning",
    message,
  });
  if (typeof req !== "object" || Array.isArray(req)) {
    return [warn("github_request must be a mapping (github_request: { create_issue: true }); it will be ignored")];
  }
  const v: LintViolation[] = [];
  if (frontmatter.github !== undefined && frontmatter.github !== null) {
    v.push(warn("ticket already carries a github: provenance block; github_request will be ignored"));
  }
  if (frontmatter.push_remote === "fork") {
    v.push(warn("fork-push tickets never write to the upstream repo; github_request will be ignored"));
  }
  return v;
}
```

Register it in `lintTicket` (after the `checkNoCdInSteps` push):

```ts
  violations.push(...checkGithubRequestScope(frontmatter));
```

Add to the header comment's rule list:

```
 * - github_request_scope (warn): github_request rides a ticket the worker will actually fulfill
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/planLint.test.ts > /tmp/t4.out 2>&1; echo "exit: $?"`
Expected: `exit: 0`.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/planLint.ts tests/planLint.test.ts
git add src/planLint.ts tests/planLint.test.ts
git commit -m "feat(lint): advisory github_request_scope rule"
```

---

### Task 5: Docs, skill, changelog + full gate

**Files:**
- Modify: `docs/tickets.md` (frontmatter table + worker-managed `github:` note, currently lines 22-40)
- Modify: `skills/junco-dispatch/SKILL.md` (new subsection under "Metadata rules")
- Modify: `skills/junco-dispatch/TEMPLATE.md` (optional-frontmatter comment lines)
- Modify: `ARCHITECTURE.md` (module map row)
- Modify: `CHANGELOG.md` (`## [Unreleased]` → `### Added`)

**Interfaces:**
- Consumes: the shipped behavior of Tasks 1-4 — every doc claim below is a conformance assertion against it.
- Produces: nothing code-visible.

- [ ] **Step 1: `docs/tickets.md`**

Add a row to the frontmatter table after the `analyze` row:

```markdown
| `github_request`  | mapping             | Dispatcher-settable. `{ create_issue: true }` asks the worker to create a GitHub tracking issue for this ticket at claim time — on the clone's origin repo, under the worker's own gh identity (the bot account when configured) — and stamp the `github:` provenance block itself, so the resulting PR closes the issue on merge. Best-effort: if creation fails (offline, no permission, non-GitHub origin) the ticket still runs, unlinked. Ignored on fork-push (`push_remote: fork`) and Q&A/assess/analyze tickets. |
```

Append one sentence to the existing "Worker-managed `github:` block" blockquote:

```markdown
Local dispatches can *request* linkage without writing the block: set `github_request: { create_issue: true }` and the worker creates the issue and stamps `github:` itself.
```

- [ ] **Step 2: `skills/junco-dispatch/SKILL.md` + `TEMPLATE.md`**

SKILL.md — add at the end of the "Metadata rules" section (note: the inner fence is a real ```yaml fence in SKILL.md):

````markdown
### Linked tracking issue (optional)

When the user asks for an issue alongside the PR ("file an issue for this too", "link the PR to a tracking issue"), add to the frontmatter:

```yaml
github_request:
  create_issue: true
```

The **worker** — not you — creates the issue at claim time under its own GitHub identity (the operator's bot account when configured), on the clone's `origin` repo, and the eventual PR carries `Closes owner/repo#N` so merging closes it. Do NOT create the issue yourself with `gh`, and never write a `github:` block by hand (it is worker-managed). Omit the request when the ticket targets a repo the operator does not control (fork-PR dispatch) — the worker ignores it there.
````

TEMPLATE.md — inside the fenced frontmatter example, after the `# amends_pr: 42` comment line, add:

```markdown
# github_request:     # optional — worker creates a tracking issue and links the PR to it
#   create_issue: true
```

- [ ] **Step 3: `ARCHITECTURE.md` + `CHANGELOG.md`**

ARCHITECTURE.md module map — add a row adjacent to `githubInbox.ts`:

```markdown
| `githubIssueRequest.ts` | Dispatcher-requested issue linkage (`github_request.create_issue`): at claim time, creates a tracking issue on the clone's origin repo under the worker's gh identity, stamps worker-managed `github:` provenance into the claimed ticket file (crash/requeue-safe), and returns the meta `executeClaimed` feeds to the PR flow's `Closes` line and the reporter. Best-effort throughout; fork-push tickets and non-GitHub origins are skipped. |
```

CHANGELOG.md — under `## [Unreleased]` / `### Added`:

```markdown
- Tickets can request a bot-created tracking issue: `github_request: { create_issue: true }` makes the worker create the issue at claim time (own gh identity — bot account when configured) and link the PR (`Closes owner/repo#N`), so merging closes it. Best-effort; fork-push tickets are skipped.
```

- [ ] **Step 4: Full gate**

Run: `npm run lint && npm run format:check && npm run typecheck && npm run build && npm test > /tmp/gate.out 2>&1; echo "exit: $?"`
Expected: `exit: 0` (typecheck: no NEW errors vs the ~57 pre-existing on main).

- [ ] **Step 5: Commit**

```bash
npx prettier --write docs/tickets.md ARCHITECTURE.md CHANGELOG.md skills/junco-dispatch/SKILL.md skills/junco-dispatch/TEMPLATE.md
git add docs/tickets.md ARCHITECTURE.md CHANGELOG.md skills/junco-dispatch/SKILL.md skills/junco-dispatch/TEMPLATE.md docs/superpowers/plans/2026-07-17-ticket-issue-linkage.md
git commit -m "docs: github_request tracking-issue linkage — tickets guide, skill, architecture"
```

---

## Verification (whole-feature, after all tasks)

- `npm run build && node dist/cli.js schema | grep -A3 github_request` — the contract is user-visible.
- Grep sweep for doc honesty: every claim added in Task 5 must be implemented behavior (`create_issue`, claim-time, best-effort, fork skip); reconcile or fix.
- No release actions: this branch ends at a PR against `main` (Release HOLD is absolute).
