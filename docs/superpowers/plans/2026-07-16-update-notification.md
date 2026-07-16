# Update Notification + `junco update` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Passive npm update check (dashboard chip, `status` line, `doctor` row) plus a `junco update` command that installs the latest release and drain-restarts the daemon.

**Architecture:** A pure `src/updateCheck.ts` module (deps-injected fetch/fs/clock) reads a 24h cache at `<dataDir>/update-check.json` and hits `registry.npmjs.org/<name>/latest` when stale; every human surface (TUI, status, doctor) calls it. `src/updateCmd.ts` composes it with `npm install -g` and the existing `runRestartCommand` drain-and-kickstart path. The daemon is untouched.

**Tech Stack:** TypeScript strict ESM/NodeNext, Node ≥ 22.19, vitest, ink 7 + ink-testing-library, zod config schema. **No new dependencies.**

**Spec:** `docs/superpowers/specs/2026-07-16-update-notification-design.md`

## Global Constraints

- Node ≥ 22.19; ESM/NodeNext; `npm run build` compiles `src/` only.
- Dependencies are exact-pinned; this plan adds **zero** dependencies (hand-rolled semver compare).
- Every side effect goes behind an injectable `*Deps` seam; tests never touch the network or real npm registry.
- Package name and version are **never hardcoded** in `src/` — always read from junco's own `package.json` (fork-friendly, stack-agnostic).
- Ink/TUI tests: never assert a fixed timer tick — use `until()` from `tests/helpers/until.ts`.
- Conventional commits; suite green at every commit; **no AI attribution trailers** (amend them away if a subagent adds one).
- Run `npx prettier --write` on touched files before each commit; re-read files before editing if prettier may have reformatted them.
- Vitest exit-code trap: never pipe vitest through a filter — `npx vitest run tests/x.test.ts > /tmp/out 2>&1; echo "exit: $?"`.
- Working branch: `feat/update-notification` (already exists, spec committed).

---

### Task 1: `updateCheck.ts` core — `getSelfPackage` + `compareVersions`

**Files:**

- Create: `src/updateCheck.ts`
- Create: `tests/updateCheck.test.ts`

**Interfaces:**

- Produces: `getSelfPackage(): SelfPackage` where `SelfPackage = { name: string; version: string; rootDir: string }`; `compareVersions(a: string, b: string): -1 | 0 | 1 | null`. Both consumed by Tasks 4, 5, 7, 8.

- [ ] **Step 1: Write the failing test**

```ts
// tests/updateCheck.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getSelfPackage, compareVersions } from "../src/updateCheck.js";

describe("getSelfPackage", () => {
  it("reads junco's own package.json (never hardcoded)", () => {
    const self = getSelfPackage();
    const pkg = JSON.parse(readFileSync(join(self.rootDir, "package.json"), "utf8")) as {
      name: string;
      version: string;
    };
    expect(self.name).toBe(pkg.name);
    expect(self.version).toBe(pkg.version);
    expect(self.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("compareVersions", () => {
  it("orders numeric triples", () => {
    expect(compareVersions("0.8.0", "0.7.0")).toBe(1);
    expect(compareVersions("0.7.0", "0.8.0")).toBe(-1);
    expect(compareVersions("0.7.0", "0.7.0")).toBe(0);
    expect(compareVersions("0.7.10", "0.7.9")).toBe(1);
    expect(compareVersions("1.0.0", "0.99.99")).toBe(1);
  });
  it("tolerates a leading v and surrounding whitespace", () => {
    expect(compareVersions("v0.8.0", "0.7.0")).toBe(1);
    expect(compareVersions(" 0.7.0 ", "0.7.0")).toBe(0);
  });
  it("returns null on anything unparseable (prerelease, garbage, empty)", () => {
    expect(compareVersions("0.8.0-beta.1", "0.7.0")).toBeNull();
    expect(compareVersions("0.8", "0.7.0")).toBeNull();
    expect(compareVersions("latest", "0.7.0")).toBeNull();
    expect(compareVersions("", "0.7.0")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/updateCheck.test.ts > /tmp/vt.out 2>&1; echo "exit: $?"; tail -5 /tmp/vt.out`
Expected: exit 1, "Failed to load ../src/updateCheck.js" (module does not exist).

- [ ] **Step 3: Write minimal implementation**

```ts
// src/updateCheck.ts
/**
 * Best-effort npm update check (spec 2026-07-16). CLI/TUI-side only — the
 * daemon never checks and never restarts itself. Never throws: no network
 * (or a garbage registry response) degrades to "no badge".
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface SelfPackage {
  name: string;
  version: string;
  /** Dir containing our own package.json: repo root in dev, package root installed. */
  rootDir: string;
}

/** `../package.json` relative to this module — resolves from both src/ (vitest) and dist/ (installed CLI). */
export function getSelfPackage(): SelfPackage {
  const rootDir = fileURLToPath(new URL("..", import.meta.url));
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    name: string;
    version: string;
  };
  return { name: pkg.name, version: pkg.version, rootDir };
}

/**
 * Strict X.Y.Z compare (leading `v` tolerated). Junco publishes plain semver
 * to the `latest` dist-tag; anything else → null, which every caller treats
 * as "no update available" — never a badge on garbage.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | null {
  const parse = (v: string): number[] | null => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const pa = parse(a);
  const pb = parse(b);
  if (pa === null || pb === null) return null;
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/updateCheck.test.ts > /tmp/vt.out 2>&1; echo "exit: $?"; tail -5 /tmp/vt.out`
Expected: exit 0, all tests pass.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/updateCheck.ts tests/updateCheck.test.ts
git add src/updateCheck.ts tests/updateCheck.test.ts
git commit -m "feat(update): self-package introspection + strict semver compare"
```

---

### Task 2: dataTree registration for `update-check.json`

**Files:**

- Modify: `src/dataTree.ts` (constant + `DataTreePaths` + `dataTreePaths()` + `sandboxDenyPaths()`)
- Modify: `src/dataCmd.ts` (counts interface + counts builder + `fileLine` output)
- Test: `tests/dataTree.test.ts`, `tests/dataCmd.test.ts` (extend existing suites)

**Interfaces:**

- Produces: `UPDATE_CHECK_FILENAME = "update-check.json"` and `DataTreePaths.updateCheckFile: string` (consumed by Task 4's cache path and by dataCmd).

- [ ] **Step 1: Write the failing tests**

In `tests/dataTree.test.ts`, find the existing `dataTreePaths` describe block (it asserts fields like `watchlistFile`) and add, using that block's existing `cfg` fixture:

```ts
it("registers update-check.json at the root and denies it to the sandbox", () => {
  const p = dataTreePaths(cfg);
  expect(p.updateCheckFile).toBe(join(cfg.dataDir, "update-check.json"));
  expect(sandboxDenyPaths(cfg).files).toContain(p.updateCheckFile);
});
```

In `tests/dataCmd.test.ts`, find the test asserting `watchlist.json` appears in the rendered tree and add a sibling assertion in the same style that the output contains `update-check.json`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/dataTree.test.ts tests/dataCmd.test.ts > /tmp/vt.out 2>&1; echo "exit: $?"; tail -8 /tmp/vt.out`
Expected: exit 1 — `updateCheckFile` property missing / `update-check.json` absent from output.

- [ ] **Step 3: Implement**

`src/dataTree.ts` — four edits:

```ts
// next to WATCHLIST_FILENAME:
export const UPDATE_CHECK_FILENAME = "update-check.json";

// in DataTreePaths, after watchlistFile:
updateCheckFile: string; // npm update-check cache (spec 2026-07-16)

// in dataTreePaths(), after watchlistFile:
updateCheckFile: join(r, UPDATE_CHECK_FILENAME),

// in sandboxDenyPaths().files, append:
p.updateCheckFile,
```

`src/dataCmd.ts` — three edits, each patterned on the `watchlistFile` line already present:

- In the counts interface (the one declaring `watchlistFile: FileInfo;`), add `updateCheckFile: FileInfo;`.
- In the counts-building object literal (near `watchlistFile: fileInfo(p.watchlistFile, existsFn, statFn),`), add `updateCheckFile: fileInfo(p.updateCheckFile, existsFn, statFn),`.
- After the `fileLine("watchlist.json", p.watchlistFile, counts.watchlistFile);` call, add `fileLine("update-check.json", p.updateCheckFile, counts.updateCheckFile);`.

No `ensureDataTree` change — the file is created lazily by the first successful check.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/dataTree.test.ts tests/dataCmd.test.ts > /tmp/vt.out 2>&1; echo "exit: $?"; tail -5 /tmp/vt.out`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/dataTree.ts src/dataCmd.ts tests/dataTree.test.ts tests/dataCmd.test.ts
git add -A src/dataTree.ts src/dataCmd.ts tests/dataTree.test.ts tests/dataCmd.test.ts
git commit -m "feat(update): register update-check.json in the data tree + sandbox deny"
```

---

### Task 3: `updateCheck` config lever

**Files:**

- Modify: `src/config.ts` (schema + assembly), `src/types.ts` (Config field)
- Modify: `docs/superpowers/specs/2026-07-16-update-notification-design.md` (§6.1: JSON key is camelCase `updateCheck`, matching `startupWait`/`dailyBudgetUsd` convention — the spec's `update_check` predates checking the schema)
- Test: `tests/config.test.ts` (extend)

**Interfaces:**

- Produces: `cfg.updateCheck?: boolean` (optional on `Config`; zod default `true` — consumed by Task 4's step 1 guard). Optional keeps every existing full-`Config` test fixture compiling (no makeConfig sweep).

- [ ] **Step 1: Write the failing test**

In `tests/config.test.ts`, locate the describe block exercising defaults (it asserts values like `startupWait`) and add, using that suite's existing config-file fixture helper:

```ts
it("updateCheck defaults true and honors an explicit false", () => {
  expect(loadFixture({}).updateCheck).toBe(true);
  expect(loadFixture({ updateCheck: false }).updateCheck).toBe(false);
});
```

(`loadFixture` = whatever helper that block already uses to parse a config object — reuse it verbatim; it may be named differently.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/config.test.ts > /tmp/vt.out 2>&1; echo "exit: $?"; tail -5 /tmp/vt.out`
Expected: exit 1 — `updateCheck` is `undefined`.

- [ ] **Step 3: Implement**

`src/config.ts`, in `ConfigSchema` directly under the top-level `dataDir` line:

```ts
// npm update-check opt-out (spec 2026-07-16): CLI/TUI-side only, the daemon
// never phones home either way.
updateCheck: z.boolean().default(true),
```

In the `Config` assembly return (the object starting `dataDir, queueRoot, legacy,`), add `updateCheck: d.updateCheck,`.

`src/types.ts`, in `interface Config` after `queueRoot`:

```ts
/** npm update-check opt-out (default true). Optional so test fixtures that
 * build full Config literals keep compiling; loaders always set it. */
updateCheck?: boolean;
```

Spec edit: in §6.1 replace `` `update_check?: boolean` (JSON) `` with `` `updateCheck?: boolean` (JSON, camelCase per schema convention) `` and in §2 Goals replace `update_check: false` with `updateCheck: false`.

- [ ] **Step 4: Run test + typecheck**

Run: `npx vitest run tests/config.test.ts > /tmp/vt.out 2>&1; echo "exit: $?"; tail -3 /tmp/vt.out && npm run typecheck`
Expected: both exit 0.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/config.ts src/types.ts tests/config.test.ts docs/superpowers/specs/2026-07-16-update-notification-design.md
git add src/config.ts src/types.ts tests/config.test.ts docs/superpowers/specs/2026-07-16-update-notification-design.md
git commit -m "feat(update): updateCheck config lever (default true)"
```

---

### Task 4: `checkForUpdate` — cache, fetch, backoff

**Files:**

- Modify: `src/updateCheck.ts` (append)
- Test: `tests/updateCheck.test.ts` (extend)

**Interfaces:**

- Consumes: `UPDATE_CHECK_FILENAME` (Task 2), `cfg.updateCheck` (Task 3), Task 1's functions.
- Produces: `checkForUpdate(cfg: Config, opts?: UpdateCheckOpts): Promise<UpdateInfo | null>` with `UpdateInfo = { current: string; latest: string; available: boolean }` and `UpdateCheckOpts = { forceFresh?, fetchFn?, readFileFn?, writeFileFn?, renameFn?, nowFn?, selfPkgFn? }`. Exported constants `FRESH_WINDOW_MS` (24h), `RETRY_BACKOFF_MS` (1h). Consumed by Tasks 6–9.

- [ ] **Step 1: Write the failing tests**

Append to `tests/updateCheck.test.ts`:

```ts
import type { Config } from "../src/types.js";
import {
  checkForUpdate,
  FRESH_WINDOW_MS,
  RETRY_BACKOFF_MS,
  type UpdateCheckOpts,
} from "../src/updateCheck.js";

describe("checkForUpdate", () => {
  const NOW = new Date("2026-07-16T12:00:00Z");
  const cfg = { dataDir: "/sbxroot/data", updateCheck: true } as unknown as Config;

  interface Harness {
    opts: UpdateCheckOpts;
    writes: Record<string, string>;
    fetches: string[];
  }
  /** Fake fs keyed by path; rename moves tmp → final like the real thing. */
  const harness = (o: {
    cacheJson?: string;
    registry?: { status: number; body: unknown } | "offline";
  }): Harness => {
    const writes: Record<string, string> = {};
    const fetches: string[] = [];
    const files: Record<string, string> = {};
    if (o.cacheJson !== undefined) files["/sbxroot/data/update-check.json"] = o.cacheJson;
    return {
      writes,
      fetches,
      opts: {
        nowFn: () => NOW,
        selfPkgFn: () => ({ name: "@x/junco", version: "0.7.0", rootDir: "/sbxroot/app" }),
        readFileFn: (p: string) => {
          if (files[p] === undefined) throw new Error("ENOENT");
          return files[p];
        },
        writeFileFn: (p: string, s: string) => {
          writes[p] = s;
          files[p] = s;
        },
        renameFn: (a: string, b: string) => {
          files[b] = files[a];
          writes[b] = writes[a];
        },
        fetchFn: (async (url: string | URL | Request) => {
          fetches.push(String(url));
          if (o.registry === "offline" || o.registry === undefined) throw new Error("offline");
          return {
            ok: o.registry.status === 200,
            status: o.registry.status,
            json: async () => o.registry.body,
          } as Response;
        }) as typeof fetch,
      },
    };
  };
  const iso = (msAgo: number): string => new Date(NOW.getTime() - msAgo).toISOString();

  it("fresh cache short-circuits the network and recomputes available live", async () => {
    const h = harness({
      cacheJson: JSON.stringify({ latest: "0.8.0", checkedAt: iso(60_000) }),
    });
    const r = await checkForUpdate(cfg, h.opts);
    expect(h.fetches).toEqual([]);
    expect(r).toEqual({ current: "0.7.0", latest: "0.8.0", available: true });
  });

  it("clears the moment the running version catches up (no cache-expiry wait)", async () => {
    const h = harness({
      cacheJson: JSON.stringify({ latest: "0.7.0", checkedAt: iso(60_000) }),
    });
    const r = await checkForUpdate(cfg, h.opts);
    expect(r).toEqual({ current: "0.7.0", latest: "0.7.0", available: false });
  });

  it("stale cache fetches, rewrites atomically (tmp+rename), returns fresh info", async () => {
    const h = harness({
      cacheJson: JSON.stringify({ latest: "0.7.0", checkedAt: iso(FRESH_WINDOW_MS + 1) }),
      registry: { status: 200, body: { version: "0.8.0" } },
    });
    const r = await checkForUpdate(cfg, h.opts);
    expect(h.fetches).toEqual(["https://registry.npmjs.org/@x/junco/latest"]);
    expect(r).toEqual({ current: "0.7.0", latest: "0.8.0", available: true });
    const written = JSON.parse(h.writes["/sbxroot/data/update-check.json"]) as {
      latest: string;
      checkedAt: string;
    };
    expect(written.latest).toBe("0.8.0");
    expect(h.writes["/sbxroot/data/update-check.json.tmp"]).toBeDefined();
  });

  it("offline with a stale cache serves the stale latest and stamps lastAttempt", async () => {
    const h = harness({
      cacheJson: JSON.stringify({ latest: "0.8.0", checkedAt: iso(FRESH_WINDOW_MS + 1) }),
      registry: "offline",
    });
    const r = await checkForUpdate(cfg, h.opts);
    expect(r).toEqual({ current: "0.7.0", latest: "0.8.0", available: true });
    const written = JSON.parse(h.writes["/sbxroot/data/update-check.json"]) as {
      lastAttempt: string;
    };
    expect(written.lastAttempt).toBe(NOW.toISOString());
  });

  it("offline with no cache returns null (and still stamps lastAttempt)", async () => {
    const h = harness({ registry: "offline" });
    expect(await checkForUpdate(cfg, h.opts)).toBeNull();
    expect(h.writes["/sbxroot/data/update-check.json"]).toContain("lastAttempt");
  });

  it("a recent failed attempt suppresses refetch for RETRY_BACKOFF_MS", async () => {
    const h = harness({
      cacheJson: JSON.stringify({ lastAttempt: iso(RETRY_BACKOFF_MS - 1) }),
      registry: { status: 200, body: { version: "0.8.0" } },
    });
    expect(await checkForUpdate(cfg, h.opts)).toBeNull();
    expect(h.fetches).toEqual([]);
  });

  it("garbage registry payloads are failures, not updates", async () => {
    for (const body of [{ version: "not-semver" }, { nope: 1 }, "junk"]) {
      const h = harness({ registry: { status: 200, body } });
      expect(await checkForUpdate(cfg, h.opts)).toBeNull();
    }
  });

  it("non-2xx is a failure", async () => {
    const h = harness({ registry: { status: 500, body: {} } });
    expect(await checkForUpdate(cfg, h.opts)).toBeNull();
  });

  it("corrupt cache file is treated as missing", async () => {
    const h = harness({
      cacheJson: "{not json",
      registry: { status: 200, body: { version: "0.8.0" } },
    });
    const r = await checkForUpdate(cfg, h.opts);
    expect(r?.available).toBe(true);
  });

  it("updateCheck: false short-circuits everything", async () => {
    const off = { ...cfg, updateCheck: false } as Config;
    const h = harness({ registry: { status: 200, body: { version: "9.9.9" } } });
    expect(await checkForUpdate(off, h.opts)).toBeNull();
    expect(h.fetches).toEqual([]);
  });

  it("forceFresh bypasses both the fresh window and the failure backoff", async () => {
    const h = harness({
      cacheJson: JSON.stringify({
        latest: "0.7.0",
        checkedAt: iso(60_000),
        lastAttempt: iso(60_000),
      }),
      registry: { status: 200, body: { version: "0.8.0" } },
    });
    const r = await checkForUpdate(cfg, { ...h.opts, forceFresh: true });
    expect(h.fetches.length).toBe(1);
    expect(r?.available).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/updateCheck.test.ts > /tmp/vt.out 2>&1; echo "exit: $?"; tail -5 /tmp/vt.out`
Expected: exit 1 — `checkForUpdate` not exported.

- [ ] **Step 3: Implement**

Append to `src/updateCheck.ts`:

```ts
import { writeFileSync, renameSync } from "node:fs"; // merge into the existing node:fs import
import { join } from "node:path";
import type { Config } from "./types.js";
import { UPDATE_CHECK_FILENAME } from "./dataTree.js";

export interface UpdateInfo {
  current: string; // running version
  latest: string; // newest known on the registry (possibly cache-served)
  available: boolean; // compareVersions(latest, current) === 1
}

/** All fields optional: a first-ever failed check writes just lastAttempt. */
interface UpdateCache {
  latest?: string;
  checkedAt?: string;
  lastAttempt?: string;
}

export interface UpdateCheckOpts {
  forceFresh?: boolean; // junco update: skip fresh-window AND failure backoff
  fetchFn?: typeof fetch;
  readFileFn?: (p: string) => string; // throws when absent (fs semantics)
  writeFileFn?: (p: string, s: string) => void;
  renameFn?: (from: string, to: string) => void;
  nowFn?: () => Date;
  selfPkgFn?: () => SelfPackage;
}

export const FRESH_WINDOW_MS = 24 * 60 * 60 * 1000;
export const RETRY_BACKOFF_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 2000;

/**
 * Best-effort check. Cache stores only { latest, checkedAt, lastAttempt } —
 * `available` is recomputed against the RUNNING version every call, so the
 * badge clears the instant the operator actually updates. Never throws; every
 * failure path degrades to the stale cache or null.
 */
export async function checkForUpdate(
  cfg: Config,
  opts: UpdateCheckOpts = {},
): Promise<UpdateInfo | null> {
  if (cfg.updateCheck === false) return null;
  const self = (opts.selfPkgFn ?? getSelfPackage)();
  const now = (opts.nowFn ?? (() => new Date()))();
  const readFileFn = opts.readFileFn ?? ((p: string) => readFileSync(p, "utf8"));
  const writeFileFn = opts.writeFileFn ?? ((p: string, s: string) => writeFileSync(p, s, "utf8"));
  const renameFn = opts.renameFn ?? renameSync;
  const cachePath = join(cfg.dataDir, UPDATE_CHECK_FILENAME);

  let cache: UpdateCache = {};
  try {
    cache = JSON.parse(readFileFn(cachePath)) as UpdateCache;
  } catch {
    cache = {}; // absent or corrupt — same thing
  }

  // NaN (garbage timestamp) compares false against every window → "infinitely old".
  const ageMs = (isoStamp?: string): number =>
    isoStamp === undefined ? Infinity : now.getTime() - Date.parse(isoStamp);
  const fromCache = (): UpdateInfo | null =>
    cache.latest !== undefined
      ? {
          current: self.version,
          latest: cache.latest,
          available: compareVersions(cache.latest, self.version) === 1,
        }
      : null;
  const writeCache = (c: UpdateCache): void => {
    // Atomic tmp+rename in the same dir; a read-only/missing dataDir just
    // means no cache — the check stays best-effort.
    try {
      writeFileFn(cachePath + ".tmp", JSON.stringify(c) + "\n");
      renameFn(cachePath + ".tmp", cachePath);
    } catch {
      /* best-effort */
    }
  };

  if (opts.forceFresh !== true) {
    if (ageMs(cache.checkedAt) < FRESH_WINDOW_MS) return fromCache();
    if (ageMs(cache.lastAttempt) < RETRY_BACKOFF_MS) return fromCache();
  }

  try {
    const fetchFn = opts.fetchFn ?? fetch;
    // Literal scoped name works on this route (cf. registry.npmjs.org/@types/node/latest).
    const resp = await fetchFn(`https://registry.npmjs.org/${self.name}/latest`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const body = (await resp.json()) as { version?: unknown };
    if (typeof body.version !== "string" || compareVersions(body.version, "0.0.0") === null) {
      throw new Error("unparseable registry response");
    }
    cache = { latest: body.version, checkedAt: now.toISOString() };
    writeCache(cache);
    return fromCache();
  } catch {
    writeCache({ ...cache, lastAttempt: now.toISOString() });
    return fromCache();
  }
}
```

(Merge the `node:fs` import additions into the existing import line; keep `import type { Config }` and value imports separate per file convention.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/updateCheck.test.ts > /tmp/vt.out 2>&1; echo "exit: $?"; tail -5 /tmp/vt.out`
Expected: exit 0, all Task 1 + Task 4 tests pass.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/updateCheck.ts tests/updateCheck.test.ts
git add src/updateCheck.ts tests/updateCheck.test.ts
git commit -m "feat(update): cached best-effort npm update check"
```

---

### Task 5: `junco --version`

**Files:**

- Modify: `src/cli.ts` (parseCli options, handler after `--help`, USAGE options block)
- Test: `tests/cli.test.ts` (extend)

**Interfaces:**

- Consumes: `getSelfPackage()` (Task 1).
- Produces: `junco --version` prints the bare version (`0.7.0\n`) — exactly what Task 8's post-install verify parses.

- [ ] **Step 1: Write the failing test**

In `tests/cli.test.ts`, add alongside the existing `--help` test (reuse that test's deps/printFn capture pattern):

```ts
it("--version prints the package version and exits 0", async () => {
  const out: string[] = [];
  const code = await run(["--version"], { printFn: (s) => out.push(s) });
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  };
  expect(code).toBe(0);
  expect(out.join("")).toBe(`${pkg.version}\n`);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cli.test.ts > /tmp/vt.out 2>&1; echo "exit: $?"; tail -5 /tmp/vt.out`
Expected: exit 1 — parseArgs throws on unknown `--version` → exit code 2, not 0.

- [ ] **Step 3: Implement**

`src/cli.ts`:

- In `parseCli` options, after `help`: `version: { type: "boolean", default: false },`
- Immediately after the `--help` block in `run()` (BEFORE config-path resolution — `junco --version` must work with no config at all):

```ts
// --version (bare version only — junco update's post-install verify parses it)
if (values.version) {
  const { getSelfPackage } = await import("./updateCheck.js");
  (deps.printFn ?? ((s: string) => process.stdout.write(s)))(`${getSelfPackage().version}\n`);
  return 0;
}
```

- In `USAGE`'s Options block, after `--help`: `  --version             Print junco's version and exit`

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/cli.test.ts > /tmp/vt.out 2>&1; echo "exit: $?"; tail -3 /tmp/vt.out`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/cli.ts tests/cli.test.ts
git add src/cli.ts tests/cli.test.ts
git commit -m "feat(cli): junco --version"
```

---

### Task 6: `junco status` update line

**Files:**

- Modify: `src/statusCmd.ts`
- Test: `tests/statusCmd.test.ts` (extend)

**Interfaces:**

- Consumes: `checkForUpdate`, `UpdateInfo` (Task 4).
- Produces: `StatusDeps.checkUpdateFn?: (cfg: Config) => Promise<UpdateInfo | null>`.

- [ ] **Step 1: Write the failing tests**

In `tests/statusCmd.test.ts`'s `runStatusCommand` describe (reusing its `cfg`/`out`/`print` fixture):

```ts
it("prints an update line when a newer version is available", async () => {
  await runStatusCommand(cfg, {
    printFn: print,
    checkUpdateFn: async () => ({ current: "0.7.0", latest: "0.8.0", available: true }),
  });
  expect(out.join("")).toContain("update:    v0.8.0 available (run: junco update)");
});

it("stays silent when current, unavailable, or check-less", async () => {
  for (const fn of [
    async () => ({ current: "0.7.0", latest: "0.7.0", available: false }),
    async () => null,
  ]) {
    out = [];
    await runStatusCommand(cfg, { printFn: print, checkUpdateFn: fn });
    expect(out.join("")).not.toContain("update:");
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/statusCmd.test.ts > /tmp/vt.out 2>&1; echo "exit: $?"; tail -5 /tmp/vt.out`
Expected: exit 1 — `checkUpdateFn` not a known dep / no update line printed. (A type error surfaces at typecheck, vitest runs it anyway via esbuild — the assertion failure is what you'll see.)

- [ ] **Step 3: Implement**

`src/statusCmd.ts`:

- Imports: `import { checkForUpdate, type UpdateInfo } from "./updateCheck.js";`
- `StatusDeps` gains: `checkUpdateFn?: (cfg: Config) => Promise<UpdateInfo | null>;`
- At the end of `runStatusCommand`, immediately before `return 0;`:

```ts
// npm update nudge (spec 2026-07-16) — best-effort; silent unless newer.
const update = await (deps.checkUpdateFn ?? ((c: Config) => checkForUpdate(c)))(cfg);
if (update !== null && update.available) {
  print(`update:    v${update.latest} available (run: junco update)\n`);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/statusCmd.test.ts > /tmp/vt.out 2>&1; echo "exit: $?"; tail -3 /tmp/vt.out`
Expected: exit 0. NOTE: pre-existing tests in this file call `runStatusCommand` without `checkUpdateFn` — the default hits the real `checkForUpdate`, whose fetch would go out on a test machine. Those tests set `cfg.dataDir` under a tmp root with no cache, so add `updateCheck: false` to the file's `cfg` fixture object to keep the suite airtight offline, and assert in the silent-case test above with `{ ...cfg, updateCheck: false }` semantics preserved (fixture-level `updateCheck: false` + explicit `checkUpdateFn` fakes in the two new tests).

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/statusCmd.ts tests/statusCmd.test.ts
git add src/statusCmd.ts tests/statusCmd.test.ts
git commit -m "feat(status): update-available line"
```

---

### Task 7: `junco doctor` version row

**Files:**

- Modify: `src/doctor.ts`
- Test: `tests/doctor.test.ts` (extend)

**Interfaces:**

- Consumes: `checkForUpdate`, `UpdateInfo`, `getSelfPackage` (Tasks 1, 4).
- Produces: `DoctorDeps.checkUpdateFn?: (cfg: Config) => Promise<UpdateInfo | null>`. Verdicts: available → `warn`, latest → `ok`, null → `ok` with "skipped" detail (doctor has only ok/warn/fail; a skipped best-effort check is not a degradation).

- [ ] **Step 1: Write the failing tests**

Open `tests/doctor.test.ts`, find how existing tests build `DoctorDeps` fakes (grep `runDoctor(`) and reuse that construction verbatim, adding `checkUpdateFn`. Three cases:

```ts
it("doctor reports an available update as a warning", async () => {
  // <suite's standard deps fixture> +
  //   checkUpdateFn: async () => ({ current: "0.7.0", latest: "0.8.0", available: true })
  // run doctor, capture print output:
  expect(output).toContain("⚠ junco version — v0.7.0 — v0.8.0 available (run: junco update)");
});
it("doctor reports latest as ok", async () => {
  // checkUpdateFn: async () => ({ current: "0.7.0", latest: "0.7.0", available: false })
  expect(output).toContain("✓ junco version — v0.7.0 (latest)");
});
it("doctor reports a skipped check as ok", async () => {
  // checkUpdateFn: async () => null
  expect(output).toContain("update check skipped");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/doctor.test.ts > /tmp/vt.out 2>&1; echo "exit: $?"; tail -5 /tmp/vt.out`
Expected: exit 1 — no "junco version" row printed.

- [ ] **Step 3: Implement**

`src/doctor.ts`:

- Imports: `import { checkForUpdate, getSelfPackage, type UpdateInfo } from "./updateCheck.js";`
- `DoctorDeps` gains: `checkUpdateFn?: (cfg: Config) => Promise<UpdateInfo | null>;`
- Inside the big `if (cfg) { ... }` block in `runDoctor`, immediately before its closing brace (after the health-bind / outbox / sandbox checks — last check in the block):

```ts
// 8. npm update check (spec 2026-07-16) — best-effort, never a failure.
const update = await (deps.checkUpdateFn ?? ((c: Config) => checkForUpdate(c)))(cfg);
if (update === null) {
  report(
    "ok",
    "junco version",
    `v${getSelfPackage().version} (update check skipped — offline or disabled)`,
  );
} else if (update.available) {
  report(
    "warn",
    "junco version",
    `v${update.current} — v${update.latest} available (run: junco update)`,
  );
} else {
  report("ok", "junco version", `v${update.current} (latest)`);
}
```

(Number the comment to follow whatever the last existing check number is — read the neighbors.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/doctor.test.ts > /tmp/vt.out 2>&1; echo "exit: $?"; tail -3 /tmp/vt.out`
Expected: exit 0. Same offline-hygiene note as Task 6: existing doctor tests that reach this code path without a `checkUpdateFn` fake would hit the real fetch — inject `checkUpdateFn: async () => null` into the suite's shared deps builder so every pre-existing test stays network-free.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/doctor.ts tests/doctor.test.ts
git add src/doctor.ts tests/doctor.test.ts
git commit -m "feat(doctor): junco version row with update nudge"
```

---

### Task 8: `junco update` command

**Files:**

- Create: `src/updateCmd.ts`
- Modify: `src/cli.ts` (subcommand dispatch + USAGE subcommand list)
- Test: `tests/updateCmd.test.ts`

**Interfaces:**

- Consumes: `getSelfPackage`, `checkForUpdate` (Tasks 1, 4); `readLockHolder` (`src/lock.ts`); `runRestartCommand` (`src/restartCmd.ts`); `loadConfig` (`src/config.ts`).
- Produces: `runUpdateCommand(configPath: string, deps?: UpdateCmdDeps): Promise<number>`; CLI subcommand `update`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/updateCmd.test.ts
import { describe, it, expect } from "vitest";
import { runUpdateCommand, type UpdateCmdDeps } from "../src/updateCmd.js";
import type { Config } from "../src/types.js";
import type { UpdateInfo } from "../src/updateCheck.js";

const CONFIG_PATH = "/sbxroot/cfg/config.json";

interface Rec {
  runs: Array<{ cmd: string; args: string[] }>;
  execs: Array<{ cmd: string; args: string[] }>;
  restarts: string[];
  out: string[];
  err: string[];
}

const harness = (o: {
  sourceCheckout?: boolean;
  check?: UpdateInfo | null;
  npmExit?: number;
  lockHolder?: number | null;
  restartCode?: number;
  verify?: { code: number; stdout: string };
}): { deps: UpdateCmdDeps; rec: Rec } => {
  const rec: Rec = { runs: [], execs: [], restarts: [], out: [], err: [] };
  return {
    rec,
    deps: {
      printFn: (s) => rec.out.push(s),
      errPrintFn: (s) => rec.err.push(s),
      selfPkgFn: () => ({ name: "@x/junco", version: "0.7.0", rootDir: "/sbxroot/app/" }),
      existsFn: (p) => (o.sourceCheckout ?? false) && p === "/sbxroot/app/.git",
      loadConfigFn: () => ({ dataDir: "/sbxroot/data", updateCheck: true }) as unknown as Config,
      checkUpdateFn: async () => o.check ?? null,
      runFn: async (cmd, args) => {
        rec.runs.push({ cmd, args });
        return o.npmExit ?? 0;
      },
      execFn: async (cmd, args) => {
        rec.execs.push({ cmd, args });
        return { code: o.verify?.code ?? 0, stdout: o.verify?.stdout ?? "0.8.0\n", stderr: "" };
      },
      lockHolderFn: () => o.lockHolder ?? null,
      restartFn: async (p) => {
        rec.restarts.push(p);
        return o.restartCode ?? 0;
      },
    },
  };
};

const UPD: UpdateInfo = { current: "0.7.0", latest: "0.8.0", available: true };

describe("runUpdateCommand", () => {
  it("refuses a source checkout before doing ANYTHING", async () => {
    const { deps, rec } = harness({ sourceCheckout: true, check: UPD });
    expect(await runUpdateCommand(CONFIG_PATH, deps)).toBe(1);
    expect(rec.runs).toEqual([]);
    expect(rec.restarts).toEqual([]);
    expect(rec.out.join("")).toContain("git pull && npm run build");
  });

  it("exits 0 pre-install when already current", async () => {
    const { deps, rec } = harness({
      check: { current: "0.7.0", latest: "0.7.0", available: false },
    });
    expect(await runUpdateCommand(CONFIG_PATH, deps)).toBe(0);
    expect(rec.runs).toEqual([]);
    expect(rec.out.join("")).toContain("already up to date (v0.7.0)");
  });

  it("a failed check is loud (unlike the passive surfaces)", async () => {
    const { deps, rec } = harness({ check: null });
    expect(await runUpdateCommand(CONFIG_PATH, deps)).toBe(1);
    expect(rec.runs).toEqual([]);
    expect(rec.err.join("")).toContain("update check failed");
  });

  it("installs via npm -g and skips restart when no daemon lock is held", async () => {
    const { deps, rec } = harness({ check: UPD, lockHolder: null });
    expect(await runUpdateCommand(CONFIG_PATH, deps)).toBe(0);
    expect(rec.runs).toEqual([{ cmd: "npm", args: ["install", "-g", "@x/junco@latest"] }]);
    expect(rec.restarts).toEqual([]);
    expect(rec.out.join("")).toContain("updated v0.7.0 → v0.8.0");
  });

  it("npm failure aborts BEFORE any restart, exit 1", async () => {
    const { deps, rec } = harness({ check: UPD, npmExit: 1, lockHolder: 42 });
    expect(await runUpdateCommand(CONFIG_PATH, deps)).toBe(1);
    expect(rec.restarts).toEqual([]);
    expect(rec.err.join("")).toContain("npm install failed");
  });

  it("lock held → drain-restart via runRestartCommand; its exit code propagates", async () => {
    const ok = harness({ check: UPD, lockHolder: 42, restartCode: 0 });
    expect(await runUpdateCommand(CONFIG_PATH, ok.deps)).toBe(0);
    expect(ok.rec.restarts).toEqual([CONFIG_PATH]);

    const bad = harness({ check: UPD, lockHolder: 42, restartCode: 1 });
    expect(await runUpdateCommand(CONFIG_PATH, bad.deps)).toBe(1);
  });

  it("verify failure is a warning, not a rollback", async () => {
    const { deps, rec } = harness({ check: UPD, verify: { code: 1, stdout: "" } });
    expect(await runUpdateCommand(CONFIG_PATH, deps)).toBe(0);
    expect(rec.out.join("")).toContain("could not verify");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/updateCmd.test.ts > /tmp/vt.out 2>&1; echo "exit: $?"; tail -5 /tmp/vt.out`
Expected: exit 1 — module does not exist.

- [ ] **Step 3: Implement**

```ts
// src/updateCmd.ts
/**
 * `junco update` — npm-install the latest release, then drain-restart the
 * supervised daemon (spec 2026-07-16 §7). Install strictly precedes restart:
 * a failed install must leave the running daemon untouched. Restart reuses
 * runRestartCommand, whose launchctl kickstart / systemctl restart gives the
 * daemon its TERM-first drain window — the in-flight ticket completes before
 * the relaunch on new code.
 */
import { existsSync } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import type { Config } from "./types.js";
import { loadConfig } from "./config.js";
import { readLockHolder } from "./lock.js";
import { runRestartCommand } from "./restartCmd.js";
import {
  checkForUpdate,
  getSelfPackage,
  type SelfPackage,
  type UpdateInfo,
} from "./updateCheck.js";

export interface UpdateCmdDeps {
  loadConfigFn?: (p: string) => Config;
  selfPkgFn?: () => SelfPackage;
  checkUpdateFn?: (cfg: Config) => Promise<UpdateInfo | null>;
  existsFn?: (p: string) => boolean;
  /** Streaming exec (npm install): stdio inherited, resolves with the exit code. */
  runFn?: (cmd: string, args: string[]) => Promise<number>;
  /** Capturing exec (post-install `junco --version` verify). */
  execFn?: (
    cmd: string,
    args: string[],
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
  lockHolderFn?: (lockPath: string) => number | null;
  restartFn?: (configPath: string) => Promise<number>;
  printFn?: (s: string) => void;
  errPrintFn?: (s: string) => void;
}

/** npm output belongs on the operator's terminal — inherit stdio, keep the exit code. */
function defaultRun(cmd: string, args: string[]): Promise<number> {
  return new Promise((res, rej) => {
    const child = spawn(cmd, args, { stdio: "inherit" });
    child.on("error", rej); // ENOENT → caught by the caller
    child.on("close", (code) => res(code ?? 1));
  });
}

function defaultCapture(
  cmd: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((res) => {
    execFile(cmd, args, { timeout: 15_000 }, (err, stdout, stderr) => {
      const code = err ? ((err as NodeJS.ErrnoException & { code?: number }).code ?? 1) : 0;
      res({ code: typeof code === "number" ? code : 1, stdout, stderr });
    });
  });
}

export async function runUpdateCommand(
  configPath: string,
  deps: UpdateCmdDeps = {},
): Promise<number> {
  const print = deps.printFn ?? ((s: string) => process.stdout.write(s));
  const errPrint = deps.errPrintFn ?? ((s: string) => process.stderr.write(s));
  const self = (deps.selfPkgFn ?? getSelfPackage)();

  // 1. Source-checkout guard. Worktrees carry a .git FILE (gitdir pointer),
  // main checkouts a .git dir — existsSync covers both. npm -g package roots
  // have neither.
  if ((deps.existsFn ?? existsSync)(join(self.rootDir, ".git"))) {
    print(
      `running from a source checkout (${self.rootDir}) — update with: git pull && npm run build\n`,
    );
    return 1;
  }

  // 2. Fresh check — loud on failure, unlike the passive surfaces.
  const cfg = (deps.loadConfigFn ?? loadConfig)(configPath);
  const info = await (
    deps.checkUpdateFn ?? ((c: Config) => checkForUpdate(c, { forceFresh: true }))
  )(cfg);
  if (info === null) {
    errPrint("junco update: update check failed (offline, or updateCheck disabled in config)\n");
    return 1;
  }
  if (!info.available) {
    print(`already up to date (v${info.current})\n`);
    return 0;
  }

  // 3. Install — strictly precedes restart.
  print(`updating ${self.name} v${info.current} → v${info.latest}\n`);
  let npmExit: number;
  try {
    npmExit = await (deps.runFn ?? defaultRun)("npm", ["install", "-g", `${self.name}@latest`]);
  } catch (e) {
    errPrint(`junco update: npm not runnable: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
  if (npmExit !== 0) {
    errPrint(`junco update: npm install failed (exit ${npmExit}) — daemon untouched\n`);
    return 1;
  }

  // 4. Drain-restart, only when a daemon actually holds the lock (same
  // lockPath derivation as restartCmd/start: worker.lock beside config.json).
  let exit = 0;
  const lockPath = join(dirname(resolve(configPath)), "worker.lock");
  const holder = (deps.lockHolderFn ?? readLockHolder)(lockPath);
  if (holder !== null) {
    exit = await (deps.restartFn ?? runRestartCommand)(configPath);
  } else {
    print("daemon not running — nothing to restart\n");
  }

  // 5. Verify by exec'ing the freshly installed CLI (this process is old code).
  const ver = await (deps.execFn ?? defaultCapture)("junco", ["--version"]);
  if (ver.code === 0 && ver.stdout.trim().length > 0) {
    print(`updated v${info.current} → v${ver.stdout.trim()}\n`);
  } else {
    print("installed, but could not verify `junco --version` — check your PATH\n");
  }
  return exit;
}
```

`src/cli.ts` — dispatch block (place next to the `restart` subcommand block) + USAGE line after `restart`:

```ts
// ------------------------------------------------------------
// update: npm-install the latest release, drain-restart the daemon. Lazy
// import keeps npm/child_process plumbing off every other subcommand.
// ------------------------------------------------------------
if (subcommand === "update") {
  const { runUpdateCommand } = await import("./updateCmd.js");
  return runUpdateCommand(configPath, {});
}
```

USAGE: `  update       Update junco to the latest npm release (drains, then restarts the daemon)`

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/updateCmd.test.ts tests/cli.test.ts > /tmp/vt.out 2>&1; echo "exit: $?"; tail -3 /tmp/vt.out`
Expected: exit 0. (No cli-level `update` test: the wiring is one lazy-import line; a real invocation would shell out to npm. `runUpdateCommand` is fully covered above, and the source-checkout guard makes an accidental dev invocation a safe no-op.)

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/updateCmd.ts src/cli.ts tests/updateCmd.test.ts
git add src/updateCmd.ts src/cli.ts tests/updateCmd.test.ts
git commit -m "feat(cli): junco update — install latest + drain-restart the daemon"
```

---

### Task 9: TUI — header chip, help line, App wiring

**Files:**

- Modify: `src/tui/components/Chrome.tsx` (Header prop + chip)
- Modify: `src/tui/components/HelpModal.tsx` (optional update line)
- Modify: `src/tui/App.tsx` (AppProps field, state, mount+24h effect, Header/HelpModal props)
- Modify: `src/dashboardCmd.ts` (`buildAppProps` wires the real `checkForUpdate`)
- Create: `tests/tuiUpdateChip.test.tsx`

**Interfaces:**

- Consumes: `checkForUpdate`, `UpdateInfo` (Task 4).
- Produces: `AppProps.checkUpdateFn?: () => Promise<UpdateInfo | null>`; `Header` prop `updateLatest?: string | null`; `HelpModal` prop `updateLatest?: string | null`.

- [ ] **Step 1: Write the failing tests**

```tsx
// tests/tuiUpdateChip.test.tsx
import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { Header } from "../src/tui/components/Chrome.js";
import { HelpModal } from "../src/tui/components/HelpModal.js";
import { until } from "./helpers/until.js";

const headerProps = {
  repoNwo: "acme/site",
  health: null,
  reviewCount: 0,
  now: new Date("2026-07-16T12:00:00Z"),
  mode: "wide" as const,
  queueRunning: 0,
  queueWaiting: 0,
  watchlistError: null,
  outboxDepth: 0,
  prAttention: 0,
  prFailing: false,
  refreshedAt: null,
};

describe("Header update chip", () => {
  it("renders ⬆ v<latest> when an update is known", async () => {
    const { lastFrame } = render(<Header {...headerProps} updateLatest="0.8.0" />);
    await until(() => (lastFrame() ?? "").includes("⬆ v0.8.0"));
  });

  it("renders no chip when updateLatest is null/absent", async () => {
    const { lastFrame } = render(<Header {...headerProps} updateLatest={null} />);
    await until(() => (lastFrame() ?? "").includes("acme/site"));
    expect(lastFrame()).not.toContain("⬆");
  });
});

describe("HelpModal update line", () => {
  // Reuse the prop shape from tests/tuiModal.test.tsx's HelpModal render if it
  // differs — the essential contract is the updateLatest line below.
  const modalProps = {
    view: "main" as const,
    pane: 1 as const,
    mode: "wide" as const,
    trigger: "junco",
    uiMode: "local" as const,
    localSection: "queue" as const,
  };

  it("names junco update when an update is available", async () => {
    const { lastFrame } = render(<HelpModal {...modalProps} updateLatest="0.8.0" />);
    await until(() => (lastFrame() ?? "").includes("junco update"));
    expect(lastFrame()).toContain("v0.8.0");
  });

  it("omits the line otherwise", async () => {
    const { lastFrame } = render(<HelpModal {...modalProps} />);
    await until(() => (lastFrame() ?? "").length > 0);
    expect(lastFrame()).not.toContain("v0.8.0 available");
  });
});
```

(If `Header`/`HelpModal` require props added since this plan was written, satisfy them minimally — the two contracts under test are the chip and the help line.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/tuiUpdateChip.test.tsx > /tmp/vt.out 2>&1; echo "exit: $?"; tail -5 /tmp/vt.out`
Expected: exit 1 — no `⬆` in the frame (unknown props are ignored by React).

- [ ] **Step 3: Implement**

`src/tui/components/Chrome.tsx` — `Header`:

- Add to the destructured params and the props type:

```ts
/** Latest npm version when newer than the running one; null/absent → no chip. */
updateLatest?: string | null;
```

- First entry inside the right-hand chip group (`<Box flexShrink={0} gap={2}>`, before the `watchlistError` chip). Wide-mode only per spec §6.2 (narrow headers keep only essential chips; `junco status` mirrors the nudge for narrow terminals) — the Header test's `mode: "wide"` matches:

```tsx
{
  wide && updateLatest != null && <Text color={theme.accent}>⬆ v{updateLatest}</Text>;
}
```

`src/tui/components/HelpModal.tsx`:

- Add `updateLatest?: string | null;` to the props type and destructuring.
- At the bottom of the modal's content column (after the last `<Section>`; keep the existing layout intact):

```tsx
{
  updateLatest != null && (
    <Box marginTop={1}>
      <Text color={theme.accent}>⬆ junco v{updateLatest} available — run: junco update</Text>
    </Box>
  );
}
```

`src/tui/App.tsx`:

- `AppProps` gains:

```ts
/** Best-effort npm update check (spec 2026-07-16); absent in tests → no chip. */
checkUpdateFn?: () => Promise<UpdateInfo | null>;
```

with `import type { UpdateInfo } from "../updateCheck.js";`

- State (next to the other `useState` calls): `const [updateLatest, setUpdateLatest] = useState<string | null>(null);`
- Effect (next to the other polling effects). Async post-mount + 24h re-check; never blocks first paint:

```ts
useEffect(() => {
  const fn = props.checkUpdateFn;
  if (!fn) return;
  let cancelled = false;
  const tick = (): void => {
    void fn()
      .then((info) => {
        if (!cancelled) setUpdateLatest(info !== null && info.available ? info.latest : null);
      })
      .catch(() => {}); // checkForUpdate never throws; belt for injected fakes
  };
  tick();
  const t = setInterval(tick, 24 * 60 * 60 * 1000);
  return () => {
    cancelled = true;
    clearInterval(t);
  };
}, [props.checkUpdateFn]);
```

- Pass `updateLatest={updateLatest}` to the `<Header … />` render (App.tsx ~line 2398) and to the `<HelpModal … />` render (grep `<HelpModal`).

`src/dashboardCmd.ts` — in `buildAppProps` (the `(c: Config) => ({ ... })` object), add:

```ts
checkUpdateFn: () => checkForUpdate(c),
```

with `import { checkForUpdate } from "./updateCheck.js";`

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run tests/tuiUpdateChip.test.tsx > /tmp/vt.out 2>&1; echo "exit: $?"; tail -3 /tmp/vt.out && npm run typecheck`
Expected: both exit 0. Typecheck is what validates the App/dashboardCmd wiring (the full-App render suites cover the header indirectly; the new props are optional so they stay green).

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/tui/components/Chrome.tsx src/tui/components/HelpModal.tsx src/tui/App.tsx src/dashboardCmd.ts tests/tuiUpdateChip.test.tsx
git add src/tui/components/Chrome.tsx src/tui/components/HelpModal.tsx src/tui/App.tsx src/dashboardCmd.ts tests/tuiUpdateChip.test.tsx
git commit -m "feat(tui): update-available header chip + help-modal nudge"
```

---

### Task 10: Docs, CHANGELOG, full gate, smoke test

**Files:**

- Modify: `README.md` (command table: `update`, `--version`)
- Modify: the config reference page (find it: `grep -rln "dailyBudgetUsd\|commitLeftovers" docs/ README.md` — add an `updateCheck` row: "npm update check opt-out; CLI/TUI-side only, default `true`")
- Modify: `CHANGELOG.md` (Unreleased → Added)

**Steps:**

- [ ] **Step 1: Write docs**

CHANGELOG under `## [Unreleased]` / `### Added`:

```markdown
- Update notification: the dashboard header, `junco status`, and `junco doctor` now surface a newer npm release (best-effort daily check against the npm registry, cached in `<dataDir>/update-check.json`; opt out with `"updateCheck": false`).
- `junco update` — install the latest release and drain-restart the supervised daemon.
- `junco --version`.
```

README command table: add `update` and `--version` rows matching the table's existing voice. Config reference: add `updateCheck` (default `true`) with the opt-out sentence above. Keep all copy stack-agnostic — "npm registry" is the only service named; no personal-setup strings.

- [ ] **Step 2: Full gate**

Run: `npm run lint && npm run format:check && npm run typecheck && npm run build && npm test > /tmp/gate.out 2>&1; echo "exit: $?"; tail -5 /tmp/gate.out`
Expected: exit 0. Also sweep test types (lint doesn't cover tests/): `npx tsc --noEmit -p tsconfig.eslint.json` — only the known pre-existing errors (~57) may appear; zero NEW ones.

- [ ] **Step 3: Sandboxed smoke test** (never from the repo root — live config)

```bash
SB=$(mktemp -d) && cd "$SB" && HOME="$SB" XDG_CONFIG_HOME="$SB/.config" \
  node /Users/alxedelweiss/junco/.claude/worktrees/worktree-1/dist/cli.js --version && \
  HOME="$SB" XDG_CONFIG_HOME="$SB/.config" \
  node /Users/alxedelweiss/junco/.claude/worktrees/worktree-1/dist/cli.js config init && \
  HOME="$SB" XDG_CONFIG_HOME="$SB/.config" \
  node /Users/alxedelweiss/junco/.claude/worktrees/worktree-1/dist/cli.js update ; cd / && rm -rf "$SB"
```

Expected: `--version` prints the version; `update` prints the source-checkout refusal (dist under the worktree has `.git` at its package root) — proving the guard, wiring, and USAGE all work end-to-end without touching npm -g.

- [ ] **Step 4: Commit**

```bash
npx prettier --write README.md CHANGELOG.md
git add README.md CHANGELOG.md docs/
git commit -m "docs: update notification + junco update"
```

- [ ] **Step 5: Push and open the PR**

```bash
git push -u origin feat/update-notification
gh pr create --title "feat: update notification + junco update" --body "..."
```

PR body: summarize per the spec (link `docs/superpowers/specs/2026-07-16-update-notification-design.md`), note the daemon is untouched and the check is opt-out via `updateCheck: false`. **No AI attribution.** Do not merge without the maintainer's go-ahead (merges promote to the live daemon via the post-merge hook).

---

## Plan Self-Review (completed)

- **Spec coverage:** §4 → Tasks 1+4; §5 → Task 2; §6.1 → Task 3; §6.2 → Task 9; §6.3 → Tasks 6+7; §6.4 → Task 5; §7 → Task 8; §8 error table → distributed (4.3 never-throws in Task 4 tests, npm-fail/restart/verify rows in Task 8 tests); §9 → per-task tests; §10 → Task 10.
- **Order-of-operations deviation from spec §7:** verify (step 5) runs after restart, matching the spec's sequence; the "updated X → Y" line doubles as the closing summary. Restart exit code propagates; verify failure never overrides it.
- **Known judgment call recorded inline (Task 9):** chip is wide-mode-only per spec §6.2.
- **Type consistency:** `UpdateInfo`/`SelfPackage`/`UpdateCheckOpts` defined once in Task 4/1, imported by name everywhere else; `checkUpdateFn` is `(cfg) => Promise<UpdateInfo | null>` in StatusDeps/DoctorDeps/UpdateCmdDeps and `() => Promise<UpdateInfo | null>` (cfg pre-bound) in AppProps.
