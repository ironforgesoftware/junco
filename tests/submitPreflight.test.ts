import { describe, it, expect } from "vitest";
import { join } from "node:path";
import {
  environmentChecks,
  runLint,
  ticketSlug,
  decideRoute,
  runSubmitDryRun,
} from "../src/submitPreflight.js";
import { inboxPath } from "../src/dispatch.js";
import { makeConfig } from "./helpers/config.js";
import type { Config } from "../src/types.js";

const REPO = "/sbxroot/repos/acme-api";

const TICKET = `---
id: add-x-2026-08-31
repo: ${JSON.stringify(REPO)}
pr_title: "Add X"
---

# Add X

## Steps

### Step 1: do it

Make the change.

\`\`\`bash
git commit -m "feat: x"
\`\`\`

## Notes for the agent (strict)

Do not loop.
`;

/** Fake git seam: scripted answers per subcommand; records calls. */
function fakeGit(answers: {
  gitDir?: { code: number; stdout: string };
  origin?: { code: number; stdout: string };
  lsRemote?: { code: number; stdout: string };
  head?: { code: number; stdout: string };
}) {
  const calls: string[][] = [];
  const fn = async (_c: unknown, args: string[]) => {
    calls.push(args);
    const blank = { code: 1, stdout: "", stderr: "" };
    if (args.includes("--git-dir"))
      return { stderr: "", ...(answers.gitDir ?? { code: 0, stdout: ".git\n" }) };
    if (args[0] === "remote") return { stderr: "", ...(answers.origin ?? blank) };
    if (args[0] === "ls-remote")
      return { stderr: "", ...(answers.lsRemote ?? { code: 0, stdout: "" }) };
    if (args[0] === "symbolic-ref") return { stderr: "", ...(answers.head ?? blank) };
    return blank;
  };
  return { fn: fn as never, calls };
}

function cfg() {
  return makeConfig({
    dataDir: "/sbxroot/data",
    queueRoot: "/sbxroot/data/queue",
    worktreeRoot: "/sbxroot/worktrees",
    tools: ["read", "bash"],
    criticEnabled: false,
    planLintEnabled: true,
    verifyEnabled: false,
    supervisorEnabled: false,
    healthEnabled: false,
    removeWorktreeOnSuccess: false,
  });
}

// --- decideRoute / runSubmitDryRun fixtures ---
// Mirrors tests/submitAsIssue.test.ts's DEFAULT_GITHUB fixture: acme/api
// watched at REPO, bot account enabled.
const DEFAULT_GITHUB: Config["github"] = {
  enabled: true,
  triggerLabel: "junco",
  askLabel: "junco:ask",
  pollIntervalSeconds: 60,
  repos: [{ nwo: "acme/api", path: REPO }],
  requireApproval: true,
  plannerModelId: null,
  externalReposRoot: "/sbxroot/external",
};
const DEFAULT_BOT_ACCOUNT: Config["botAccount"] = {
  enabled: true,
  configDir: "/sbxroot/junco-gh",
};

/** cfg() plus a watched-and-bot-enabled github/botAccount, toggleable per test. */
function ghCfg(opts: { githubEnabled?: boolean; botEnabled?: boolean } = {}) {
  return makeConfig(
    {
      dataDir: "/sbxroot/data",
      queueRoot: "/sbxroot/data/queue",
      worktreeRoot: "/sbxroot/worktrees",
      tools: ["read", "bash"],
      criticEnabled: false,
      planLintEnabled: true,
      verifyEnabled: false,
      supervisorEnabled: false,
      healthEnabled: false,
      removeWorktreeOnSuccess: false,
    },
    {
      github: { ...DEFAULT_GITHUB, enabled: opts.githubEnabled ?? true },
      botAccount: { ...DEFAULT_BOT_ACCOUNT, enabled: opts.botEnabled ?? true },
    },
  );
}

/** fakeGit with defaults suited to decideRoute: a GitHub origin resolving to
 * acme/api, and origin/main as the resolved default branch — overridable
 * per-call via the same `answers` shape fakeGit takes. existsFn defaults to
 * "the repo path exists" (B2's guard would otherwise short-circuit every
 * base_branch check against the real, nonexistent sandbox REPO path). */
function routeDeps(answers: Parameters<typeof fakeGit>[0] = {}) {
  return {
    gitFn: fakeGit({
      origin: { code: 0, stdout: "git@github.com:acme/api.git\n" },
      head: { code: 0, stdout: "origin/main\n" },
      ...answers,
    }).fn,
    existsFn: () => true,
  };
}

const TICKET_WITH_TIMEOUT = `---
id: add-x-2026-08-31
repo: ${JSON.stringify(REPO)}
pr_title: "Add X"
timeout_minutes: 60
draft: true
---

# Add X

## Steps

### Step 1: do it

Make the change.

\`\`\`bash
git commit -m "feat: x"
\`\`\`

## Notes for the agent (strict)

Do not loop.
`;

const TICKET_LOCAL = `---
id: add-y-2026-08-31
repo: ${JSON.stringify(REPO)}
---

# Add Y

## Steps

### Step 1: do it

Make the change.

\`\`\`bash
git commit -m "feat: y"
\`\`\`

## Notes for the agent (strict)

Do not loop.
`;

describe("ticketSlug", () => {
  it("mirrors dispatch.ts slugging", () => {
    expect(ticketSlug("add x!!2026")).toBe("add-x-2026");
    expect(ticketSlug("///")).toBe("ticket");
  });
});

describe("environmentChecks", () => {
  it("passes a healthy repo", async () => {
    const g = fakeGit({ origin: { code: 0, stdout: "git@github.com:acme/api.git\n" } });
    const r = await environmentChecks(cfg(), { repo: REPO }, "add-x-2026-08-31", {
      gitFn: g.fn,
      existsFn: () => true,
    });
    expect(r.violations).toEqual([]);
    expect(r.repoNwo).toBe("acme/api");
    expect(r.repoPath).toBe(REPO);
  });

  it("errors when repo: is missing, without calling git", async () => {
    const g = fakeGit({});
    const r = await environmentChecks(cfg(), {}, "id", { gitFn: g.fn, existsFn: () => true });
    expect(r.violations.map((v) => v.rule)).toEqual(["repo_missing"]);
    expect(g.calls).toEqual([]);
  });

  it("errors when the path does not exist", async () => {
    const g = fakeGit({});
    const r = await environmentChecks(cfg(), { repo: REPO }, "id", {
      gitFn: g.fn,
      existsFn: () => false,
    });
    expect(r.violations.map((v) => v.rule)).toEqual(["repo_path_missing"]);
  });

  it("errors when the path is not a git repo", async () => {
    const g = fakeGit({ gitDir: { code: 128, stdout: "" } });
    const r = await environmentChecks(cfg(), { repo: REPO }, "id", {
      gitFn: g.fn,
      existsFn: () => true,
    });
    expect(r.violations.map((v) => v.rule)).toEqual(["repo_not_git"]);
  });

  it("errors when origin is absent or not GitHub", async () => {
    const none = await environmentChecks(cfg(), { repo: REPO }, "id", {
      gitFn: fakeGit({ origin: { code: 2, stdout: "" } }).fn,
      existsFn: () => true,
    });
    expect(none.violations.map((v) => v.rule)).toContain("repo_no_origin");
    const gitlab = await environmentChecks(cfg(), { repo: REPO }, "id", {
      gitFn: fakeGit({ origin: { code: 0, stdout: "git@gitlab.com:a/b.git\n" } }).fn,
      existsFn: () => true,
    });
    expect(gitlab.violations.map((v) => v.rule)).toContain("repo_origin_not_github");
  });

  it("errors when the derived branch already exists on origin; warns when the check fails", async () => {
    const taken = await environmentChecks(cfg(), { repo: REPO }, "add-x-2026-08-31", {
      gitFn: fakeGit({
        origin: { code: 0, stdout: "https://github.com/acme/api.git\n" },
        lsRemote: { code: 0, stdout: "deadbeef\trefs/heads/junco/add-x-2026-08-31\n" },
      }).fn,
      existsFn: () => true,
    });
    expect(taken.violations.map((v) => v.rule)).toContain("branch_exists");
    expect(taken.violations.find((v) => v.rule === "branch_exists")?.severity).toBe("error");
    const offline = await environmentChecks(cfg(), { repo: REPO }, "add-x-2026-08-31", {
      gitFn: fakeGit({
        origin: { code: 0, stdout: "https://github.com/acme/api.git\n" },
        lsRemote: { code: 128, stdout: "" },
      }).fn,
      existsFn: () => true,
    });
    expect(offline.violations.find((v) => v.rule === "branch_check_failed")?.severity).toBe(
      "warning",
    );
  });

  it("prefers frontmatter branch_name over the derived branch", async () => {
    const g = fakeGit({
      origin: { code: 0, stdout: "https://github.com/acme/api.git\n" },
      lsRemote: { code: 0, stdout: "deadbeef\trefs/heads/custom\n" },
    });
    const r = await environmentChecks(cfg(), { repo: REPO, branch_name: "custom" }, "id", {
      gitFn: g.fn,
      existsFn: () => true,
    });
    expect(r.violations.map((v) => v.rule)).toContain("branch_exists");
    expect(g.calls.some((a) => a[0] === "ls-remote" && a.includes("custom"))).toBe(true);
  });

  // B3: the branch-collision check must mirror repoContext.ts's
  // deriveRepoContext exactly (cfg.branchPrefix, deriveBranchName's '/'-
  // preserving slug, isSafeGitRef gating) — not a re-derivation via
  // ticketSlug + a hardcoded "junco/" prefix.

  it("derives the branch via cfg.branchPrefix, not a hardcoded junco/ prefix", async () => {
    const g = fakeGit({
      origin: { code: 0, stdout: "https://github.com/acme/api.git\n" },
      lsRemote: { code: 0, stdout: "deadbeef\trefs/heads/custom-prefix/add-x-2026-08-31\n" },
    });
    const r = await environmentChecks(
      { ...cfg(), branchPrefix: "custom-prefix/" },
      { repo: REPO },
      "add-x-2026-08-31",
      { gitFn: g.fn, existsFn: () => true },
    );
    expect(r.violations.map((v) => v.rule)).toContain("branch_exists");
    expect(
      g.calls.some((a) => a[0] === "ls-remote" && a.includes("custom-prefix/add-x-2026-08-31")),
    ).toBe(true);
  });

  it("preserves '/' in the id slug (deriveBranchName), unlike ticketSlug's '-' collapse", async () => {
    const g = fakeGit({
      origin: { code: 0, stdout: "https://github.com/acme/api.git\n" },
      lsRemote: { code: 0, stdout: "" },
    });
    await environmentChecks(cfg(), { repo: REPO }, "feat/thing-2026-08-31", {
      gitFn: g.fn,
      existsFn: () => true,
    });
    expect(
      g.calls.some((a) => a[0] === "ls-remote" && a.includes("junco/feat/thing-2026-08-31")),
    ).toBe(true);
  });

  it("falls back to the derived branch when branch_name is unsafe (isSafeGitRef gating)", async () => {
    const g = fakeGit({
      origin: { code: 0, stdout: "https://github.com/acme/api.git\n" },
      lsRemote: { code: 0, stdout: "" },
    });
    await environmentChecks(
      cfg(),
      { repo: REPO, branch_name: "-unsafe --option" },
      "add-x-2026-08-31",
      { gitFn: g.fn, existsFn: () => true },
    );
    expect(g.calls.some((a) => a[0] === "ls-remote" && a.includes("junco/add-x-2026-08-31"))).toBe(
      true,
    );
    expect(g.calls.some((a) => a.includes("-unsafe --option"))).toBe(false);
  });
});

describe("runLint", () => {
  const okGit = () => fakeGit({ origin: { code: 0, stdout: "git@github.com:acme/api.git\n" } }).fn;

  it("exits 0 and prints lint: ok for a clean ticket", async () => {
    const out: string[] = [];
    const code = await runLint(cfg(), "t.md", TICKET, {
      gitFn: okGit(),
      existsFn: () => true,
      fetchLabels: () => new Set(["bug"]),
      printFn: (s) => out.push(s),
    });
    expect(code).toBe(0);
    expect(out.join("")).toContain("lint: ok");
  });

  it("exits 1 and lists violations when plan-lint or environment errors exist", async () => {
    const out: string[] = [];
    const bad = TICKET.replace("Make the change.", "TBD");
    const code = await runLint(cfg(), "t.md", bad, {
      gitFn: okGit(),
      existsFn: () => false,
      fetchLabels: () => new Set(),
      printFn: (s) => out.push(s),
    });
    expect(code).toBe(1);
    const text = out.join("");
    expect(text).toContain("[error] repo_path_missing");
    expect(text).toContain("[error] no_forbidden_phrases");
    expect(text).toMatch(/lint: \d+ error\(s\)/);
  });

  it("warnings alone still exit 0", async () => {
    const out: string[] = [];
    const code = await runLint(cfg(), "t.md", TICKET, {
      gitFn: fakeGit({
        origin: { code: 0, stdout: "https://github.com/acme/api.git\n" },
        lsRemote: { code: 128, stdout: "" },
      }).fn,
      existsFn: () => true,
      fetchLabels: () => new Set(),
      printFn: (s) => out.push(s),
    });
    expect(code).toBe(0);
    expect(out.join("")).toContain("[warning] branch_check_failed");
  });

  // I-5: `junco lint` parsed tickets with the silent default warnFn, so a
  // both-keys collision (audit:/assess:) never reached the author — it lints
  // "ok" even though the ticket is ambiguous. Now surfaced as a lint warning.
  it("surfaces a both-keys audit:/assess: collision as a lint warning", async () => {
    const out: string[] = [];
    const both = TICKET.replace('pr_title: "Add X"', 'pr_title: "Add X"\naudit: {}\nassess: {}');
    const code = await runLint(cfg(), "t.md", both, {
      gitFn: okGit(),
      existsFn: () => true,
      fetchLabels: () => new Set(["bug"]),
      printFn: (s) => out.push(s),
    });
    expect(code).toBe(0); // a warning, not an error
    const text = out.join("");
    expect(text).toContain("[warning] key_collision");
    expect(text).toMatch(/both `audit:` and legacy `assess:` present/);
    expect(text).toMatch(/lint: 1 warning\(s\)/);
  });

  it("does not warn when only one of audit:/assess: is present", async () => {
    const out: string[] = [];
    const single = TICKET.replace('pr_title: "Add X"', 'pr_title: "Add X"\naudit: {}');
    const code = await runLint(cfg(), "t.md", single, {
      gitFn: okGit(),
      existsFn: () => true,
      fetchLabels: () => new Set(["bug"]),
      printFn: (s) => out.push(s),
    });
    expect(code).toBe(0);
    expect(out.join("")).not.toContain("key_collision");
    expect(out.join("")).toContain("lint: ok");
  });
});

describe("decideRoute", () => {
  it("routes a plain fresh ticket on a watched repo to the issue destination", async () => {
    const d = await decideRoute(
      ghCfg(),
      { repo: REPO, timeout_minutes: 60, draft: true },
      routeDeps(),
    );
    expect(d.destination).toBe("issue");
    expect(d.watchedNwo).toBe("acme/api");
    expect(d.carriedTimeout).toBe(60);
    expect(d.discarded).toContain("draft");
    expect(d.discarded).not.toContain("timeout_minutes");
  });

  it("shape exclusions force the inbox with a reason each", async () => {
    for (const fm of [
      { repo: REPO, amends_pr: 7 },
      { repo: REPO, depends_on: ["other"] },
      { repo: REPO, branch_name: "custom" },
      { repo: REPO, tools: ["read"] },
      { repo: REPO, workdir: "sub/" },
    ]) {
      const d = await decideRoute(ghCfg(), fm, routeDeps());
      expect(d.destination).toBe("inbox");
      expect(d.reasons.length).toBeGreaterThan(0);
    }
    // empty depends_on is NOT exclusionary
    const ok = await decideRoute(ghCfg(), { repo: REPO, depends_on: [] }, routeDeps());
    expect(ok.destination).toBe("issue");
  });

  it("base_branch equal to the origin default is not exclusionary; different or unresolvable is", async () => {
    const same = await decideRoute(ghCfg(), { repo: REPO, base_branch: "main" }, routeDeps());
    expect(same.destination).toBe("issue");
    const diff = await decideRoute(ghCfg(), { repo: REPO, base_branch: "develop" }, routeDeps());
    expect(diff.destination).toBe("inbox");
    const unresolved = await decideRoute(
      ghCfg(),
      { repo: REPO, base_branch: "main" },
      routeDeps({ head: { code: 1, stdout: "" } }),
    );
    expect(unresolved.destination).toBe("inbox");
  });

  it("disabled github/bot or an unwatched repo routes to the inbox with the failed leg as reason", async () => {
    const noGh = await decideRoute(ghCfg({ githubEnabled: false }), { repo: REPO }, routeDeps());
    expect(noGh.destination).toBe("inbox");
    expect(noGh.reasons.join(" ")).toContain("github.enabled");
    const noBot = await decideRoute(ghCfg({ botEnabled: false }), { repo: REPO }, routeDeps());
    expect(noBot.reasons.join(" ")).toContain("botAccount.enabled");
    const unwatched = await decideRoute(
      ghCfg(),
      { repo: "/sbxroot/repos/other" },
      routeDeps({ origin: { code: 0, stdout: "git@github.com:other/repo.git\n" } }),
    );
    expect(unwatched.destination).toBe("inbox");
  });

  // B2: a nonexistent repo path (typo'd, or another machine's checkout) must
  // route to the conservative inbox verdict instead of letting the real git
  // wrapper's ENOENT throw escape decideRoute and crash `submit --dry-run`
  // before it can print `destination:`.
  it("base_branch on a nonexistent repo path routes to the inbox instead of throwing", async () => {
    const d = await decideRoute(
      ghCfg(),
      { repo: "/sbxroot/nonexistent-xyz/repo", base_branch: "main" },
      {
        gitFn: fakeGit({}).fn,
        existsFn: () => false,
      },
    );
    expect(d.destination).toBe("inbox");
    expect(d.reasons.join(" ")).toContain(
      "base_branch is set and the origin default branch could not be resolved",
    );
  });

  it("a throwing gitFn on an existing repo path is caught, not propagated", async () => {
    const throwingGit = async () => {
      throw new Error("git ENOENT (spawn git ENOENT)");
    };
    await expect(
      decideRoute(
        ghCfg(),
        { repo: REPO, base_branch: "main" },
        { gitFn: throwingGit as never, existsFn: () => true },
      ),
    ).resolves.toMatchObject({ destination: "inbox" });
  });
});

describe("runSubmitDryRun", () => {
  it("prints the issue verdict with carried/discard/timeout lines and submits nothing", async () => {
    const out: string[] = [];
    const code = await runSubmitDryRun(ghCfg(), "t.md", TICKET_WITH_TIMEOUT, {
      ...routeDeps(),
      existsFn: (p) => p === REPO, // repo exists; inbox dest does not
      fetchLabels: () => new Set(["bug"]),
      printFn: (s) => out.push(s),
    });
    const text = out.join("");
    expect(code).toBe(0);
    expect(text).toContain("destination: issue");
    expect(text).toContain("watched: acme/api");
    expect(text).toContain("carried: timeout_minutes=60");
    expect(text).toMatch(/would discard: .*draft/);
    expect(text).toContain("timeout: 60 minutes (carried)");
    expect(text).toContain("dry run — nothing submitted");
  });

  it("prints the inbox verdict with the would-submit path and exits 1 on lint errors", async () => {
    const out: string[] = [];
    const bad = TICKET_LOCAL.replace("Make the change.", "TBD"); // lint error
    const code = await runSubmitDryRun(ghCfg({ githubEnabled: false }), "t.md", bad, {
      ...routeDeps(),
      existsFn: (p) => p === REPO,
      fetchLabels: () => new Set(),
      printFn: (s) => out.push(s),
    });
    const text = out.join("");
    expect(code).toBe(1);
    expect(text).toContain("destination: inbox");
    expect(text).toContain("would submit: ");
    expect(text).toContain("[error] no_forbidden_phrases");
  });

  it("warns when the inbox destination is already queued", async () => {
    const localCfg = ghCfg({ githubEnabled: false });
    const dest = join(inboxPath(localCfg), `${ticketSlug("add-y-2026-08-31")}.md`);
    const out: string[] = [];
    const code = await runSubmitDryRun(localCfg, "t.md", TICKET_LOCAL, {
      ...routeDeps(),
      existsFn: (p) => p === REPO || p === dest, // repo AND the computed inbox path both exist
      fetchLabels: () => new Set(["bug"]),
      printFn: (s) => out.push(s),
    });
    const text = out.join("");
    expect(code).toBe(0);
    expect(text).toContain("already queued");
  });

  // O4: on the issue route the bridge re-ids the ticket, so a branch_exists
  // hit against the LOCAL id's branch can't be the real collision — this
  // route downgrades it to a warning instead of blocking the dry-run.
  it("downgrades branch_exists to a warning on the issue route (bridge re-ids the ticket)", async () => {
    const out: string[] = [];
    const code = await runSubmitDryRun(ghCfg(), "t.md", TICKET, {
      ...routeDeps({
        lsRemote: { code: 0, stdout: "deadbeef\trefs/heads/junco/add-x-2026-08-31\n" },
      }),
      existsFn: (p) => p === REPO,
      fetchLabels: () => new Set(["bug"]),
      printFn: (s) => out.push(s),
    });
    const text = out.join("");
    expect(code).toBe(0);
    expect(text).toContain("destination: issue");
    expect(text).toContain("[warning] branch_exists");
    expect(text).not.toContain("[error] branch_exists");
  });

  // I-5: `junco submit --dry-run` had the same silent-warnFn gap as runLint.
  it("surfaces a both-keys audit:/assess: collision in the dry-run lint report", async () => {
    const localCfg = ghCfg({ githubEnabled: false });
    const both = TICKET_LOCAL.replace(
      `repo: ${JSON.stringify(REPO)}`,
      `repo: ${JSON.stringify(REPO)}\naudit: {}\nassess: {}`,
    );
    const out: string[] = [];
    const code = await runSubmitDryRun(localCfg, "t.md", both, {
      ...routeDeps(),
      existsFn: (p) => p === REPO,
      fetchLabels: () => new Set(["bug"]),
      printFn: (s) => out.push(s),
    });
    const text = out.join("");
    expect(code).toBe(0);
    expect(text).toContain("[warning] key_collision");
    expect(text).toMatch(/both `audit:` and legacy `assess:` present/);
  });

  it("does not warn on the dry-run path when only one of audit:/assess: is present", async () => {
    const localCfg = ghCfg({ githubEnabled: false });
    const single = TICKET_LOCAL.replace(
      `repo: ${JSON.stringify(REPO)}`,
      `repo: ${JSON.stringify(REPO)}\naudit: {}`,
    );
    const out: string[] = [];
    const code = await runSubmitDryRun(localCfg, "t.md", single, {
      ...routeDeps(),
      existsFn: (p) => p === REPO,
      fetchLabels: () => new Set(["bug"]),
      printFn: (s) => out.push(s),
    });
    expect(code).toBe(0);
    expect(out.join("")).not.toContain("key_collision");
  });
});
