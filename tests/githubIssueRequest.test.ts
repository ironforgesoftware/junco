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
          opts.issueUrl === null
            ? ""
            : (opts.issueUrl ?? "https://github.com/acme/api/issues/41") + "\n",
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
    const meta = await fulfillIssueRequest(
      CFG,
      ticketOf(),
      ctx({ pushRemote: "fork" }),
      "/claim/tk-1.md",
      h.deps,
    );
    expect(meta).toBeNull();
    expect(h.ghCalls).toHaveLength(0);
  });

  it("returns null (never throws) on a non-GitHub origin, a gh failure, and an unparseable issue URL", async () => {
    const bad = harness({ originUrl: "https://gitlab.com/acme/api.git" });
    expect(
      await fulfillIssueRequest(CFG, ticketOf(), ctx(), "/claim/tk-1.md", bad.deps),
    ).toBeNull();
    expect(bad.ghCalls).toHaveLength(0);

    const down = harness({ ghThrows: true });
    expect(
      await fulfillIssueRequest(CFG, ticketOf(), ctx(), "/claim/tk-1.md", down.deps),
    ).toBeNull();

    const weird = harness({ issueUrl: null });
    expect(
      await fulfillIssueRequest(CFG, ticketOf(), ctx(), "/claim/tk-1.md", weird.deps),
    ).toBeNull();
    // No stamp on any failure path.
    expect(weird.files.get("/claim/tk-1.md")).toBe(TICKET_MD);
  });

  it("keeps the in-memory link when the frontmatter is malformed (stamp cannot round-trip)", async () => {
    const h = harness();
    // A tab inside the block makes YAML parse fail → parseTicket falls back to
    // no-frontmatter → upsert result re-parses with github: null (#108 class).
    const broken =
      "---\nid: tk-1\nrepo: /sbxroot/clone\n\tbad: indent\ngithub_request:\n  create_issue: true\n---\nBody.";
    h.files.set("/claim/tk-1.md", broken);
    const t = { ...ticketOf(), githubRequest: { createIssue: true } };
    const meta = await fulfillIssueRequest(CFG, t, ctx(), "/claim/tk-1.md", h.deps);
    expect(meta).toEqual({ nwo: "acme/api", issue: 41, kind: "pr", external: false });
    expect(h.files.get("/claim/tk-1.md")).toBe(broken); // not persisted, not corrupted
  });
});
