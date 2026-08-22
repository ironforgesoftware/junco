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

/** Every outcome a single ensure step can land on. `ok` and
 * `harness-not-installed` are both "nothing to do" — kept distinct so a
 * caller can never mistake "never linked here" for "already linked". The
 * rest are failures (see `isSkillLinkFailure`). */
export type SkillLinkKind =
  | "created"
  | "repaired"
  | "ok"
  | "harness-not-installed"
  | "target-missing"
  | "symlink-failed"
  | "occupied"
  | "repair-failed"
  | "mkdir-failed";

export interface SkillLinkEntry {
  /** The link path, or the harness directory for harness-not-installed / mkdir-failed. */
  path: string;
  kind: SkillLinkKind;
  /** The harness directory this entry belongs to, when it has one. Lets a
   * caller decide "did MY requested harness fail?" without path arithmetic. */
  harnessDir?: string;
  /** Human detail — an error message, or the missing target. */
  detail?: string;
}

export interface SkillLinksReport {
  entries: SkillLinkEntry[];
}

/** True for every kind that represents a failure ensureSkillLinks could not
 * resolve on its own (the old "warnings" bucket). */
export function isSkillLinkFailure(kind: SkillLinkKind): boolean {
  return (
    kind === "target-missing" ||
    kind === "symlink-failed" ||
    kind === "occupied" ||
    kind === "repair-failed" ||
    kind === "mkdir-failed"
  );
}

/** Renders one entry's human-readable detail text — the prose that used to
 * be baked into the producer's strings. Shared by every consumer so a
 * reword happens in exactly one place. */
export function renderSkillLinkEntry(e: SkillLinkEntry): string {
  switch (e.kind) {
    case "created":
    case "repaired":
    case "ok":
      return e.path;
    case "harness-not-installed":
      return `${e.path} (harness not installed)`;
    case "target-missing":
      return `${e.path}: target missing (${e.detail})`;
    case "symlink-failed":
      return `${e.path}: symlink failed (${e.detail})`;
    case "occupied":
      return `${e.path}: occupied by a non-symlink — not touching it`;
    case "repair-failed":
      return `${e.path}: repair failed (${e.detail})`;
    case "mkdir-failed":
      return `${e.path}: mkdir failed (${e.detail})`;
  }
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
  const entries: SkillLinkEntry[] = [];
  const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

  const ensureLink = (path: string, target: string, harnessDir?: string): void => {
    if (!existsFn(target)) {
      entries.push({ path, kind: "target-missing", harnessDir, detail: target });
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
        entries.push({ path, kind: "created", harnessDir });
      } catch (e) {
        entries.push({ path, kind: "symlink-failed", harnessDir, detail: msg(e) });
      }
      return;
    }
    if (!st.isSymbolicLink()) {
      entries.push({ path, kind: "occupied", harnessDir });
      return;
    }
    // A LIVE symlink is left alone even when it points elsewhere: an
    // operator's deliberate checkout-targeted mount must survive runs of the
    // npm-installed daemon. Only a broken link (dead target) gets repointed.
    if (existsFn(path)) {
      entries.push({ path, kind: "ok", harnessDir });
      return;
    }
    try {
      unlinkFn(path);
      symlinkFn(target, path);
      entries.push({ path, kind: "repaired", harnessDir });
    } catch (e) {
      entries.push({ path, kind: "repair-failed", harnessDir, detail: msg(e) });
    }
  };

  const mount = dataTreePaths(cfg).skills;
  ensureLink(mount, (deps.packageSkillsDirFn ?? packageSkillsDir)());

  for (const dir of cfg.skills.harnessDirs) {
    // Parent-exists = harness installed; the skills dir itself may be missing
    // on a fresh harness and is safe to mkdir. An uninstalled harness is a
    // silent skip, never a warning — configs roam between machines.
    if (!existsFn(dirname(dir))) {
      entries.push({ path: dir, kind: "harness-not-installed", harnessDir: dir });
      continue;
    }
    try {
      mkdirFn(dir);
    } catch (e) {
      entries.push({ path: dir, kind: "mkdir-failed", harnessDir: dir, detail: msg(e) });
      continue;
    }
    ensureLink(join(dir, SKILL_DIR_NAME), join(mount, SKILL_DIR_NAME), dir);
  }
  return { entries };
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
