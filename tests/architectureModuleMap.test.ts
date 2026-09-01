import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// ARCHITECTURE.md's module map is hand-maintained prose; this pins the two ways
// it drifts (#376): a module added under src/ with no row, and a row whose file
// is gone. Row keys are the first backticked token of each table line — a file
// (`slug.ts`, `agent/replay.ts`) or a directory (`tui/`, `agent/sandbox/`).
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(ROOT, "src");

function moduleMapRows(): Map<string, string> {
  const doc = readFileSync(join(ROOT, "ARCHITECTURE.md"), "utf8");
  const start = doc.indexOf("\n## Module map");
  expect(start).toBeGreaterThan(-1);
  const rest = doc.slice(start + 1);
  const end = rest.indexOf("\n## ");
  const section = end === -1 ? rest : rest.slice(0, end);
  const rows = new Map<string, string>();
  for (const line of section.split("\n")) {
    const m = /^\| `([^`]+)`\s+\|\s*(.*?)\s*\|\s*$/.exec(line);
    if (m) rows.set(m[1], m[2]);
  }
  expect(rows.size).toBeGreaterThan(0);
  return rows;
}

describe("ARCHITECTURE.md module map", () => {
  it("has a row for every top-level src module", () => {
    const rows = moduleMapRows();
    const modules = readdirSync(SRC)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"))
      .sort();
    const missing = modules.filter((f) => !rows.has(f));
    expect(missing).toEqual([]);
  });

  it("names only modules and directories that still exist", () => {
    const stale = [...moduleMapRows().keys()].filter((key) => !existsSync(join(SRC, key)));
    expect(stale).toEqual([]);
  });

  it("points the cli.ts row at USAGE instead of enumerating subcommands", () => {
    // A verb list maintained in two places always drifts to the shorter one —
    // the row defers to the USAGE string cli.ts prints for `junco --help`.
    expect(moduleMapRows().get("cli.ts")).toContain("`USAGE`");
  });
});
