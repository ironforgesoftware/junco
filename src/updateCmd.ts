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
import { join } from "node:path";
import type { Config } from "./types.js";
import { loadConfig } from "./config.js";
import { readLockHolder, workerLockPath } from "./lock.js";
import { runRestartCommand, discoverService } from "./restartCmd.js";
import {
  checkForUpdate,
  getSelfPackage,
  type SelfPackage,
  type UpdateInfo,
} from "./updateCheck.js";
import {
  ensureSkillLinks,
  isSkillLinkFailure,
  renderSkillLinkEntry,
  type SkillLinksReport,
} from "./skillLinks.js";

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
  /** Service-unit discovery (launchd/systemd) by config path; null → no unit references it. */
  discoverServiceFn?: (configPath: string) => Promise<unknown | null>;
  /** Re-ensures skill links against the newly installed package (Task 3).
   * Defaults to the real ensureSkillLinks. */
  ensureSkillLinksFn?: (cfg: Config) => SkillLinksReport;
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

  // Re-ensure skill links against the NEW package (the mount may have been
  // created by an older version; a fresh npm root never changes the path,
  // but a broken chain heals here rather than at next daemon start).
  const links = (deps.ensureSkillLinksFn ?? ensureSkillLinks)(cfg);
  for (const e of links.entries.filter((e) => e.kind === "created")) {
    print(`skill link created: ${renderSkillLinkEntry(e)}\n`);
  }
  for (const e of links.entries.filter((e) => e.kind === "repaired")) {
    print(`skill link repaired: ${renderSkillLinkEntry(e)}\n`);
  }
  for (const e of links.entries.filter((e) => isSkillLinkFailure(e.kind))) {
    errPrint(`skill link warning: ${renderSkillLinkEntry(e)}\n`);
  }

  // 4. Drain-restart, only when a daemon actually holds the lock (same
  // lockPath derivation as restartCmd/start: worker.lock beside config.json).
  // A held lock with no discoverable service unit means a foreground
  // `junco start` — restartCmd's own "nothing to restart" message is written
  // for the truly-unsupervised case and would misreport a real, running
  // daemon as nothing to do (spec §7.4/§8): discover first and only defer to
  // runRestartCommand once a unit is confirmed.
  let exit = 0;
  const lockPath = workerLockPath(configPath);
  const holder = (deps.lockHolderFn ?? readLockHolder)(lockPath);
  if (holder !== null) {
    const svc = await (deps.discoverServiceFn ?? discoverService)(configPath);
    if (svc === null) {
      print("daemon running outside a service manager — restart it manually\n");
    } else {
      exit = await (deps.restartFn ?? runRestartCommand)(configPath);
    }
  } else {
    print("daemon not running — nothing to restart\n");
  }

  // 5. Verify by exec'ing the freshly installed CLI (this process is old
  // code). PATH may resolve to a stale shadowing install (nvm switch, an
  // earlier prefix earlier in PATH) — only claim success when the reported
  // version actually matches what we just installed.
  const ver = await (deps.execFn ?? defaultCapture)("junco", ["--version"]);
  const got = ver.stdout.trim();
  if (ver.code === 0 && got.length > 0) {
    if (got === info.latest) {
      print(`updated v${info.current} → v${got}\n`);
    } else {
      print(
        `installed v${info.latest}, but \`junco\` on PATH reports v${got} — another install may be shadowing it\n`,
      );
    }
  } else {
    print("installed, but could not verify `junco --version` — check your PATH\n");
  }
  return exit;
}
