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
});
