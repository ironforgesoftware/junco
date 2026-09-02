import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// #356: three helpers had been hand-rolled per module — `emptyRunResult` ×3,
// `describeError`/`errMsg` ×11 (in two behaviours, so a caller could reach for
// the one that drops GitOpError.stderr), and `GH_TIMEOUT = 60_000` ×8. Each
// now has exactly one home; this scan is what keeps a fourth copy from
// reappearing, since a re-declaration is invisible in review.
const SRC = fileURLToPath(new URL("../src", import.meta.url));

function sourceFiles(dir: string = SRC): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(p));
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

/** Files declaring `name` as a top-level function or const, relative to src/. */
function declarers(name: string): string[] {
  const re = new RegExp(`^(?:export )?(?:async )?(?:function ${name}\\b|const ${name}\\b)`, "m");
  return sourceFiles()
    .filter((p) => re.test(readFileSync(p, "utf8")))
    .map((p) => p.slice(SRC.length + 1))
    .sort();
}

describe("deduped helpers have exactly one home (#356)", () => {
  it("declares emptyRunResult only in agent/runResult.ts", () => {
    expect(declarers("emptyRunResult")).toEqual(["agent/runResult.ts"]);
  });

  it("declares describeError only in git.ts, and errMsg nowhere", () => {
    expect(declarers("describeError")).toEqual(["git.ts"]);
    expect(declarers("errMsg")).toEqual([]);
  });

  it("declares the gh timeout budgets only in git.ts", () => {
    expect(declarers("GH_TIMEOUT_MS")).toEqual(["git.ts"]);
    expect(declarers("GH_PUSH_TIMEOUT_MS")).toEqual(["git.ts"]);
  });

  it("leaves no module re-declaring the shared budgets' VALUES", () => {
    // Modules keep their own SHORTER budgets (30s in the interactive paths) —
    // those are real overrides. What must not come back is a local constant
    // that just restates 60s/3min, since it drifts silently from git.ts's.
    const re = /^const (GH_[A-Z_]*TIMEOUT[A-Z_]*|PUSH_TIMEOUT[A-Z_]*) = (60_000|180_000);/gm;
    const offenders: string[] = [];
    for (const p of sourceFiles()) {
      if (p === join(SRC, "git.ts")) continue;
      for (const m of readFileSync(p, "utf8").matchAll(re)) {
        offenders.push(`${p.slice(SRC.length + 1)}:${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the dashboard's shorter budget as an override with its reason", () => {
    const src = readFileSync(join(SRC, "tui", "ghClient.ts"), "utf8");
    const m = /\/\*\*([\s\S]*?)\*\/\nconst GH_TIMEOUT = 30_000;/.exec(src);
    expect(m, "ghClient.ts must document why it overrides GH_TIMEOUT_MS").not.toBeNull();
    expect(m?.[1]).toContain("GH_TIMEOUT_MS");
  });
});
