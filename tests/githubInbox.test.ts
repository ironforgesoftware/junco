import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  lifecycleLabels,
  isEligible,
  nwoFromRemoteUrl,
  issueToTicket,
  pollGithubInbox,
  newBridgeState,
  extractPlanBody,
  buildPlanComment,
  PLAN_COMMENT_MARKER,
  type GhIssue,
} from "../src/githubInbox.js";
import { parseTicket } from "../src/ticket.js";
import type { Config } from "../src/types.js";
import type { CmdResult } from "../src/git.js";

// executionTicketExists (approval path) calls queuePaths(cfg); point bridge
// configs at a vault dir that does not exist so readdirSync ENOENTs → "absent".
const NX_VAULT = join(tmpdir(), `junco-nx-${Math.random().toString(36).slice(2)}`);

// Minimal Config for conversion tests — only the fields issueToTicket reads.
const cfg = {
  github: {
    enabled: true,
    triggerLabel: "junco",
    askLabel: "junco:ask",
    pollIntervalSeconds: 60,
    repos: [],
    requireApproval: true,
    plannerModelId: null,
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
  it("derives all eight from the trigger", () => {
    expect(lifecycleLabels("bot")).toEqual({
      queued: "bot:queued",
      working: "bot:working",
      done: "bot:done",
      failed: "bot:failed",
      denied: "bot:denied",
      planning: "bot:planning",
      planReady: "bot:plan-ready",
      approved: "bot:approved",
    });
  });
});

describe("isEligible", () => {
  it("requires the trigger label", () => {
    expect(isEligible(issue(["bug"]), "junco")).toBe(false);
    expect(isEligible(issue(["junco"]), "junco")).toBe(true);
    expect(isEligible(issue(["junco", "bug", "junco:ask"]), "junco")).toBe(true);
  });

  it("excludes every lifecycle label", () => {
    const lifecycle = [
      "junco:queued",
      "junco:working",
      "junco:done",
      "junco:failed",
      "junco:denied",
      "junco:planning",
      "junco:plan-ready",
    ];
    for (const l of lifecycle) {
      expect(isEligible(issue(["junco", l]), "junco")).toBe(false);
    }
  });

  it("approved alone does NOT block eligibility (neutralized by the timestamp rule)", () => {
    expect(isEligible(issue(["junco", "junco:approved"]), "junco")).toBe(true);
  });
});

describe("nwoFromRemoteUrl", () => {
  it.each([
    ["https://github.com/acme/api.git", "acme/api"],
    ["https://github.com/acme/api", "acme/api"],
    ["https://github.com/acme/api/", "acme/api"],
    ["git@github.com:acme/api.git", "acme/api"],
    ["git@github.com:acme/api", "acme/api"],
    ["ssh://git@github.com/acme/api.git", "acme/api"],
  ])("%s → %s", (url, nwo) => {
    expect(nwoFromRemoteUrl(url)).toBe(nwo);
  });

  it("returns null for non-github urls", () => {
    expect(nwoFromRemoteUrl("https://gitlab.com/a/b.git")).toBeNull();
    expect(nwoFromRemoteUrl("not a url")).toBeNull();
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
    expect(parsed.workdir).toBeNull();
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
    expect(parsed.github).toEqual({ nwo: "acme/api", issue: 42, kind: "pr" });
  });

  it("handles an empty issue body (title-only ticket)", () => {
    const t = issueToTicket(issue(["junco"], { body: null }), repo, cfg, null);
    const parsed = parseTicket(`/in/${t.id}.md`, t.content);
    expect(parsed.body.trim()).toBe("# Add rate limiting");
  });

  it("appends parent context as a marked background section", () => {
    const t = issueToTicket(issue(["junco"]), repo, cfg, {
      title: "Uploads are slow",
      body: "Users report 30s uploads.",
    });
    expect(t.content).toContain("## Context: parent issue");
    expect(t.content).toContain("**Uploads are slow**");
    expect(t.content).toContain("Users report 30s uploads.");
    expect(t.content).toContain("_Background only");
  });
});

// ---------------------------------------------------------------------------
// pollGithubInbox — sweep behavior against DI fakes (no network, no shell)
// ---------------------------------------------------------------------------

describe("pollGithubInbox", () => {
  type Call = string[];
  function makeFakes(opts: {
    issues?: unknown[];
    events?: string; // NDJSON lines from the --jq filter
    permission?: string;
    parent?: string; // "" | "null" | JSON
    origin?: string;
    failList?: boolean;
    comments?: unknown[];
    viewer?: string;
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
      if (args[0] === "api" && args[1] === "user") return ok(opts.viewer ?? "junco-bot");
      if (args[0] === "api" && args[1] === "graphql") return ok(opts.parent ?? "null");
      if (args[0] === "api" && String(args[2] ?? "").includes("/comments"))
        return ok((opts.comments ?? []).map((c) => JSON.stringify(c)).join("\n"));
      if (args[0] === "api" && String(args[2] ?? "").includes("/events"))
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
    vaultRoot: NX_VAULT,
    juncoSubdir: "tickets",
    github: {
      ...cfg.github,
      repos: [{ nwo: "acme/api", path: "/home/u/code/api" }],
    },
  } as Config;
  const rawIssue = {
    number: 42,
    title: "Add rate limiting",
    body: "Body.",
    labels: [{ name: "junco" }],
  };
  const labeledEvent = `{"actor":"alice","label":"junco","created_at":"2026-07-06T00:00:00Z"}`;

  it("bridges an eligible PR issue into a PLANNING ticket + planning label", async () => {
    const f = makeFakes({ issues: [rawIssue], events: labeledEvent, permission: "write" });
    const n = await pollGithubInbox(bridgeCfg, newBridgeState(), f as never);
    expect(n).toBe(1);
    expect(f.submitted).toHaveLength(1);
    expect(f.submitted[0].idHint).toBe("gh-acme-api-42-plan");
    expect(f.submitted[0].content).toContain("kind: plan");
    expect(f.submitted[0].content).toContain("workdir:");
    // Scoped to the machine-built frontmatter block (before the planner prompt body) —
    // the embedded template further down legitimately shows a "repo:" example field.
    expect(f.submitted[0].content.split("\n\n")[0]).not.toContain("\nrepo:");
    expect(f.submitted[0].content).toContain("# Junco ticket template"); // discipline embedded
    expect(f.submitted[0].content).toContain("Add rate limiting"); // the issue
    const edit = f.calls.find((c) => c[0] === "issue" && c[1] === "edit");
    expect(edit).toContain("junco:planning");
    expect(edit).not.toContain("junco:queued");
  });

  it("ask issues keep the direct path: verbatim ask ticket + queued label", async () => {
    const askIssue = { ...rawIssue, labels: [{ name: "junco" }, { name: "junco:ask" }] };
    const f = makeFakes({ issues: [askIssue], events: labeledEvent, permission: "write" });
    const n = await pollGithubInbox(bridgeCfg, newBridgeState(), f as never);
    expect(n).toBe(1);
    expect(f.submitted[0].idHint).toBe("gh-acme-api-42");
    expect(f.submitted[0].content).toContain("kind: ask");
    const edit = f.calls.find((c) => c[0] === "issue" && c[1] === "edit");
    expect(edit).toContain("junco:queued");
  });

  it("denies without write permission: denied label, no submit", async () => {
    const f = makeFakes({ issues: [rawIssue], events: labeledEvent, permission: "read" });
    const n = await pollGithubInbox(bridgeCfg, newBridgeState(), f as never);
    expect(n).toBe(0);
    expect(f.submitted).toHaveLength(0);
    const edit = f.calls.find((c) => c[0] === "issue" && c[1] === "edit");
    expect(edit).toContain("junco:denied");
  });

  it("fail-closed: no labeled event found → no submit, no label", async () => {
    const f = makeFakes({ issues: [rawIssue], events: "", permission: "write" });
    const n = await pollGithubInbox(bridgeCfg, newBridgeState(), f as never);
    expect(n).toBe(0);
    expect(f.submitted).toHaveLength(0);
    expect(f.calls.find((c) => c[0] === "issue" && c[1] === "edit")).toBeUndefined();
  });

  it("duplicate submit still applies the queued label", async () => {
    const f = makeFakes({ issues: [rawIssue], events: labeledEvent });
    const throwingSubmit = (): string => {
      throw new Error("ticket already queued: /inbox/gh-acme-api-42-plan.md");
    };
    const n = await pollGithubInbox(bridgeCfg, newBridgeState(), {
      ghFn: f.ghFn,
      gitFn: f.gitFn,
      submitFn: throwingSubmit,
    } as never);
    expect(n).toBe(1);
    expect(f.calls.find((c) => c[1] === "edit" && c.includes("junco:planning"))).toBeDefined();
  });

  it("a non-duplicate submit failure skips the issue (no queued label)", async () => {
    const f = makeFakes({ issues: [rawIssue], events: labeledEvent });
    const throwingSubmit = (): string => {
      throw new Error("EACCES: permission denied");
    };
    const n = await pollGithubInbox(bridgeCfg, newBridgeState(), {
      ghFn: f.ghFn,
      gitFn: f.gitFn,
      submitFn: throwingSubmit,
    } as never);
    expect(n).toBe(0);
    expect(f.calls.find((c) => c[1] === "edit")).toBeUndefined();
  });

  it("origin mismatch disables the repo: no issue list call", async () => {
    const f = makeFakes({ issues: [rawIssue], origin: "https://github.com/other/thing.git" });
    const n = await pollGithubInbox(bridgeCfg, newBridgeState(), f as never);
    expect(n).toBe(0);
    expect(f.calls.find((c) => c[0] === "issue" && c[1] === "list")).toBeUndefined();
  });

  it("caches the origin verdict and ensured labels across sweeps in one state", async () => {
    const f = makeFakes({ issues: [], events: labeledEvent });
    const state = newBridgeState();
    await pollGithubInbox(bridgeCfg, state, f as never);
    await pollGithubInbox(bridgeCfg, state, f as never);
    const originProbes = f.calls.filter((c) => c[0] === "git");
    expect(originProbes).toHaveLength(1);
    const labelCreates = f.calls.filter((c) => c[0] === "label");
    expect(labelCreates).toHaveLength(8); // once per lifecycle label, first sweep only
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
    expect(f.submitted[0].content).toContain("Parent issue (background only)");
    expect(f.submitted[0].content).toContain("Uploads are slow");
  });

  it("takes the LATEST labeled event for the trigger (relabeled issues)", async () => {
    const events = [
      `{"actor":"mallory","label":"junco"}`,
      `{"actor":"someone","label":"bug"}`,
      `{"actor":"alice","label":"junco"}`,
    ].join("\n");
    const perms: string[] = [];
    const f = makeFakes({ issues: [rawIssue], events });
    const ghFn = async (c: unknown, args: string[]): Promise<CmdResult> => {
      if (args[0] === "api" && String(args[1]).includes("/permission")) {
        perms.push(String(args[1]));
      }
      return f.ghFn(c, args);
    };
    await pollGithubInbox(bridgeCfg, newBridgeState(), {
      ghFn,
      gitFn: f.gitFn,
      submitFn: f.submitFn,
    } as never);
    expect(perms).toEqual(["repos/acme/api/collaborators/alice/permission"]);
  });

  describe("approval scan", () => {
    const planComment = (body: string, over: Record<string, unknown> = {}) => ({
      author: "junco-bot",
      body,
      created_at: "2026-07-06T10:00:00Z",
      ...over,
    });
    const planBody = "# The plan\n\n## Steps\n- do it";
    const fencedComment =
      "<!-- junco:plan -->\nProposed plan\n\n```junco-ticket\n" + planBody + "\n```\n";
    const readyIssue = {
      number: 42,
      title: "Add rate limiting",
      body: "raw",
      labels: [{ name: "junco" }, { name: "junco:plan-ready" }, { name: "junco:approved" }],
    };
    const approvedAfter = `{"actor":"alice","label":"junco:approved","created_at":"2026-07-06T11:00:00Z"}`;
    const approvedBefore = `{"actor":"alice","label":"junco:approved","created_at":"2026-07-06T09:00:00Z"}`;

    it("approved plan-ready issue → execution ticket from the comment + label swap", async () => {
      const f = makeFakes({
        issues: [readyIssue],
        events: approvedAfter,
        permission: "write",
        comments: [planComment(fencedComment)],
      });
      const n = await pollGithubInbox(bridgeCfg, newBridgeState(), f as never);
      expect(n).toBe(1);
      expect(f.submitted[0].idHint).toBe("gh-acme-api-42");
      expect(f.submitted[0].content).toContain("kind: pr");
      expect(f.submitted[0].content).toContain('repo: "/home/u/code/api"');
      expect(f.submitted[0].content).toContain("# The plan");
      const edit = f.calls.find((c) => c[1] === "edit");
      expect(edit).toEqual(
        expect.arrayContaining([
          "--add-label",
          "junco:queued",
          "--remove-label",
          "junco:plan-ready",
          "--remove-label",
          "junco:approved",
        ]),
      );
    });

    it("plan-ready without approved waits (require_approval on)", async () => {
      const noApproval = {
        ...readyIssue,
        labels: [{ name: "junco" }, { name: "junco:plan-ready" }],
      };
      const f = makeFakes({ issues: [noApproval], comments: [planComment(fencedComment)] });
      expect(await pollGithubInbox(bridgeCfg, newBridgeState(), f as never)).toBe(0);
      expect(f.submitted).toHaveLength(0);
    });

    it("stale approval (predates the plan comment) is ignored", async () => {
      const f = makeFakes({
        issues: [readyIssue],
        events: approvedBefore,
        permission: "write",
        comments: [planComment(fencedComment)],
      });
      expect(await pollGithubInbox(bridgeCfg, newBridgeState(), f as never)).toBe(0);
    });

    it("approval by a non-writer is ignored", async () => {
      const f = makeFakes({
        issues: [readyIssue],
        events: approvedAfter,
        permission: "read",
        comments: [planComment(fencedComment)],
      });
      expect(await pollGithubInbox(bridgeCfg, newBridgeState(), f as never)).toBe(0);
    });

    it("forged plan comment (wrong author) is ignored", async () => {
      const f = makeFakes({
        issues: [readyIssue],
        events: approvedAfter,
        permission: "write",
        comments: [planComment(fencedComment, { author: "mallory" })],
      });
      expect(await pollGithubInbox(bridgeCfg, newBridgeState(), f as never)).toBe(0);
      expect(f.submitted).toHaveLength(0);
    });

    it("require_approval=false: plan-ready alone converts", async () => {
      const autoCfg = {
        ...bridgeCfg,
        github: { ...bridgeCfg.github, requireApproval: false },
      } as Config;
      const noApproval = {
        ...readyIssue,
        labels: [{ name: "junco" }, { name: "junco:plan-ready" }],
      };
      const f = makeFakes({ issues: [noApproval], comments: [planComment(fencedComment)] });
      expect(await pollGithubInbox(autoCfg, newBridgeState(), f as never)).toBe(1);
      expect(f.submitted[0].idHint).toBe("gh-acme-api-42");
    });

    it("the LATEST own-authored plan comment wins", async () => {
      const older = planComment("<!-- junco:plan -->\n```junco-ticket\n# Old plan\n```\n", {
        created_at: "2026-07-06T08:00:00Z",
      });
      const f = makeFakes({
        issues: [readyIssue],
        events: approvedAfter,
        permission: "write",
        comments: [older, planComment(fencedComment)],
      });
      await pollGithubInbox(bridgeCfg, newBridgeState(), f as never);
      expect(f.submitted[0].content).toContain("# The plan");
      expect(f.submitted[0].content).not.toContain("# Old plan");
    });

    it("plan comment with an unparseable created_at → no submit (postdate fails closed)", async () => {
      const f = makeFakes({
        issues: [readyIssue],
        events: approvedAfter,
        permission: "write",
        comments: [planComment(fencedComment, { created_at: "not-a-real-date" })],
      });
      expect(await pollGithubInbox(bridgeCfg, newBridgeState(), f as never)).toBe(0);
      expect(f.submitted).toHaveLength(0);
    });

    it("plan-ready with a lifecycle label already set → label cleanup only, no submit", async () => {
      const dispatched = {
        ...readyIssue,
        labels: [
          { name: "junco" },
          { name: "junco:plan-ready" },
          { name: "junco:approved" },
          { name: "junco:queued" },
        ],
      };
      const f = makeFakes({
        issues: [dispatched],
        events: approvedAfter,
        permission: "write",
        comments: [planComment(fencedComment)],
      });
      const n = await pollGithubInbox(bridgeCfg, newBridgeState(), f as never);
      expect(n).toBe(0);
      expect(f.submitted).toHaveLength(0);
      const edit = f.calls.find((c) => c[1] === "edit");
      expect(edit).toEqual(
        expect.arrayContaining([
          "--remove-label",
          "junco:plan-ready",
          "--remove-label",
          "junco:approved",
        ]),
      );
      expect(edit).not.toContain("--add-label");
    });

    it("execution ticket already in the local queue → no submit, label swap still happens", async () => {
      const root = mkdtempSync(join(tmpdir(), "junco-bridge-"));
      try {
        const processing = join(root, "tickets", "processing");
        mkdirSync(processing, { recursive: true });
        // Claim-prefixed file for the exec-ticket id gh-acme-api-42.
        writeFileSync(join(processing, "1720000000000__gh-acme-api-42.md"), "stub", "utf8");
        const localCfg = { ...bridgeCfg, vaultRoot: root, juncoSubdir: "tickets" } as Config;
        const f = makeFakes({
          issues: [readyIssue],
          events: approvedAfter,
          permission: "write",
          comments: [planComment(fencedComment)],
        });
        const n = await pollGithubInbox(localCfg, newBridgeState(), f as never);
        expect(n).toBe(1);
        expect(f.submitted).toHaveLength(0);
        const edit = f.calls.find((c) => c[1] === "edit");
        expect(edit).toEqual(
          expect.arrayContaining([
            "--add-label",
            "junco:queued",
            "--remove-label",
            "junco:plan-ready",
          ]),
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
});

describe("extractPlanBody", () => {
  const fenced = (inner: string) => "chatter\n\n```junco-ticket\n" + inner + "\n```\n\ntrailing";

  it("extracts the fenced plan body", () => {
    expect(extractPlanBody(fenced("# Title\n\n## Steps\n- do"))).toBe("# Title\n\n## Steps\n- do");
  });

  it("takes the LAST fence when several exist (newer plan supersedes)", () => {
    const text = fenced("# Old") + "\n\n" + fenced("# New");
    expect(extractPlanBody(text)).toBe("# New");
  });

  it("strips a smuggled frontmatter block", () => {
    const out = extractPlanBody(fenced("---\nrepo: /etc\ntools: [bash]\n---\n# Title\nbody"));
    expect(out).toBe("# Title\nbody");
    expect(out).not.toContain("repo:");
  });

  it("returns null when no fence or an empty fence", () => {
    expect(extractPlanBody("no fence here")).toBeNull();
    expect(extractPlanBody("```junco-ticket\n   \n```")).toBeNull();
  });

  it("keeps an inner ```bash block via a 4-backtick outer fence (no truncation)", () => {
    const plan = "# Title\n\n## Verification\n\n```bash\nnpm test\n```\n\ndone";
    const text = "chatter\n\n````junco-ticket\n" + plan + "\n````\n\ntrailing";
    expect(extractPlanBody(text)).toBe(plan);
  });

  it("still extracts a legacy 3-backtick fence with no inner fences (backward compat)", () => {
    expect(extractPlanBody("```junco-ticket\n# Legacy\n## Steps\n- go\n```")).toBe(
      "# Legacy\n## Steps\n- go",
    );
  });

  it("ignores an unterminated fence (no complete block)", () => {
    expect(extractPlanBody("````junco-ticket\n# No closer")).toBeNull();
  });
});

describe("buildPlanComment", () => {
  it("carries the marker, the fenced plan, and approval instructions", () => {
    const c = buildPlanComment("# Plan\n## Steps", {
      issue: 42,
      trigger: "junco",
      requireApproval: true,
    });
    expect(c).not.toBeNull();
    expect(c).toContain(PLAN_COMMENT_MARKER);
    // Outer fence is >= 4 backticks now (fence-length-aware).
    expect(c).toContain("````junco-ticket\n# Plan\n## Steps\n````");
    expect(c).toContain("junco:approved");
    expect(extractPlanBody(c!)).toBe("# Plan\n## Steps"); // round-trips
  });

  it("auto mode says it executes on the next sweep", () => {
    const c = buildPlanComment("# P", { issue: 1, trigger: "junco", requireApproval: false });
    expect(c).toContain("next sweep");
    expect(c).not.toContain("junco:approved");
  });

  it("round-trips a plan containing a ```bash block losslessly", () => {
    const plan = "# Plan\n\n## Verification\n\n```bash\nnpm test\n```";
    const c = buildPlanComment(plan, { issue: 7, trigger: "junco", requireApproval: true });
    expect(c).not.toBeNull();
    expect(c).toContain("````junco-ticket"); // 4 backticks outruns the inner ```
    expect(extractPlanBody(c!)).toBe(plan);
  });

  it("escalates to a 5-backtick outer fence when the plan contains a 4-backtick run", () => {
    const plan = "# Plan\n\n````\nnested fence sample\n````";
    const c = buildPlanComment(plan, { issue: 7, trigger: "junco", requireApproval: true });
    expect(c).not.toBeNull();
    expect(c).toContain("`````junco-ticket"); // 5 backticks outruns the inner 4
    expect(extractPlanBody(c!)).toBe(plan);
  });

  it("returns null when the plan cannot fit a comment", () => {
    expect(
      buildPlanComment("x".repeat(70_000), { issue: 1, trigger: "junco", requireApproval: true }),
    ).toBeNull();
  });
});
