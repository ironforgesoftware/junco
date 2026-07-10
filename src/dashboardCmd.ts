/**
 * `junco dashboard` — entry point. TTY guard runs BEFORE any Ink import so
 * non-interactive invocations never pay the React cost; the Ink app module
 * is loaded dynamically (the daemon and every other subcommand stay React-free).
 */

import { join } from "node:path";
import type { Config } from "./types.js";
import type React from "react";

export interface DashboardDeps {
  isTTY?: boolean;
  renderFn?: (element: React.ReactElement) => { waitUntilExit: () => Promise<void> };
  printErr?: (s: string) => void;
}

export async function runDashboard(
  cfg: Config,
  configPath: string,
  deps: DashboardDeps = {},
): Promise<number> {
  const isTTY = deps.isTTY ?? Boolean(process.stdout.isTTY && process.stdin.isTTY);
  const printErr = deps.printErr ?? ((s: string) => process.stderr.write(s));
  if (!isTTY) {
    printErr(
      "junco dashboard needs an interactive terminal.\n" +
        "Try `junco list`, `junco status`, or `junco logs -f` instead.\n",
    );
    return 1;
  }

  const [
    { App },
    { makeGhDashboardClient },
    { watchlistPath },
    { makeQueueSnapshotFn },
    { makeLocalCheapFn, makeLocalHeavyFn },
    react,
    ink,
  ] = await Promise.all([
    import("./tui/App.js"),
    import("./tui/ghClient.js"),
    import("./watchlist.js"),
    import("./tui/queueSnapshot.js"),
    import("./tui/localSnapshot.js"),
    import("react"),
    import("ink"),
  ]);
  // Alt buffer — fullscreen, zero scrollback pollution, terminal restored on
  // exit; a no-op when non-interactive, and the TTY guard exits before this anyway.
  const renderFn =
    deps.renderFn ??
    ((el: React.ReactElement) => ink.render(el, { exitOnCtrlC: true, alternateScreen: true }));

  const client = makeGhDashboardClient(cfg);
  const instance = renderFn(
    react.createElement(App, {
      client,
      trigger: cfg.github.triggerLabel,
      branchPrefix: cfg.branchPrefix,
      configRepos: cfg.github.repos,
      watchlistFile: watchlistPath(cfg),
      // The palette spawns CLI subcommands against this same config.
      configPath,
      // Managed clones for the add-repo "empty path = clone for me" flow.
      clonesDir: join(cfg.stateDir, "repos"),
      queueFn: makeQueueSnapshotFn(cfg),
      // LOCAL surface snapshot factories (cheap @3s, heavy @15s).
      localCheapFn: makeLocalCheapFn(cfg),
      localHeavyFn: makeLocalHeavyFn(cfg),
      // GitHub disabled -> land on LOCAL; the daemon still won't sweep GitHub,
      // but there's a live local surface to show instead of refusing to launch.
      initialUiMode: cfg.github.enabled ? "github" : "local",
      githubEnabled: cfg.github.enabled,
      // App drives useApp().exit() itself; this stays a no-op hook point.
      onExit: () => {},
    }),
  );
  await instance.waitUntilExit();
  return 0;
}
