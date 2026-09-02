/**
 * `junco dashboard` — entry point. TTY guard runs BEFORE any Ink import so
 * non-interactive invocations never pay the React cost; the Ink app module
 * is loaded dynamically (the daemon and every other subcommand stay React-free).
 *
 * The dashboard hosts the first-run setup walkthrough (spec §4): a null `cfg`
 * means no config exists yet, so the Ink Root opens the wizard first and swaps
 * to the dashboard once a config is written. A FRESH-mode cancel is the only
 * exit that returns non-zero (130).
 */

import { resolve } from "node:path";
import { existsSync } from "node:fs";
import type { Config } from "./types.js";
import type { AppProps } from "./tui/App.js";
import { dataTreePaths } from "./dataTree.js";
import { draftFilePath } from "./chat/draftStore.js";
import { checkForUpdate } from "./updateCheck.js";
import { resolveBotLogin } from "./botIdentity.js";
import type React from "react";

/**
 * Ink render options for the dashboard host (do NOT flip exitOnCtrlC back to
 * true). In ink 7.1.0 `exitOnCtrlC: true` makes use-input SKIP every registered
 * useInput handler for Ctrl-C and exit directly (node_modules/ink/build/hooks/
 * use-input.js: "If app is supposed to exit on Ctrl+C, skip input listeners").
 * This one render also hosts the setup walkthrough, so that would make
 * WizardApp's Ctrl-C branch dead: a post-write Ctrl-C could no longer report
 * written/unchanged, and an FTUE cancel could never fire onOutcome → Root would
 * never call onFinalExitCode(130). So Ink must NOT intercept Ctrl-C — WizardApp
 * handles its own (WizardApp.tsx) and the dashboard App installs a dedicated
 * Ctrl-C quit handler (App.tsx's first input hook). Mirrors the deleted
 * inkCollect host's rationale. `alternateScreen`: fullscreen alt buffer, zero
 * scrollback pollution, terminal restored on exit.
 */
export const INK_RENDER_OPTIONS = {
  exitOnCtrlC: false,
  alternateScreen: true,
  // Line-diff writes: an animation frame (spinner) rewrites only the changed
  // line(s) — measured 15.6 KiB → 0.4 KiB per frame — CPU unchanged (spec
  // 2026-09-01-ink-render-perf-design.md, tier 2). Safe with useSuspend's
  // blank-frame handoff: tests/useSuspendTty.test.tsx pins the full repaint.
  incrementalRendering: true,
} as const;

export interface DashboardDeps {
  isTTY?: boolean;
  renderFn?: (element: React.ReactElement) => { waitUntilExit: () => Promise<void> };
  printErr?: (s: string) => void;
  /** Config reload after the wizard writes one (FTUE handoff). Default: loadConfig. */
  loadConfigFn?: (p: string) => Config;
  /** stdout sink for the post-cancel message (Amendment 1). Default: process.stdout.write. */
  printOut?: (s: string) => void;
  /** Existence probe for the truthful cancel message (Amendment 1). Default: fs.existsSync. */
  existsFn?: (p: string) => boolean;
}

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
    { Root },
    { MouseProvider },
    { buildWizardIO },
    { loadConfig },
    { makeGhDashboardClient },
    { watchlistPath },
    { makeQueueSnapshotFn },
    { makeLocalCheapFn, makeLocalHeavyFn },
    { listHistory },
    react,
    ink,
  ] = await Promise.all([
    // App.js is pulled in transitively by Root.js — no separate value import.
    import("./tui/Root.js"),
    import("./tui/MouseProvider.js"),
    import("./wizard.js"),
    import("./config.js"),
    import("./tui/ghClient.js"),
    import("./watchlist.js"),
    import("./tui/queueSnapshot.js"),
    import("./tui/localSnapshot.js"),
    import("./assessHistory.js"),
    import("react"),
    import("ink"),
  ]);
  // INK_RENDER_OPTIONS is the single source of truth for the host options
  // (exitOnCtrlC:false is load-bearing — see the constant's doc); a no-op when
  // non-interactive, and the TTY guard exits before this anyway.
  const renderFn =
    deps.renderFn ?? ((el: React.ReactElement) => ink.render(el, INK_RENDER_OPTIONS));

  // The exact prop assembly that used to live inline — now per-config so the
  // FTUE handoff (and future config re-runs) rebuild the client stack fresh.
  const buildAppProps = (c: Config): Omit<AppProps, "onRequestWizard"> => ({
    client: makeGhDashboardClient(c),
    trigger: c.github.triggerLabel,
    branchPrefix: c.branchPrefix,
    configRepos: c.github.repos,
    watchlistFile: watchlistPath(c),
    // The palette spawns CLI subcommands against this same config.
    configPath,
    // Managed clones for the add-repo "empty path = clone for me" flow.
    clonesDir: dataTreePaths(c).clonesWatched,
    // The daemon's log file — the LOCAL logs section tails it (useLogTail).
    logPath: dataTreePaths(c).logFile,
    // A parked chat draft's file on disk: `e` edits it, `s` hands the CLI the
    // very same path (spec 2026-09-01 §6.6).
    draftFilePathFn: (id: string, name: string) => draftFilePath(c, id, name),
    queueFn: makeQueueSnapshotFn(c),
    // Per-repo assess history for the rail's audit-age indicator (#193).
    assessHistoryFn: () => Promise.resolve(listHistory(c)),
    // Local snapshot factories (cheap @3s, heavy @15s) — always on in the
    // unified view (system badges + local rail rows + section bodies).
    localCheapFn: makeLocalCheapFn(c),
    localHeavyFn: makeLocalHeavyFn(c),
    githubEnabled: c.github.enabled,
    // App drives useApp().exit() itself; this stays a no-op hook point.
    onExit: () => {},
    // Best-effort passive update check — cfg pre-bound, zero-arg (App's seam
    // is CLI-agnostic; checkForUpdate itself never throws).
    checkUpdateFn: () => checkForUpdate(c),
    // Bot-account identity probe for issue/PR highlighting — cfg pre-bound,
    // zero-arg; resolveBotLogin never throws (null = disabled/unresolvable).
    botLoginFn: () => resolveBotLogin(c),
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
    // Amendment 1 — truthful cancel: WizardIO.write() renames the config into
    // place BEFORE a throwable re-read, so a user CAN cancel with the file
    // already on disk. Existence-check at PRINT time rather than unconditionally
    // claiming nothing was written.
    const printOut = deps.printOut ?? ((s: string) => process.stdout.write(s));
    // Print the RESOLVED path the existence check actually probed, so the
    // message never names a relative path that differs from what was checked.
    const resolved = resolve(configPath);
    const exists = (deps.existsFn ?? existsSync)(resolved);
    printOut(
      exists
        ? `Setup did not finish — but a config exists at ${resolved}. Run junco doctor to verify it.\n`
        : "Setup cancelled — nothing written.\n",
    );
  }
  return exitCode;
}
