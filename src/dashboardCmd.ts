/**
 * `junco dashboard` — entry point. TTY guard runs BEFORE any Ink import so
 * non-interactive invocations never pay the React cost; the Ink app module
 * is loaded dynamically (the daemon and every other subcommand stay React-free).
 */

import type { Config } from "./types.js";
import type React from "react";

export interface DashboardDeps {
  isTTY?: boolean;
  renderFn?: (element: React.ReactElement) => { waitUntilExit: () => Promise<void> };
  printErr?: (s: string) => void;
}

export async function runDashboard(cfg: Config, deps: DashboardDeps = {}): Promise<number> {
  const isTTY = deps.isTTY ?? Boolean(process.stdout.isTTY && process.stdin.isTTY);
  const printErr = deps.printErr ?? ((s: string) => process.stderr.write(s));
  if (!isTTY) {
    printErr(
      "junco dashboard needs an interactive terminal.\n" +
        "Try `junco list`, `junco status`, or `junco logs -f` instead.\n",
    );
    return 1;
  }

  const [{ App }, { makeGhDashboardClient }, { watchlistPath }, react, ink] = await Promise.all([
    import("./tui/App.js"),
    import("./tui/ghClient.js"),
    import("./watchlist.js"),
    import("react"),
    import("ink"),
  ]);
  const renderFn =
    deps.renderFn ?? ((el: React.ReactElement) => ink.render(el, { exitOnCtrlC: true }));

  const client = makeGhDashboardClient(cfg);
  let exitRequested = false;
  const instance = renderFn(
    react.createElement(App, {
      client,
      trigger: cfg.github.triggerLabel,
      configRepos: cfg.github.repos,
      watchlistFile: watchlistPath(cfg),
      onExit: () => {
        exitRequested = true;
      },
    }),
  );
  await instance.waitUntilExit();
  void exitRequested;
  return 0;
}
