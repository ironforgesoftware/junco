import { describe, it, expect } from "vitest";
import {
  lifecycleLabels,
  isEligible,
  nwoFromRemoteUrl,
  issueToTicket,
  type GhIssue,
} from "../src/githubInbox.js";
import { parseTicket } from "../src/ticket.js";
import type { Config } from "../src/types.js";

// Minimal Config for conversion tests — only the fields issueToTicket reads.
const cfg = {
  github: {
    enabled: true,
    triggerLabel: "junco",
    askLabel: "junco:ask",
    pollIntervalSeconds: 60,
    repos: [],
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
  it("derives all five from the trigger", () => {
    expect(lifecycleLabels("bot")).toEqual({
      queued: "bot:queued",
      working: "bot:working",
      done: "bot:done",
      failed: "bot:failed",
      denied: "bot:denied",
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
    ];
    for (const l of lifecycle) {
      expect(isEligible(issue(["junco", l]), "junco")).toBe(false);
    }
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
