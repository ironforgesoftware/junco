/**
 * `junco skill install [--harness <name|path>]...` — the explicit skill-link
 * entry point. No args: re-ensure from config (what the daemon does at start,
 * with a printed report). With --harness: resolve registry names to their
 * default dirs, persist NEW dirs to skills.harnessDirs (atomic tmp+rename,
 * configCmd pattern — presence in config is the standing consent the ensure
 * step honors), then ensure. Exit 1 only when an explicitly requested link
 * failed; config-driven warnings stay exit 0 (daemon parity).
 */
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "./types.js";
import { expandHome, loadConfig } from "./config.js";
import { getAtPath, setAtPath } from "./configLevers.js";
import {
  ensureSkillLinks,
  HARNESS_REGISTRY,
  SKILL_DIR_NAME,
  type SkillLinksReport,
} from "./skillLinks.js";

export interface SkillCmdDeps {
  printFn?: (s: string) => void;
  readFileFn?: (p: string) => string;
  writeFileFn?: (p: string, s: string) => void;
  renameFn?: (from: string, to: string) => void;
  loadConfigFn?: (p: string) => Config;
  ensureFn?: (cfg: Config) => SkillLinksReport;
}

/** Registry name -> its default dir; anything path-shaped passes through
 * verbatim (stored un-expanded so the config stays portable across HOMEs).
 * `Object.hasOwn` guards the lookup: HARNESS_REGISTRY is a plain object
 * literal, so a bare `[arg]` index resolves inherited Object.prototype
 * members for names like "constructor"/"toString"/"__proto__" — a real
 * function value that downstream code (join(dir, ...) etc.) then throws a
 * TypeError on, instead of landing on the unknown-harness error below. */
export function resolveHarnessArg(arg: string): { dir: string } | { error: string } {
  if (Object.hasOwn(HARNESS_REGISTRY, arg)) return { dir: HARNESS_REGISTRY[arg] };
  if (arg.includes("/") || arg.startsWith("~")) return { dir: arg };
  return {
    error:
      `unknown harness '${arg}' — known: ${Object.keys(HARNESS_REGISTRY).join(", ")}; ` +
      `or pass a skills-directory path`,
  };
}

export async function runSkillInstallCommand(
  configPath: string,
  opts: { harness: string[] },
  deps: SkillCmdDeps = {},
): Promise<number> {
  const print = deps.printFn ?? ((s: string) => process.stdout.write(s));
  const readFile = deps.readFileFn ?? ((p: string) => readFileSync(p, "utf8"));
  const writeFile = deps.writeFileFn ?? ((p: string, s: string) => writeFileSync(p, s, "utf8"));
  const renameFn = deps.renameFn ?? renameSync;
  const loadConfigFn = deps.loadConfigFn ?? loadConfig;
  const ensureFn = deps.ensureFn ?? ensureSkillLinks;

  const requested: string[] = [];
  for (const arg of opts.harness) {
    const r = resolveHarnessArg(arg);
    if ("error" in r) {
      print(`junco skill install: ${r.error}\n`);
      return 2;
    }
    requested.push(r.dir);
  }

  if (requested.length > 0) {
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(readFile(configPath)) as Record<string, unknown>;
    } catch (e) {
      print(`junco skill install: ${configPath}: ${e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    }
    const existing = (getAtPath(raw, "skills.harnessDirs") as string[] | undefined) ?? [];
    const known = new Set(existing.map((d) => expandHome(d)));
    // First occurrence wins on expandHome-normalized form — this also
    // collapses within-invocation repeats (`--harness claude --harness
    // claude`), not just dedupe against what's already in the config.
    const additions: string[] = [];
    for (const d of requested) {
      const norm = expandHome(d);
      if (known.has(norm)) continue;
      known.add(norm);
      additions.push(d);
    }
    if (additions.length > 0) {
      setAtPath(raw, "skills.harnessDirs", [...existing, ...additions]);
      // Atomic tmp+rename — same pattern as configCmd/wizard writes.
      const tmp = join(dirname(configPath), `.config.json.tmp-${process.pid}`);
      writeFile(tmp, JSON.stringify(raw, null, 2) + "\n");
      renameFn(tmp, configPath);
      for (const d of additions) print(`configured: ${d}\n`);
    }
  }

  const cfg = loadConfigFn(configPath);
  const report = ensureFn(cfg);
  for (const c of report.created) print(`created:  ${c}\n`);
  for (const r of report.repaired) print(`repaired: ${r}\n`);
  // report.skipped mixes two meanings (skillLinks.ts): a genuinely valid,
  // already-linked path ("ok") and a harness whose parent dir doesn't exist
  // here — never linked at all, suffixed "(harness not installed)". The
  // latter under "ok:" would misleadingly imply it was linked.
  for (const s of report.skipped) {
    print(s.endsWith("(harness not installed)") ? `skipped:  ${s}\n` : `ok:       ${s}\n`);
  }
  for (const w of report.warnings) print(`warning:  ${w}\n`);

  // Explicitly requested links must land; config-driven warnings are daemon
  // parity (exit 0). Compare on expanded paths — the report is post-expansion.
  const requestedLinks = requested.map((d) => join(expandHome(d), SKILL_DIR_NAME));
  const failedRequested = report.warnings.some((w) =>
    requestedLinks.some((p) => w.startsWith(p) || w.startsWith(dirname(p))),
  );
  return failedRequested ? 1 : 0;
}
