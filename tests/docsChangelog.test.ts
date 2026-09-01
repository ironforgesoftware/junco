import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// CHANGELOG.md declares Keep a Changelog 1.1.0 conformance, whose version
// headings are reference-style links: `## [0.12.0]` needs a matching
// `[0.12.0]: <compare url>` definition or it renders as literal bracket text
// on npm and GitHub. Nothing generated that block, so every heading dangled
// (#374). These checks pin the block to the headings and to package.json, so
// a release that adds a heading without its link fails the gate instead of
// shipping.
const read = (rel: string): string => readFileSync(new URL("../" + rel, import.meta.url), "utf8");
const CHANGELOG = read("CHANGELOG.md");
const CLAUDE = read("CLAUDE.md");
const REPO = "https://github.com/ironforgesoftware/junco";

/** The label of every `## [label]` heading, top to bottom. */
function headings(doc: string): string[] {
  return doc
    .split("\n")
    .map((line) => /^## \[([^\]]+)\]/.exec(line)?.[1])
    .filter((label): label is string => label !== undefined);
}

/** Every `[label]: url` reference definition, in file order. */
function references(doc: string): Map<string, string> {
  const refs = new Map<string, string>();
  for (const line of doc.split("\n")) {
    const m = /^\[([^\]]+)\]: (\S+)$/.exec(line);
    if (m !== null) refs.set(m[1], m[2]);
  }
  return refs;
}

/** The `## [Unreleased]` section, up to the first released heading. */
function unreleased(doc: string): string {
  const start = doc.indexOf("## [Unreleased]");
  const end = doc.indexOf("\n## [", start + 1);
  if (start < 0 || end < 0) throw new Error("CHANGELOG.md has no Unreleased section");
  return doc.slice(start, end);
}

const numeric = (v: string): number[] => v.split(".").map(Number);
const descending = (a: string, b: string): number => {
  const [x, y] = [numeric(a), numeric(b)];
  return y[0] - x[0] || y[1] - x[1] || y[2] - x[2];
};

describe("CHANGELOG.md link references (#374)", () => {
  it("defines exactly one reference per heading, in heading order", () => {
    const labels = headings(CHANGELOG);
    expect(labels[0]).toBe("Unreleased");
    expect(labels.length).toBeGreaterThan(10);
    expect([...references(CHANGELOG).keys()]).toEqual(labels);
  });

  it("links Unreleased and each release to the tag diff Keep a Changelog prescribes", () => {
    const versions = headings(CHANGELOG).slice(1);
    expect(versions).toEqual([...versions].sort(descending));
    const refs = references(CHANGELOG);
    expect(refs.get("Unreleased")).toBe(`${REPO}/compare/v${versions[0]}...HEAD`);
    versions.forEach((version, i) => {
      const previous = versions[i + 1];
      expect(refs.get(version)).toBe(
        previous === undefined
          ? `${REPO}/releases/tag/v${version}`
          : `${REPO}/compare/v${previous}...v${version}`,
      );
    });
  });

  it("heads the released history with package.json's version", () => {
    const pkg = JSON.parse(read("package.json")) as { version: string };
    expect(headings(CHANGELOG)[1]).toBe(pkg.version);
  });

  it("keeps the Unreleased lists tight — no blank line between bullets", () => {
    expect(unreleased(CHANGELOG)).not.toMatch(/^- [^\n]*\n\n- /m);
  });

  it("names no specific inference server — the CHANGELOG ships on npm", () => {
    expect(CHANGELOG).not.toMatch(/oMLX/i);
  });
});

describe("CLAUDE.md release checklist (#374)", () => {
  it("lists the pre-tag doc checks in §Git & release", () => {
    const start = CLAUDE.indexOf("## Git & release");
    const end = CLAUDE.indexOf("\n## ", start + 1);
    expect(start).toBeGreaterThanOrEqual(0);
    const section = CLAUDE.slice(start, end < 0 ? undefined : end);
    expect(section).toMatch(/`USAGE`[^\n]*README[^\n]*`docs\/operations\.md`/);
    expect(section).toMatch(/`ConfigSchema`[^\n]*`docs\/configuration\.md`/);
    expect(section).toMatch(/link-reference block[^\n]*`CHANGELOG\.md`/);
  });
});
