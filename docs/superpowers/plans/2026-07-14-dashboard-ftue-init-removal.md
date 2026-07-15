# Dashboard FTUE + `junco init` Removal (Plan B of 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The dashboard becomes junco's only interactive flow: first open with no config runs the setup walkthrough in-place (FTUE), the walkthrough is re-runnable from the command palette, the wizard is mouse-driven, and the standalone `junco init` subcommand is removed (headless scaffold moves to `junco config init`).

**Architecture:** A `Root` switcher component hosts either `WizardApp` or `App` inside one Ink render root (one alternate screen, one `MouseProvider`). `WizardApp` stops exiting the Ink instance itself — it reports its outcome and `Root` decides (swap to dashboard, or exit 130 on a fresh-mode cancel). The wizard-IO assembly is extracted from `runInitWizard` into `buildWizardIO` so `Root` and tests share it; `runInitWizard` and the `init` subcommand are then deleted.

**Tech Stack:** TypeScript strict/ESM, React 19.2.7 + ink 7.1.0, vitest + ink-testing-library.

**Spec:** `docs/superpowers/specs/2026-07-14-tui-mouse-ftue-design.md` (Sections 3-wizard, 4, 5). **Depends on Plan A** (`2026-07-14-tui-mouse-registry.md`): `ClickableBox`, `MouseProvider`, `useGuardedInput`, `theme.hoverBg` must exist. Same branch, after Plan A's tasks.

## Global Constraints

- Everything from Plan A's Global Constraints applies verbatim (gate, no-attribution, prettier, flake rule, exit-code trap, typecheck-covers-tests).
- **Breaking-change discipline:** `junco init` removal is a breaking CLI change → CHANGELOG under `[Unreleased]` with a **Removed** section. NO version bump, NO tag, NO release (Release HOLD is absolute; the maintainer cuts v0.8.0).
- Packaged surface stays stack-agnostic: any new wizard/dashboard copy says "inference endpoint", never a specific server.
- The repo doubles as the maintainer's live runtime: never run `junco start`/`dashboard` from the repo root; smoke-test only inside a sandboxed `$HOME` (CLAUDE.md recipe).
- `docs/` + `README.md` claims are conformance assertions — every `junco init` mention must be updated in the same PR that removes the command.

---

### Task 1: `junco config init` — headless scaffold replacement

**Files:**

- Modify: `src/configCmd.ts`, `src/wizard.ts` (export `summary`), `src/cli.ts` (USAGE line for `config`), `scripts/package-smoke.sh`, `CLAUDE.md` (sandbox recipe line)
- Test: `tests/configCmd.test.ts`

**Interfaces:**

- Consumes: `renderConfigJson`, `defaultAnswers` (`src/wizard/flow.js`), `queuePaths`, `loadConfig` (`src/config.js`), `summary` (newly exported from `src/wizard.js`).
- Produces: `junco config init` subcommand — exact old `junco init --yes` behavior: fresh → write default config + ensure queue dirs + print summary, exit 0; existing config → NEVER overwrite, ensure queue dirs, print "Config already exists…", exit 0.

- [ ] **Step 1: Write the failing tests** — add to `tests/configCmd.test.ts` (mirror the file's existing deps-injection style):

```ts
describe("config init", () => {
  it("fresh: writes the default config, ensures queue dirs, prints the summary", () => {
    const written = new Map<string, string>();
    const made: string[] = [];
    const out: string[] = [];
    const code = runConfigCommand(["init"], "/tmp/cfg/config.json", {
      existsFn: () => false,
      writeFileFn: (p, s) => void written.set(p, s),
      mkdirFn: (p) => void made.push(p),
      loadConfigFn: () => makeFakeConfig(), // helper with queue paths under /tmp/q
      printFn: (s) => void out.push(s),
    });
    expect(code).toBe(0);
    expect([...written.keys()]).toEqual(["/tmp/cfg/config.json"]);
    expect(JSON.parse(written.get("/tmp/cfg/config.json") ?? "")).toBeTypeOf("object");
    expect(made.length).toBeGreaterThan(0); // inbox/processing/done/failed/worktrees
    expect(out.join("")).toContain("Wrote config");
  });

  it("existing config: never overwrites, still ensures dirs", () => {
    const written: string[] = [];
    const out: string[] = [];
    const code = runConfigCommand(["init"], "/tmp/cfg/config.json", {
      existsFn: () => true,
      writeFileFn: (p) => void written.push(p),
      mkdirFn: () => {},
      loadConfigFn: () => makeFakeConfig(),
      printFn: (s) => void out.push(s),
    });
    expect(code).toBe(0);
    expect(written).toEqual([]);
    expect(out.join("")).toContain("Config already exists");
  });
});
```

(`ConfigCmdDeps` gains `mkdirFn?: (p: string) => void` and `loadConfigFn?: (p: string) => Config` — add them; `makeFakeConfig` = a minimal `Config` literal helper local to the test file. If `tests/configCmd.test.ts` already has one, reuse it.)

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/configCmd.test.ts` → FAIL (unknown subcommand 'init').

- [ ] **Step 3: Implement.**

`src/wizard.ts` — change `function summary(` to `export function summary(` (it already renders both the "Wrote config" and "Config untouched" variants plus NEXT_STEPS).

`src/configCmd.ts` — extend `ConfigCmdDeps`:

```ts
  mkdirFn?: (p: string) => void;
  loadConfigFn?: (p: string) => Config;
```

(imports: `import { mkdirSync } from "node:fs";` — extend the existing fs import — plus `import { loadConfig, queuePaths } from "./config.js";`, `import type { Config } from "./types.js";`, `import { renderConfigJson, defaultAnswers } from "./wizard/flow.js";`, `import { summary } from "./wizard.js";`, `import { resolve } from "node:path";`.)

Add before the final unknown-subcommand error:

```ts
if (sub === "init") {
  // Headless scaffold — the old `junco init --yes` contract verbatim:
  // fresh → default config + queue dirs; existing → ensure dirs, NEVER
  // overwrite. (The interactive walkthrough lives in `junco dashboard`.)
  const mkdir = deps.mkdirFn ?? ((p: string) => mkdirSync(p, { recursive: true }));
  const loadConfigFn = deps.loadConfigFn ?? loadConfig;
  const resolved = resolve(configPath);
  const ensureDirs = (cfg: Config): string => {
    const paths = queuePaths(cfg);
    for (const d of [paths.inbox, paths.processing, paths.done, paths.failed, cfg.worktreeRoot]) {
      mkdir(d);
    }
    return dirname(paths.inbox);
  };
  if (exists(resolved)) {
    const queueRoot = ensureDirs(loadConfigFn(resolved));
    print(`Config already exists at ${resolved}; ensured queue directories under ${queueRoot}.\n`);
    return 0;
  }
  mkdir(dirname(resolved));
  writeFile(resolved, renderConfigJson(defaultAnswers()));
  const queueRoot = ensureDirs(loadConfigFn(resolved));
  print(summary(resolved, queueRoot, true));
  return 0;
}
```

Update the trailing error string: `(path|list|get|set|init)`.

`src/cli.ts` USAGE — the config line becomes:

```
  config path|list|get <path>|set <path> <value>|init  Inspect/edit config.json knobs; init scaffolds defaults
```

`scripts/package-smoke.sh` — replace `"$JUNCO" init --yes` with `"$JUNCO" config init` (comment update on line 4: "config-init scaffold").

`CLAUDE.md` — in the sandbox recipe, `init --yes` → `config init`.

- [ ] **Step 4: Verify** — `npx vitest run tests/configCmd.test.ts tests/cli.test.ts > /tmp/out 2>&1; echo "exit: $?"` → 0. Then `npm run build && bash scripts/package-smoke.sh` → "package smoke OK".

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/configCmd.ts src/wizard.ts src/cli.ts tests/configCmd.test.ts
git add -A
git commit -m "feat(config): junco config init — headless default-config scaffold"
```

---

### Task 2: Extract `buildWizardIO`; `WizardApp` stops exiting Ink itself

**Files:**

- Modify: `src/wizard.ts` (extract), `src/tui/wizard/WizardApp.tsx` (drop `useApp().exit`)
- Test: `tests/wizard.test.ts` (buildWizardIO specs), `tests/wizardApp.test.tsx` (outcome-only assertions)

**Interfaces:**

- Consumes: existing `WizardDeps`, `WizardIO` (`src/wizard/io.js`).
- Produces (exact):

```ts
// src/wizard.ts
export type WizardIoResult =
  | { ok: true; io: WizardIO; mode: "fresh" | "rerun" }
  | { ok: false; error: string };
export function buildWizardIO(configPath: string, deps?: WizardDeps): WizardIoResult;
```

`WizardApp` keeps its exact props (`io`, `onOutcome`, `sizeOverride`, `revealMs`) but `finishWith` no longer calls `exit()` — the HOST owns the instance lifetime (Root, Task 3). `onOutcome` still fires exactly once.

- [ ] **Step 1: Failing tests.**

`tests/wizard.test.ts` — add:

```ts
describe("buildWizardIO", () => {
  it("fresh mode when no config exists; io.write scaffolds it", () => {
    const r = buildWizardIO("/tmp/w/config.json", {
      existsFn: () => false,
      /* …the file's existing fs/detect fakes… */
    });
    expect(r.ok && r.mode).toBe("fresh");
  });
  it("rerun mode reads the existing raw config into initialAnswers", () => {
    /* existsFn true + readFileFn returning a valid minimal config JSON →
       r.ok, r.mode === "rerun", r.io.currentRaw is the parsed object */
  });
  it("invalid existing config → ok:false with the parse reason", () => {
    /* readFileFn returns "not json" → { ok: false, error: /not a valid config|JSON/ } */
  });
});
```

(Reuse the fake-deps helpers `tests/wizard.test.ts` already builds for `runInitWizard` — the IO contract itself is already covered there; these specs pin the new entry point.)

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement.**

`src/wizard.ts` — move the body of `runInitWizard` between the `mode` computation and the `io` literal (inclusive) into:

```ts
export function buildWizardIO(configPath: string, deps: WizardDeps = {}): WizardIoResult {
  const resolved = resolve(configPath);
  const existsFn = deps.existsFn ?? existsSync;
  /* …the same readFileFn/writeFileFn/renameFn/unlinkFn/mkdirFn/loadConfigFn
     defaulting lines runInitWizard has today… */
  const mode: "fresh" | "rerun" = existsFn(resolved) ? "rerun" : "fresh";
  let raw: Record<string, unknown> | null = null;
  if (mode === "rerun") {
    /* …the existing parse/validate-shape block, but returning
       { ok: false, error: `${resolved} is not a valid config (${reason})` }
       instead of printing+returning 1… */
  }
  const io: WizardIO = {
    /* …the existing literal, verbatim, minus the
    outer-scope `wroteFile` flag (delete it — the post-write cancel path it
    served is unreachable from the dashboard host: after a successful write
    the WizardApp maps quit/Ctrl-C to done, never cancelled)… */
  };
  return { ok: true, io, mode };
}
```

`runInitWizard` shrinks to: `--yes` branch (unchanged for now — deleted in Task 4), the raw-mode probe, then `const built = buildWizardIO(configPath, deps); if (!built.ok) { printFn(`junco init: ${built.error}\n…`); return 1; }` and the existing collect/outcome/summary tail using `built.io`.

`src/tui/wizard/WizardApp.tsx` — delete the `useApp` import and `const { exit } = useApp();`; `finishWith` becomes:

```ts
const finishWith = (o: WizardOutcome): void => {
  if (reported.current) return;
  reported.current = true;
  onOutcome(o);
};
```

(Update the module doc: "Outcome is reported exactly once via onOutcome; the HOST — Root — swaps views or exits.")

- [ ] **Step 4: Fix `tests/wizardApp.test.tsx`** — any spec that asserted the app un-rendered/exited after finish now asserts only that `onOutcome` fired with the right value (and fires once on double-finish attempts). `npx vitest run tests/wizard.test.ts tests/wizardApp.test.tsx tests/wizardChapters.test.tsx > /tmp/out 2>&1; echo "exit: $?"` → 0.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/wizard.ts src/tui/wizard/WizardApp.tsx tests/wizard.test.ts tests/wizardApp.test.tsx
git add -A
git commit -m "refactor(wizard): extract buildWizardIO; WizardApp defers lifetime to its host"
```

---

### Task 3: `Root` switcher + FTUE in `runDashboard` + palette "setup" re-run

**Files:**

- Create: `src/tui/Root.tsx`
- Modify: `src/dashboardCmd.ts` (cfg nullable, `buildAppProps` extraction, render Root), `src/tui/App.tsx` (`onRequestWizard` prop + paletteEnter special case), `src/tui/cliRunner.ts` (roster row), `src/cli.ts` (dashboard block passes null for missing config)
- Test: `tests/tuiRoot.test.tsx`, `tests/dashboardCmd.test.ts` (extend), `tests/tuiCliRunner.test.ts` (roster consistency exception)

**Interfaces:**

- Consumes: `buildWizardIO` (Task 2), `WizardApp` (outcome-only, Task 2), `MouseProvider` (Plan A), `App`, `loadConfig`.
- Produces (exact):

```tsx
// src/tui/Root.tsx
export interface RootProps {
  configPath: string;
  initialConfig: Config | null; // null → FTUE: wizard first
  buildAppProps: (cfg: Config) => Omit<React.ComponentProps<typeof App>, "onRequestWizard">;
  makeWizardIo: () => WizardIoResult;
  loadConfigFn: (p: string) => Config;
  onFinalExitCode: (code: number) => void; // 130 on FTUE cancel; otherwise never called
}
export function Root(props: RootProps): React.JSX.Element;

// App.tsx — new prop
onRequestWizard?: () => void;

// dashboardCmd.ts — signature widens
export async function runDashboard(cfg: Config | null, configPath: string, deps?: DashboardDeps): Promise<number>;
// DashboardDeps gains: loadConfigFn?: (p: string) => Config; printOut?: (s: string) => void;
```

- [ ] **Step 1: Failing tests.**

`tests/tuiRoot.test.tsx`:

```tsx
import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { Text } from "ink";
import { render, cleanup } from "ink-testing-library";
import { Root } from "../src/tui/Root.js";
import { until } from "./helpers/until.js";

afterEach(cleanup);

// A scripted WizardIO: fresh mode, deterministic checks, io.write records.
function fakeIo(overrides = {}) {
  return {
    mode: "fresh",
    configPath: "/tmp/x/config.json",
    initialAnswers: /* defaultAnswers() — import from src/wizard/flow.js */ undefined!,
    currentRaw: null,
    greetName: () => "friend",
    preflight: async () => [],
    discoverModels: async () => ({ ok: false, error: "n/a" }),
    listModelsJson: () => ({ ok: false, error: "n/a" }),
    listCatalogProviders: async () => [],
    write: vi.fn(() => ({
      written: true,
      configPath: "/tmp/x/config.json",
      queueRoot: "/tmp/x/q",
      changes: [],
    })),
    flightCheck: async () => [],
    ...overrides,
  };
}
// NOTE: match the real WizardIO shape in src/wizard/io.ts EXACTLY — read it
// first; the literal above is indicative and must be corrected against it.

describe("Root FTUE switcher", () => {
  it("no config → renders the wizard; fresh-mode cancel exits 130", async () => {
    const onCode = vi.fn();
    const r = render(
      <Root
        configPath="/tmp/x/config.json"
        initialConfig={null}
        buildAppProps={() => {
          throw new Error("App must not mount before a config exists");
        }}
        makeWizardIo={() => ({ ok: true, io: fakeIo() as never, mode: "fresh" })}
        loadConfigFn={() => {
          throw new Error("unused");
        }}
        onFinalExitCode={onCode}
      />,
    );
    await until(() => (r.lastFrame() ?? "").includes("junco setup"));
    r.stdin.write("q"); // Welcome chapter → cancel
    await until(() => onCode.mock.calls.length === 1);
    expect(onCode).toHaveBeenCalledWith(130);
  });

  it("config present → renders the App props straight away", async () => {
    const r = render(
      <Root
        configPath="/tmp/x/config.json"
        initialConfig={{} as never}
        buildAppProps={() => ({ marker: true }) as never}
        makeWizardIo={() => ({ ok: false, error: "unused" })}
        loadConfigFn={() => ({}) as never}
        onFinalExitCode={() => {}}
      />,
    );
    // buildAppProps feeding the REAL App needs the localFixtures prop set —
    // use makeAppProps() exported from tests/helpers/localFixtures.ts.
    await until(() => (r.lastFrame() ?? "").length > 0);
  });
});
```

(Export a `makeAppProps()` helper from `tests/helpers/localFixtures.ts` — the props object its `renderApp` already assembles — and use it as `buildAppProps` so the second spec mounts the real App and asserts its header renders. Adjust the first spec's chapter-cancel key to whatever `tests/wizardApp.test.tsx` uses to cancel from Welcome — reuse that file's exact incantation.)

`tests/dashboardCmd.test.ts` — extend: `runDashboard(null, path, { isTTY: false, printErr })` → returns 1 and the message mentions `config init`; `runDashboard(null, path, { isTTY: true, renderFn: spy })` → renderFn receives an element (Root path) without throwing.

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement.**

`src/tui/Root.tsx`:

```tsx
/** FTUE switcher (spec §4): one Ink root hosts either the setup walkthrough
 * or the dashboard. No config → WizardApp (fresh); outcome written/unchanged
 * → load the just-written config → App; App may request a re-run (palette
 * "setup") → WizardApp (rerun) → config-reloaded App. A FRESH-mode cancel is
 * the only path out: exit code 130, nothing written. */
import React, { useState } from "react";
import { Text, useApp } from "ink";
import type { Config } from "../types.js";
import type { WizardOutcome, WizardIO } from "../wizard/io.js";
import type { WizardIoResult } from "../wizard.js";
import { App } from "./App.js";
import { WizardApp } from "./wizard/WizardApp.js";

export interface RootProps {
  configPath: string;
  initialConfig: Config | null;
  buildAppProps: (cfg: Config) => Omit<React.ComponentProps<typeof App>, "onRequestWizard">;
  makeWizardIo: () => WizardIoResult;
  loadConfigFn: (p: string) => Config;
  onFinalExitCode: (code: number) => void;
}

export function Root({
  configPath,
  initialConfig,
  buildAppProps,
  makeWizardIo,
  loadConfigFn,
  onFinalExitCode,
}: RootProps): React.JSX.Element {
  const { exit } = useApp();
  const [cfg, setCfg] = useState<Config | null>(initialConfig);
  const [wizardIo, setWizardIo] = useState<WizardIO | null>(() => {
    if (initialConfig !== null) return null;
    const made = makeWizardIo();
    return made.ok ? made.io : null;
  });
  const [ioError] = useState<string | null>(() => {
    if (initialConfig !== null) return null;
    const made = makeWizardIo();
    return made.ok ? null : made.error;
  });

  const onOutcome = (o: WizardOutcome): void => {
    if (o === "cancelled") {
      if (cfg === null) {
        onFinalExitCode(130); // FTUE cancel — nothing to fall back to
        exit();
        return;
      }
      setWizardIo(null); // re-run cancel: dashboard resumes, config untouched
      return;
    }
    setCfg(loadConfigFn(configPath));
    setWizardIo(null);
  };

  if (ioError !== null) {
    // Unreachable in fresh mode (no file to be invalid); guards a corrupt
    // config racing between the cli existence check and the wizard build.
    onFinalExitCode(1);
    exit();
    return <Text color="red">✗ {ioError}</Text>;
  }
  if (wizardIo !== null) return <WizardApp io={wizardIo} onOutcome={onOutcome} />;
  if (cfg === null) return <Text> </Text>; // transient frame after cancel-exit
  return (
    <App
      {...buildAppProps(cfg)}
      onRequestWizard={() => {
        const made = makeWizardIo();
        if (made.ok) setWizardIo(made.io);
      }}
    />
  );
}
```

(NOTE the double `makeWizardIo()` in the two initializers — collapse into one lazy `useState` holding the whole result if you prefer; the invariant is it runs once per mount for FTUE.)

`src/dashboardCmd.ts` — widen the signature and restructure:

```ts
export async function runDashboard(
  cfg: Config | null,
  configPath: string,
  deps: DashboardDeps = {},
): Promise<number> {
  const isTTY = deps.isTTY ?? Boolean(process.stdout.isTTY && process.stdin.isTTY);
  const printErr = deps.printErr ?? ((s: string) => process.stderr.write(s));
  if (!isTTY) {
    printErr(
      cfg === null
        ? "junco dashboard needs an interactive terminal for first-run setup.\n" +
            "  Run `junco config init` to scaffold a default config headlessly, then re-run in a terminal.\n"
        : "junco dashboard needs an interactive terminal.\n" +
            "Try `junco list`, `junco status`, or `junco logs -f` instead.\n",
    );
    return 1;
  }
  const [
    { App },
    { Root },
    { MouseProvider },
    { buildWizardIO },
    { loadConfig },
    ghClientMod,
    watchlistMod,
    queueSnapMod,
    localSnapMod,
    react,
    ink,
  ] = await Promise.all([
    import("./tui/App.js"),
    import("./tui/Root.js"),
    import("./tui/MouseProvider.js"),
    import("./wizard.js"),
    import("./config.js"),
    import("./tui/ghClient.js"),
    import("./watchlist.js"),
    import("./tui/queueSnapshot.js"),
    import("./tui/localSnapshot.js"),
    import("react"),
    import("ink"),
  ]);
  const renderFn =
    deps.renderFn ??
    ((el: React.ReactElement) => ink.render(el, { exitOnCtrlC: true, alternateScreen: true }));

  // The exact prop assembly that used to live inline — now per-config so the
  // FTUE handoff (and future config re-runs) rebuild the client stack fresh.
  const buildAppProps = (c: Config): Omit<React.ComponentProps<typeof App>, "onRequestWizard"> => ({
    client: ghClientMod.makeGhDashboardClient(c),
    trigger: c.github.triggerLabel,
    branchPrefix: c.branchPrefix,
    configRepos: c.github.repos,
    watchlistFile: watchlistMod.watchlistPath(c),
    configPath,
    clonesDir: join(c.stateDir, "repos"),
    queueFn: queueSnapMod.makeQueueSnapshotFn(c),
    localCheapFn: localSnapMod.makeLocalCheapFn(c),
    localHeavyFn: localSnapMod.makeLocalHeavyFn(c),
    initialUiMode: c.github.enabled ? "github" : "local",
    githubEnabled: c.github.enabled,
    onExit: () => {},
  });

  let exitCode = 0;
  const instance = renderFn(
    react.createElement(
      MouseProvider,
      null,
      react.createElement(Root, {
        configPath,
        initialConfig: cfg,
        buildAppProps,
        makeWizardIo: () => buildWizardIO(configPath),
        loadConfigFn: deps.loadConfigFn ?? loadConfig,
        onFinalExitCode: (n: number) => {
          exitCode = n;
        },
      }),
    ),
  );
  await instance.waitUntilExit();
  if (exitCode === 130) {
    (deps.printOut ?? ((s: string) => process.stdout.write(s)))(
      "Setup cancelled — nothing written.\n",
    );
  }
  return exitCode;
}
```

(`DashboardDeps` gains `loadConfigFn?: (p: string) => Config; printOut?: (s: string) => void`. Keep `setLogLevel` where it is in cli.ts — it needs a loaded config.)

`src/cli.ts` dashboard block:

```ts
if (subcommand === "dashboard") {
  const runDashboardFn =
    deps.runDashboardFn ??
    (async (c: Config | null, p: string) => {
      const { runDashboard } = await import("./dashboardCmd.js");
      return runDashboard(c, p);
    });
  if (!existsFn(resolve(configPath))) {
    // FTUE: the dashboard hosts the setup walkthrough (spec §4).
    return runDashboardFn(null, configPath);
  }
  const cfg = loadConfigFn(configPath);
  setLogLevel(cfg.logLevel);
  return runDashboardFn(cfg, configPath);
}
```

(Widen `deps.runDashboardFn`'s type to `(cfg: Config | null, configPath: string) => Promise<number>`.)

`src/tui/cliRunner.ts` — replace the `init` roster row:

```ts
  cmd("setup", null, "Guided setup walkthrough (runs inside the dashboard)"),
```

`tests/tuiCliRunner.test.ts` — the USAGE-consistency spec pins runnable names to cli USAGE: add `"setup"` to its documented in-process exception list (it never spawns; App intercepts it). Read the test and amend its allowlist accordingly.

`src/tui/App.tsx` — add `onRequestWizard?: () => void` to the props interface; in `paletteEnter`, before the `excluded` check:

```ts
if (current.name === "setup") {
  // In-process: swap the Root host to the wizard instead of spawning.
  setView("main");
  props.onRequestWizard?.();
  return;
}
```

- [ ] **Step 4: Verify** — `npx vitest run tests/tuiRoot.test.tsx tests/dashboardCmd.test.ts tests/tuiCliRunner.test.ts tests/cli.test.ts tests/tuiPalette.test.tsx > /tmp/out 2>&1; echo "exit: $?"` → 0; then the full suite (the `runDashboard` signature change ripples through `tests/cli.test.ts` spies — update their fake signatures).

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/tui/Root.tsx src/dashboardCmd.ts src/cli.ts src/tui/App.tsx src/tui/cliRunner.ts tests
git add -A
git commit -m "feat(dashboard): FTUE — wizard-first Root host + in-palette setup re-run"
```

---

### Task 4: Remove `junco init`; reroute bare `junco`; USAGE rewrite

**Files:**

- Modify: `src/cli.ts` (delete init block + routing default + USAGE + `--yes` option), `src/wizard.ts` (delete `runInitWizard` + `inkCollect` + now-unused `WizardDeps` fields `yes`/`collectFn`/`isInteractiveFn`)
- Test: `tests/cli.test.ts`, `tests/wizard.test.ts`

**Interfaces:**

- Consumes: Tasks 1–3 (scaffold + FTUE must exist BEFORE the old door closes).
- Produces: `junco init` → exit 2 "Unknown subcommand"; bare `junco` with no config → dashboard FTUE (TTY) / guidance error (non-TTY, via runDashboard's guard); bare `junco` with config → `start` (unchanged).

- [ ] **Step 1: Failing tests** — in `tests/cli.test.ts`:

```ts
it("init is gone: unknown subcommand, exit 2", async () => {
  const code = await run(["init"], depsWithConfig());
  expect(code).toBe(2);
});

it("bare junco with no config routes to the dashboard (FTUE)", async () => {
  const dash = vi.fn(async () => 0);
  const code = await run([], { ...depsWithoutConfig(), runDashboardFn: dash });
  expect(code).toBe(0);
  expect(dash).toHaveBeenCalledWith(null, expect.any(String));
});

it("bare junco with a config still routes to start", async () => {
  /* existing spec — must keep passing unchanged */
});
```

(Adapt helper names to the file's existing fixtures — it already has spies for `runInitWizardFn`/`runDashboardFn` routing; the `runInitWizardFn` seam and its specs are DELETED in this task.)

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement.**

`src/cli.ts`:

- Routing default (line ~265): `positionals[0] ?? (existsFn(configPath) ? "start" : "dashboard")`.
- Delete the whole `if (subcommand === "init") { … }` block, the `runInitWizard` import, the `runInitWizardFn` deps field + its doc comment, and the `yes`/`-y` entry from the `parseArgs` options and USAGE.
- USAGE: delete the `init` line; the trailing note becomes:

```
  (no subcommand) → opens the dashboard setup walkthrough on first run
                    (no config yet), otherwise starts the daemon.
```

and the `dashboard` line becomes:

```
  dashboard    Interactive dashboard — first run opens the guided setup walkthrough
```

- Update the file's header comment (line ~6) that documents `junco init`.

`src/wizard.ts` — delete `runInitWizard`, `inkCollect`, and the `WizardDeps` fields `yes`, `collectFn`, `isInteractiveFn` (grep for remaining consumers first: `grep -rn "runInitWizard\|collectFn\|isInteractiveFn" src tests` — tests that exercised them move to buildWizardIO/Root coverage or are deleted). KEEP: `WizardDeps` (fs/detect seams — buildWizardIO uses them), `buildWizardIO`, `summary`.

- [ ] **Step 4: Verify** — full suite + typecheck + `npm run build && bash scripts/package-smoke.sh`. Also assert `node dist/cli.js --help` no longer mentions `init` (except `config … init`).

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/cli.ts src/wizard.ts tests
git add -A
git commit -m "feat(cli)!: remove junco init — setup lives in the dashboard (config init scaffolds headlessly)"
```

---

### Task 5: Wizard mouse — Select/MultiSelect clicks, legend chips, Finale

**Files:**

- Modify: `src/tui/wizard/controls.tsx`, `src/tui/wizard/WizardApp.tsx`, `src/tui/wizard/chapters/Finale.tsx`
- Test: `tests/wizardChapters.test.tsx` (extend; render inside `<MouseProvider>` for click specs)

**Interfaces:**

- Consumes: `ClickableBox`, `theme.hoverBg` (Plan A). No prop changes to `Select`/`MultiSelect`/`Finale` — clicks reuse their existing callbacks.
- Produces: click semantics — `Select` option click = choose + advance (`onSubmit(option.value)`, enter parity); `MultiSelect` option click = toggle that entry (space parity); WizardApp legend "← back"/"q quit" clickable; Finale body click = finish (enter parity). Wizard clicks only act while the control has `focus` (matching its `isActive` keyboard gate).

- [ ] **Step 1: Failing tests** — `tests/wizardChapters.test.tsx` style (fake io as that file already builds):

```tsx
it("Select: clicking an option chooses it (enter parity)", async () => {
  const onSubmit = vi.fn();
  const r = render(
    <MouseProvider>
      <Select
        options={[
          { value: "a", label: "Alpha" },
          { value: "b", label: "Beta" },
        ]}
        onSubmit={onSubmit}
        focus
      />
    </MouseProvider>,
  );
  await until(() => (r.lastFrame() ?? "").includes("Beta"));
  const y = lineOf(r.lastFrame() ?? "", "Beta");
  r.stdin.write(press(2, y));
  await until(() => onSubmit.mock.calls.length === 1);
  expect(onSubmit).toHaveBeenCalledWith("b");
});

it("MultiSelect: clicking an option toggles it without submitting", async () => {
  const onSubmit = vi.fn();
  const r = render(
    <MouseProvider>
      <MultiSelect
        items={[
          { value: "a", label: "Alpha", checked: false },
          { value: "b", label: "Beta", checked: false },
        ]}
        onSubmit={onSubmit}
        onFocusChange={() => {}}
        focus
      />
    </MouseProvider>,
  );
  await until(() => (r.lastFrame() ?? "").includes("Beta"));
  const y = lineOf(r.lastFrame() ?? "", "Beta");
  r.stdin.write(press(4, y));
  await until(() => (r.lastFrame() ?? "").split("\n")[y].includes("[x]"));
  expect(onSubmit).not.toHaveBeenCalled();
});

it("Finale: clicking finishes once revealed", async () => {
  const onDone = vi.fn();
  const r = render(
    <MouseProvider>
      <Finale result={fakeWriteResult()} io={fakeIo()} onDone={onDone} revealMs={0} />
    </MouseProvider>,
  );
  // Wait for the signoff line (flight check resolved + steps revealed).
  await until(() => (r.lastFrame() ?? "").includes("enter to finish"));
  r.stdin.write(press(2, 1));
  await until(() => onDone.mock.calls.length === 1);
});
```

(`fakeWriteResult()`/`fakeIo()` = the fixtures `tests/wizardChapters.test.tsx` already uses for its Finale specs — reuse them verbatim; `press`/`lineOf` defined locally as in `tests/tuiClickable.test.tsx`.)

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement.**

`controls.tsx` `Select` — option rows become (import `ClickableBox` from `../ClickableBox.js`):

```tsx
{
  options.map((o, i) => (
    <ClickableBox
      key={o.value}
      hoverBg={theme.hoverBg}
      onPress={
        focus
          ? () => {
              idxRef.current = i;
              bump((n) => n + 1);
              onSubmit(o.value); // click = choose + advance (enter parity)
            }
          : undefined
      }
    >
      <Text color={i === idxRef.current ? theme.accent : undefined}>
        {i === idxRef.current ? "▌ " : "  "}
        {o.label}
        {o.hint ? <Text dimColor> ({o.hint})</Text> : null}
      </Text>
    </ClickableBox>
  ));
}
```

`MultiSelect` — same wrap; onPress body (space parity, cursor follows the click):

```tsx
() => {
  idxRef.current = i;
  checkedRef.current = checkedRef.current.map((v, j) => (j === i ? !v : v));
  onFocusChange(i);
  bump((n) => n + 1);
};
```

`WizardApp.tsx` legend — replace the single `<Text dimColor>enter continue · ← back · q quit</Text>` with:

```tsx
<Box marginTop={1}>
  <Text dimColor>enter continue · </Text>
  <ClickableBox hoverBg={theme.hoverBg} onPress={result === null && idx > 0 ? back : undefined}>
    <Text dimColor>← back</Text>
  </ClickableBox>
  <Text dimColor> · </Text>
  <ClickableBox
    hoverBg={theme.hoverBg}
    onPress={result !== null ? done : textEditing.current ? undefined : cancel}
  >
    <Text dimColor>q quit</Text>
  </ClickableBox>
</Box>
```

`Finale.tsx` — root `<Box flexDirection="column">` → `<ClickableBox flexDirection="column" onPress={onDone}>` (click = the enter key).

- [ ] **Step 4: Verify** — `npx vitest run tests/wizardChapters.test.tsx tests/wizardApp.test.tsx > /tmp/out 2>&1; echo "exit: $?"` → 0; full suite.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/tui/wizard tests/wizardChapters.test.tsx
git add -A
git commit -m "feat(wizard): mouse — clickable choices, legend chips, click-to-finish"
```

---

### Task 6: Docs sweep + CHANGELOG + full gate + sandboxed smoke

**Files:**

- Modify: `README.md`, `docs/operations.md`, `docs/configuration.md`, `ARCHITECTURE.md`, `CHANGELOG.md`

**Steps:**

- [ ] **Step 1: Sweep every `junco init` mention** — `grep -rn "junco init" README.md docs/ templates/ skills/ src/ --include="*.md" --include="*.ts"` (exclude `docs/superpowers/` history — plans/specs are records, leave them). Rewrite each: first-run setup → "run `junco dashboard` (or bare `junco`) — the first open walks you through setup"; scripted/CI scaffold → `junco config init`. Also sweep `src/wizard/tips.ts` NEXT_STEPS: if any step references `junco init` re-runs, point it at the dashboard palette "setup" command instead (stack-agnostic wording).
- [ ] **Step 2:** `ARCHITECTURE.md` — dashboard section gains Root (FTUE switcher); `junco init` removed from the CLI list.
- [ ] **Step 3:** CHANGELOG `[Unreleased]`:

```markdown
### Added

- First-run setup lives in the dashboard: `junco dashboard` (or bare `junco`) with no config opens the guided walkthrough, then lands in the dashboard. Re-run it anytime from the command palette ("setup").
- `junco config init` — headless default-config scaffold (the old `junco init --yes`).
- Mouse support in the setup walkthrough: clickable choices, back/quit chips, click-to-finish.

### Removed

- **Breaking:** the `junco init` subcommand. Interactive setup → `junco dashboard`; scripted scaffold → `junco config init`.
```

- [ ] **Step 4: Full gate** — `npm run lint && npm run format:check && npm run typecheck && npm run build && npm test` (vitest exit captured explicitly) → all green; `bash scripts/package-smoke.sh` → OK.
- [ ] **Step 5: Sandboxed FTUE smoke** (never from the repo root):

```bash
SB=$(mktemp -d) && cd "$SB" && HOME="$SB" XDG_CONFIG_HOME="$SB/.config" \
  node /path/to/junco/dist/cli.js dashboard
# expect: walkthrough opens; complete it with defaults; dashboard appears;
# palette (:) shows "setup"; q quits cleanly. Then: cd / && rm -rf "$SB"
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "docs: dashboard-first setup story; changelog for init removal"
```

---

## Plan self-review notes

- Spec §4 coverage: Root switcher (T3), palette re-run (T3), init removal + routing + USAGE (T4), `config init` + smoke/CLAUDE.md (T1), docs sweep (T6). Spec §3-wizard coverage: Select/MultiSelect/legend/Finale (T5); wizard text fields render one focused field at a time, so click-to-focus has no target — deliberately omitted (spec's "text fields focus on click" is satisfied vacuously; note kept here for the reviewer).
- Ordering invariant: the new doors (T1 scaffold, T3 FTUE) open BEFORE the old door closes (T4) — the tree is never in a state where setup is impossible.
- Type ripples called out: `runDashboardFn` nullable-cfg signature (cli deps + tests), `WizardDeps` field deletions (wizard tests), roster consistency test (`setup` exception).
- Exit codes preserved: FTUE cancel = 130 (was: init cancel 130); non-TTY dashboard = 1 with `config init` guidance (was: init non-TTY 1).
