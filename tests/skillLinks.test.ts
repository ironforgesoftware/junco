import { describe, it, expect } from "vitest";
import { join } from "node:path";
import {
  ensureSkillLinks,
  detectInstalledHarnesses,
  HARNESS_REGISTRY,
  SKILL_DIR_NAME,
  type SkillLinksDeps,
} from "../src/skillLinks.js";
import { makeConfig, READ_ONLY_TOOLS } from "./helpers/config.js";

const PKG_SKILLS = "/sbxroot/pkg/skills";
const DATA = "/sbxroot/data";
const MOUNT = join(DATA, "skills");

function cfgWith(harnessDirs: string[]) {
  return makeConfig(
    {
      dataDir: DATA,
      queueRoot: join(DATA, "queue"),
      worktreeRoot: join(DATA, "worktrees"),
      tools: READ_ONLY_TOOLS,
      criticEnabled: false,
      planLintEnabled: false,
      verifyEnabled: false,
      supervisorEnabled: false,
      healthEnabled: false,
      removeWorktreeOnSuccess: true,
    },
    { skills: { harnessDirs } },
  );
}

/** In-memory fs: real dirs/files + symlinks, with prefix-substituting
 * symlink resolution so existsFn(join(MOUNT, "junco-dispatch")) follows the
 * mount link the way the real fs would. */
function makeFakeFs(init: { dirs?: string[]; files?: string[]; links?: Record<string, string> }) {
  const dirs = new Set(init.dirs ?? []);
  const files = new Set(init.files ?? []);
  const links = new Map(Object.entries(init.links ?? {}));
  const resolve = (p: string, depth = 0): string | null => {
    if (depth > 8) return null; // cycle guard
    for (const [lp, target] of links) {
      if (p === lp) return resolve(target, depth + 1);
      if (p.startsWith(lp + "/")) return resolve(target + p.slice(lp.length), depth + 1);
    }
    return dirs.has(p) || files.has(p) ? p : null;
  };
  const deps: SkillLinksDeps = {
    lstatFn: (p) => {
      if (links.has(p)) return { isSymbolicLink: () => true };
      if (dirs.has(p) || files.has(p)) return { isSymbolicLink: () => false };
      throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
    },
    existsFn: (p) => resolve(p) !== null,
    symlinkFn: (target, p) => {
      if (links.has(p) || dirs.has(p) || files.has(p))
        throw Object.assign(new Error(`EEXIST: ${p}`), { code: "EEXIST" });
      links.set(p, target);
    },
    unlinkFn: (p) => {
      if (!links.delete(p)) throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
    },
    mkdirFn: (p) => dirs.add(p),
    packageSkillsDirFn: () => PKG_SKILLS,
  };
  return { deps, links, dirs };
}

// The package skills content that every healthy chain resolves to.
const PKG_TREE = { dirs: [PKG_SKILLS, join(PKG_SKILLS, SKILL_DIR_NAME), DATA] };

describe("ensureSkillLinks: mount", () => {
  it("creates <dataDir>/skills -> package skills when absent", () => {
    const { deps, links } = makeFakeFs(PKG_TREE);
    const r = ensureSkillLinks(cfgWith([]), deps);
    expect(links.get(MOUNT)).toBe(PKG_SKILLS);
    expect(r.created).toEqual([MOUNT]);
    expect(r.warnings).toEqual([]);
  });

  it("repairs a broken mount (target gone) but leaves a valid foreign mount alone", () => {
    const broken = makeFakeFs({ ...PKG_TREE, links: { [MOUNT]: "/sbxroot/old-checkout/skills" } });
    const r1 = ensureSkillLinks(cfgWith([]), broken.deps);
    expect(broken.links.get(MOUNT)).toBe(PKG_SKILLS);
    expect(r1.repaired).toEqual([MOUNT]);

    // Valid but pointing elsewhere (operator's dev checkout): untouched.
    const foreign = makeFakeFs({
      dirs: [...PKG_TREE.dirs, "/sbxroot/checkout/skills"],
      links: { [MOUNT]: "/sbxroot/checkout/skills" },
    });
    const r2 = ensureSkillLinks(cfgWith([]), foreign.deps);
    expect(foreign.links.get(MOUNT)).toBe("/sbxroot/checkout/skills");
    expect(r2.skipped).toContain(MOUNT);
  });

  it("refuses to touch a real directory occupying the mount path", () => {
    const { deps, dirs } = makeFakeFs({ dirs: [...PKG_TREE.dirs, MOUNT] });
    const r = ensureSkillLinks(cfgWith([]), deps);
    expect(dirs.has(MOUNT)).toBe(true);
    expect(r.warnings.some((w) => w.startsWith(MOUNT))).toBe(true);
  });

  it("warns instead of linking when the package skills dir is missing", () => {
    const { deps, links } = makeFakeFs({ dirs: [DATA] });
    const r = ensureSkillLinks(cfgWith([]), deps);
    expect(links.has(MOUNT)).toBe(false);
    expect(r.warnings.some((w) => w.includes("target missing"))).toBe(true);
  });
});

describe("ensureSkillLinks: harness links", () => {
  const HDIR = "/sbxroot/home/.claude/skills";
  const HLINK = join(HDIR, SKILL_DIR_NAME);

  it("creates the harness link through the mount, mkdir-ing the skills dir", () => {
    const { deps, links } = makeFakeFs({ dirs: [...PKG_TREE.dirs, "/sbxroot/home/.claude"] });
    const r = ensureSkillLinks(cfgWith([HDIR]), deps);
    expect(links.get(HLINK)).toBe(join(MOUNT, SKILL_DIR_NAME));
    expect(r.created).toEqual([MOUNT, HLINK]);
  });

  it("skips a harness whose parent dir does not exist (harness not installed)", () => {
    const { deps, links } = makeFakeFs(PKG_TREE);
    const r = ensureSkillLinks(cfgWith([HDIR]), deps);
    expect(links.has(HLINK)).toBe(false);
    expect(r.skipped.some((s) => s.startsWith(HDIR))).toBe(true);
    expect(r.warnings).toEqual([]);
  });

  it("repairs a broken harness link and preserves a valid one", () => {
    const broken = makeFakeFs({
      dirs: [...PKG_TREE.dirs, "/sbxroot/home/.claude", HDIR],
      links: { [HLINK]: "/sbxroot/gone/junco-dispatch" },
    });
    const r = ensureSkillLinks(cfgWith([HDIR]), broken.deps);
    expect(broken.links.get(HLINK)).toBe(join(MOUNT, SKILL_DIR_NAME));
    expect(r.repaired).toContain(HLINK);
  });

  it("collects a warning (never throws) when symlink creation fails", () => {
    const { deps } = makeFakeFs(PKG_TREE);
    const failing: SkillLinksDeps = {
      ...deps,
      symlinkFn: () => {
        throw new Error("EPERM: operation not permitted");
      },
    };
    const r = ensureSkillLinks(cfgWith([]), failing);
    expect(r.warnings.some((w) => w.includes("EPERM"))).toBe(true);
  });
});

describe("detectInstalledHarnesses", () => {
  it("returns registry entries whose parent dir exists", () => {
    // Suffix-match, not equality against a HOME we construct: expandHome is
    // homedir()-based (see config.ts's note on the expandHome/env split), so
    // the probe paths are homedir-anchored regardless of process.env.HOME.
    const existsFn = (p: string) => p.endsWith("/.claude") || p.endsWith("/.omp/agent");
    const found = detectInstalledHarnesses(existsFn);
    expect(found.map((f) => f.name).sort()).toEqual(["claude", "omp"]);
    expect(found.find((f) => f.name === "claude")?.dir).toBe(HARNESS_REGISTRY.claude);
  });
});
