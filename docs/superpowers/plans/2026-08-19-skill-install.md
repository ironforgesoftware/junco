# Skill Install & Runtime Skill-Link Ensure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `<dataDir>/skills` becomes a junco-managed symlink mount to the package's `skills/` dir, harness skill dirs listed in a new `skills.harnessDirs` config key get `junco-dispatch` links through it — created and self-healed at daemon start, `junco update`, the setup wizard, and a new `junco skill install` command, with a doctor check.

**Architecture:** A new pure module `src/skillLinks.ts` (registry + idempotent `ensureSkillLinks` behind a `SkillLinksDeps` seam) is called from four instantiation points. Config gains an additive `skills.harnessDirs` array (paths = standing consent). `PACKAGE_ROOT` is hoisted from `planPrompt.ts` into a shared `src/packageRoot.ts`.

**Tech Stack:** TypeScript (Node ≥22.19, ESM/NodeNext, strict), zod config schema, vitest, Ink (wizard chapter only).

**Spec:** `docs/superpowers/specs/2026-08-19-skill-install-design.md` — read it first; it carries the decisions (runtime ensure not postinstall; repair policy; consent model) this plan implements.

## Global Constraints

- Branch: `feat/skill-install` off `main`, in a worktree under `worktrees-manual/` or via `claude -w` — never under `worktrees/` (daemon-owned). The main checkout stays parked on `main`.
- Full gate before every commit claim: `npm run lint && npm run format:check && npm run typecheck && npm run build && npm test`. Capture vitest exit codes explicitly (`npx vitest run > /tmp/out 2>&1; echo "exit: $?"`) — never pipe into grep/tail.
- Run `npx prettier --write` on touched files before each commit; re-read files before editing (prettier may have reformatted them).
- No AI attribution in commits (no `Co-Authored-By: Claude`, no "Generated with" lines). Subagent commits auto-append the trailer — amend it away.
- No new dependencies. If one ever becomes necessary, exact-pin (`npm install --save-exact`).
- Never import the Pi SDK at module top level — irrelevant to these modules, but the rule stands.
- `skills/junco-dispatch/SKILL.md` is NOT touched by this plan. `tests/skill.test.ts` bans `\b(omp|pi|...)\b` there; the harness registry lives in `src/` only.
- Synthetic paths (`/sbxroot/...`) in all unit tests — no real HOME, no real harness dirs, no disk symlinks (all fs behavior faked through the deps seam).
- PR #288 (`feat/run-envelope-replay`) is open and may touch `daemon.ts` — merge `origin/main` into the branch between tasks; treat a collision found mid-plan as a course correction.

---

### Task 1: Config surface — `skills.harnessDirs`

**Files:**

- Modify: `src/types.ts` (Config interface, ~line 190 near `assess: AssessConfig`)
- Modify: `src/config.ts` (ConfigSchema ~line 396 after `assess`, `assembleConfig` ~line 640 after the `assess:` block)
- Modify: `src/configLevers.ts` (LEVERS array — bijection with ConfigSchema is test-enforced)
- Modify: `tests/helpers/config.ts` (the single full Config literal — ballast, not a seam)
- Test: `tests/config.test.ts`

**Interfaces:**

- Consumes: nothing new.
- Produces: `Config.skills: SkillsConfig` where `interface SkillsConfig { harnessDirs: string[] }` (exported from `src/types.ts`); parsed entries are `expandHome`-expanded in `assembleConfig`. Every later task reads `cfg.skills.harnessDirs`.

- [ ] **Step 1: Write the failing tests** — append to `tests/config.test.ts` (follow the file's existing fixture pattern for writing a temp config JSON and loading it; read the file's top before editing):

```ts
describe("skills config", () => {
  it("defaults skills.harnessDirs to [] when the block is absent", () => {
    // Use the file's existing write-temp-config + loadConfig pattern.
    const cfg = loadFixtureConfig({}); // minimal valid config object, no skills key
    expect(cfg.skills.harnessDirs).toEqual([]);
  });

  it("expands ~ in skills.harnessDirs", () => {
    const cfg = loadFixtureConfig({ skills: { harnessDirs: ["~/.claude/skills"] } });
    expect(cfg.skills.harnessDirs).toEqual([join(homedir(), ".claude/skills")]);
  });

  it("rejects a non-array harnessDirs", () => {
    expect(() => loadFixtureConfig({ skills: { harnessDirs: "~/.claude/skills" } })).toThrow();
  });
});
```

(`loadFixtureConfig` here stands for whatever helper the file already uses to parse an object through `parseConfigFile`/`assembleConfig` — reuse it, do not invent a parallel one.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/config.test.ts > /tmp/t1 2>&1; echo "exit: $?"`
Expected: FAIL — `cfg.skills` is undefined (type error at compile: property `skills` does not exist on `Config`).

- [ ] **Step 3: Implement**

`src/types.ts` — next to `AssessConfig`:

```ts
/** Skill-link distribution (spec 2026-08-19): harness skills dirs that get a
 * junco-dispatch symlink via <dataDir>/skills. Presence in this list is the
 * operator's standing consent — junco never writes to a dir not listed. */
export interface SkillsConfig {
  harnessDirs: string[];
}
```

and in `Config` (after `assess: AssessConfig;`):

```ts
  // Skill-link distribution (junco skill install / ensureSkillLinks).
  skills: SkillsConfig;
```

`src/config.ts` — ConfigSchema, after the `assess` block:

```ts
  skills: z
    .object({
      harnessDirs: z.array(z.string().min(1)).default([]),
    })
    .default({}),
```

`assembleConfig`, after the `assess:` mapping:

```ts
    skills: {
      harnessDirs: d.skills.harnessDirs.map(expandHome),
    },
```

`src/configLevers.ts` — LEVERS entry (bijection with the schema; place in schema order after the `assess.*` entries):

```ts
  // --- skills.* ---
  {
    path: "skills.harnessDirs",
    type: "structured",
    default: [],
    editable: false,
    reload: "restart",
    description:
      "Harness skills dirs that receive a junco-dispatch symlink (standing consent; managed by 'junco skill install' and the wizard).",
  },
```

`tests/helpers/config.ts` — ballast (after `assess: {...}` line 129), NOT a seam (tests that care pass it via the `overrides` parameter):

```ts
    skills: { harnessDirs: [] },
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/config.test.ts tests/configLevers.test.ts > /tmp/t1 2>&1; echo "exit: $?"`
Expected: PASS — including the schema↔LEVERS bijection test.

- [ ] **Step 5: Full gate, then commit**

```bash
npm run lint && npm run format:check && npm run typecheck && npm run build && npx vitest run > /tmp/gate 2>&1; echo "exit: $?"
git add src/types.ts src/config.ts src/configLevers.ts tests/helpers/config.ts tests/config.test.ts
git commit -m "feat(config): additive skills.harnessDirs key for skill-link consent list"
```

---

### Task 2: `src/packageRoot.ts` + `src/skillLinks.ts` core

**Files:**

- Create: `src/packageRoot.ts`
- Create: `src/skillLinks.ts`
- Modify: `src/planPrompt.ts:21-23` (import PACKAGE_ROOT instead of computing it)
- Modify: `src/dataTree.ts` (DataTreePaths + dataTreePaths gain `skills`; ensureDataTree does NOT mkdir it)
- Test: `tests/skillLinks.test.ts` (new), `tests/dataTree.test.ts` (one addition)

**Interfaces:**

- Consumes: `Config.skills.harnessDirs` (Task 1), `dataTreePaths(cfg)` (existing).
- Produces (all exported from `src/skillLinks.ts`, used by Tasks 3–6):
  - `HARNESS_REGISTRY: Record<string, string>` — `{ claude: "~/.claude/skills", codex: "~/.codex/skills", pi: "~/.pi/agent/skills", omp: "~/.omp/agent/skills", opencode: "~/.config/opencode/skills" }`
  - `SKILL_DIR_NAME = "junco-dispatch"`
  - `interface SkillLinksReport { created: string[]; repaired: string[]; skipped: string[]; warnings: string[] }`
  - `interface SkillLinksDeps { lstatFn?; existsFn?; symlinkFn?; unlinkFn?; mkdirFn?; packageSkillsDirFn? }` (exact shapes in Step 3)
  - `ensureSkillLinks(cfg: Config, deps?: SkillLinksDeps): SkillLinksReport`
  - `detectInstalledHarnesses(existsFn?: (p: string) => boolean): { name: string; dir: string }[]`
  - From `src/packageRoot.ts`: `PACKAGE_ROOT: string`, `packageSkillsDir(): string`
  - From `src/dataTree.ts`: `DataTreePaths.skills: string` (`join(dataDir, "skills")`, both layouts)

- [ ] **Step 1: Verify the opencode registry path.** Before writing the registry, check opencode's current docs for its global skills directory (`https://opencode.ai/docs` or the GitHub README). If it differs from `~/.config/opencode/skills`, use the documented path and update the spec table's row. Record what you found in the commit message body. Do not skip this — the spec explicitly defers this verification to implementation.

- [ ] **Step 2: Write the failing tests** — `tests/skillLinks.test.ts`. The fake fs lives in this test file (a Map-based model with symlink-chain resolution):

```ts
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
```

And in `tests/dataTree.test.ts`, one assertion in the existing paths describe (follow its fixture idiom):

```ts
it("exposes skills as <root>/skills in both layouts", () => {
  // both "flat" and "v2" fixtures: dataTreePaths(cfg).skills === join(root, "skills")
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run tests/skillLinks.test.ts > /tmp/t2 2>&1; echo "exit: $?"`
Expected: FAIL — module `../src/skillLinks.js` does not exist.

- [ ] **Step 4: Implement**

`src/packageRoot.ts`:

```ts
/**
 * The installed package's root directory (one level above dist/ at runtime,
 * one above src/ under vitest) — the anchor for packaged assets: skills/,
 * templates/, examples/. Hoisted from planPrompt.ts so skillLinks.ts and
 * planPrompt.ts can never disagree about where the package lives.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The packaged skills/ dir — the content source every skill link resolves to. */
export function packageSkillsDir(): string {
  return join(PACKAGE_ROOT, "skills");
}
```

`src/planPrompt.ts` — delete the local `PACKAGE_ROOT` const (line 21) and import it: `import { PACKAGE_ROOT } from "./packageRoot.js";` (keep `TEMPLATE_PATH`/`EXAMPLE_PATH` derivations unchanged).

`src/dataTree.ts` — add to `DataTreePaths`:

```ts
  skills: string; // <root>/skills symlink mount -> packaged skills/ (skillLinks.ts owns it)
```

and in `dataTreePaths()` (root-level in both layouts, like `watchlistFile`):

```ts
    skills: join(r, "skills"),
```

Do NOT add it to `ensureDataTree`'s `dirs` list — a mkdir'd real directory there would permanently block the symlink ("occupied by a non-symlink"). Add a comment on the `dirs` array saying exactly that.

`src/skillLinks.ts`:

```ts
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
```

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run tests/skillLinks.test.ts tests/dataTree.test.ts tests/planPrompt.test.ts > /tmp/t2 2>&1; echo "exit: $?"`
Expected: PASS (`tests/planPrompt.test.ts` exists and confirms the PACKAGE_ROOT hoist broke nothing).

- [ ] **Step 6: Full gate, then commit**

```bash
git add src/packageRoot.ts src/skillLinks.ts src/planPrompt.ts src/dataTree.ts tests/skillLinks.test.ts tests/dataTree.test.ts
git commit -m "feat(skills): skillLinks core — registry, idempotent ensure, detection"
```

(Body: note the verified opencode path and its source.)

---

### Task 3: Instantiate at daemon start and `junco update`

**Files:**

- Modify: `src/daemon.ts` (the startup path that calls `ensureDataTree` — `defaultMkdirs`, ~line 318; read the surrounding mainLoop deps shape first)
- Modify: `src/updateCmd.ts` (after successful install, before drain-restart, ~line 108)
- Test: `tests/daemon.test.ts`, `tests/updateCmd.test.ts`

**Interfaces:**

- Consumes: `ensureSkillLinks`, `SkillLinksReport` (Task 2).
- Produces: `ensureSkillLinksFn?: (cfg: Config) => SkillLinksReport` seam on the daemon's startup deps and on `UpdateCmdDeps` (exact seam names below — later tasks don't depend on them, but tests do).

- [ ] **Step 1: Write the failing tests.** In `tests/daemon.test.ts`, find the existing startup/mainLoop test that fakes `mkdirs`/`ensureDataTree` and add (following its deps idiom exactly — read it first; scheduler tests need the real-tick sleep, see Global Constraints):

```ts
it("runs ensureSkillLinks once at startup, after the data tree ensure", async () => {
  const calls: string[] = [];
  // thread into the same deps object the existing startup test builds:
  //   mkdirs: () => calls.push("tree"),
  //   ensureSkillLinksFn: () => { calls.push("links"); return { created: [], repaired: [], skipped: [], warnings: [] }; },
  // ...run one startup cycle the way the neighboring test does...
  expect(calls).toEqual(["tree", "links"]);
});
```

In `tests/updateCmd.test.ts` (its deps are already fully seamed — follow the existing success-path test):

```ts
it("re-ensures skill links after a successful install", async () => {
  let ensured = 0;
  const code = await runUpdateCommand("/sbxroot/config.json", {
    ...successPathDeps, // the existing fixture that gets past check+install
    ensureSkillLinksFn: () => {
      ensured++;
      return { created: ["/sbxroot/data/skills"], repaired: [], skipped: [], warnings: [] };
    },
  });
  expect(code).toBe(0);
  expect(ensured).toBe(1);
});

it("does not ensure links when npm install fails", async () => {
  let ensured = 0;
  const code = await runUpdateCommand("/sbxroot/config.json", {
    ...failedInstallDeps,
    ensureSkillLinksFn: () => {
      ensured++;
      return { created: [], repaired: [], skipped: [], warnings: [] };
    },
  });
  expect(code).toBe(1);
  expect(ensured).toBe(0);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/daemon.test.ts tests/updateCmd.test.ts > /tmp/t3 2>&1; echo "exit: $?"`
Expected: FAIL — `ensureSkillLinksFn` is not a known dep on either module.

- [ ] **Step 3: Implement.** `src/daemon.ts`: add `ensureSkillLinksFn?: (cfg: Config) => SkillLinksReport` to the startup deps interface next to the `mkdirs` seam; in the startup sequence, immediately after the data-tree ensure:

```ts
const linkReport = (deps.ensureSkillLinksFn ?? ensureSkillLinks)(cfg);
if (linkReport.created.length + linkReport.repaired.length + linkReport.warnings.length > 0) {
  log("info", "skill links ensured", {
    created: linkReport.created,
    repaired: linkReport.repaired,
    warnings: linkReport.warnings,
  });
}
```

(Adapt the `log(...)` call to daemon.ts's actual logging signature from `./logging.js` — match a neighboring call verbatim. All-quiet runs log nothing.)

`src/updateCmd.ts`: add `ensureSkillLinksFn?: (cfg: Config) => SkillLinksReport;` to `UpdateCmdDeps`; after the npm-install success check (post line 108) and the version verify, before drain-restart:

```ts
  // Re-ensure skill links against the NEW package (the mount may have been
  // created by an older version; a fresh npm root never changes the path,
  // but a broken chain heals here rather than at next daemon start).
  const links = (deps.ensureSkillLinksFn ?? ensureSkillLinks)(cfg);
  for (const c of links.created) print(`skill link created: ${c}\n`);
  for (const r of links.repaired) print(`skill link repaired: ${r}\n`);
  for (const w of links.warnings) errPrint(`skill link warning: ${w}\n`);
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/daemon.test.ts tests/updateCmd.test.ts > /tmp/t3 2>&1; echo "exit: $?"`
Expected: PASS.

- [ ] **Step 5: Full gate, then commit**

```bash
git add src/daemon.ts src/updateCmd.ts tests/daemon.test.ts tests/updateCmd.test.ts
git commit -m "feat(skills): ensure skill links at daemon startup and after junco update"
```

---

### Task 4: `junco skill install` command

**Files:**

- Create: `src/skillCmd.ts`
- Modify: `src/cli.ts` (usage text; `parseCli` options ~line 241: add `harness: { type: "string", multiple: true }`; subcommand dispatch — insert a `skill` block near `assess`, ~line 680 pattern)
- Test: `tests/skillCmd.test.ts` (new), `tests/cli.test.ts` (wiring, following its existing subcommand-dispatch test idiom)

**Interfaces:**

- Consumes: `HARNESS_REGISTRY`, `SKILL_DIR_NAME`, `ensureSkillLinks` (Task 2); `expandHome`, `loadConfig` (existing); `getAtPath`/`setAtPath` from `src/configLevers.ts`.
- Produces: `runSkillInstallCommand(configPath: string, opts: { harness: string[] }, deps?: SkillCmdDeps): Promise<number>` and `resolveHarnessArg(arg: string): { dir: string } | { error: string }` — exported from `src/skillCmd.ts`.

- [ ] **Step 1: Write the failing tests** — `tests/skillCmd.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { runSkillInstallCommand, resolveHarnessArg } from "../src/skillCmd.js";
import { makeConfig, READ_ONLY_TOOLS } from "./helpers/config.js";

const seams = {
  dataDir: "/sbxroot/data",
  queueRoot: "/sbxroot/data/queue",
  worktreeRoot: "/sbxroot/data/worktrees",
  tools: READ_ONLY_TOOLS,
  criticEnabled: false,
  planLintEnabled: false,
  verifyEnabled: false,
  supervisorEnabled: false,
  healthEnabled: false,
  removeWorktreeOnSuccess: true,
};

describe("resolveHarnessArg", () => {
  it("resolves registry names and passes paths through", () => {
    expect(resolveHarnessArg("claude")).toEqual({ dir: "~/.claude/skills" });
    expect(resolveHarnessArg("~/custom/skills")).toEqual({ dir: "~/custom/skills" });
    expect(resolveHarnessArg("/abs/skills")).toEqual({ dir: "/abs/skills" });
  });
  it("rejects an unknown bare name, listing the registry", () => {
    const r = resolveHarnessArg("cursor");
    expect("error" in r && r.error).toMatch(/unknown harness 'cursor'.*claude.*codex.*omp/s);
  });
});

describe("runSkillInstallCommand", () => {
  function harness(rawConfig: object, harnessDirs: string[] = []) {
    const out: string[] = [];
    const writes: Record<string, string> = {};
    let renamed: [string, string] | null = null;
    const deps = {
      printFn: (s: string) => out.push(s),
      readFileFn: () => JSON.stringify(rawConfig),
      writeFileFn: (p: string, s: string) => {
        writes[p] = s;
      },
      renameFn: (a: string, b: string) => {
        renamed = [a, b];
      },
      loadConfigFn: () => makeConfig(seams, { skills: { harnessDirs } }),
      ensureFn: () => ({ created: [], repaired: [], skipped: [], warnings: [] }),
    };
    return { out, writes, deps, renamedRef: () => renamed };
  }

  it("no args: ensures from config without touching the config file", async () => {
    const h = harness({});
    const code = await runSkillInstallCommand("/sbxroot/config.json", { harness: [] }, h.deps);
    expect(code).toBe(0);
    expect(Object.keys(h.writes)).toEqual([]);
  });

  it("--harness claude persists the registry dir and ensures", async () => {
    const h = harness({ model: { id: "m" } });
    const code = await runSkillInstallCommand(
      "/sbxroot/config.json",
      { harness: ["claude"] },
      h.deps,
    );
    expect(code).toBe(0);
    const [tmpPath, written] = Object.entries(h.writes)[0];
    expect(tmpPath).toContain(".config.json.tmp-");
    expect(JSON.parse(written).skills.harnessDirs).toEqual(["~/.claude/skills"]);
    expect(JSON.parse(written).model.id).toBe("m"); // untouched keys preserved
    expect(h.renamedRef()).toEqual([tmpPath, "/sbxroot/config.json"]);
  });

  it("does not duplicate an already-configured dir", async () => {
    const h = harness({ skills: { harnessDirs: ["~/.claude/skills"] } }, ["~/.claude/skills"]);
    const code = await runSkillInstallCommand(
      "/sbxroot/config.json",
      { harness: ["claude"] },
      h.deps,
    );
    expect(code).toBe(0);
    expect(Object.keys(h.writes)).toEqual([]); // no-op write skipped
  });

  it("unknown name: usage error, nothing written or ensured", async () => {
    let ensured = 0;
    const h = harness({});
    h.deps.ensureFn = () => {
      ensured++;
      return { created: [], repaired: [], skipped: [], warnings: [] };
    };
    const code = await runSkillInstallCommand(
      "/sbxroot/config.json",
      { harness: ["cursor"] },
      h.deps,
    );
    expect(code).toBe(2);
    expect(ensured).toBe(0);
  });

  it("exit 1 when an explicitly requested link ends in a warning", async () => {
    const h = harness({}, ["/sbxroot/home/.claude/skills"]);
    h.deps.ensureFn = () => ({
      created: [],
      repaired: [],
      skipped: [],
      warnings: [
        join("/sbxroot/home/.claude/skills", "junco-dispatch") + ": symlink failed (EPERM)",
      ],
    });
    const code = await runSkillInstallCommand(
      "/sbxroot/config.json",
      { harness: ["/sbxroot/home/.claude/skills"] },
      h.deps,
    );
    expect(code).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/skillCmd.test.ts > /tmp/t4 2>&1; echo "exit: $?"`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement** — `src/skillCmd.ts`:

```ts
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
 * verbatim (stored un-expanded so the config stays portable across HOMEs). */
export function resolveHarnessArg(arg: string): { dir: string } | { error: string } {
  const fromRegistry = HARNESS_REGISTRY[arg];
  if (fromRegistry !== undefined) return { dir: fromRegistry };
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
    const additions = requested.filter((d) => !known.has(expandHome(d)));
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
  for (const s of report.skipped) print(`ok:       ${s}\n`);
  for (const w of report.warnings) print(`warning:  ${w}\n`);

  // Explicitly requested links must land; config-driven warnings are daemon
  // parity (exit 0). Compare on expanded paths — the report is post-expansion.
  const requestedLinks = requested.map((d) => join(expandHome(d), SKILL_DIR_NAME));
  const failedRequested = report.warnings.some((w) =>
    requestedLinks.some((p) => w.startsWith(p) || w.startsWith(dirname(p))),
  );
  return failedRequested ? 1 : 0;
}
```

`src/cli.ts`:

1. `parseCli` options: add `harness: { type: "string", multiple: true },`
2. Usage text (near the `submit`/`dispatch` lines):

```
  skill install [--harness <name|path>]...  Link the junco-dispatch skill into
                  harness skills dirs via <dataDir>/skills (names: claude,
                  codex, pi, omp, opencode); no args re-ensures configured links
```

3. Subcommand block (alongside `assess`):

```ts
  // ------------------------------------------------------------
  // skill: skill-link management (src/skillCmd.ts) — install creates the
  // <dataDir>/skills mount + consented harness links; the daemon re-ensures
  // the same set at every startup.
  // ------------------------------------------------------------
  if (subcommand === "skill") {
    if (positionals[1] === "install") {
      const { runSkillInstallCommand } = await import("./skillCmd.js");
      const harness = (values.harness as string[] | undefined) ?? [];
      return runSkillInstallCommand(configPath, { harness }, { printFn });
    }
    process.stderr.write(`Usage: junco skill install [--harness <name|path>]...\n`);
    return 2;
  }
```

In `tests/cli.test.ts`, add a wiring test following the file's existing dispatch-mock idiom (assert `junco skill install --harness claude` reaches `runSkillInstallCommand` with `{ harness: ["claude"] }`, and bare `junco skill` exits 2).

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/skillCmd.test.ts tests/cli.test.ts > /tmp/t4 2>&1; echo "exit: $?"`
Expected: PASS.

- [ ] **Step 5: Full gate, then commit**

```bash
git add src/skillCmd.ts src/cli.ts tests/skillCmd.test.ts tests/cli.test.ts
git commit -m "feat(cli): junco skill install — resolve, consent-persist, ensure"
```

---

### Task 5: Doctor check

**Files:**

- Modify: `src/doctor.ts` (inside the `if (cfg)` block, after the 2c legacy-worktree check; `DoctorDeps` may need an `lstatFn` seam)
- Test: `tests/doctor.test.ts`

**Interfaces:**

- Consumes: `dataTreePaths(cfg).skills`, `SKILL_DIR_NAME` (Task 2), `cfg.skills.harnessDirs` (Task 1), doctor's existing `existsFn` seam.
- Produces: a `skill links` doctor line — `ok` when every applicable link resolves, `warn` naming dead/blocked paths with the `junco skill install` hint. Never `fail`.

- [ ] **Step 1: Write the failing tests.** In `tests/doctor.test.ts`, extend the existing fixture (it already fakes `loadConfigFn` + `existsFn`):

```ts
it("reports ok skill links when mount and configured links resolve", async () => {
  // cfg fixture: skills.harnessDirs = ["/sbxroot/home/.claude/skills"]
  // existsFn returns true for: <dataDir>/skills, /sbxroot/home/.claude,
  //   /sbxroot/home/.claude/skills/junco-dispatch
  // expect output line matching /✓ skill links/
});

it("warns on a dead skill link and points at junco skill install", async () => {
  // existsFn false for <dataDir>/skills/junco-dispatch chain
  // expect /⚠ skill links.*junco skill install/
});

it("skips harness dirs whose parent does not exist (not installed here)", async () => {
  // harnessDirs parent absent; mount healthy → still ✓ (roaming config)
});
```

(Write them as real tests against the file's actual harness — read its `runDoctor` invocation pattern first; the comments above are the required behaviors, not placeholders to leave in.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/doctor.test.ts > /tmp/t5 2>&1; echo "exit: $?"`
Expected: FAIL — no `skill links` line in doctor output.

- [ ] **Step 3: Implement** — in `src/doctor.ts` after check 2c:

```ts
    // 2d. skill links (spec 2026-08-19): the <dataDir>/skills mount plus each
    // configured harness link must RESOLVE (existsSync follows symlinks, so a
    // broken link reads as absent). Harness dirs whose parent is missing are
    // skipped — a config roams between machines, and an uninstalled harness
    // is not a defect. warn (never fail): the daemon self-heals at startup,
    // and 'junco skill install' does it on demand.
    const skillLinks = [
      dataTreePaths(cfg).skills,
      ...cfg.skills.harnessDirs
        .filter((d) => existsFn(dirname(d)))
        .map((d) => join(d, SKILL_DIR_NAME)),
    ];
    const deadLinks = skillLinks.filter((p) => !existsFn(p));
    if (deadLinks.length === 0) {
      report("ok", "skill links", `${skillLinks.length} link(s) resolve`);
    } else {
      report(
        "warn",
        "skill links",
        `${deadLinks.join(", ")} — run 'junco skill install' (or start the daemon) to create/repair`,
      );
    }
```

(Imports: `dataTreePaths` is already available or added; `SKILL_DIR_NAME` from `./skillLinks.js`; `dirname`/`join` from `node:path`.)

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/doctor.test.ts > /tmp/t5 2>&1; echo "exit: $?"`
Expected: PASS.

- [ ] **Step 5: Full gate, then commit**

```bash
git add src/doctor.ts tests/doctor.test.ts
git commit -m "feat(doctor): skill-links resolution check"
```

---

### Task 6: Wizard step

**Files:**

- Modify: `src/wizard/flow.ts` (`WizardAnswers`, `defaultAnswers`, `buildConfigObject`, `coveredPaths`, `answersFromConfig`)
- Modify: `src/wizard/io.ts` (`WizardIO` gains `detectedHarnesses`)
- Modify: `src/wizard.ts` (`buildWizardIO` populates it; the `write` closure runs ensure; `WizardDeps` gains `ensureSkillLinksFn`)
- Create: `src/tui/wizard/chapters/Skills.tsx`
- Modify: `src/tui/wizard/WizardApp.tsx` (import + render), `src/wizard/flow.ts` `CHAPTERS` (insert `"Skills"` between `"Extras"` and `"Review"`)
- Modify: `src/wizard/tips.ts` (a `TIPS.skills` entry — match the file's existing tone)
- Test: `tests/wizardFlow.test.ts`, `tests/wizard.test.ts`, `tests/wizardChapters.test.tsx`

**Interfaces:**

- Consumes: `detectInstalledHarnesses` (Task 2), `ensureSkillLinks` (Task 2), `skills.harnessDirs` write shape (Task 1).
- Produces: `WizardAnswers.harnessDirs: string[]`; `WizardIO.detectedHarnesses: { name: string; dir: string }[]`; chapter `Skills` rendered between Extras and Review.

- [ ] **Step 1: Write the failing flow tests** — `tests/wizardFlow.test.ts` additions (follow the file's describe structure):

```ts
describe("skills harnessDirs answers", () => {
  it("defaults to [] and writes no skills key when empty", () => {
    const a = defaultAnswers();
    expect(a.harnessDirs).toEqual([]);
    expect(buildConfigObject(a)).not.toHaveProperty("skills");
  });

  it("materializes skills.harnessDirs when chosen", () => {
    const a = { ...defaultAnswers(), harnessDirs: ["~/.claude/skills"] };
    expect(buildConfigObject(a)).toMatchObject({
      skills: { harnessDirs: ["~/.claude/skills"] },
    });
  });

  it("round-trips through answersFromConfig and is diffed/applied on rerun", () => {
    const raw = { model: { id: "m" }, skills: { harnessDirs: ["~/.omp/agent/skills"] } };
    expect(answersFromConfig(raw).harnessDirs).toEqual(["~/.omp/agent/skills"]);
    const changed = { ...answersFromConfig(raw), harnessDirs: ["~/.omp/agent/skills", "~/.claude/skills"] };
    const next = applyAnswers(raw, changed);
    expect(next.skills).toEqual({ harnessDirs: ["~/.omp/agent/skills", "~/.claude/skills"] });
    expect(next.model).toEqual({ id: "m" }); // untouched keys preserved
  });
});
```

Note: `COVERED_LEVER_COUNT` increments by one — find any test pinning it (grep `COVERED_LEVER_COUNT` in tests) and update the pin deliberately, stating the new count.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/wizardFlow.test.ts > /tmp/t6 2>&1; echo "exit: $?"`
Expected: FAIL — `harnessDirs` missing from `WizardAnswers`.

- [ ] **Step 3: Implement flow + IO.** `src/wizard/flow.ts`:

- `WizardAnswers`: add `/** Harness skills dirs to link (skills.harnessDirs); [] = write no key. */ harnessDirs: string[];`
- `defaultAnswers()`: `harnessDirs: []` (the `--yes` path links nothing — consent needs an interactive choice).
- `buildConfigObject()`: `if (a.harnessDirs.length > 0) obj.skills = { harnessDirs: a.harnessDirs };`
- `coveredPaths()`: append `{ path: "skills.harnessDirs", value: a.harnessDirs },`
- `answersFromConfig()`: `harnessDirs: (g("skills.harnessDirs") as string[]) ?? [],`
- `CHAPTERS`: insert `"Skills"` between `"Extras"` and `"Review"`.

`src/wizard/io.ts` — on `WizardIO`:

```ts
  /** Registry harnesses that look installed on THIS machine (parent of the
   * skills dir exists) — the Skills chapter's option list. */
  detectedHarnesses: { name: string; dir: string }[];
```

`src/wizard.ts` — `WizardDeps` gains `ensureSkillLinksFn?: (cfg: Config) => SkillLinksReport;`; `buildWizardIO`:

- populate `detectedHarnesses: detectInstalledHarnesses(existsFn),` in the `io` literal;
- in the `write` closure, after `const queueRoot = ensureDirs(loadConfigFn(resolved));` add:

```ts
      // Skill links ride config-init: consent was just written (or confirmed)
      // by the Skills chapter, so materialize it now rather than at first
      // daemon start. Warnings are non-fatal by ensureSkillLinks contract.
      (deps.ensureSkillLinksFn ?? ensureSkillLinks)(loadConfigFn(resolved));
```

Add a `tests/wizard.test.ts` case: fresh-mode `write` with `harnessDirs: ["~/.claude/skills"]` calls the injected `ensureSkillLinksFn` once and writes the `skills` block (follow the file's existing `buildWizardIO` fixture).

- [ ] **Step 4: Implement the chapter.** `src/tui/wizard/chapters/Skills.tsx`, modeled line-for-line on `Extras.tsx` (same `MultiSelect`, `Tip`, footer-description structure):

```tsx
/** Chapter 6 — skill distribution: which detected harnesses get the
 * junco-dispatch skill linked (skills.harnessDirs consent list). Options are
 * the registry harnesses whose home dir exists on this machine; none detected
 * renders a note and continues. */
import React from "react";
import { Box, Text, useInput } from "ink";
import { Tip, MultiSelect, type ChapterProps } from "../controls.js";
import { TIPS } from "../../../wizard/tips.js";

export function Skills({
  answers,
  patch,
  onNext,
  detectedHarnesses,
}: ChapterProps & { detectedHarnesses: { name: string; dir: string }[] }): React.JSX.Element {
  // No known harness on this machine: nothing to consent to — plain continue.
  useInput((_i, key) => {
    if (detectedHarnesses.length === 0 && key.return) onNext();
  });
  if (detectedHarnesses.length === 0) {
    return (
      <Box flexDirection="column">
        <Text>No known agent harnesses detected — skipping skill links.</Text>
        <Text dimColor>Link one later with: junco skill install --harness {"<name|path>"}</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      <Text>Link the junco-dispatch skill into these harnesses? (space toggles, enter continues)</Text>
      <Box marginTop={1}>
        <MultiSelect
          focus
          items={detectedHarnesses.map((h) => ({
            value: h.dir,
            label: `${h.name}  (${h.dir})`,
            // Pre-check: already-consented dirs on rerun; everything detected on
            // a fresh run (the operator still confirms with enter).
            checked:
              answers.harnessDirs.length > 0 ? answers.harnessDirs.includes(h.dir) : true,
          }))}
          onSubmit={(vals) => {
            patch({ harnessDirs: vals });
            onNext();
          }}
        />
      </Box>
      <Tip>{TIPS.skills}</Tip>
    </Box>
  );
}
```

(Adapt the exact `ChapterProps`/`MultiSelect` prop shapes to `controls.tsx` — read it first; if `MultiSelect` requires `onFocusChange`, wire a no-op or a footer as Extras does.) Wire into `WizardApp.tsx` in chapter order (import + `<Skills {...chapterProps} detectedHarnesses={io.detectedHarnesses} />` — match how WizardApp threads `io`), add `TIPS.skills` to `src/wizard/tips.ts` (e.g. `"Skills teach coding agents to write well-formed junco tickets — links live under <dataDir>/skills."`).

Add a `tests/wizardChapters.test.tsx` case per that file's Ink render idiom: with two detected harnesses, both render checked on fresh answers; submitting patches `harnessDirs` with both dirs. **Ink gotcha:** never assert one `setTimeout` tick after a state change — loop-until-condition with bounded retries.

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run tests/wizardFlow.test.ts tests/wizard.test.ts tests/wizardChapters.test.tsx tests/wizardApp.test.tsx > /tmp/t6 2>&1; echo "exit: $?"`
Expected: PASS (wizardApp tests may pin the chapter rail — update pins for the new "Skills" chapter deliberately).

- [ ] **Step 6: Full gate, then commit**

```bash
git add src/wizard src/wizard.ts src/tui/wizard tests/wizardFlow.test.ts tests/wizard.test.ts tests/wizardChapters.test.tsx tests/wizardApp.test.tsx
git commit -m "feat(wizard): Skills chapter — detect harnesses, consent, link at write"
```

---

### Task 7: Docs

**Files:**

- Modify: `docs/configuration.md` (the `skills` block, next to the other optional blocks)
- Modify: `docs/tickets.md:101` (replace the bare "bundled skill" sentence with the install command)
- Modify: `README.md` (one line under installation/quickstart)
- Test: none (prose) — but run the full gate anyway (format:check covers these files).

**Interfaces:** consumes the final CLI surface from Tasks 4–6; produces no code.

- [ ] **Step 1: Write the docs.**

`docs/configuration.md` — add alongside the other optional config blocks:

```markdown
### `skills`

| Key                  | Default | Effect                                                                                                                                                                     |
| -------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `skills.harnessDirs` | `[]`    | Harness skills directories that receive a `junco-dispatch` symlink (via the `<dataDir>/skills` mount). Listing a dir is standing consent; links self-heal at daemon start. |

Managed by `junco skill install --harness <name|path>` (names: `claude`, `codex`, `pi`,
`omp`, `opencode`) and the setup walkthrough's Skills step. Junco never writes into a
harness directory not listed here.
```

`docs/tickets.md` — replace line 101's sentence with:

```markdown
The bundled `junco-dispatch` skill teaches coding agents (Claude Code and other
skills-capable harnesses) to scaffold well-structured tickets and submit them. Link it
into your harness once with `junco skill install --harness <name|path>`; the daemon
re-checks and self-heals the links at every start.
```

README — one line in the setup section (match surrounding voice):

```markdown
junco skill install --harness claude   # link the junco-dispatch skill into your agent harness
```

- [ ] **Step 2: Full gate, then commit**

```bash
npm run lint && npm run format:check && npm run typecheck && npm run build && npx vitest run > /tmp/gate 2>&1; echo "exit: $?"
git add docs/configuration.md docs/tickets.md README.md
git commit -m "docs: skill install command, skills.harnessDirs config key"
```

---

### Final verification (before PR)

- [ ] `git merge origin/main` (PR #288 may have landed) — resolve, full gate again.
- [ ] Sandboxed smoke test (NEVER with real HOME — this checkout is the maintainer's live runtime):

```bash
SB=$(mktemp -d) && cd "$SB" && HOME="$SB" XDG_CONFIG_HOME="$SB/.config" \
  node /path/to/checkout/dist/cli.js config init --yes && \
  mkdir -p "$SB/.claude" && \
  HOME="$SB" node /path/to/checkout/dist/cli.js skill install --harness claude && \
  ls -la "$SB/.junco/skills" "$SB/.claude/skills/junco-dispatch" && \
  HOME="$SB" node /path/to/checkout/dist/cli.js doctor | grep "skill links" ; cd / && rm -rf "$SB"
```

Expected: mount symlink → the checkout's `skills/`; harness link → `$SB/.junco/skills/junco-dispatch`; doctor line `✓ skill links`. (Adjust `config init --yes` to the CLI's actual non-interactive init form — check `--help` first.)

- [ ] Commit any smoke-test-revealed fix, full gate, open PR `feat/skill-install` with the spec + plan files included.
