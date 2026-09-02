import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// README.md is the npm package's front page and hand-written prose with no
// code coupling, so nothing guarded it — its CLI table shipped without any of
// the three `submit` routes (apply tickets, plan sets, the parked-issue door)
// and its quick-start comment said bare `junco` starts the daemon when cli.ts
// opens the dashboard (#372). These checks pin the claims that have a source
// of truth elsewhere in the tree.
const read = (rel: string): string => readFileSync(new URL("../" + rel, import.meta.url), "utf8");
const README = read("README.md");

/** The `## CLI at a glance` section, up to the next `## ` heading. */
function cliSection(doc: string): string {
  const lines = doc.split("\n");
  const start = lines.findIndex((l) => /^## CLI at a glance/.test(l));
  if (start < 0) throw new Error("README.md has no CLI at a glance section");
  const end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  return lines.slice(start, end < 0 ? lines.length : end).join("\n");
}

describe("README.md documents the shipped `submit` routes (#372)", () => {
  it("lists the apply-ticket, plan-set, and parked-issue submit routes in the CLI table", () => {
    const section = cliSection(README);
    for (const phrase of [
      "submit --patch <file> --repo <path>",
      "submit --plan <file> --repo <path>",
      "submit --as-issue <file>",
    ]) {
      expect(section).toContain("`junco " + phrase + "`");
    }
  });

  it("describes bare `junco` as opening the dashboard, not as starting the daemon", () => {
    // cli.ts: bare `junco` on a TTY ensures the supervised daemon, then
    // runDashboardFn — the daemon is a side effect, the dashboard is the result.
    const line = README.split("\n").find((l) => l.includes("npx @ironforgesoftware/junco"));
    expect(line).toBeDefined();
    expect(line).toMatch(/dashboard/);
    expect(line).not.toMatch(/starts the daemon/);
  });

  it("introduces apply tickets and links a docs/tickets.md heading that exists", () => {
    expect(README).toMatch(/\(docs\/tickets\.md#apply-tickets\)/);
    expect(read("docs/tickets.md")).toMatch(/^## Apply tickets$/m);
  });
});
