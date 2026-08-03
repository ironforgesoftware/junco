# Config Resolution: Env-Only, Canonical `~/.junco/config.json` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make junco's config path a pure function of the environment — identical from any working directory, with or without flags — canonical at `~/.junco/config.json`, ending the cwd-dependent resolution that silently split the live queue on 2026-08-01.

**Architecture:** `resolveConfigPath` loses its `explicit` parameter and cwd probe and becomes `defaultUserConfigPath(env)` = `~/.junco/config.json`, with a read-only fallback to the legacy XDG path (`~/.config/junco/config.json`) while the canonical file does not exist — so existing installs are never routed into the setup wizard (which would write a competing config, the exact incident failure). `--config` stays **parsed but inert** (installed service units still pass it; `parseArgs` runs `strict:true` and would crash-loop them if the option were deleted). Service templates stop rendering `--config`, and `discoverService` gains a fallback so flagless units remain discoverable by `junco restart` / `ensureDaemon` — **the post-merge auto-promote hook depends on this fallback working**.

**Tech Stack:** TypeScript (Node ≥ 22.19, ESM/NodeNext, strict), vitest, no new dependencies.

**Origin:** Incident note (split queue, 2026-08-01): dashboard wrote tickets to `~/.local/state/junco/queue/inbox` while the worker polled `~/junco/tickets/inbox`; no error anywhere. Maintainer decisions: no `--config` flag ("it is confusing"); canonical home is **`~/.junco/`** — the seed of a future single-root consolidation (config now; queue/review/data/cache/logs in a follow-up plan). NOT `~/junco` (that's the git checkout) and NOT XDG (`~/.docker`/`~/.claude`-style single root won).

## Global Constraints

- `--config` must remain **parsed** (strict `parseArgs`) while becoming **inert**. Hard-deleting the option crash-loops installed launchd/systemd daemons (`ERR_PARSE_ARGS_UNKNOWN_OPTION`). Full removal is a separate, later breaking change (follow-up issue).
- Behavior-breaking change → next release is **0.10.0**. Do NOT bump `package.json` in this PR; releases are maintainer-approved and separate (Release HOLD is absolute).
- Conventional commits; suite green at every commit; TDD (failing test first). **No AI attribution trailers, ever** — subagent commits auto-append one; amend it away.
- `npm test` does not type-check. After shared-signature changes run `npx tsc --noEmit -p tsconfig.eslint.json` (~57 pre-existing errors are noise; look for NEW ones in touched files).
- Vitest exit-code trap: `npx vitest run > /tmp/out 2>&1; echo "exit: $?"` — never pipe into grep/tail.
- `src/tui/**`: react-hooks `rules-of-hooks` + `exhaustive-deps` at **error**. Fix dep arrays (Task 5 removes `configPath` from a `useMemo` array); never `eslint-disable`.
- Prettier may reformat between read and edit; re-read before editing, `npx prettier --write` touched files before each commit.
- The repo doubles as the maintainer's live runtime. The PR itself touches no runtime state; the migration runbook (Task 7) is maintainer-gated. **Do not merge without the maintainer's explicit go-ahead** — merging auto-promotes to the live daemon via a PostToolUse hook.
- Old plan documents under `docs/superpowers/plans/` are historical records — never edit them, even where they quote the old resolution order.

## File Structure

| File | Responsibility after this plan |
| --- | --- |
| `src/config.ts` | `juncoHome()`, `defaultUserConfigPath()` (→ `~/.junco/config.json`), `legacyConfigPath()` (XDG, read-only fallback), `resolveConfigPath(deps)` — env-pure |
| `src/cli.ts` | Resolves once via env; `--config` inert + stderr deprecation notice; `CliDeps.env` seam; USAGE/banner scrubbed |
| `src/wizard.ts` | `summary()` drops the dead `--config` hint |
| `src/restartCmd.ts` | `discoverService` falls back to flagless junco units (launchd) |
| `src/service.ts` | Templates render `… start` with no `--config`; `ServiceOpts.configPath` removed; `logDir` defaults to `<home>/.junco` |
| `src/tui/cliRunner.ts` + `src/tui/App.tsx` | Child CLI spawns without `--config` |
| `tests/{config,cli,restartCmd,service,tuiCliRunner}.test.ts` | Contract inverted; env-seam injection replaces `--config` |
| `docs/{operations,configuration,tickets}.md`, `CLAUDE.md` | Canonical-location docs; flag rows scrubbed |

Task order matters: Task 3 (discovery fallback) lands **before** Task 4 (flagless templates) so a re-rendered unit is never undiscoverable at any commit.

---

### Task 1: Env-pure `resolveConfigPath` + call sites + test-suite conversion

This is the contract flip. It is one commit because the signature change and the behavior change force `src/cli.ts`, `src/wizard.ts`, `tests/config.test.ts`, and every `--config`-dependent test in `tests/cli.test.ts` to move together to keep the suite green.

**Files:**
- Modify: `src/config.ts:42-74` (`defaultUserConfigPath`, `ResolveConfigDeps`, `resolveConfigPath`; add `juncoHome`, `legacyConfigPath`)
- Modify: `src/cli.ts:76-176` (CliDeps — add `env` seam), `src/cli.ts:353-356` (call site)
- Modify: `src/wizard.ts:179-189` (`summary()` — drop flag hint), `src/wizard.ts:20-24` (drop `resolveConfigPath` import)
- Test: `tests/config.test.ts:540-576` (rewrite block), `tests/cli.test.ts` (all 29 `--config` sites)

**Interfaces:**
- Consumes: nothing new.
- Produces (later tasks and all callers rely on these exact shapes):
  - `juncoHome(env?: Record<string, string | undefined>): string` → `<HOME>/.junco`
  - `defaultUserConfigPath(env?): string` → `<HOME>/.junco/config.json`
  - `legacyConfigPath(env?): string` → `<XDG_CONFIG_HOME|~/.config>/junco/config.json`
  - `resolveConfigPath(deps?: ResolveConfigDeps): string` where `ResolveConfigDeps = { existsFn?: (p: string) => boolean; env?: Record<string, string | undefined> }`
  - `CliDeps.env?: Record<string, string | undefined>`

- [ ] **Step 1: Write the failing contract tests**

Replace the `describe("resolveConfigPath / defaultUserConfigPath", …)` block at `tests/config.test.ts:540-576` (add `juncoHome`, `legacyConfigPath` to the `../src/config.js` import at the top):

```ts
describe("resolveConfigPath / juncoHome / legacyConfigPath", () => {
  it("juncoHome anchors to env.HOME and falls back to os.homedir()", () => {
    expect(juncoHome({ HOME: "/h" })).toBe("/h/.junco");
    expect(juncoHome({})).toBe(join(homedir(), ".junco"));
    expect(juncoHome({ HOME: "  " })).toBe(join(homedir(), ".junco"));
  });

  it("canonical config path is ~/.junco/config.json", () => {
    expect(defaultUserConfigPath({ HOME: "/h" })).toBe("/h/.junco/config.json");
  });

  it("resolution is cwd-independent — a cwd config.json can never win", () => {
    // existsFn claiming EVERY path exists: the canonical still wins. There is
    // no cwd seam left in ResolveConfigDeps for a cwd lookup to use.
    expect(resolveConfigPath({ existsFn: () => true, env: { HOME: "/h" } })).toBe(
      "/h/.junco/config.json",
    );
  });

  it("falls back to the legacy XDG path only while the canonical file is absent", () => {
    const env = { HOME: "/h", XDG_CONFIG_HOME: "/xdg" };
    expect(resolveConfigPath({ existsFn: (p) => p === "/xdg/junco/config.json", env })).toBe(
      "/xdg/junco/config.json",
    );
    expect(resolveConfigPath({ existsFn: () => false, env })).toBe("/h/.junco/config.json");
  });

  it("legacyConfigPath honors XDG_CONFIG_HOME and falls back to ~/.config", () => {
    expect(legacyConfigPath({ XDG_CONFIG_HOME: "/xdg" })).toBe("/xdg/junco/config.json");
    expect(legacyConfigPath({})).toBe(join(homedir(), ".config/junco/config.json"));
    expect(legacyConfigPath({ XDG_CONFIG_HOME: "  ", HOME: "/h" })).toBe(
      "/h/.config/junco/config.json",
    );
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/config.test.ts > /tmp/t1a 2>&1; echo "exit: $?"` — expect FAIL (`juncoHome` not exported; old signature).

- [ ] **Step 3: Implement in `src/config.ts`**

Replace lines 42-74 (`defaultUserConfigPath`, `ResolveConfigDeps`, `resolveConfigPath` and the doc comment at line 59-63):

```ts
/** Junco's single home directory: ~/.junco. env.HOME wins over os.homedir()
 * so tests and sandboxes can relocate it. Config lives here today; the data
 * tree follows in the single-root consolidation (follow-up issue). */
export function juncoHome(env: Record<string, string | undefined> = process.env): string {
  const home = env.HOME && env.HOME.trim() !== "" ? env.HOME : homedir();
  return join(home, ".junco");
}

/** The canonical config location: ~/.junco/config.json. */
export function defaultUserConfigPath(
  env: Record<string, string | undefined> = process.env,
): string {
  return join(juncoHome(env), "config.json");
}

/** Pre-0.10 config location (XDG_CONFIG_HOME or ~/.config). Read-only
 * fallback: an existing install keeps loading its config instead of being
 * routed to the setup walkthrough — which would write a competing config,
 * the exact failure mode this module was rewritten to prevent. */
export function legacyConfigPath(env: Record<string, string | undefined> = process.env): string {
  const base =
    env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.trim() !== ""
      ? env.XDG_CONFIG_HOME
      : join(env.HOME && env.HOME.trim() !== "" ? env.HOME : homedir(), ".config");
  return join(base, "junco", "config.json");
}

export interface ResolveConfigDeps {
  existsFn?: (p: string) => boolean;
  env?: Record<string, string | undefined>;
}

/**
 * Where the config lives — a pure function of the environment, never of the
 * working directory or argv (split-queue incident, 2026-08-01): the canonical
 * ~/.junco/config.json, falling back to the legacy XDG path only while the
 * canonical file does not exist. The returned path may not exist — first-run
 * detection checks that separately.
 */
export function resolveConfigPath(deps: ResolveConfigDeps = {}): string {
  const existsFn = deps.existsFn ?? existsSync;
  const env = deps.env ?? process.env;
  const canonical = defaultUserConfigPath(env);
  if (existsFn(canonical)) return canonical;
  const legacy = legacyConfigPath(env);
  if (existsFn(legacy)) return legacy;
  return canonical;
}
```

If `resolve` from `node:path` is now unused in `config.ts`, drop it from the import (lint will flag it).

- [ ] **Step 4: Fix the two compile-broken call sites**

`src/cli.ts` — add to `CliDeps` (after `existsFn`, ~line 115):

```ts
/** Process environment for config-path resolution (tests inject HOME /
 * XDG_CONFIG_HOME to relocate ~/.junco). Default: process.env. */
env?: Record<string, string | undefined>;
```

`src/cli.ts:353-356` — replace the resolution site:

```ts
const existsFn = deps.existsFn ?? ((p: string) => existsSync(p));
const env = deps.env ?? process.env;
// Resolve the config path ONCE — a pure function of the environment (HOME /
// XDG_CONFIG_HOME), never of cwd or argv (split-queue incident, 2026-08-01).
const configPath = resolveConfigPath({ existsFn, env });
```

`src/wizard.ts:179-189` — `summary()` loses the flag hint (`configPath` is always the resolved canonical now); drop `resolveConfigPath` from the wizard's import list:

```ts
export function summary(configPath: string, queueRoot: string, wrote: boolean): string {
  const head = wrote ? `✓ Wrote config:  ${configPath}\n` : `✓ Config untouched: ${configPath}\n`;
  return (
    `\n${head}` +
    `✓ Queue ready:   ${queueRoot}/{inbox,processing,done,failed}\n\n` +
    `Next steps:\n` +
    NEXT_STEPS.map((s) => `  • ${s.cmd} — ${s.blurb}\n`).join("")
  );
}
```

- [ ] **Step 5: Verify config tests pass, then sweep `tests/cli.test.ts`**

Run: `npx vitest run tests/config.test.ts > /tmp/t1b 2>&1; echo "exit: $?"` — expect PASS.

Then convert every `--config` site in `tests/cli.test.ts` (29 hits; find them with `grep -n -- '--config' tests/cli.test.ts`, sweep until zero). Two conversion patterns:

**Pattern A — test uses a real config file on disk** (inbox-path ~885, submit ~941, config init ~995, outbox ~1079, prs ~1142, assess ~1159, service logDir ~762/783): write the config at `<dir>/.junco/config.json` and drive resolution through the env seam.

```ts
// BEFORE
const code = await run(["inbox-path", "--config", configPath], { printFn });
// AFTER
const configPath = join(dir, ".junco", "config.json");
mkdirSync(dirname(configPath), { recursive: true });
writeFileSync(configPath, JSON.stringify(cfgObj));
const code = await run(["inbox-path"], { printFn, env: { HOME: dir } });
```

**Pattern B — test uses a fake path + injected fns** (service ~701-743, start ~803, dashboard ~1045/1059, restart ~1192/1209, config subcommand ~1311/1321): replace `"--config", "/x/config.json"` with `env: { HOME: "/x" }` in deps, and update any assertion expecting `/x/config.json` to `join("/x", ".junco", "config.json")` (e.g. the path forwarded to `runRestartFn`, `runDashboardFn`, `loadConfigFn`, and lock paths derived as `dirname(configPath) + "/worker.lock"` → `/x/.junco/worker.lock`).

Tests with `existsFn: () => false` need no further change: both canonical and legacy miss, resolution returns the canonical, FTUE routing keys off the same `existsFn`. Path-shaped `existsFn` fakes must answer for the canonical path, not the old fake path.

- [ ] **Step 6: Run the full suite**

Run: `npx vitest run > /tmp/t1c 2>&1; echo "exit: $?"` — expect exit 0. Also `npx tsc --noEmit -p tsconfig.eslint.json 2>&1 | grep -v <pre-existing>` — no NEW errors in touched files.

- [ ] **Step 7: Commit**

```bash
npx prettier --write src/config.ts src/cli.ts src/wizard.ts tests/config.test.ts tests/cli.test.ts
git add -A src tests
git commit -m "feat(config): resolve config from the environment only — canonical ~/.junco/config.json

The path is now a pure function of HOME/XDG_CONFIG_HOME: no cwd probe, no
--config influence. Legacy XDG location stays as a read-only fallback so
pre-0.10 installs are not routed into the setup wizard against a live
daemon (the 2026-08-01 split-queue incident)."
```

---

### Task 2: `--config` inert with a deprecation notice; scrub usage text

**Files:**
- Modify: `src/cli.ts:1-23` (header comment), `src/cli.ts:220-221` (USAGE options block), `src/cli.ts:240` (option comment), after the resolution site (~line 356) the notice, `src/cli.ts:883` + `src/cli.ts:936` (submit/dispatch usage strings)
- Test: `tests/cli.test.ts` (one new test)

**Interfaces:**
- Consumes: `resolveConfigPath({ existsFn, env })`, `CliDeps.env` (Task 1).
- Produces: stderr line containing `--config is deprecated` whenever `values.config` is set — Task 7's runbook and future removal issue reference this exact behavior.

- [ ] **Step 1: Write the failing test**

Add to `tests/cli.test.ts` (adapt fixture helpers/imports to the file's existing style; `mkdtempSync`/`tmpdir` are already in use there):

```ts
it("--config is parsed, ignored, and warns on stderr", async () => {
  const dir = mkdtempSync(join(tmpdir(), "junco-cli-"));
  const configPath = join(dir, ".junco", "config.json");
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify({ vaultRoot: dir, juncoSubdir: "tickets" }));
  const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  let out = "";
  const code = await run(["inbox-path", "--config", "/somewhere/else/config.json"], {
    printFn: (s) => (out += s),
    env: { HOME: dir },
  });
  expect(code).toBe(0);
  expect(out.trim()).toBe(join(dir, "tickets", "inbox")); // canonical config won, not the flag
  expect(errSpy.mock.calls.map((c) => String(c[0])).join("")).toContain("--config is deprecated");
  errSpy.mockRestore();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/cli.test.ts > /tmp/t2a 2>&1; echo "exit: $?"` — expect FAIL (no notice emitted).

- [ ] **Step 3: Implement**

Immediately after the `configPath` resolution in `run()`:

```ts
if (values.config !== undefined) {
  process.stderr.write(
    "junco: --config is deprecated and ignored — the config always lives at " +
      `~/.junco/config.json (resolved: ${configPath}). See docs/configuration.md.\n`,
  );
}
```

Annotate the option in `parseCli` (line 240):

```ts
// Deprecated + inert: kept PARSED so installed service units that still pass
// `--config <path>` don't crash-loop under strict:true (see run()'s notice).
// Actual removal is a separate breaking change once rendered units are flagless.
config: { type: "string" },
```

Text scrub in the same file: header comment lines 6-14 (drop every `[--config <path>]`), USAGE lines 220-221 (delete the `--config` option row entirely), line 883 → `Usage: junco submit <file|->`, line 936 → `Usage: junco dispatch <owner/repo#N | issue-url>`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/cli.test.ts > /tmp/t2b 2>&1; echo "exit: $?"` — expect PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/cli.ts tests/cli.test.ts
git add src/cli.ts tests/cli.test.ts
git commit -m "feat(cli): make --config inert with a deprecation notice

Kept parsed (strict parseArgs would crash-loop installed service units that
still pass it); its value no longer influences resolution."
```

---

### Task 3: `discoverService` finds flagless units (BEFORE templates change)

Today launchd discovery matches plists by the config path inside `ProgramArguments` — which only exists there via `--config`. Once Task 4 renders flagless units, discovery would return null and `junco restart` / `ensureDaemon` / **the maintainer's auto-promote hook** would break. Systemd already has a single-`junco*`-unit fallback (`src/restartCmd.ts:114-115`) that covers flagless units; only launchd needs the new fallback.

**Files:**
- Modify: `src/restartCmd.ts:1-12` (header comment), `src/restartCmd.ts:70-94` (darwin branch)
- Test: `tests/restartCmd.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (signature `discoverService(configPath, deps)` unchanged).
- Produces: launchd discovery contract = exact config-path match first, else any plist whose `ProgramArguments` include `"start"` and some element containing `"junco"`. Task 4's flagless templates and Task 7's runbook rely on this.

- [ ] **Step 1: Write the failing tests**

Add to `tests/restartCmd.test.ts` (reuse `makeFakes`, `CONFIG`, and the existing `juncoPlist`/`decoyPlist` fixtures at lines 70-77; match their exact shapes):

```ts
const flaglessPlist = {
  Label: "com.junco.worker",
  ProgramArguments: ["/usr/local/bin/node", "/opt/junco/dist/cli.js", "start"],
};

it("launchd: falls back to a flagless junco unit when no plist references the config path", async () => {
  const f = makeFakes({ plists: { "a-decoy.plist": decoyPlist, "j.plist": flaglessPlist } });
  expect(await discoverService(CONFIG, f.deps)).toEqual({
    platform: "launchd",
    id: "com.junco.worker",
  });
});

it("launchd: an exact config-path match beats a flagless junco unit", async () => {
  const f = makeFakes({ plists: { "flagless.plist": flaglessPlist, "legacy.plist": juncoPlist } });
  expect((await discoverService(CONFIG, f.deps))?.id).toBe(juncoPlist.Label);
});

it("launchd: a flagless unit that is not junco-ish does not match", async () => {
  const f = makeFakes({
    plists: { "x.plist": { Label: "com.x.thing", ProgramArguments: ["/usr/bin/foo", "start"] } },
  });
  expect(await discoverService(CONFIG, f.deps)).toBeNull();
});
```

- [ ] **Step 2: Run to verify the first and second fail**

Run: `npx vitest run tests/restartCmd.test.ts > /tmp/t3a 2>&1; echo "exit: $?"` — expect FAIL (fallback missing).

- [ ] **Step 3: Implement**

Replace the darwin branch of `discoverService` (`src/restartCmd.ts:70-94`):

```ts
if (platform === "darwin") {
  const dir = join(home, "Library", "LaunchAgents");
  const parsed: Array<{ label: string; args: string[] }> = [];
  for (const name of (deps.readdirFn ?? defaultReaddir)(dir).filter((n) =>
    n.endsWith(".plist"),
  )) {
    const r = await execFn("plutil", ["-convert", "json", "-o", "-", join(dir, name)]);
    if (r.code !== 0) continue; // unreadable/binary-corrupt plist — keep scanning
    try {
      const j = JSON.parse(r.stdout) as { Label?: string; ProgramArguments?: string[] };
      if (j.Label && Array.isArray(j.ProgramArguments)) {
        parsed.push({ label: j.Label, args: j.ProgramArguments });
      }
    } catch {
      continue;
    }
  }
  // Exact config-path match first: pre-0.10 units carry `--config <path>`,
  // and on a legacy multi-config machine it picks the right unit.
  let matches = parsed.filter((p) => p.args.includes(cfg)).map((p) => p.label);
  // 0.10+ units are flagless — fall back to a junco-ish invocation: a `start`
  // verb plus some argument mentioning "junco" (the binary, an npm binstub,
  // or a dist/cli.js path under the package dir always does; the Label can be
  // customized, so it cannot be relied on).
  if (matches.length === 0) {
    matches = parsed
      .filter((p) => p.args.includes("start") && p.args.some((a) => a.includes("junco")))
      .map((p) => p.label);
  }
  if (matches.length === 0) return null;
  if (matches.length > 1 && deps.printFn) {
    deps.printFn(
      `multiple launchd jobs reference this config; using ${matches[0]} (others: ${matches.slice(1).join(", ")})\n`,
    );
  }
  return { platform: "launchd", id: matches[0] };
}
```

Update the module header comment (`src/restartCmd.ts:4-6`): discovery is by config path for legacy units, falling back to a flagless junco invocation. In the systemd branch, add one comment line noting the existing single-unit fallback (line 114-115) is what covers flagless units there.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/restartCmd.test.ts > /tmp/t3b 2>&1; echo "exit: $?"` — expect PASS (existing exact-match/decoy/unreadable tests must still pass).

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/restartCmd.ts tests/restartCmd.test.ts
git add src/restartCmd.ts tests/restartCmd.test.ts
git commit -m "feat(restart): discover flagless junco service units

Exact config-path match keeps priority; units rendered without --config
(next commit) fall back to a start-verb + junco-path heuristic. Required
by ensureDaemon and the post-merge promote flow."
```

---

### Task 4: Service templates drop `--config`; `ServiceOpts.configPath` removed

**Files:**
- Modify: `src/service.ts:1-16` (header), `src/service.ts:24-45` (`ServiceOpts`), `src/service.ts:63-82` (`resolveOpts`), `src/service.ts:88-125` (plist template), `src/service.ts:129-171` (systemd template)
- Modify: `src/cli.ts:405` (the `renderService(platform, { cliEntry, configPath, … })` call)
- Test: `tests/service.test.ts`

**Interfaces:**
- Consumes: Task 3's discovery fallback (flagless units stay restartable).
- Produces: `ServiceOpts` without `configPath` — `{ label?, nodeBin?, cliEntry, logDir?, home?, pathEnv?, stopTimeoutSeconds? }`; `logDir` default `join(home || homedir(), ".junco")`. Rendered invocations: launchd `ProgramArguments` `[nodeBin, cliEntry, "start"]`; systemd `ExecStart="<nodeBin>" "<cliEntry>" start`.

- [ ] **Step 1: Invert the template tests**

In `tests/service.test.ts`: remove `configPath: "/x/config.json"` from the shared base opts (line 16). Rewrite:
- Lines 44-50 → one test: `it("does not render --config (config resolves from the environment)")` asserting `expect(out).not.toContain("--config")` for the launchd render.
- Lines 114-117 (logDir default) → pass `home: "/x"` in opts; expect `<string>/x/.junco/launchd.out</string>`.
- Line 146-149 → `'ExecStart="/usr/bin/node" "/x/dist/cli.js" start'` (no config segment); also assert `not.toContain("--config")`.
- Lines 208-211 and 233-236 (quoting/escaping) → drop the config path from the expected `ExecStart`; the `$`/`%`/space escaping coverage survives via the existing `nodeBin` and `cliEntry` values in those tests.

- [ ] **Step 2: Run to verify failures**

Run: `npx vitest run tests/service.test.ts > /tmp/t4a 2>&1; echo "exit: $?"` — expect FAIL (templates still render the flag; fixture type error surfaces at runtime via esbuild only if asserted — rely on the assertion failures).

- [ ] **Step 3: Implement**

`src/service.ts`: delete the `configPath` field from `ServiceOpts` (and its doc line); add `import { homedir } from "node:os";`; update `resolveOpts`:

```ts
function resolveOpts(opts: ServiceOpts): Required<ServiceOpts> {
  const nodeBin = opts.nodeBin ?? process.execPath;
  const home = opts.home ?? process.env.HOME ?? "";
  // launchd.out/err land under the junco home by default — next to the
  // canonical config, ahead of the single-root logs/ consolidation.
  const logDir = opts.logDir ?? join(home !== "" ? home : homedir(), ".junco");
  const nodeBinDir = dirname(nodeBin);
  const pathEnv = opts.pathEnv ?? `${nodeBinDir}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`;
  const label = opts.label ?? "com.junco.worker";
  const stopTimeoutSeconds = opts.stopTimeoutSeconds ?? 2400;
  return { label, nodeBin, cliEntry: opts.cliEntry, logDir, home, pathEnv, stopTimeoutSeconds };
}
```

Templates: in `renderLaunchdPlist` delete the two lines `<string>--config</string>` / `<string>${x(o.configPath)}</string>`; in `renderSystemdUnit` the ExecStart becomes `ExecStart=${qExec(o.nodeBin)} ${qExec(o.cliEntry)} start`. Header comment line 9 → ``run `<nodeBin> <cliEntry> start` (config resolves from the environment: ~/.junco/config.json)``. Drop `resolve` from the `node:path` import if now unused.

`src/cli.ts:405`: `renderService(platform, { cliEntry, stopTimeoutSeconds, logDir })`.

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run tests/service.test.ts tests/cli.test.ts > /tmp/t4b 2>&1; echo "exit: $?"` — expect PASS. `npx tsc --noEmit -p tsconfig.eslint.json` — no NEW errors (the removed field must be gone from every construction site).

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/service.ts src/cli.ts tests/service.test.ts
git add src/service.ts src/cli.ts tests/service.test.ts
git commit -m "feat(service): render flagless units — config resolves from the environment"
```

---

### Task 5: TUI `cliRunner` stops passing `--config`

**Files:**
- Modify: `src/tui/cliRunner.ts:1-10` (header), `src/tui/cliRunner.ts:93-110` (`runCliCommand` signature + spawn args)
- Modify: `src/tui/App.tsx:258-263` (`runCliFn` memo)
- Test: `tests/tuiCliRunner.test.ts:98-112`

**Interfaces:**
- Consumes: canonical resolution (the spawned child inherits the parent's environment and resolves the same `~/.junco/config.json`).
- Produces: `runCliCommand(name: string, extraArgs: string[], deps?: CliRunnerDeps): Promise<CliRunResult>` — the `configPath` first parameter is gone.

- [ ] **Step 1: Invert the spawn-args test**

`tests/tuiCliRunner.test.ts:98-112`: the call becomes `runCliCommand(name, extra, deps)`; the expected spawn args become `[cliPath, name, ...extra]` and add `expect(args).not.toContain("--config")` (a stray flag would print the Task 2 deprecation notice into every palette command's captured output).

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/tuiCliRunner.test.ts > /tmp/t5a 2>&1; echo "exit: $?"` — expect FAIL.

- [ ] **Step 3: Implement**

`src/tui/cliRunner.ts`: remove the `configPath` parameter; spawn line becomes:

```ts
child = spawnFn(process.execPath, [cliPath, name, ...extraArgs], {
  stdio: ["ignore", "pipe", "pipe"],
});
```

Header comment: the child resolves the same canonical config from the inherited environment — no flag threading.

`src/tui/App.tsx:258-263`: the memo drops `configPath` from the closure AND the dep array (exhaustive-deps is at error — the array must shrink, not the rule):

```tsx
const runCliFn = useMemo(
  () => props.runCliFn ?? ((name: string, extraArgs: string[]) => runCliCommand(name, extraArgs)),
  [props.runCliFn],
);
```

`configPath` remains in use elsewhere in App (display/props); if lint reports it fully unused, follow the lint, not this plan.

- [ ] **Step 4: Run tests + lint**

Run: `npx vitest run tests/tuiCliRunner.test.ts > /tmp/t5b 2>&1; echo "exit: $?"` — expect PASS. Then `npm run lint` (react-hooks rules must be clean).

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/tui/cliRunner.ts src/tui/App.tsx tests/tuiCliRunner.test.ts
git add src/tui tests/tuiCliRunner.test.ts
git commit -m "refactor(tui): spawn palette commands without --config"
```

---

### Task 6: Documentation sweep

Docs are conformance assertions in this repo — every claim about resolution order must match the new contract.

**Files:**
- Modify: `docs/operations.md` (line 9 paragraph; strip `[--config <path>]` from every table row in lines 13-28; examples at lines 87, 97, 177)
- Modify: `docs/configuration.md:3`
- Modify: `docs/tickets.md:92-98`
- Modify: `CLAUDE.md:50` (stale "Config resolution prefers `./config.json`" clause)
- Check: `ARCHITECTURE.md` (`grep -n -i "config" ARCHITECTURE.md | grep -i "resol\|\./config\|--config"` — fix any stale resolution claim; the `worker.lock next to config.json` phrasing stays true)

**Interfaces:** consumes the final behavior of Tasks 1-5; produces nothing downstream.

- [ ] **Step 1: `docs/operations.md`**

Replace line 9 with:

> Junco reads its configuration from a single canonical location: `~/.junco/config.json` — the same from any working directory, with or without flags. Installs that predate this (0.10) are still read from the legacy `~/.config/junco/config.json` (respects `XDG_CONFIG_HOME`) until the canonical file exists; the `--config` flag is deprecated and ignored (junco prints a notice when it is passed). No global install needed: `npx @ironforgesoftware/junco <command>` works the same as the installed `junco` binary.

Strip ` [--config <path>]` / `[--config <path>]` from every command-signature cell in the table (lines 13-28). Update the service examples at lines 87 and 97 to drop `--config ~/junco/config.json`, and the submit example at line 177 to `junco submit ./fixed-ticket.md`.

- [ ] **Step 2: `docs/configuration.md:3`**

Replace the resolution sentence with:

> Junco is configured via a single JSON file: `~/.junco/config.json` (pre-0.10 installs are still read from the legacy `~/.config/junco/config.json`, which respects `XDG_CONFIG_HOME`, until the canonical file exists). Every field is optional; anything you omit falls back to its default.

Keep the rest of the paragraph (wizard / `junco config init` guidance) but delete the `--config` parenthetical.

- [ ] **Step 3: `docs/tickets.md:92-98`**

Drop `--config ~/junco/config.json` from the three examples (`junco submit ./my-ticket.md`, `cat my-ticket.md | junco submit -`, `junco inbox-path`).

- [ ] **Step 4: `CLAUDE.md:50`**

Replace the clause `Config resolution prefers './config.json', so running the CLI from the repo root picks up the **live** config — sandbox every smoke test:` with:

> Config resolution is HOME-anchored (`~/.junco/config.json`, legacy XDG fallback) — cwd never matters, but running the CLI with your real `HOME` still picks up the **live** config, so sandbox every smoke test:

(The existing sandbox recipe already overrides `HOME`/`XDG_CONFIG_HOME`, so it keeps working verbatim.)

- [ ] **Step 5: Verify and commit**

`grep -rn -- '--config' docs/*.md README.md CLAUDE.md ARCHITECTURE.md` must return nothing outside `docs/superpowers/plans/` (historical, untouched). Run `npm run format:check`.

```bash
git add docs CLAUDE.md ARCHITECTURE.md
git commit -m "docs: canonical config location ~/.junco/config.json; retire --config"
```

---

### Task 7: Full gate, PR, follow-up issues, migration runbook

**Files:** none new (gate + GitHub actions).

- [ ] **Step 1: Full gate**

Run: `npm run lint && npm run format:check && npm run typecheck && npm run build && npm test` — capture the final exit code explicitly (`echo "exit: $?"`). All five must pass before any claim of done.

- [ ] **Step 2: Sweep for AI attribution**

`git log --format='%B' origin/main..HEAD | grep -in "claude\|generated with"` must return nothing; amend any commit that acquired a trailer.

- [ ] **Step 3: Push and open the PR (do NOT merge)**

```bash
git push -u origin feat/config-resolution-env-only
gh pr create --title "feat: cwd-independent config resolution — canonical ~/.junco/config.json" --body-file <body>
```

PR body must contain: the incident summary (one paragraph), the breaking note (**0.10.0**: `--config` inert; canonical moved; legacy XDG fallback), the discovery-fallback rationale, and the migration runbook below. **Merging is maintainer-gated**: the merge auto-promotes to the live daemon, so the pre-merge runbook steps must be complete first.

- [ ] **Step 4: File follow-up issues** (labels per repo habit; reference the PR)

1. **Single-root `~/.junco/` consolidation** (umbrella): move the data tree — `queue/`, `review/`, `watchlist.json`, `data/` (assess-history, history, transcripts), `cache/` (clones, github-cache, update-check, worktrees), `logs/` (consolidating `worker.log` + launchd.out/err) — under `~/.junco/`; extend `dataMigrate.ts`; enables root-level sandbox deny except `cache/` (resolves the `dataTree.ts:69-75` compromise); then remove the legacy XDG config fallback.
2. **FTUE liveness gate**: the setup walkthrough must refuse to run when a daemon is up (health endpoint answers) or the data tree is non-empty — it ran against a 4-day-uptime daemon in the incident.
3. **Queue-divergence startup warning**: warn when the resolved `queueRoot` is empty but another known queue root contains tickets — the incident was invisible because both sides reported healthy.
4. **`JUNCO_CONFIG` env override** for scripted/non-interactive contexts (precedence: above canonical or below? decide there).
5. **Remove `--config` parsing entirely** — the final breaking step, once rendered units in the wild are flagless (blocked on adoption, not code).

- [ ] **Step 5: Migration runbook (live install — maintainer executes/confirms each step)**

*Pre-merge (required — merging auto-promotes the daemon):*
1. `mkdir -p ~/.junco && cp ~/junco/config.json ~/.junco/config.json` — verbatim copy. It MUST retain `vaultRoot: "~/junco"` / `juncoSubdir: "tickets"` so the queue stays at `~/junco/tickets`; migrating config location and queue location at once is how the original split happened.
2. Confirm `~/.config/junco/config.json` does not exist (the FTUE-written one was deleted in triage). If present, inspect, then remove — with the canonical staged it can no longer win, but it would linger as a trap for the legacy fallback if the canonical were ever deleted.
3. Confirm the daemon is idle: `curl -s http://127.0.0.1:8787/health` → `currentTicket: null`. Do not merge mid-ticket — the promote restart would hard-kill it.

*Merge → auto-promote:* the hook rebuilds and runs `junco restart`; either binary generation discovers the unit (old binary: cwd/`--config` path match; new binary: Task 3 fallback). Verify `junco-promote.log` and `/health` ready on a NEW pid.

*Post-merge:*
4. Re-render or hand-edit the unit to drop the flag: remove the `<string>--config</string>` + `<string>/Users/…/config.json</string>` lines from `~/Library/LaunchAgents/com.edelweiss.junco-worker.plist`, then `launchctl bootout gui/$UID/com.edelweiss.junco-worker && launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.edelweiss.junco-worker.plist`. (Leaving it is safe — the flag is inert — but every start logs a deprecation line to launchd.err.)
5. Relocate the two orphaned assess tickets: `mv ~/.local/state/junco/queue/inbox/*.md ~/junco/tickets/inbox/` (inbox moves are safe while running; claims are atomic renames).
6. Re-add the repo lost with the deleted FTUE config: `alxedelweiss/arkanoid` → `/Users/alxedelweiss/Development/arkanoid`, via the dashboard watchlist.
7. Cleanup, maintainer's call: the stale `~/junco/worker.lock` (the lock now lives at `~/.junco/worker.lock`); keep `~/junco/config.json` in place as a dormant rollback copy until the single-root migration lands.
8. Verify: `junco status`, one `junco restart` round-trip (exercises the flagless discovery on the real unit), dashboard shows the queue and both relocated tickets.

---

## Self-Review (performed at authoring time)

- **Spec coverage:** note §Implementation-surface 1-4 → Tasks 1, 2, 4, 1; §Sequencing-hazard → Global Constraints + Task 2; §Migration → Task 7; §Open-decision → resolved by maintainer (`~/.junco`). Gaps the note missed, covered here: `discoverService` breakage (Task 3 — required by the promote hook), TUI `cliRunner` (Task 5), `wizard.summary()` dead hint (Task 1), `CliDeps.env` test seam (Task 1), `ServiceOpts.logDir` default losing its `configPath` anchor (Task 4), `CLAUDE.md`/docs staleness (Task 6), legacy-XDG fallback so existing installs don't FTUE-overwrite (Task 1).
- **Deviation from the note, deliberate:** the deprecation notice is a direct stderr write at the resolution site, not the `configDeprecations` channel — that channel is `Config`-shaped and only prints on daemon paths; a `--config` user on ANY subcommand must see the notice. Second deviation: canonical is `~/.junco/config.json` (maintainer decision), not the note's recommended XDG path, so the note's "keep the XDG tests as-is" is superseded by Task 1's rewrite.
- **Type consistency:** `resolveConfigPath(deps?)`/`juncoHome`/`legacyConfigPath`/`CliDeps.env` (Task 1) are consumed with identical shapes in Tasks 2-5; `ServiceOpts` post-Task-4 shape matches the Task 4 call-site change; `runCliCommand(name, extraArgs, deps?)` matches App.tsx usage.
