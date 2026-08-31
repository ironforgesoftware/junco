import { describe, it, expect } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { submitAsIssue, wrapInFence, carriedTimeoutMinutes } from "../src/submitAsIssue.js";
import { extractPlanBody, extractPlanSetBody } from "../src/githubInbox.js";
import { writeWatchlist, watchlistPath } from "../src/watchlist.js";
import { makeConfig } from "./helpers/config.js";
import type { Config } from "../src/types.js";

// Synthetic, non-existent absolute paths (CLAUDE.md: prefer these over real
// tmp dirs in unit tests) — canonPath's realpath-or-resolve fallback matches
// them consistently on both the ticket's repo: side and the watched-entry side
// without touching the filesystem.
const REPO_PATH = "/sbxroot/repos/acme-api";

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

const PLAN_DOC =
  "```junco-plan\nversion: 1\ntasks:\n  - id: t-one\n    title: Do one\n    description: |\n      Self-contained.\n    acceptance:\n      - done\n```\n";

const INVALID_PLAN_DOC = "```junco-plan\nversion: 1\ntasks: []\n```\n";

const fakeBotAuth = async (c: Config): Promise<Config> => ({
  ...c,
  ghAuth: {
    configDir: "/sbxroot/junco-gh",
    login: "junco-bot",
    email: "1+junco-bot@users.noreply.github.com",
    credentialHelper: "",
  },
});

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

const DEFAULT_GITHUB: Config["github"] = {
  enabled: true,
  triggerLabel: "junco",
  askLabel: "junco:ask",
  pollIntervalSeconds: 60,
  repos: [{ nwo: "acme/api", path: REPO_PATH }],
  requireApproval: true,
  plannerModelId: null,
  externalReposRoot: "/sbxroot/external",
};
const DEFAULT_BOT_ACCOUNT: Config["botAccount"] = {
  enabled: true,
  configDir: "/sbxroot/junco-gh",
};

function baseCfg(overrides: Partial<Config> = {}): Config {
  return makeConfig(
    {
      dataDir: "/sbxroot/data",
      queueRoot: "/sbxroot/queue",
      worktreeRoot: "/sbxroot/worktrees",
      tools: [],
      criticEnabled: false,
      planLintEnabled: false,
      verifyEnabled: false,
      supervisorEnabled: false,
      healthEnabled: false,
      removeWorktreeOnSuccess: false,
    },
    {
      github: DEFAULT_GITHUB,
      botAccount: DEFAULT_BOT_ACCOUNT,
      ...overrides,
    },
  );
}

describe("submitAsIssue", () => {
  it("files a parked, unlabeled issue wrapping the ticket body in a junco-ticket fence", async () => {
    const cfg = baseCfg();
    const calls: string[][] = [];
    let capturedBody = "";
    const ghFn = async (_c: unknown, args: string[]) => {
      calls.push(args);
      if (args[0] === "issue" && args[1] === "create") {
        // createIssueLive deletes its temp body file in a finally, so capture
        // the CONTENT here, at call time, rather than re-reading afterward.
        const idx = args.indexOf("--body-file");
        capturedBody = readFileSync(args[idx + 1], "utf8");
        return { code: 0, stdout: "https://github.com/acme/api/issues/9\n", stderr: "" };
      }
      throw new Error(`unhandled: ${args.join(" ")}`);
    };
    const out: string[] = [];
    const code = await submitAsIssue(
      cfg,
      "t.md",
      TICKET,
      { plan: false },
      {
        ghFn: ghFn as never,
        printFn: (s) => out.push(s),
        errFn: () => {},
        withBotAuthFn: fakeBotAuth,
      },
    );

    expect(code).toBe(0);
    const create = calls.find((c) => c[0] === "issue" && c[1] === "create")!;
    expect(create).toContain("--repo");
    expect(create).toContain("acme/api");
    expect(create.join(" ")).toContain("Add X"); // pr_title becomes the issue title
    expect(create.join(" ")).not.toContain("--label"); // parked: no labels, ever

    const extracted = extractPlanBody(capturedBody);
    expect(extracted).toContain("# Add X");
    expect(extracted).toContain("echo has a code fence"); // inner ``` fence survived
    expect(capturedBody).toContain("<!-- junco:as-issue -->");
    expect(out.join("")).toContain("issues/9");
    expect(out.join("")).toContain(cfg.github.triggerLabel); // launch instruction names the label
  });

  it("warns that discarded frontmatter keys will not survive, but still files the issue", async () => {
    const cfg = baseCfg();
    // TICKET's frontmatter is id/repo/pr_title/timeout_minutes: 60 — with a
    // valid timeout now CARRIED (see the "timeout carry" describe below),
    // none of those keys are discarded. Add a genuinely foreign key so this
    // test still exercises the discard-warning path.
    const ticket = TICKET.replace('pr_title: "Add X"', 'pr_title: "Add X"\npriority: high');
    const calls: string[][] = [];
    const ghFn = async (_c: unknown, args: string[]) => {
      calls.push(args);
      if (args[0] === "issue" && args[1] === "create")
        return { code: 0, stdout: "https://github.com/acme/api/issues/9\n", stderr: "" };
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
        printFn: () => {},
        errFn: (s) => errs.push(s),
        withBotAuthFn: fakeBotAuth,
      },
    );

    expect(code).toBe(0);
    expect(calls.some((c) => c[0] === "issue" && c[1] === "create")).toBe(true);
    expect(errs.join("")).toContain("priority");
    expect(errs.join("")).not.toContain("timeout_minutes"); // carried, not discarded
  });

  it("refuses when the ticket's repo is not bridge-watched", async () => {
    const cfg = baseCfg();
    const ticket = TICKET.replace(JSON.stringify(REPO_PATH), JSON.stringify("/elsewhere"));
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

    expect(code).not.toBe(0);
    expect(errs.join("")).toContain("not a bridge-watched repo");
    expect(calls.some((c) => c[0] === "issue" && c[1] === "create")).toBe(false);
  });

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

  // Spec (docs/superpowers/specs/2026-08-21-issue-as-inbox-design.md) names
  // "unwatched" and "unowned" as distinct refusal cases: an external/fork-PR
  // watchlist entry (external: true) is excluded by resolveWatchedRepos (no
  // triage rights, no label, no gate) — a real dataDir is needed here so
  // writeWatchlist has somewhere to persist the entry for readWatchlist to load.
  it("refuses when the ticket's repo matches only an unowned (external) watchlist entry", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-submit-as-issue-"));
    try {
      const externalPath = join(root, "external-repo");
      const cfg = baseCfg({ github: { ...DEFAULT_GITHUB, repos: [] }, dataDir: root });
      writeWatchlist(watchlistPath(cfg), [
        { nwo: "acme/external", path: externalPath, external: true },
      ]);
      const ticket = TICKET.replace(JSON.stringify(REPO_PATH), JSON.stringify(externalPath));
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
          gitFn: fakeGit("https://github.com/acme/external.git").fn,
          printFn: () => {},
          errFn: (s) => errs.push(s),
          withBotAuthFn: fakeBotAuth,
        },
      );

      expect(code).not.toBe(0);
      expect(errs.join("")).toContain("not a bridge-watched repo");
      expect(calls.some((c) => c[0] === "issue" && c[1] === "create")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses when github integration is disabled", async () => {
    const cfg = baseCfg({ github: { ...DEFAULT_GITHUB, enabled: false } });
    const calls: string[][] = [];
    const ghFn = async (_c: unknown, args: string[]) => {
      calls.push(args);
      throw new Error(`unhandled: ${args.join(" ")}`);
    };
    const errs: string[] = [];
    const code = await submitAsIssue(
      cfg,
      "t.md",
      TICKET,
      { plan: false },
      {
        ghFn: ghFn as never,
        printFn: () => {},
        errFn: (s) => errs.push(s),
        withBotAuthFn: fakeBotAuth,
      },
    );

    expect(code).not.toBe(0);
    expect(errs.join("")).toContain("github.enabled");
    expect(calls.some((c) => c[0] === "issue" && c[1] === "create")).toBe(false);
  });

  it("refuses when the bot account is disabled", async () => {
    const cfg = baseCfg({ botAccount: { enabled: false, configDir: "/sbxroot/junco-gh" } });
    const calls: string[][] = [];
    const ghFn = async (_c: unknown, args: string[]) => {
      calls.push(args);
      throw new Error(`unhandled: ${args.join(" ")}`);
    };
    const errs: string[] = [];
    const code = await submitAsIssue(
      cfg,
      "t.md",
      TICKET,
      { plan: false },
      {
        ghFn: ghFn as never,
        printFn: () => {},
        errFn: (s) => errs.push(s),
        withBotAuthFn: fakeBotAuth,
      },
    );

    expect(code).not.toBe(0);
    expect(errs.join("")).toContain("botAccount.enabled");
    expect(calls.some((c) => c[0] === "issue" && c[1] === "create")).toBe(false);
  });

  // parseTicket (src/ticket.ts) never throws — unparsable content degrades to
  // an empty frontmatter record rather than raising (verified by reading
  // ticket.ts before writing this test; the brief's premise that parseTicket
  // throws does not hold). A frontmatter-less/malformed ticket is refused
  // instead by the missing `repo:` field check, which is the realistic
  // "invalid ticket" refusal on this route.
  it("refuses an invalid ticket that carries no repo: frontmatter", async () => {
    const cfg = baseCfg();
    const calls: string[][] = [];
    const ghFn = async (_c: unknown, args: string[]) => {
      calls.push(args);
      throw new Error(`unhandled: ${args.join(" ")}`);
    };
    const errs: string[] = [];
    const code = await submitAsIssue(
      cfg,
      "t.md",
      "not a ticket",
      { plan: false },
      {
        ghFn: ghFn as never,
        printFn: () => {},
        errFn: (s) => errs.push(s),
        withBotAuthFn: fakeBotAuth,
      },
    );

    expect(code).not.toBe(0);
    expect(errs.join("")).toContain("repo:");
    expect(calls.some((c) => c[0] === "issue" && c[1] === "create")).toBe(false);
  });

  it("refuses when the bot auth resolution throws (broken bot login)", async () => {
    const cfg = baseCfg();
    const calls: string[][] = [];
    const ghFn = async (_c: unknown, args: string[]) => {
      calls.push(args);
      throw new Error(`unhandled: ${args.join(" ")}`);
    };
    const errs: string[] = [];
    const code = await submitAsIssue(
      cfg,
      "t.md",
      TICKET,
      { plan: false },
      {
        ghFn: ghFn as never,
        printFn: () => {},
        errFn: (s) => errs.push(s),
        withBotAuthFn: async () => {
          throw new Error("botAccount.enabled is true but no working gh login exists");
        },
      },
    );

    expect(code).not.toBe(0);
    expect(errs.join("")).toContain("gh login");
    expect(calls.some((c) => c[0] === "issue" && c[1] === "create")).toBe(false);
  });
});

describe("timeout carry", () => {
  it("embeds a clamped junco:timeout marker and stops listing timeout_minutes as discarded", async () => {
    // Extra foreign keys alongside the carried timeout: still listed as
    // discarded, so the carve-out is specific to timeout_minutes.
    const ticket = TICKET.replace(
      'pr_title: "Add X"',
      'pr_title: "Add X"\npriority: high\ndraft: true',
    );
    const calls: string[][] = [];
    let capturedBody = "";
    const ghFn = async (_c: unknown, args: string[]) => {
      calls.push(args);
      if (args[0] === "issue" && args[1] === "create") {
        const idx = args.indexOf("--body-file");
        capturedBody = readFileSync(args[idx + 1], "utf8");
        return { code: 0, stdout: "https://github.com/acme/api/issues/9\n", stderr: "" };
      }
      throw new Error(`unhandled: ${args.join(" ")}`);
    };
    const out: string[] = [];
    const errs: string[] = [];
    const code = await submitAsIssue(
      baseCfg(),
      "t.md",
      ticket,
      { plan: false },
      {
        ghFn: ghFn as never,
        printFn: (s) => out.push(s),
        errFn: (s) => errs.push(s),
        withBotAuthFn: fakeBotAuth,
      },
    );

    expect(code).toBe(0);
    expect(capturedBody).toContain("<!-- junco:timeout:60 -->");
    const stderrText = errs.join("");
    expect(stderrText).not.toContain("timeout_minutes");
    expect(stderrText).toContain("priority"); // still discarded
    expect(stderrText).toContain("draft"); // still discarded
    expect(out.join("")).toContain("carried: timeout_minutes=60");
  });

  it("clamps to 480 and drops non-positive values", async () => {
    const highTicket = TICKET.replace("timeout_minutes: 60", "timeout_minutes: 9999");
    const zeroTicket = TICKET.replace("timeout_minutes: 60", "timeout_minutes: 0");

    // 9999 clamps to 480 and is still carried.
    {
      let capturedBody = "";
      const ghFn = async (_c: unknown, args: string[]) => {
        if (args[0] === "issue" && args[1] === "create") {
          const idx = args.indexOf("--body-file");
          capturedBody = readFileSync(args[idx + 1], "utf8");
          return { code: 0, stdout: "https://github.com/acme/api/issues/9\n", stderr: "" };
        }
        throw new Error(`unhandled: ${args.join(" ")}`);
      };
      const out: string[] = [];
      const errs: string[] = [];
      const code = await submitAsIssue(
        baseCfg(),
        "t.md",
        highTicket,
        { plan: false },
        {
          ghFn: ghFn as never,
          printFn: (s) => out.push(s),
          errFn: (s) => errs.push(s),
          withBotAuthFn: fakeBotAuth,
        },
      );
      expect(code).toBe(0);
      expect(capturedBody).toContain("<!-- junco:timeout:480 -->");
      expect(out.join("")).toContain("carried: timeout_minutes=480");
      expect(errs.join("")).not.toContain("timeout_minutes");
    }

    // 0 is not carried: no marker, and timeout_minutes IS listed as discarded.
    {
      let capturedBody = "";
      const ghFn = async (_c: unknown, args: string[]) => {
        if (args[0] === "issue" && args[1] === "create") {
          const idx = args.indexOf("--body-file");
          capturedBody = readFileSync(args[idx + 1], "utf8");
          return { code: 0, stdout: "https://github.com/acme/api/issues/9\n", stderr: "" };
        }
        throw new Error(`unhandled: ${args.join(" ")}`);
      };
      const out: string[] = [];
      const errs: string[] = [];
      const code = await submitAsIssue(
        baseCfg(),
        "t.md",
        zeroTicket,
        { plan: false },
        {
          ghFn: ghFn as never,
          printFn: (s) => out.push(s),
          errFn: (s) => errs.push(s),
          withBotAuthFn: fakeBotAuth,
        },
      );
      expect(code).toBe(0);
      expect(capturedBody).not.toContain("junco:timeout");
      expect(errs.join("")).toContain("timeout_minutes");
      expect(out.join("")).not.toContain("carried: timeout_minutes");
    }
  });
});

describe("carriedTimeoutMinutes", () => {
  it("clamps and rejects", () => {
    expect(carriedTimeoutMinutes({ timeout_minutes: 60 })).toBe(60);
    expect(carriedTimeoutMinutes({ timeout_minutes: 9999 })).toBe(480);
    expect(carriedTimeoutMinutes({ timeout_minutes: 0.4 })).toBe(null); // < 1 → null
    expect(carriedTimeoutMinutes({ timeout_minutes: 1.4 })).toBe(1);
    expect(carriedTimeoutMinutes({ timeout_minutes: "90" })).toBe(90);
    expect(carriedTimeoutMinutes({ timeout_minutes: 0 })).toBe(null);
    expect(carriedTimeoutMinutes({ timeout_minutes: -5 })).toBe(null);
    expect(carriedTimeoutMinutes({ timeout_minutes: "soon" })).toBe(null);
    expect(carriedTimeoutMinutes({})).toBe(null);
  });
});

describe("submitAsIssue --as-issue --plan (parked plan-set issue)", () => {
  function planCfg(overrides: Partial<Config> = {}): Config {
    return baseCfg({
      planSets: { enabled: true, mergePollSeconds: 60, maxTasks: 10 },
      ...overrides,
    });
  }

  it("files a parked issue wrapping a validated junco-plan fence", async () => {
    const cfg = planCfg();
    const calls: string[][] = [];
    let capturedBody = "";
    const ghFn = async (_c: unknown, args: string[]) => {
      calls.push(args);
      if (args[0] === "issue" && args[1] === "create") {
        const idx = args.indexOf("--body-file");
        capturedBody = readFileSync(args[idx + 1], "utf8");
        return { code: 0, stdout: "https://github.com/acme/api/issues/11\n", stderr: "" };
      }
      throw new Error(`unhandled: ${args.join(" ")}`);
    };
    const out: string[] = [];
    const code = await submitAsIssue(
      cfg,
      "plan.md",
      PLAN_DOC,
      { plan: true, repoFlag: REPO_PATH },
      {
        ghFn: ghFn as never,
        printFn: (s) => out.push(s),
        errFn: () => {},
        withBotAuthFn: fakeBotAuth,
      },
    );

    expect(code).toBe(0);
    const create = calls.find((c) => c[0] === "issue" && c[1] === "create")!;
    expect(create).toContain("--repo");
    expect(create).toContain("acme/api");
    expect(create.join(" ")).not.toContain("--label"); // parked: no labels, ever

    const extracted = extractPlanSetBody(capturedBody);
    expect(extracted).not.toBeNull();
    expect(extracted).toContain("t-one");
    expect(capturedBody).toContain("<!-- junco:as-issue -->");
    expect(out.join("")).toContain("issues/11");
    expect(out.join("")).toContain(cfg.github.triggerLabel); // launch instruction names the label
  });

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

  it("refuses --plan when planSets are disabled", async () => {
    const cfg = planCfg({ planSets: { enabled: false, mergePollSeconds: 60, maxTasks: 10 } });
    const calls: string[][] = [];
    const ghFn = async (_c: unknown, args: string[]) => {
      calls.push(args);
      throw new Error(`unhandled: ${args.join(" ")}`);
    };
    const errs: string[] = [];
    const code = await submitAsIssue(
      cfg,
      "plan.md",
      PLAN_DOC,
      { plan: true, repoFlag: REPO_PATH },
      {
        ghFn: ghFn as never,
        printFn: () => {},
        errFn: (s) => errs.push(s),
        withBotAuthFn: fakeBotAuth,
      },
    );

    expect(code).toBe(1);
    expect(errs.join("")).toContain("planSets.enabled");
    expect(calls.some((c) => c[0] === "issue" && c[1] === "create")).toBe(false);
  });

  it("refuses --plan without --repo", async () => {
    const cfg = planCfg();
    const calls: string[][] = [];
    const ghFn = async (_c: unknown, args: string[]) => {
      calls.push(args);
      throw new Error(`unhandled: ${args.join(" ")}`);
    };
    const errs: string[] = [];
    const code = await submitAsIssue(
      cfg,
      "plan.md",
      PLAN_DOC,
      { plan: true, repoFlag: undefined },
      {
        ghFn: ghFn as never,
        printFn: () => {},
        errFn: (s) => errs.push(s),
        withBotAuthFn: fakeBotAuth,
      },
    );

    expect(code).toBe(2);
    expect(calls.some((c) => c[0] === "issue" && c[1] === "create")).toBe(false);
  });

  it("refuses --plan when the fence does not validate", async () => {
    const cfg = planCfg();
    const calls: string[][] = [];
    const ghFn = async (_c: unknown, args: string[]) => {
      calls.push(args);
      throw new Error(`unhandled: ${args.join(" ")}`);
    };
    const errs: string[] = [];
    const code = await submitAsIssue(
      cfg,
      "plan.md",
      INVALID_PLAN_DOC,
      { plan: true, repoFlag: REPO_PATH },
      {
        ghFn: ghFn as never,
        printFn: () => {},
        errFn: (s) => errs.push(s),
        withBotAuthFn: fakeBotAuth,
      },
    );

    expect(code).toBe(1);
    expect(errs.join("")).toContain("plan error");
    expect(calls.some((c) => c[0] === "issue" && c[1] === "create")).toBe(false);
  });

  it("refuses --plan when the file has no junco-plan fence", async () => {
    const cfg = planCfg();
    const calls: string[][] = [];
    const ghFn = async (_c: unknown, args: string[]) => {
      calls.push(args);
      throw new Error(`unhandled: ${args.join(" ")}`);
    };
    const errs: string[] = [];
    const code = await submitAsIssue(
      cfg,
      "plan.md",
      "no fence here at all",
      { plan: true, repoFlag: REPO_PATH },
      {
        ghFn: ghFn as never,
        printFn: () => {},
        errFn: (s) => errs.push(s),
        withBotAuthFn: fakeBotAuth,
      },
    );

    expect(code).toBe(1);
    expect(errs.join("")).toContain("no junco-plan fence found");
    expect(calls.some((c) => c[0] === "issue" && c[1] === "create")).toBe(false);
  });

  it("refuses --plan when --repo is not a bridge-watched repo", async () => {
    const cfg = planCfg();
    const calls: string[][] = [];
    const ghFn = async (_c: unknown, args: string[]) => {
      calls.push(args);
      throw new Error(`unhandled: ${args.join(" ")}`);
    };
    const errs: string[] = [];
    const code = await submitAsIssue(
      cfg,
      "plan.md",
      PLAN_DOC,
      { plan: true, repoFlag: "/elsewhere" },
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
});

describe("wrapInFence", () => {
  it("wraps with a fence longer than any backtick run in the body", () => {
    const wrapped = wrapInFence("junco-ticket", "x\n````\ny\n````\nz");
    expect(wrapped.startsWith("`````junco-ticket\n")).toBe(true);
    expect(extractPlanBody(wrapped)).toContain("````");
  });

  it("uses a minimum 3-backtick fence when the body has no backticks", () => {
    const wrapped = wrapInFence("junco-ticket", "plain body, no fences");
    expect(wrapped.startsWith("```junco-ticket\n")).toBe(true);
    expect(extractPlanBody(wrapped)).toBe("plain body, no fences");
  });
});

describe("parked issue readability", () => {
  function captureGh() {
    const state = { body: "" };
    const ghFn = async (_c: unknown, args: string[]) => {
      if (args[0] === "issue" && args[1] === "create") {
        const idx = args.indexOf("--body-file");
        state.body = readFileSync(args[idx + 1], "utf8");
        return { code: 0, stdout: "https://github.com/acme/api/issues/9\n", stderr: "" };
      }
      throw new Error(`unhandled: ${args.join(" ")}`);
    };
    return { state, ghFn };
  }

  it("renders the plan above a collapsed machine fence and keeps the round-trip", async () => {
    const { state, ghFn } = captureGh();
    const code = await submitAsIssue(
      baseCfg(),
      "t.md",
      TICKET,
      { plan: false },
      { ghFn: ghFn as never, printFn: () => {}, errFn: () => {}, withBotAuthFn: fakeBotAuth },
    );
    expect(code).toBe(0);
    const body = state.body;
    const details = body.indexOf("<details><summary>machine copy");
    expect(details).toBeGreaterThan(-1);
    // Rendered (unfenced) copy sits above the collapsed machine fence.
    expect(body.indexOf("# Add X")).toBeLessThan(details);
    expect((body.match(/# Add X/g) ?? []).length).toBe(2); // rendered + fenced
    // Markers land after the details block, at the end of the body.
    expect(body.indexOf("<!-- junco:as-issue -->")).toBeGreaterThan(body.indexOf("</details>"));
    expect(body).toContain("<!-- junco:timeout:60 -->");
    // The machine fence is untouched: the bridge's extractor still returns the
    // exact ticket body, and never the human chrome.
    const extracted = extractPlanBody(body);
    expect(extracted).toContain("# Add X");
    expect(extracted).not.toContain("<details>");
  });

  it("falls back to fence-only when both copies would exceed the body budget", async () => {
    const big = TICKET.replace("- add it", "- add it\n\n" + "long line ".repeat(4000));
    const { state, ghFn } = captureGh();
    const code = await submitAsIssue(
      baseCfg(),
      "t.md",
      big,
      { plan: false },
      { ghFn: ghFn as never, printFn: () => {}, errFn: () => {}, withBotAuthFn: fakeBotAuth },
    );
    expect(code).toBe(0);
    const body = state.body;
    expect(body).not.toContain("<details>");
    expect((body.match(/# Add X/g) ?? []).length).toBe(1); // single, fenced copy
    expect(body).toContain("<!-- junco:as-issue -->");
    expect(extractPlanBody(body)).toContain("long line");
  });
});
