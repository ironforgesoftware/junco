/**
 * Skill-link distribution (spec 2026-08-19): <dataDir>/skills is a symlink
 * mount to the package's skills/ dir; each consented harness dir
 * (cfg.skills.harnessDirs) gets <harnessDir>/junco-dispatch ->
 * <dataDir>/skills/junco-dispatch. Idempotent + self-healing: absent links
 * are created, broken symlinks replaced, VALID symlinks left alone even when
 * they point elsewhere (an operator's checkout-targeted mount survives npm-
 * installed runs), and real files/dirs are never touched. All failures are
 * warnings — the daemon must never fail to start over skill links.
 */
import { lstatSync, existsSync, symlinkSync, unlinkSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "./types.js";
import { expandHome } from "./config.js";
import { dataTreePaths } from "./dataTree.js";
import { packageSkillsDir } from "./packageRoot.js";

/** Known harnesses and their default global skills dirs. A compat matrix of
 * public products (not personal setup); `--harness <path>` covers the rest. */
export const HARNESS_REGISTRY: Record<string, string> = {
  claude: "~/.claude/skills",
  codex: "~/.codex/skills",
  pi: "~/.pi/agent/skills",
  omp: "~/.omp/agent/skills",
  opencode: "~/.config/opencode/skills",
};

export const SKILL_DIR_NAME = "junco-dispatch";

export interface SkillLinksReport {
  created: string[];
  repaired: string[];
  skipped: string[];
  warnings: string[];
}

export interface SkillLinksDeps {
  /** lstat (does NOT follow the link) — throws ENOENT when absent. */
  lstatFn?: (p: string) => { isSymbolicLink(): boolean };
  /** exists (FOLLOWS symlinks) — false for a broken link. */
  existsFn?: (p: string) => boolean;
  symlinkFn?: (target: string, path: string) => void;
  unlinkFn?: (p: string) => void;
  mkdirFn?: (p: string) => void;
  packageSkillsDirFn?: () => string;
}

export function ensureSkillLinks(cfg: Config, deps: SkillLinksDeps = {}): SkillLinksReport {
  const lstatFn = deps.lstatFn ?? lstatSync;
  const existsFn = deps.existsFn ?? existsSync;
  const symlinkFn = deps.symlinkFn ?? ((t: string, p: string) => symlinkSync(t, p));
  const unlinkFn = deps.unlinkFn ?? unlinkSync;
  const mkdirFn = deps.mkdirFn ?? ((p: string) => mkdirSync(p, { recursive: true }));
  const report: SkillLinksReport = { created: [], repaired: [], skipped: [], warnings: [] };
  const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

  const ensureLink = (path: string, target: string): void => {
    if (!existsFn(target)) {
      report.warnings.push(`${path}: target missing (${target})`);
      return;
    }
    let st: { isSymbolicLink(): boolean } | null;
    try {
      st = lstatFn(path);
    } catch {
      st = null;
    }
    if (st === null) {
      try {
        symlinkFn(target, path);
        report.created.push(path);
      } catch (e) {
        report.warnings.push(`${path}: symlink failed (${msg(e)})`);
      }
      return;
    }
    if (!st.isSymbolicLink()) {
      report.warnings.push(`${path}: occupied by a non-symlink — not touching it`);
      return;
    }
    // A LIVE symlink is left alone even when it points elsewhere: an
    // operator's deliberate checkout-targeted mount must survive runs of the
    // npm-installed daemon. Only a broken link (dead target) gets repointed.
    if (existsFn(path)) {
      report.skipped.push(path);
      return;
    }
    try {
      unlinkFn(path);
      symlinkFn(target, path);
      report.repaired.push(path);
    } catch (e) {
      report.warnings.push(`${path}: repair failed (${msg(e)})`);
    }
  };

  const mount = dataTreePaths(cfg).skills;
  ensureLink(mount, (deps.packageSkillsDirFn ?? packageSkillsDir)());

  for (const dir of cfg.skills.harnessDirs) {
    // Parent-exists = harness installed; the skills dir itself may be missing
    // on a fresh harness and is safe to mkdir. An uninstalled harness is a
    // silent skip, never a warning — configs roam between machines.
    if (!existsFn(dirname(dir))) {
      report.skipped.push(`${dir} (harness not installed)`);
      continue;
    }
    try {
      mkdirFn(dir);
    } catch (e) {
      report.warnings.push(`${dir}: mkdir failed (${msg(e)})`);
      continue;
    }
    ensureLink(join(dir, SKILL_DIR_NAME), join(mount, SKILL_DIR_NAME));
  }
  return report;
}

/** Registry entries whose harness appears installed (parent of the skills
 * dir exists) — the wizard's detection probe. */
export function detectInstalledHarnesses(
  existsFn: (p: string) => boolean = existsSync,
): { name: string; dir: string }[] {
  return Object.entries(HARNESS_REGISTRY)
    .filter(([, dir]) => existsFn(dirname(expandHome(dir))))
    .map(([name, dir]) => ({ name, dir }));
}

/**
 * True when two spellings denote the same harness directory. Both sides are
 * expandHome'd because the two forms genuinely coexist: the registry (and so
 * `detectInstalledHarnesses`) emits the tilde form, `junco skill install
 * --harness <path>` stores whatever the operator typed, and `loadConfig`
 * expands `skills.harnessDirs` on every read. Comparing raw strings makes an
 * already-consented harness render unchecked on a wizard rerun and then
 * writes a two-spelling duplicate (#292).
 */
export function sameHarnessDir(a: string, b: string): boolean {
  return expandHome(a) === expandHome(b);
}
