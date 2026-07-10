import { describe, it, expect } from "vitest";
import { parseTicket } from "../src/ticket.js";

const QA = `---\nid: q1\npriority: high\ntimeout_minutes: 5\n---\n# Title\nHello body\n`;
const NOFM = `# No frontmatter\njust body\n`;
const PR = `---\nid: p1\nrepo: /tmp/repo\n---\n# x\n`;

describe("parseTicket", () => {
  it("parses frontmatter and body for a Q&A ticket", () => {
    const t = parseTicket("/in/q1.md", QA);
    expect(t.id).toBe("q1");
    expect(t.priority).toBe("high");
    expect(t.timeoutSeconds).toBe(300);
    expect(t.body.trim()).toBe("# Title\nHello body");
    expect(t.hasRepo).toBe(false);
  });

  it("defaults id from filename, priority normal, timeout from arg", () => {
    const t = parseTicket("/in/note.md", NOFM, 30);
    expect(t.id).toBe("note");
    expect(t.priority).toBe("normal");
    expect(t.timeoutSeconds).toBe(1800);
    expect(t.hasRepo).toBe(false);
  });

  it("flags hasRepo when repo frontmatter present", () => {
    expect(parseTicket("/in/p1.md", PR).hasRepo).toBe(true);
  });

  it("does not throw on malformed YAML frontmatter", () => {
    const t = parseTicket("/in/bad.md", "---\n: invalid: yaml: [\n---\nbody");
    expect(t.id).toBe("bad");
    expect(t.body).toBe("body");
    expect(t.priority).toBe("normal");
    expect(t.hasRepo).toBe(false);
  });

  it("falls back to the default timeout for non-positive timeout_minutes", () => {
    const t = parseTicket("/in/z.md", "---\nid: z\ntimeout_minutes: 0\n---\nx", 30);
    expect(t.timeoutSeconds).toBe(1800);
  });

  it("accepts uppercase priority (lowercased, Python parity)", () => {
    const t = parseTicket("/in/u.md", "---\nid: u\npriority: HIGH\n---\nx");
    expect(t.priority).toBe("high");
  });

  it("parses not_before, retry_count and tools", () => {
    const t = parseTicket(
      "/q/a.md",
      `---\nid: x\nnot_before: "2099-01-01T00:00:00Z"\nretry_count: 2\ntools: [read, bash]\n---\nbody`,
    );
    expect(t.notBefore).toBe("2099-01-01T00:00:00Z");
    expect(t.retryCount).toBe(2);
    expect(t.tools).toEqual(["read", "bash"]);
  });

  it("defaults: notBefore null, retryCount 0, tools null", () => {
    const t = parseTicket("/q/a.md", "---\nid: x\n---\nbody");
    expect(t.notBefore).toBeNull();
    expect(t.retryCount).toBe(0);
    expect(t.tools).toBeNull();
  });

  it("guards malformed retry/tools values (negative count, non-string tools)", () => {
    const t = parseTicket(
      "/q/a.md",
      "---\nid: x\nretry_count: -3\ntools: [read, 7, '']\n---\nbody",
    );
    expect(t.retryCount).toBe(0);
    expect(t.tools).toEqual(["read"]);
  });

  it("parses a github provenance block and workdir", () => {
    const t = parseTicket(
      "/q/a.md",
      `---\nid: gh-acme-api-42\nworkdir: /tmp/clone\ngithub:\n  nwo: acme/api\n  issue: 42\n  kind: ask\n---\nbody`,
    );
    expect(t.github).toEqual({ nwo: "acme/api", issue: 42, kind: "ask", external: false });
    expect(t.workdir).toBe("/tmp/clone");
  });

  it("defaults github/workdir to null and rejects malformed blocks", () => {
    expect(parseTicket("/q/a.md", "---\nid: x\n---\nbody").github).toBeNull();
    expect(parseTicket("/q/a.md", "---\nid: x\n---\nbody").workdir).toBeNull();
    const bad = parseTicket(
      "/q/a.md",
      `---\nid: x\nworkdir: ""\ngithub:\n  nwo: acme/api\n  issue: -1\n  kind: pr\n---\nbody`,
    );
    expect(bad.github).toBeNull(); // negative issue number
    expect(bad.workdir).toBeNull(); // empty string
    expect(
      parseTicket("/q/a.md", `---\ngithub:\n  nwo: acme/api\n  issue: 7\n  kind: nope\n---\nb`)
        .github,
    ).toBeNull(); // bad kind
  });

  it("accepts kind: plan in the github block", () => {
    const t = parseTicket(
      "/q/a.md",
      `---\nid: gh-a-b-1-plan\nworkdir: /tmp/c\ngithub:\n  nwo: a/b\n  issue: 1\n  kind: plan\n---\nbody`,
    );
    expect(t.github?.kind).toBe("plan");
  });

  it("parses github.external true and defaults it to false", () => {
    const withExt = parseTicket(
      "t.md",
      `---\nid: x\nrepo: /r\ngithub:\n  nwo: "o/r"\n  issue: 7\n  kind: pr\n  external: true\n---\nbody`,
    );
    expect(withExt.github).toEqual({ nwo: "o/r", issue: 7, kind: "pr", external: true });

    const without = parseTicket(
      "t.md",
      `---\nid: x\nrepo: /r\ngithub:\n  nwo: "o/r"\n  issue: 7\n  kind: pr\n---\nbody`,
    );
    expect(without.github).toEqual({ nwo: "o/r", issue: 7, kind: "pr", external: false });
  });

  it("parses assess: {} with autoPlan defaulting to false", () => {
    const t = parseTicket("/q/a.md", `---\nid: x\nassess: {}\n---\nbody`);
    expect(t.assess).toEqual({ autoPlan: false });
  });

  it("parses assess with auto_plan: true", () => {
    const t = parseTicket("/q/a.md", `---\nid: x\nassess:\n  auto_plan: true\n---\nbody`);
    expect(t.assess).toEqual({ autoPlan: true });
  });

  it("defaults assess to null when bare assess: (YAML null)", () => {
    const t = parseTicket("/q/a.md", `---\nid: x\nassess:\n---\nbody`);
    expect(t.assess).toBeNull();
  });

  it("rejects assess as scalar or array (only object counts)", () => {
    expect(parseTicket("/q/a.md", `---\nid: x\nassess: "yes"\n---\nbody`).assess).toBeNull();
    expect(parseTicket("/q/a.md", `---\nid: x\nassess: [1]\n---\nbody`).assess).toBeNull();
  });

  it("requires auto_plan to be strictly boolean (string 'true' → false)", () => {
    const t = parseTicket("/q/a.md", `---\nid: x\nassess:\n  auto_plan: "true"\n---\nbody`);
    expect(t.assess).toEqual({ autoPlan: false });
  });

  it("parses ticket with both assess and repo", () => {
    const t = parseTicket("/q/a.md", `---\nid: x\nrepo: /some/path\nassess: {}\n---\nbody`);
    expect(t.assess).toEqual({ autoPlan: false });
    expect(t.hasRepo).toBe(true);
  });

  it("defaults assess to null when absent", () => {
    const t = parseTicket("/q/a.md", "---\nid: x\n---\nbody");
    expect(t.assess).toBeNull();
  });

  it("parses analyze: { issue, title } round-trip", () => {
    const t = parseTicket(
      "/q/a.md",
      `---\nid: x\nanalyze:\n  issue: 7\n  title: "Bug in x"\n---\nbody`,
    );
    expect(t.analyze).toEqual({ issue: 7, title: "Bug in x" });
  });

  it("defaults analyze to null when absent", () => {
    const t = parseTicket("/q/a.md", "---\nid: x\n---\nbody");
    expect(t.analyze).toBeNull();
  });

  it("defaults analyze to null when malformed (non-numeric issue)", () => {
    const t = parseTicket(
      "/q/a.md",
      `---\nid: x\nanalyze:\n  issue: "seven"\n  title: "Bug in x"\n---\nbody`,
    );
    expect(t.analyze).toBeNull();
  });

  it("rejects analyze as scalar or array (only object counts)", () => {
    expect(parseTicket("/q/a.md", `---\nid: x\nanalyze: "yes"\n---\nbody`).analyze).toBeNull();
    expect(parseTicket("/q/a.md", `---\nid: x\nanalyze: [1]\n---\nbody`).analyze).toBeNull();
  });

  it("defaults analyze.title to empty string when omitted", () => {
    const t = parseTicket("/q/a.md", `---\nid: x\nanalyze:\n  issue: 3\n---\nbody`);
    expect(t.analyze).toEqual({ issue: 3, title: "" });
  });
});
