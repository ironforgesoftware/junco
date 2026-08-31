import { describe, it, expect } from "vitest";
import { environmentChecks, runLint, ticketSlug } from "../src/submitPreflight.js";
import { makeConfig } from "./helpers/config.js";

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
    const bad = TICKET.replace("## Notes for the agent (strict)", "## Notes");
    const code = await runLint(cfg(), "t.md", bad, {
      gitFn: okGit(),
      existsFn: () => false,
      fetchLabels: () => new Set(),
      printFn: (s) => out.push(s),
    });
    expect(code).toBe(1);
    const text = out.join("");
    expect(text).toContain("[error] repo_path_missing");
    expect(text).toContain("[error] notes_block_present");
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
});
