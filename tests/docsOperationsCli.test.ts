import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { run } from "../src/cli.js";

// docs/operations.md's command table is hand-written prose with no code
// coupling, so nothing else guarded it — it drifted ~20 commands behind
// `junco --help` and misdescribed bare `junco` (#371). USAGE (src/cli.ts)
// is the authoritative reference; these checks keep the table a mirror of it.
const OPERATIONS = readFileSync(new URL("../docs/operations.md", import.meta.url), "utf8");

async function captureHelp(): Promise<string> {
  const out: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  try {
    expect(await run(["--help"], {})).toBe(0);
  } finally {
    spy.mockRestore();
  }
  return out.join("");
}

/** The `## … CLI …` section, up to the next `## ` heading. */
function cliSection(doc: string): string {
  const lines = doc.split("\n");
  const start = lines.findIndex((l) => /^## .*\bCLI\b/.test(l));
  if (start < 0) throw new Error("docs/operations.md has no CLI section");
  const end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  return lines.slice(start, end < 0 ? lines.length : end).join("\n");
}

/**
 * The leading command phrase of every `Subcommands:` entry — the run of
 * words/flags before the first placeholder (`submit --as-issue --plan`,
 * `assess file`, `auth grant`). Entries sit at a two-space indent; deeper
 * lines are continuations and `(no subcommand)` is prose.
 */
function usagePhrases(usage: string): string[] {
  const block = usage.slice(usage.indexOf("Subcommands:"), usage.indexOf("Options:"));
  const phrases = new Set<string>();
  for (const line of block.split("\n")) {
    if (!/^ {2}[a-z]/.test(line)) continue;
    for (const alt of line.slice(2).split(" | ")) {
      const m = /^[a-z][a-z-]*(?: [a-z-][a-z-]*)*/.exec(alt);
      if (m !== null) phrases.add(m[0]);
    }
  }
  return [...phrases];
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

describe("docs/operations.md CLI table mirrors `junco --help` (#371)", () => {
  it("documents every subcommand phrase USAGE lists, as `junco <phrase>`", async () => {
    const section = cliSection(OPERATIONS);
    const phrases = usagePhrases(await captureHelp());
    expect(phrases.length).toBeGreaterThan(25);
    const missing = phrases.filter(
      (p) => !new RegExp("`junco " + escape(p) + "(?![\\w-])").test(section),
    );
    expect(missing).toEqual([]);
  });

  it("documents every flag USAGE mentions", async () => {
    const section = cliSection(OPERATIONS);
    const usage = await captureHelp();
    const flags = new Set([
      ...(usage.match(/--[a-z][a-z-]*/g) ?? []),
      ...(usage.match(/(?<=[\s[])-[a-z](?=[\s\]])/g) ?? []),
    ]);
    expect(flags.size).toBeGreaterThan(20);
    const missing = [...flags].filter(
      (f) => !new RegExp("(?<![\\w-])" + escape(f) + "(?![\\w-])").test(section),
    );
    expect(missing).toEqual([]);
  });

  it("describes bare `junco` as opening the dashboard, not as an alias for `start`", () => {
    // cli.ts: bare `junco` on a TTY ensures the supervised daemon, then
    // runDashboardFn — it never runs a foreground daemon.
    const row = cliSection(OPERATIONS)
      .split("\n")
      .find((l) => l.includes("(no subcommand)"));
    expect(row).toBeDefined();
    expect(row).toMatch(/dashboard/);
    expect(row).not.toMatch(/→ `start`/);
  });

  it("names `junco --help` as the authoritative reference", () => {
    expect(cliSection(OPERATIONS)).toMatch(/`junco --help`[^\n]*authoritative/);
  });
});
