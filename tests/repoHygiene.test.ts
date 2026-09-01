import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// Repo-level policy files (#383). None of them is code, so nothing else in
// the suite would notice if one went missing or lost the line that matters —
// these checks pin the parts a reporter or contributor is meant to act on.
const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

describe("SECURITY.md", () => {
  const doc = read("SECURITY.md");

  it("states the support window as the latest minor line, without a version number to rot", () => {
    expect(doc).toContain("## Supported versions");
    expect(doc).toMatch(/latest minor/i);
    // Lookarounds keep the loopback address (127.0.0.1) from reading as a semver.
    expect(doc).not.toMatch(/(?<![\d.])\d+\.\d+\.\d+(?![\d.])/);
  });

  it("routes reports to this repo's private vulnerability reporting, never a public issue", () => {
    expect(doc).toContain("## Reporting a vulnerability");
    expect(doc).toContain("https://github.com/ironforgesoftware/junco/security/advisories/new");
    expect(doc).toMatch(/do not open a public issue/i);
  });

  it("commits to an acknowledgement within 72 hours", () => {
    expect(doc).toMatch(/72 hours/);
  });

  it("names the four in-scope boundaries", () => {
    expect(doc).toContain("## Scope");
    expect(doc).toMatch(/execution sandbox/i);
    expect(doc).toMatch(/approval chain/i);
    expect(doc).toMatch(/bot[- ]account/i);
    expect(doc).toMatch(/health endpoint/i);
  });
});

describe(".github/PULL_REQUEST_TEMPLATE.md", () => {
  const tpl = read(".github/PULL_REQUEST_TEMPLATE.md");

  it("carries the full gate command verbatim", () => {
    expect(tpl).toContain(
      "npm run lint && npm run format:check && npm run typecheck && npm run build && npm test",
    );
  });

  it("restates the no-AI-attribution rule", () => {
    expect(tpl).toContain("Co-Authored-By");
    expect(tpl).toMatch(/Generated with/);
  });

  it("reminds about the CHANGELOG entry and the conventional title", () => {
    expect(tpl).toContain("CHANGELOG.md");
    expect(tpl).toMatch(/conventional/i);
  });
});

describe(".editorconfig", () => {
  const ec = read(".editorconfig");

  it("is the root file with the shared defaults", () => {
    expect(ec).toMatch(/^root = true$/m);
    expect(ec).toMatch(/^indent_style = space$/m);
    expect(ec).toMatch(/^indent_size = 2$/m);
    expect(ec).toMatch(/^end_of_line = lf$/m);
    expect(ec).toMatch(/^charset = utf-8$/m);
    expect(ec).toMatch(/^insert_final_newline = true$/m);
    expect(ec).toMatch(/^trim_trailing_whitespace = true$/m);
  });

  it("keeps trailing spaces in Markdown (two spaces = hard line break)", () => {
    expect(ec).toMatch(/^\[\*\.md\]\ntrim_trailing_whitespace = false$/m);
  });

  it("does not set max_line_length, which prettier would honor over printWidth", () => {
    expect(ec).not.toMatch(/^\s*max_line_length/m);
  });
});
