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
      const code = err ? ((err as NodeJS.ErrnoException).code === "ENOENT" ? 127 : 1) : 0;
      res({ code, stdout: String(stdout), stderr: String(stderr) });
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
