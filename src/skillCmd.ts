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
import { loadConfig } from "./config.js";
import { getAtPath, setAtPath } from "./configLevers.js";
import {
  ensureSkillLinks,
  sameHarnessDir,
  isSkillLinkFailure,
  renderSkillLinkEntry,
  HARNESS_REGISTRY,
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
    // First occurrence wins via sameHarnessDir (the expandHome-normalized
    // rule shared with the wizard, #292) — this also collapses
    // within-invocation repeats (`--harness claude --harness claude`), not
    // just dedupe against what's already in the config.
    const known: string[] = [...existing];
    const additions: string[] = [];
    for (const d of requested) {
      if (known.some((k) => sameHarnessDir(k, d))) continue;
      known.push(d);
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
  for (const entry of report.entries.filter((e) => e.kind === "created")) {
    print(`created:  ${renderSkillLinkEntry(entry)}\n`);
  }
  for (const entry of report.entries.filter((e) => e.kind === "repaired")) {
    print(`repaired: ${renderSkillLinkEntry(entry)}\n`);
  }
  // "ok" and "harness-not-installed" mix two meanings (skillLinks.ts): a
  // genuinely valid, already-linked path ("ok") and a harness whose parent
  // dir doesn't exist here — never linked at all. The latter under "ok:"
  // would misleadingly imply it was linked.
  for (const entry of report.entries.filter(
    (e) => e.kind === "ok" || e.kind === "harness-not-installed",
  )) {
    print(
      entry.kind === "harness-not-installed"
        ? `skipped:  ${renderSkillLinkEntry(entry)}\n`
        : `ok:       ${renderSkillLinkEntry(entry)}\n`,
    );
  }
  for (const entry of report.entries.filter((e) => isSkillLinkFailure(e.kind))) {
    print(`warning:  ${renderSkillLinkEntry(entry)}\n`);
  }

  // Explicitly requested links must land; config-driven failures are daemon
  // parity (exit 0). Compare harness directories with the normalized rule
  // (sameHarnessDir, #292) — each failing entry already carries the harness
  // dir it belongs to, so no path/dirname arithmetic is needed here.
  const failedRequested = report.entries.some(
    (e) =>
      isSkillLinkFailure(e.kind) &&
      e.harnessDir !== undefined &&
      requested.some((d) => sameHarnessDir(d, e.harnessDir as string)),
  );
  return failedRequested ? 1 : 0;
}
