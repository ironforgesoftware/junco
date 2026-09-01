import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// CONTRIBUTING.md is hand-written prose with no code coupling, so nothing
// guarded it — it quoted a suite a quarter of its real size, never named the
// gate CI actually runs, and sent frontmatter docs to a README section that
// doesn't exist (#373). These checks pin the claims that have a source of
// truth elsewhere in the tree.
const read = (rel: string): string => readFileSync(new URL("../" + rel, import.meta.url), "utf8");
const CONTRIBUTING = read("CONTRIBUTING.md");
const CLAUDE = read("CLAUDE.md");
const README = read("README.md");

/**
 * The `npm …` steps quality-gate.yml runs, in order, as one `&&` chain. The
 * node-24 leg of the matrix repeats build + test; the Set keeps first
 * occurrences only, so the chain reads as the node-22.19 leg does.
 */
function ciGate(): string {
  const steps = read(".github/workflows/quality-gate.yml")
    .split("\n")
    .map((line) => /^\s*- run: (npm (?:run [\w:]+|test))$/.exec(line)?.[1])
    .filter((step): step is string => step !== undefined);
  return [...new Set(steps)].join(" && ");
}

/** GitHub's heading → anchor slug, for every heading in a Markdown doc. */
function anchors(doc: string): string[] {
  return doc
    .split("\n")
    .filter((line) => /^#+ /.test(line))
    .map((line) =>
      line
        .replace(/^#+ /, "")
        .toLowerCase()
        .replace(/[^\w\s-]/g, "")
        .trim()
        .replace(/\s+/g, "-"),
    );
}

describe("CONTRIBUTING.md mirrors what the tree enforces (#373)", () => {
  it("states the full gate exactly as .github/workflows/quality-gate.yml runs it", () => {
    const gate = ciGate();
    expect(gate).toBe(
      "npm run lint && npm run format:check && npm run typecheck && npm run build && npm test",
    );
    expect(CONTRIBUTING).toContain(gate);
    expect(CLAUDE).toContain(gate);
  });

  it("quotes one suite size across CONTRIBUTING, CLAUDE.md and README", () => {
    const sizes = [CONTRIBUTING, CLAUDE, README].map((doc) => /~([\d,]+) tests/.exec(doc)?.[1]);
    expect(sizes[0]).toBeDefined();
    expect(new Set(sizes).size).toBe(1);
  });

  it("sends frontmatter docs to a docs/tickets.md heading that exists", () => {
    const anchor = /\(docs\/tickets\.md#([\w-]+)\)/.exec(CONTRIBUTING)?.[1];
    expect(anchor).toBeDefined();
    expect(anchors(read("docs/tickets.md"))).toContain(anchor);
    expect(CONTRIBUTING).not.toMatch(/README\.md[^\n]*config\/ticket reference/);
  });

  it("states the branch convention and the exact-pin policy package.json follows", () => {
    expect(CONTRIBUTING).toMatch(/`feat\/<topic>` off `main`/);
    expect(CONTRIBUTING).toMatch(/npm install --save-exact/);
    const pkg = JSON.parse(read("package.json")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const ranged = Object.entries({ ...pkg.dependencies, ...pkg.devDependencies }).filter(
      ([, version]) => !/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(version),
    );
    expect(ranged).toEqual([]);
  });
});
