/**
 * `junco restart` — restart the service unit supervising the daemon.
 *
 * Discovery is BY CONFIG PATH, not by name: the launchd plist (or systemd user
 * unit) whose invocation references the resolved config.toml. This finds
 * custom labels and `junco service`-rendered defaults alike, with zero config.
 *
 * The restart verb matters: a launchd job with KeepAlive.SuccessfulExit=false
 * is NOT respawned after a graceful SIGTERM, so plain kill leaves the daemon
 * down. `launchctl kickstart -k` (and `systemctl --user restart`) relaunch
 * unconditionally while still giving the daemon its TERM-first drain window.
 */

import { execFile } from "node:child_process";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { readLockHolder } from "./lock.js";

export interface ServiceRef {
  platform: "launchd" | "systemd";
  id: string;
}

export interface RestartDeps {
  execFn?: (
    cmd: string,
    args: string[],
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
  readdirFn?: (dir: string) => string[];
  homedirFn?: () => string;
  platform?: NodeJS.Platform;
  uid?: number;
  lockHolderFn?: (lockPath: string) => number | null;
  sleepFn?: (ms: number) => Promise<void>;
  printFn?: (s: string) => void;
  timeoutMs?: number;
}

function defaultExec(
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

function defaultReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Find the service unit whose invocation references `configPath`. */
export async function discoverService(
  configPath: string,
  deps: RestartDeps = {},
): Promise<ServiceRef | null> {
  const execFn = deps.execFn ?? defaultExec;
  const platform = deps.platform ?? process.platform;
  const home = (deps.homedirFn ?? homedir)();
  const cfg = resolve(configPath);

  if (platform === "darwin") {
    const dir = join(home, "Library", "LaunchAgents");
    const matches: string[] = [];
    for (const name of (deps.readdirFn ?? defaultReaddir)(dir).filter((n) =>
      n.endsWith(".plist"),
    )) {
      const r = await execFn("plutil", ["-convert", "json", "-o", "-", join(dir, name)]);
      if (r.code !== 0) continue; // unreadable/binary-corrupt plist — keep scanning
      try {
        const j = JSON.parse(r.stdout) as { Label?: string; ProgramArguments?: string[] };
        if (j.Label && Array.isArray(j.ProgramArguments) && j.ProgramArguments.includes(cfg)) {
          matches.push(j.Label);
        }
      } catch {
        continue;
      }
    }
    if (matches.length === 0) return null;
    if (matches.length > 1 && deps.printFn) {
      deps.printFn(
        `multiple launchd jobs reference this config; using ${matches[0]} (others: ${matches.slice(1).join(", ")})\n`,
      );
    }
    return { platform: "launchd", id: matches[0] };
  }

  // systemd (linux + anything else with a user manager)
  const list = await execFn("systemctl", [
    "--user",
    "list-unit-files",
    "--no-legend",
    "--plain",
    "junco*",
  ]);
  if (list.code !== 0) return null;
  const units = list.stdout
    .trim()
    .split("\n")
    .map((l) => l.trim().split(/\s+/)[0])
    .filter((u) => u && u.endsWith(".service"));
  for (const unit of units) {
    const cat = await execFn("systemctl", ["--user", "cat", unit]);
    if (cat.code === 0 && cat.stdout.includes(cfg)) return { platform: "systemd", id: unit };
  }
  // No path match, but a single junco unit is unambiguous.
  if (units.length === 1) return { platform: "systemd", id: units[0] };
  return null;
}

/** Restart the discovered unit and verify the lock holder changed. */
export async function runRestartCommand(
  configPath: string,
  deps: RestartDeps = {},
): Promise<number> {
  const execFn = deps.execFn ?? defaultExec;
  const print = deps.printFn ?? ((s: string) => process.stdout.write(s));
  const lockHolderFn = deps.lockHolderFn ?? readLockHolder;
  const sleepFn = deps.sleepFn ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const timeoutMs = deps.timeoutMs ?? 15_000;
  const lockPath = join(dirname(resolve(configPath)), "worker.lock");

  // Thread the DEFAULTED print fn down — discoverService's multi-match warn
  // must reach stdout even when the caller (the CLI) injects no printFn.
  const svc = await discoverService(configPath, { ...deps, printFn: print });
  if (!svc) {
    print(
      "no service unit references this config — nothing to restart.\n" +
        "Render one with `junco service` (see README → Running as a service);\n" +
        "an unsupervised daemon can only be stopped, not restarted.\n",
    );
    return 1;
  }

  const oldPid = lockHolderFn(lockPath);

  const kick =
    svc.platform === "launchd"
      ? await execFn("launchctl", [
          "kickstart",
          "-k",
          `gui/${deps.uid ?? process.getuid?.() ?? 0}/${svc.id}`,
        ])
      : await execFn("systemctl", ["--user", "restart", svc.id]);
  if (kick.code !== 0) {
    print(`restart failed for ${svc.id}: ${kick.stderr.trim() || `exit ${kick.code}`}\n`);
    return 1;
  }

  // Poll the lock for a NEW live holder (old null → any holder counts).
  const started = Date.now();
  for (;;) {
    const pid = lockHolderFn(lockPath);
    if (pid !== null && pid !== oldPid) {
      print(`restarted: pid ${oldPid ?? "—"} → ${pid}\n`);
      return 0;
    }
    if (Date.now() - started >= timeoutMs) break;
    await sleepFn(500);
  }
  print(
    `kick issued to ${svc.id}, but the lock holder did not change within ${Math.round(timeoutMs / 1000)}s — ` +
      "the old daemon may still be draining a ticket. Check `junco status`.\n",
  );
  return 1;
}
