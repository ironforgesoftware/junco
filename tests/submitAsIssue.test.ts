import { describe, it, expect } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { submitAsIssue, wrapInFence } from "../src/submitAsIssue.js";
import { extractPlanBody } from "../src/githubInbox.js";
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

const fakeBotAuth = async (c: Config): Promise<Config> => ({
  ...c,
  ghAuth: {
    configDir: "/sbxroot/junco-gh",
    login: "junco-bot",
    email: "1+junco-bot@users.noreply.github.com",
    credentialHelper: "",
  },
});

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
      TICKET,
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
    expect(errs.join("")).toContain("timeout_minutes");
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
        printFn: () => {},
        errFn: (s) => errs.push(s),
        withBotAuthFn: fakeBotAuth,
      },
    );

    expect(code).not.toBe(0);
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
