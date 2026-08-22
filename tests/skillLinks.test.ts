import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  ensureSkillLinks,
  detectInstalledHarnesses,
  sameHarnessDir,
  isSkillLinkFailure,
  renderSkillLinkEntry,
  HARNESS_REGISTRY,
  SKILL_DIR_NAME,
  type SkillLinksDeps,
  type SkillLinkEntry,
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

/** Find the single entry for a path — fails loudly (via find's undefined)
 * rather than silently picking the wrong one when a test's assumption about
 * uniqueness is wrong. */
function entryFor(entries: SkillLinkEntry[], path: string): SkillLinkEntry | undefined {
  return entries.find((e) => e.path === path);
}

describe("ensureSkillLinks: mount", () => {
  it("creates <dataDir>/skills -> package skills when absent", () => {
    const { deps, links } = makeFakeFs(PKG_TREE);
    const r = ensureSkillLinks(cfgWith([]), deps);
    expect(links.get(MOUNT)).toBe(PKG_SKILLS);
    expect(r.entries).toEqual([{ path: MOUNT, kind: "created", harnessDir: undefined }]);
  });

  it("repairs a broken mount (target gone) but leaves a valid foreign mount alone", () => {
    const broken = makeFakeFs({ ...PKG_TREE, links: { [MOUNT]: "/sbxroot/old-checkout/skills" } });
    const r1 = ensureSkillLinks(cfgWith([]), broken.deps);
    expect(broken.links.get(MOUNT)).toBe(PKG_SKILLS);
    expect(entryFor(r1.entries, MOUNT)).toEqual({
      path: MOUNT,
      kind: "repaired",
      harnessDir: undefined,
    });

    // Valid but pointing elsewhere (operator's dev checkout): untouched.
    const foreign = makeFakeFs({
      dirs: [...PKG_TREE.dirs, "/sbxroot/checkout/skills"],
      links: { [MOUNT]: "/sbxroot/checkout/skills" },
    });
    const r2 = ensureSkillLinks(cfgWith([]), foreign.deps);
    expect(foreign.links.get(MOUNT)).toBe("/sbxroot/checkout/skills");
    expect(entryFor(r2.entries, MOUNT)).toEqual({ path: MOUNT, kind: "ok", harnessDir: undefined });
  });

  it("refuses to touch a real directory occupying the mount path", () => {
    const { deps, dirs } = makeFakeFs({ dirs: [...PKG_TREE.dirs, MOUNT] });
    const r = ensureSkillLinks(cfgWith([]), deps);
    expect(dirs.has(MOUNT)).toBe(true);
    expect(entryFor(r.entries, MOUNT)).toEqual({
      path: MOUNT,
      kind: "occupied",
      harnessDir: undefined,
    });
    expect(r.entries.some((e) => isSkillLinkFailure(e.kind))).toBe(true);
  });

  it("warns instead of linking when the package skills dir is missing", () => {
    const { deps, links } = makeFakeFs({ dirs: [DATA] });
    const r = ensureSkillLinks(cfgWith([]), deps);
    expect(links.has(MOUNT)).toBe(false);
    expect(entryFor(r.entries, MOUNT)).toEqual({
      path: MOUNT,
      kind: "target-missing",
      harnessDir: undefined,
      detail: PKG_SKILLS,
    });
  });
});

describe("ensureSkillLinks: harness links", () => {
  const HDIR = "/sbxroot/home/.claude/skills";
  const HLINK = join(HDIR, SKILL_DIR_NAME);

  it("creates the harness link through the mount, mkdir-ing the skills dir", () => {
    const { deps, links } = makeFakeFs({ dirs: [...PKG_TREE.dirs, "/sbxroot/home/.claude"] });
    const r = ensureSkillLinks(cfgWith([HDIR]), deps);
    expect(links.get(HLINK)).toBe(join(MOUNT, SKILL_DIR_NAME));
    expect(entryFor(r.entries, MOUNT)?.kind).toBe("created");
    expect(entryFor(r.entries, HLINK)).toEqual({ path: HLINK, kind: "created", harnessDir: HDIR });
  });

  it("skips a harness whose parent dir does not exist (harness not installed)", () => {
    const { deps, links } = makeFakeFs(PKG_TREE);
    const r = ensureSkillLinks(cfgWith([HDIR]), deps);
    expect(links.has(HLINK)).toBe(false);
    expect(entryFor(r.entries, HDIR)).toEqual({
      path: HDIR,
      kind: "harness-not-installed",
      harnessDir: HDIR,
    });
    expect(r.entries.some((e) => isSkillLinkFailure(e.kind))).toBe(false);
  });

  it("repairs a broken harness link and preserves a valid one", () => {
    const broken = makeFakeFs({
      dirs: [...PKG_TREE.dirs, "/sbxroot/home/.claude", HDIR],
      links: { [HLINK]: "/sbxroot/gone/junco-dispatch" },
    });
    const r = ensureSkillLinks(cfgWith([HDIR]), broken.deps);
    expect(broken.links.get(HLINK)).toBe(join(MOUNT, SKILL_DIR_NAME));
    expect(entryFor(r.entries, HLINK)).toEqual({
      path: HLINK,
      kind: "repaired",
      harnessDir: HDIR,
    });
  });

  it("collects a symlink-failed entry (never throws) when symlink creation fails", () => {
    const { deps } = makeFakeFs(PKG_TREE);
    const failing: SkillLinksDeps = {
      ...deps,
      symlinkFn: () => {
        throw new Error("EPERM: operation not permitted");
      },
    };
    const r = ensureSkillLinks(cfgWith([]), failing);
    const mountEntry = entryFor(r.entries, MOUNT);
    expect(mountEntry?.kind).toBe("symlink-failed");
    expect(mountEntry?.detail).toContain("EPERM");
  });

  it("collects a repair-failed entry when the unlink step throws", () => {
    const broken = makeFakeFs({
      dirs: [...PKG_TREE.dirs, "/sbxroot/home/.claude", HDIR],
      links: { [HLINK]: "/sbxroot/gone/junco-dispatch" },
    });
    const failing: SkillLinksDeps = {
      ...broken.deps,
      unlinkFn: () => {
        throw new Error("EBUSY: resource busy");
      },
    };
    const r = ensureSkillLinks(cfgWith([HDIR]), failing);
    expect(entryFor(r.entries, HLINK)).toEqual({
      path: HLINK,
      kind: "repair-failed",
      harnessDir: HDIR,
      detail: expect.stringContaining("EBUSY"),
    });
  });

  it("collects a mkdir-failed entry, keyed on the harness dir, when mkdir throws", () => {
    const { deps } = makeFakeFs({ dirs: [...PKG_TREE.dirs, "/sbxroot/home/.claude"] });
    const failing: SkillLinksDeps = {
      ...deps,
      mkdirFn: () => {
        throw new Error("EACCES: permission denied");
      },
    };
    const r = ensureSkillLinks(cfgWith([HDIR]), failing);
    expect(entryFor(r.entries, HDIR)).toEqual({
      path: HDIR,
      kind: "mkdir-failed",
      harnessDir: HDIR,
      detail: expect.stringContaining("EACCES"),
    });
    // Never attempted the link once mkdir failed.
    expect(entryFor(r.entries, HLINK)).toBeUndefined();
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

describe("sameHarnessDir", () => {
  it("matches a tilde spelling against its expanded form", () => {
    expect(sameHarnessDir("~/.claude/skills", join(homedir(), ".claude/skills"))).toBe(true);
  });
  it("matches identical spellings", () => {
    expect(sameHarnessDir("~/.claude/skills", "~/.claude/skills")).toBe(true);
  });
  it("does not match different directories", () => {
    expect(sameHarnessDir("~/.claude/skills", "~/.codex/skills")).toBe(false);
  });
});

describe("isSkillLinkFailure", () => {
  it("is true for every failure kind and false for the rest", () => {
    expect(isSkillLinkFailure("target-missing")).toBe(true);
    expect(isSkillLinkFailure("symlink-failed")).toBe(true);
    expect(isSkillLinkFailure("occupied")).toBe(true);
    expect(isSkillLinkFailure("repair-failed")).toBe(true);
    expect(isSkillLinkFailure("mkdir-failed")).toBe(true);
    expect(isSkillLinkFailure("created")).toBe(false);
    expect(isSkillLinkFailure("repaired")).toBe(false);
    expect(isSkillLinkFailure("ok")).toBe(false);
    expect(isSkillLinkFailure("harness-not-installed")).toBe(false);
  });
});

describe("renderSkillLinkEntry", () => {
  // Reword-invariance: renderSkillLinkEntry is the ONE place prose lives now,
  // so a reworded `detail` must change only the rendered text — never the
  // `kind`/`path`/`harnessDir` a caller decides behavior on. This is exactly
  // the fragility structured entries replace (skillCmd used to prefix/suffix
  // match this same prose for its exit code and print prefix).
  it("changing detail text changes only the rendered string, not the entry's kind/path/harnessDir", () => {
    const base: SkillLinkEntry = {
      path: "/h/skills/junco-dispatch",
      kind: "symlink-failed",
      harnessDir: "/h/skills",
      detail: "EPERM: operation not permitted",
    };
    const reworded: SkillLinkEntry = { ...base, detail: "permission denied by the OS" };
    expect(renderSkillLinkEntry(base)).not.toBe(renderSkillLinkEntry(reworded));
    expect(base.kind).toBe(reworded.kind);
    expect(base.path).toBe(reworded.path);
    expect(base.harnessDir).toBe(reworded.harnessDir);
    expect(isSkillLinkFailure(base.kind)).toBe(isSkillLinkFailure(reworded.kind));
  });

  it("renders each kind with the prefix/suffix text a consumer expects", () => {
    expect(renderSkillLinkEntry({ path: "/p", kind: "created" })).toBe("/p");
    expect(renderSkillLinkEntry({ path: "/p", kind: "repaired" })).toBe("/p");
    expect(renderSkillLinkEntry({ path: "/p", kind: "ok" })).toBe("/p");
    expect(renderSkillLinkEntry({ path: "/p", kind: "harness-not-installed" })).toBe(
      "/p (harness not installed)",
    );
    expect(renderSkillLinkEntry({ path: "/p", kind: "target-missing", detail: "/t" })).toBe(
      "/p: target missing (/t)",
    );
    expect(renderSkillLinkEntry({ path: "/p", kind: "symlink-failed", detail: "EPERM" })).toBe(
      "/p: symlink failed (EPERM)",
    );
    expect(renderSkillLinkEntry({ path: "/p", kind: "occupied" })).toBe(
      "/p: occupied by a non-symlink — not touching it",
    );
    expect(renderSkillLinkEntry({ path: "/p", kind: "repair-failed", detail: "EBUSY" })).toBe(
      "/p: repair failed (EBUSY)",
    );
    expect(renderSkillLinkEntry({ path: "/p", kind: "mkdir-failed", detail: "EACCES" })).toBe(
      "/p: mkdir failed (EACCES)",
    );
  });
});
