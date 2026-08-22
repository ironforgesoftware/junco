import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, join as joinPath } from "node:path";
import {
  lifecycleLabels,
  isEligible,
  nwoFromRemoteUrl,
  issueToTicket,
  pollGithubInbox,
  newBridgeState,
  extractPlanBody,
  extractPlanSetBody,
  buildPlanComment,
  PLAN_SET_FENCE,
  githubTicketId,
  PLAN_COMMENT_MARKER,
  type GhIssue,
} from "../src/githubInbox.js";
import { parseTicket } from "../src/ticket.js";
import { log } from "../src/logging.js";
import type { Config } from "../src/types.js";
import type { CmdResult } from "../src/git.js";
import { writeWatchlist, watchlistPath } from "../src/watchlist.js";
import { OUTBOX_MARKER_PREFIX } from "../src/githubOutbox.js";

// ticketInFlight (every dispatch path) calls queuePaths(cfg); point bridge
// configs at a vault dir that does not exist so readdirSync ENOENTs → "absent".
const NX_VAULT = join(tmpdir(), `junco-nx-${Math.random().toString(36).slice(2)}`);
const NX_STATE_DIR = join(tmpdir(), `junco-state-${Math.random().toString(36).slice(2)}`);

// Minimal Config for conversion tests — only the fields issueToTicket and
// buildPlanningTicket read.
const cfg = {
  github: {
    enabled: true,
    triggerLabel: "junco",
    askLabel: "junco:ask",
    pollIntervalSeconds: 60,
    repos: [],
    requireApproval: true,
    plannerModelId: null,
    externalReposRoot: "/tmp/junco-test-external",
  },
  planSets: { enabled: false, mergePollSeconds: 60, maxTasks: 10 },
} as unknown as Config;
const repo = { nwo: "acme/api", path: "/home/u/code/api" };
const issue = (labels: string[], over: Partial<GhIssue> = {}): GhIssue => ({
  number: 42,
  title: "Add rate limiting",
  body: "Sliding window on /upload.",
  labels: labels.map((name) => ({ name })),
  ...over,
});

// Real ids for the acme/api#42 fixtures — DERIVED, not hardcoded, so the #133
// raw-nwo hash disambiguator (gh-acme-api-<hash>-42[-plan]) stays in sync.
const EXEC_ID = githubTicketId("acme/api", 42);
const PLAN_ID = githubTicketId("acme/api", 42, "plan");

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
    expect(t.id).toBe(EXEC_ID);
    const parsed = parseTicket(`/in/${t.id}.md`, t.content);
    expect(parsed.hasRepo).toBe(true);
    expect(parsed.frontmatter.repo).toBe("/home/u/code/api");
    expect(parsed.frontmatter.pr_title).toBe("Add rate limiting");
    expect(parsed.github).toEqual({ nwo: "acme/api", issue: 42, kind: "pr", external: false });
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
    expect(parsed.github).toEqual({ nwo: "acme/api", issue: 42, kind: "pr", external: false });
  });

  it("handles an empty issue body (title-only ticket)", () => {
    const t = issueToTicket(issue(["junco"], { body: null }), repo, cfg, null);
    const parsed = parseTicket(`/in/${t.id}.md`, t.content);
    expect(parsed.body.trim()).toBe("# Add rate limiting");
  });

  it("disambiguates owner/repo slug collisions via a raw-nwo hash (#133)", () => {
    // `acme/api-x` and `acme-api/x` both slug to `gh-acme-api-x-<n>` — a
    // collision that cross-wires their tickets and strands the second issue.
    const a = issueToTicket(issue(["junco"]), { nwo: "acme/api-x", path: "/p" }, cfg, null);
    const b = issueToTicket(issue(["junco"]), { nwo: "acme-api/x", path: "/p" }, cfg, null);
    expect(a.id).not.toBe(b.id);
    // Still human-recognizable: the readable slug prefix is preserved.
    expect(a.id.startsWith("gh-acme-api-x-")).toBe(true);
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
    lastEditedAt?: string; // issue body last-edit time (GraphQL); "null" = never edited
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
      if (args[0] === "issue" && args[1] === "comment") return ok("");
      if (args[0] === "api" && args[1] === "user") return ok(opts.viewer ?? "junco-bot");
      if (args[0] === "api" && args[1] === "graphql") {
        // Two GraphQL queries share this argv shape — route by field: the
        // body-vouching lookup (#130) vs. the sub-issue parent lookup.
        const q = args.find((a) => a.startsWith("query=")) ?? "";
        if (q.includes("lastEditedAt")) return ok(opts.lastEditedAt ?? "null");
        return ok(opts.parent ?? "null");
      }
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
    dataDir: NX_STATE_DIR,
    queueRoot: join(NX_VAULT, "tickets"),
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
    expect(f.submitted[0].idHint).toBe(PLAN_ID);
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
    expect(f.submitted[0].idHint).toBe(EXEC_ID);
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

  describe("issue-body vouching (#130)", () => {
    // labeledEvent vouches the body at 2026-07-06T00:00:00Z.
    it("refuses to dispatch when the body was edited AFTER the vouching label", async () => {
      const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
      try {
        const f = makeFakes({
          issues: [rawIssue],
          events: labeledEvent,
          permission: "write",
          lastEditedAt: "2026-07-06T01:00:00Z", // edited an hour AFTER labeling
        });
        const n = await pollGithubInbox(bridgeCfg, newBridgeState(), f as never);
        expect(n).toBe(0);
        expect(f.submitted).toHaveLength(0);
        expect(f.calls.find((c) => c[0] === "issue" && c[1] === "edit")).toBeUndefined();
        expect(warnSpy.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(/edited after/);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("dispatches when the body was last edited BEFORE the vouching label", async () => {
      const f = makeFakes({
        issues: [rawIssue],
        events: labeledEvent,
        permission: "write",
        lastEditedAt: "2026-07-05T00:00:00Z", // edited BEFORE labeling → still vouched
      });
      const n = await pollGithubInbox(bridgeCfg, newBridgeState(), f as never);
      expect(n).toBe(1);
      expect(f.submitted).toHaveLength(1);
    });

    it("dispatches a never-edited body (lastEditedAt null)", async () => {
      const f = makeFakes({
        issues: [rawIssue],
        events: labeledEvent,
        permission: "write",
        lastEditedAt: "null",
      });
      expect(await pollGithubInbox(bridgeCfg, newBridgeState(), f as never)).toBe(1);
    });

    it("fails closed when lastEditedAt is unparseable (no submit)", async () => {
      const f = makeFakes({
        issues: [rawIssue],
        events: labeledEvent,
        permission: "write",
        lastEditedAt: "not-a-real-date",
      });
      expect(await pollGithubInbox(bridgeCfg, newBridgeState(), f as never)).toBe(0);
      expect(f.submitted).toHaveLength(0);
    });

    it("guards the ask path too: an edited ask-issue body does not auto-run", async () => {
      const askIssue = { ...rawIssue, labels: [{ name: "junco" }, { name: "junco:ask" }] };
      const f = makeFakes({
        issues: [askIssue],
        events: labeledEvent,
        permission: "write",
        lastEditedAt: "2026-07-06T01:00:00Z",
      });
      expect(await pollGithubInbox(bridgeCfg, newBridgeState(), f as never)).toBe(0);
      expect(f.submitted).toHaveLength(0);
    });
  });

  describe("junco-ticket fence door (2026-08-21)", () => {
    const fenceBody = "# Do the thing\n\n## Tasks\n\n- do it\n";
    const fencedBody = "Parked ticket.\n\n```junco-ticket\n" + fenceBody + "```\n";

    it("queues a junco-ticket fence from the issue body verbatim, skipping the planner", async () => {
      const f = makeFakes({
        issues: [{ ...rawIssue, body: fencedBody }],
        events: labeledEvent,
        permission: "write",
        lastEditedAt: "null",
      });
      const n = await pollGithubInbox(bridgeCfg, newBridgeState(), f as never);
      expect(n).toBe(1);
      expect(f.submitted).toHaveLength(1);
      const t = f.submitted[0];
      // Execution ticket, not a planning ticket: body is the fence content verbatim.
      expect(t.content).toContain("# Do the thing");
      expect(t.content).not.toContain("# Junco ticket template"); // planner-prompt marker absent
      expect(t.content).toContain("kind: pr");
      expect(t.idHint).toBe(EXEC_ID);
      // State label is queued, not planning.
      const edit = f.calls.find((c) => c[0] === "issue" && c[1] === "edit");
      expect(edit).toContain("junco:queued");
      expect(edit).not.toContain("junco:planning");
    });

    it("ask label wins over a junco-ticket fence (prose ask ticket, fence not extracted)", async () => {
      const body = "Please explain X.\n\n```junco-ticket\n# Sneaky\n```\n";
      const askIssue = { ...rawIssue, body, labels: [{ name: "junco" }, { name: "junco:ask" }] };
      const f = makeFakes({ issues: [askIssue], events: labeledEvent, permission: "write" });
      const n = await pollGithubInbox(bridgeCfg, newBridgeState(), f as never);
      expect(n).toBe(1);
      expect(f.submitted).toHaveLength(1);
      expect(f.submitted[0].idHint).toBe(EXEC_ID);
      expect(f.submitted[0].content).toContain("Please explain X.");
      expect(f.submitted[0].content).toContain("workdir:"); // ask rails, not repo:
      expect(f.submitted[0].content).toContain("kind: ask");
      const edit = f.calls.find((c) => c[0] === "issue" && c[1] === "edit");
      expect(edit).toContain("junco:queued");
    });

    it("no fence still routes to the planner (regression)", async () => {
      const f = makeFakes({ issues: [rawIssue], events: labeledEvent, permission: "write" });
      const n = await pollGithubInbox(bridgeCfg, newBridgeState(), f as never);
      expect(n).toBe(1);
      expect(f.submitted).toHaveLength(1);
      expect(f.submitted[0].idHint).toBe(PLAN_ID);
      expect(f.submitted[0].content).toContain("kind: plan");
      const edit = f.calls.find((c) => c[0] === "issue" && c[1] === "edit");
      expect(edit).toContain("junco:planning");
      expect(edit).not.toContain("junco:queued");
    });

    it("refuses a fence body edited after the trigger label (re-vouch guard covers the fence door)", async () => {
      const f = makeFakes({
        issues: [{ ...rawIssue, body: fencedBody }],
        events: labeledEvent,
        permission: "write",
        lastEditedAt: "2026-07-06T01:00:00Z", // edited an hour AFTER labeling
      });
      const n = await pollGithubInbox(bridgeCfg, newBridgeState(), f as never);
      expect(n).toBe(0);
      expect(f.submitted).toHaveLength(0);
      expect(f.calls.find((c) => c[0] === "issue" && c[1] === "edit")).toBeUndefined();
    });
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
      throw new Error(`ticket already queued: /inbox/${PLAN_ID}.md`);
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

  it("origin cache is keyed by path: a corrected watchlist path re-validates", async () => {
    // Watchlist-driven (config repos empty) so the path can hot-reload between
    // sweeps; the origin verdict must not stick to a stale path for the nwo.
    const dir = mkdtempSync(join(tmpdir(), "junco-originkey-"));
    const wlCfg = {
      ...bridgeCfg,
      dataDir: dir,
      github: { ...bridgeCfg.github, repos: [] },
    } as Config;
    const wlFile = watchlistPath(wlCfg);
    const calls: string[][] = [];
    const ok = (stdout: string): CmdResult => ({ code: 0, stdout, stderr: "" });
    const gitFn = async (_c: unknown, args: string[]): Promise<CmdResult> => {
      calls.push(["git", ...args]);
      const path = args[1]; // -C <path> remote get-url origin
      return ok(
        path === "/good" ? "https://github.com/acme/api.git" : "https://github.com/other/thing.git",
      );
    };
    const ghFn = async (_c: unknown, args: string[]): Promise<CmdResult> => {
      calls.push(args);
      if (args[0] === "issue" && args[1] === "list") return ok(JSON.stringify([]));
      if (args[0] === "label") return ok("");
      throw new Error(`unhandled gh argv: ${args.join(" ")}`);
    };
    const submitFn = (): string => "/inbox/x.md";
    try {
      const state = newBridgeState();
      writeWatchlist(wlFile, [{ nwo: "acme/api", path: "/bad" }]);
      await pollGithubInbox(wlCfg, state, { ghFn, gitFn, submitFn } as never);
      expect(calls.find((c) => c[0] === "issue" && c[1] === "list")).toBeUndefined(); // disabled

      writeWatchlist(wlFile, [{ nwo: "acme/api", path: "/good" }]);
      await pollGithubInbox(wlCfg, state, { ghFn, gitFn, submitFn } as never);
      expect(calls.find((c) => c[0] === "issue" && c[1] === "list")).toBeDefined(); // re-validated
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a repo-level list failure is contained (returns 0, no throw)", async () => {
    const f = makeFakes({ failList: true });
    await expect(pollGithubInbox(bridgeCfg, newBridgeState(), f as never)).resolves.toBe(0);
  });

  describe("outbox flush", () => {
    it("sweep flushes the outbox before listing issues", async () => {
      const order: string[] = [];
      const f = makeFakes({ issues: [] });
      const ghFn = async (c: unknown, args: string[]) => {
        if (args[0] === "issue" && args[1] === "list") order.push("list");
        return f.ghFn(c, args);
      };
      const flushFn = async () => {
        order.push("flush");
        return { sent: 0, dead: 0, remaining: 0, offline: false };
      };
      await pollGithubInbox(bridgeCfg, newBridgeState(), {
        ghFn,
        gitFn: f.gitFn,
        submitFn: f.submitFn,
        flushFn,
      } as never);
      expect(order).toEqual(["flush", "list"]);
    });

    it("sweep continues quietly when flush reports offline", async () => {
      const f = makeFakes({ failList: true });
      const flushFn = async () => ({ sent: 0, dead: 0, remaining: 4, offline: true });
      await expect(
        pollGithubInbox(bridgeCfg, newBridgeState(), { ...f, flushFn } as never),
      ).resolves.toBe(0);
    });

    it("a flushFn that throws is contained; the sweep still runs", async () => {
      const f = makeFakes({ issues: [rawIssue], events: labeledEvent, permission: "write" });
      const flushFn = async () => {
        throw new Error("disk full");
      };
      const n = await pollGithubInbox(bridgeCfg, newBridgeState(), {
        ghFn: f.ghFn,
        gitFn: f.gitFn,
        submitFn: f.submitFn,
        flushFn,
      } as never);
      expect(n).toBe(1); // the rest of the sweep proceeded unaffected
    });

    it("invokes onFlush with the flush result", async () => {
      const f = makeFakes({ issues: [] });
      const received: unknown[] = [];
      const flushFn = async () => ({ sent: 1, dead: 0, remaining: 0, offline: false });
      await pollGithubInbox(bridgeCfg, newBridgeState(), {
        ghFn: f.ghFn,
        gitFn: f.gitFn,
        submitFn: f.submitFn,
        flushFn,
        onFlush: (fr: unknown) => received.push(fr),
      } as never);
      expect(received).toEqual([{ sent: 1, dead: 0, remaining: 0, offline: false }]);
    });
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
    // updated_at defaults to created_at — GitHub returns both on every comment
    // (equal until the comment is edited).
    const planComment = (body: string, over: Record<string, unknown> = {}) => ({
      author: "junco-bot",
      body,
      created_at: "2026-07-06T10:00:00Z",
      updated_at: "2026-07-06T10:00:00Z",
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
      expect(f.submitted[0].idHint).toBe(EXEC_ID);
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

    it("plan comment EDITED after approval → approval is stale: no dispatch, warn logged", async () => {
      const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
      try {
        const f = makeFakes({
          issues: [readyIssue],
          events: approvedAfter, // approved 11:00 …
          permission: "write",
          comments: [planComment(fencedComment, { updated_at: "2026-07-06T12:00:00Z" })], // … edited 12:00
        });
        expect(await pollGithubInbox(bridgeCfg, newBridgeState(), f as never)).toBe(0);
        expect(f.submitted).toHaveLength(0);
        expect(f.calls.find((c) => c[1] === "edit")).toBeUndefined(); // labels untouched
        expect(warnSpy.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(/approval predates/);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("plan comment edited BEFORE approval still dispatches (edit-then-approve flow)", async () => {
      const f = makeFakes({
        issues: [readyIssue],
        events: approvedAfter, // approved 11:00, after the 10:30 edit
        permission: "write",
        comments: [planComment(fencedComment, { updated_at: "2026-07-06T10:30:00Z" })],
      });
      expect(await pollGithubInbox(bridgeCfg, newBridgeState(), f as never)).toBe(1);
      expect(f.submitted).toHaveLength(1);
      expect(f.submitted[0].idHint).toBe(EXEC_ID);
    });

    it("plan comment with a missing or unparseable updated_at → no submit (fails closed)", async () => {
      for (const updated_at of ["not-a-real-date", undefined]) {
        const f = makeFakes({
          issues: [readyIssue],
          events: approvedAfter,
          permission: "write",
          comments: [planComment(fencedComment, { updated_at })],
        });
        expect(await pollGithubInbox(bridgeCfg, newBridgeState(), f as never)).toBe(0);
        expect(f.submitted).toHaveLength(0);
      }
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
      expect(f.submitted[0].idHint).toBe(EXEC_ID);
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

    it("a FINALIZED prior execution in done/ does not block a re-cycled plan's submit", async () => {
      // Re-cycle gesture: remove junco:failed → fresh plan → fresh approval.
      // The old finalized ticket sits in done/ (or failed/); the new approval
      // MUST still submit — only inbox/processing indicate an in-flight ticket.
      const root = mkdtempSync(join(tmpdir(), "junco-bridge-"));
      try {
        const done = join(root, "tickets", "done");
        mkdirSync(done, { recursive: true });
        writeFileSync(join(done, `1710000000000__${EXEC_ID}.md`), "old run", "utf8");
        const localCfg = { ...bridgeCfg, queueRoot: join(root, "tickets") } as Config;
        const f = makeFakes({
          issues: [readyIssue],
          events: approvedAfter,
          permission: "write",
          comments: [planComment(fencedComment)],
        });
        const n = await pollGithubInbox(localCfg, newBridgeState(), f as never);
        expect(n).toBe(1);
        expect(f.submitted).toHaveLength(1); // the fresh plan actually runs
        expect(f.submitted[0].idHint).toBe(EXEC_ID);
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

    it("execution ticket already in the local queue → no submit, label swap still happens", async () => {
      const root = mkdtempSync(join(tmpdir(), "junco-bridge-"));
      try {
        const processing = join(root, "tickets", "processing");
        mkdirSync(processing, { recursive: true });
        // Claim-prefixed file for the exec-ticket id (gh-acme-api-<hash>-42).
        writeFileSync(join(processing, `1720000000000__${EXEC_ID}.md`), "stub", "utf8");
        const localCfg = { ...bridgeCfg, queueRoot: join(root, "tickets") } as Config;
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

    describe("plan-set dispatch (spec 2026-08-20 layer 2)", () => {
      // The comment carries BOTH fences — a junco-plan set AND a junco-ticket
      // single plan — so the same fixture proves precedence (enabled: true
      // dispatches the set and ignores junco-ticket) and byte-identical
      // fallback (enabled: false ignores junco-plan and runs the pre-existing
      // junco-ticket path unchanged).
      const FENCE_SET = `version: 1
tasks:
  - {id: a, title: T A, depends_on: [], description: Build A., acceptance: [works]}
  - {id: b, title: T B, depends_on: [a], description: Build B., acceptance: [works]}
`;
      const mixedFenceComment =
        "<!-- junco:plan -->\nProposed plan\n\n```junco-ticket\n" +
        planBody +
        "\n```\n\n```junco-plan\n" +
        FENCE_SET +
        "```\n";

      it("enabled: true → junco-plan fence dispatches two child tickets + queued label swap", async () => {
        const root = mkdtempSync(join(tmpdir(), "junco-bridge-"));
        try {
          const localCfg = {
            ...bridgeCfg,
            dataDir: join(root, "data"),
            queueRoot: join(root, "tickets"),
            planSets: { enabled: true, mergePollSeconds: 60, maxTasks: 10 },
          } as Config;
          const f = makeFakes({
            issues: [readyIssue],
            events: approvedAfter,
            permission: "write",
            comments: [planComment(mixedFenceComment)],
          });
          const n = await pollGithubInbox(localCfg, newBridgeState(), f as never);
          expect(n).toBe(1);
          // dispatchPlanSet fans out via the real submitTicket, not the
          // injected submitFn — the single-ticket path never runs.
          expect(f.submitted).toHaveLength(0);
          expect(existsSync(join(root, "tickets", "inbox", `${EXEC_ID}-a.md`))).toBe(true);
          expect(existsSync(join(root, "tickets", "inbox", `${EXEC_ID}-b.md`))).toBe(true);
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
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      });

      it("enabled: false → junco-plan fence ignored; junco-ticket path runs (no set tickets)", async () => {
        const root = mkdtempSync(join(tmpdir(), "junco-bridge-"));
        try {
          const localCfg = {
            ...bridgeCfg,
            dataDir: join(root, "data"),
            queueRoot: join(root, "tickets"),
            planSets: { enabled: false, mergePollSeconds: 60, maxTasks: 10 },
          } as Config;
          const f = makeFakes({
            issues: [readyIssue],
            events: approvedAfter,
            permission: "write",
            comments: [planComment(mixedFenceComment)],
          });
          const n = await pollGithubInbox(localCfg, newBridgeState(), f as never);
          expect(n).toBe(1);
          expect(f.submitted).toHaveLength(1);
          expect(f.submitted[0].idHint).toBe(EXEC_ID);
          expect(f.submitted[0].content).toContain("# The plan");
          expect(existsSync(join(root, "tickets", "inbox", `${EXEC_ID}-a.md`))).toBe(false);
          expect(existsSync(join(root, "tickets", "inbox", `${EXEC_ID}-b.md`))).toBe(false);
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
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      });

      it("compile failure: junco:failed label swap FIRST, then a marked failure comment; nothing dispatched", async () => {
        const root = mkdtempSync(join(tmpdir(), "junco-bridge-"));
        try {
          const localCfg = {
            ...bridgeCfg,
            dataDir: join(root, "data"),
            queueRoot: join(root, "tickets"),
            planSets: { enabled: true, mergePollSeconds: 60, maxTasks: 10 },
          } as Config;
          // Duplicate task id "a" — a compile error caught by parsePlanSet.
          const badFence = `version: 1
tasks:
  - {id: a, title: T A, depends_on: [], description: Build A., acceptance: [works]}
  - {id: a, title: T A2, depends_on: [], description: Build A again., acceptance: [works]}
`;
          const badFenceComment =
            "<!-- junco:plan -->\nProposed plan\n\n```junco-plan\n" + badFence + "```\n";
          const f = makeFakes({
            issues: [readyIssue],
            events: approvedAfter,
            permission: "write",
            comments: [planComment(badFenceComment)],
          });
          let commentBody: string | null = null;
          const ghFn = async (c: unknown, args: string[]): Promise<CmdResult> => {
            if (args[0] === "issue" && args[1] === "comment") {
              const idx = args.indexOf("--body-file");
              commentBody = readFileSync(args[idx + 1], "utf8");
            }
            return f.ghFn(c, args);
          };
          const n = await pollGithubInbox(localCfg, newBridgeState(), {
            ghFn,
            gitFn: f.gitFn,
            submitFn: f.submitFn,
          } as never);
          expect(n).toBe(0);
          // Nothing dispatches on a compile error — the queue root is never
          // even touched (materializePlanSet/submitPlanSet never ran).
          expect(existsSync(join(root, "tickets", "inbox"))).toBe(false);

          const editIdx = f.calls.findIndex((c) => c[0] === "issue" && c[1] === "edit");
          const commentIdx = f.calls.findIndex((c) => c[0] === "issue" && c[1] === "comment");
          expect(editIdx).toBeGreaterThanOrEqual(0);
          expect(commentIdx).toBeGreaterThan(editIdx); // labels BEFORE the comment (bounds re-entry)

          const edit = f.calls[editIdx];
          expect(edit).toEqual(
            expect.arrayContaining([
              "--add-label",
              "junco:failed",
              "--remove-label",
              "junco:plan-ready",
              "--remove-label",
              "junco:approved",
            ]),
          );

          expect(commentBody).toContain("duplicate task id");
          // Outbox idempotency marker embedded in the posted body — a lost-ack
          // replay dedups against this instead of double-posting (#132).
          expect(commentBody).toContain(OUTBOX_MARKER_PREFIX);
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      });
    });
  });

  describe("ask/planning duplicate guard", () => {
    // Scenario (issue #38): the first sweep submitted the ticket but the
    // label add failed (rate limit, 502 — swallowed by the per-issue catch),
    // so the issue kept its trigger label with no lifecycle label. The worker
    // then CLAIMED the ticket into processing/ — the inbox-filename collision
    // no longer fires. The next sweep must NOT resubmit; it must only
    // re-attempt the (idempotent) label marking, like the execution path.
    it("planning ticket already claimed into processing/ → no resubmit, planning label re-marked", async () => {
      const root = mkdtempSync(join(tmpdir(), "junco-bridge-"));
      try {
        const processing = join(root, "tickets", "processing");
        mkdirSync(processing, { recursive: true });
        // Claim-prefixed file for the planning-ticket id (gh-acme-api-<hash>-42-plan).
        writeFileSync(join(processing, `1720000000000__${PLAN_ID}.md`), "stub", "utf8");
        const localCfg = { ...bridgeCfg, queueRoot: join(root, "tickets") } as Config;
        const f = makeFakes({ issues: [rawIssue], events: labeledEvent, permission: "write" });
        const n = await pollGithubInbox(localCfg, newBridgeState(), f as never);
        expect(n).toBe(1);
        expect(f.submitted).toHaveLength(0); // no duplicate planning run
        const edit = f.calls.find((c) => c[1] === "edit");
        expect(edit).toEqual(expect.arrayContaining(["--add-label", "junco:planning"]));
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("ask ticket already claimed into processing/ → no resubmit, queued label re-marked", async () => {
      const root = mkdtempSync(join(tmpdir(), "junco-bridge-"));
      try {
        const processing = join(root, "tickets", "processing");
        mkdirSync(processing, { recursive: true });
        // Claim-prefixed file for the ask-ticket id (gh-acme-api-<hash>-42).
        writeFileSync(join(processing, `1720000000000__${EXEC_ID}.md`), "stub", "utf8");
        const localCfg = { ...bridgeCfg, queueRoot: join(root, "tickets") } as Config;
        const askIssue = { ...rawIssue, labels: [{ name: "junco" }, { name: "junco:ask" }] };
        const f = makeFakes({ issues: [askIssue], events: labeledEvent, permission: "write" });
        const n = await pollGithubInbox(localCfg, newBridgeState(), f as never);
        expect(n).toBe(1);
        expect(f.submitted).toHaveLength(0); // no duplicate answer
        const edit = f.calls.find((c) => c[1] === "edit");
        expect(edit).toEqual(expect.arrayContaining(["--add-label", "junco:queued"]));
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("planning ticket still sitting in inbox/ → no resubmit, planning label re-marked", async () => {
      const root = mkdtempSync(join(tmpdir(), "junco-bridge-"));
      try {
        const inbox = join(root, "tickets", "inbox");
        mkdirSync(inbox, { recursive: true });
        writeFileSync(join(inbox, `${PLAN_ID}.md`), "stub", "utf8");
        const localCfg = { ...bridgeCfg, queueRoot: join(root, "tickets") } as Config;
        const f = makeFakes({ issues: [rawIssue], events: labeledEvent, permission: "write" });
        const n = await pollGithubInbox(localCfg, newBridgeState(), f as never);
        expect(n).toBe(1);
        expect(f.submitted).toHaveLength(0);
        const edit = f.calls.find((c) => c[1] === "edit");
        expect(edit).toEqual(expect.arrayContaining(["--add-label", "junco:planning"]));
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe("watchlist hot-reload", () => {
    it("a repo added to the watchlist between sweeps is swept without restart", async () => {
      const stateDir = mkdtempSync(joinPath(tmpdir(), "junco-wl-hot-"));
      const cfg = {
        ...bridgeCfg,
        dataDir: stateDir,
        github: { ...bridgeCfg.github, repos: [] }, // nothing in config
      } as Config;
      const f = makeFakes({ issues: [] });
      const state = newBridgeState();

      await pollGithubInbox(cfg, state, f as never);
      expect(f.calls.find((c) => c[0] === "issue" && c[1] === "list")).toBeUndefined();

      writeWatchlist(watchlistPath(cfg), [{ nwo: "acme/api", path: "/home/u/code/api" }]);
      await pollGithubInbox(cfg, state, f as never);
      const list = f.calls.find((c) => c[0] === "issue" && c[1] === "list");
      expect(list).toBeDefined();
      expect(list).toContain("acme/api");
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

  it("normalizes CRLF line endings from a web-UI comment edit — no \\r leaks (#134)", () => {
    const plan = "# Title\r\n\r\n## Steps\r\n- do it";
    const text = "chatter\r\n\r\n```junco-ticket\r\n" + plan + "\r\n```\r\n\r\ntrailing";
    const out = extractPlanBody(text);
    expect(out).toBe("# Title\n\n## Steps\n- do it");
    expect(out).not.toContain("\r");
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

describe("junco-plan fence (spec 2026-08-20 layer 2)", () => {
  it("extractPlanSetBody pulls the last junco-plan fence; junco-ticket fences are ignored", () => {
    const text =
      "intro\n```junco-ticket\nsingle\n```\n\n````junco-plan\nversion: 1\ntasks: []\n````\ntail";
    expect(extractPlanSetBody(text)).toBe("version: 1\ntasks: []");
    expect(extractPlanBody(text)).toBe("single");
  });

  it("extractPlanSetBody returns null when no complete junco-plan fence exists", () => {
    expect(extractPlanSetBody("```junco-plan\nunclosed")).toBeNull();
    expect(extractPlanSetBody("no fences at all")).toBeNull();
  });

  it("buildPlanComment renders with the requested fence tag and stays re-extractable", () => {
    const c = buildPlanComment("version: 1\ntasks: []", {
      issue: 7,
      trigger: "junco",
      requireApproval: true,
      fenceTag: PLAN_SET_FENCE,
    });
    expect(c).not.toBeNull();
    expect(extractPlanSetBody(c as string)).toBe("version: 1\ntasks: []");
  });
});

describe("parseRepoInput", () => {
  it.each([
    ["acme/api", "acme/api"],
    ["https://github.com/alxedelweiss/hawaiian-coral", "alxedelweiss/hawaiian-coral"],
    ["https://github.com/acme/api.git", "acme/api"],
    ["git@github.com:acme/api.git", "acme/api"],
    ["  acme/api  ", "acme/api"],
  ])("%s -> %s", async (input, expected) => {
    const { parseRepoInput } = await import("../src/githubInbox.js");
    expect(parseRepoInput(input)).toBe(expected);
  });

  it("rejects garbage and non-github urls", async () => {
    const { parseRepoInput } = await import("../src/githubInbox.js");
    expect(parseRepoInput("not a repo")).toBeNull();
    expect(parseRepoInput("https://gitlab.com/a/b")).toBeNull();
    expect(parseRepoInput("")).toBeNull();
  });
});
