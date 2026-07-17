/**
 * `junco` (bare, interactive) pre-flight: make sure the supervised daemon is up
 * before the dashboard opens. Checks the singleton lock; if the daemon is down
 * and a launchd/systemd unit references this config, kickstarts the unit and
 * blocks up to a short ceiling for the lock to appear. Never spawns an
 * unsupervised daemon, and never throws — every failure degrades to a result the
 * caller opens the dashboard on top of (the dashboard surfaces live daemon state
 * regardless). See docs/superpowers/specs/2026-07-16-bare-junco-ensure-daemon-design.md.
 */

import { join, dirname, resolve } from "node:path";
import { readLockHolder } from "./lock.js";
import { discoverService, kickstartService, type ServiceRef } from "./restartCmd.js";

export type EnsureResult =
  | { state: "running"; pid: number }
  | { state: "started"; pid: number }
  | { state: "start-failed"; ref: ServiceRef }
  | { state: "no-service" };

export interface EnsureDaemonDeps {
  /** Live lock holder (pid) or null. Default: readLockHolder. */
  lockHolderFn?: (lockPath: string) => number | null;
  /** Find the unit referencing configPath, or null. Default: discoverService. */
  discoverServiceFn?: (configPath: string) => Promise<ServiceRef | null>;
  /** Relaunch the unit. Default: kickstartService. */
  kickstartFn?: (svc: ServiceRef) => Promise<{ code: number; stdout: string; stderr: string }>;
  /** Sleep between polls. Default: real setTimeout. */
  sleepFn?: (ms: number) => Promise<void>;
  /** Status line sink. Default: process.stdout.write. */
  printFn?: (s: string) => void;
  /** Ceiling to wait for the lock after a kickstart. Default: 5000ms. */
  waitMs?: number;
  /** Poll interval. Default: 250ms. */
  pollMs?: number;
}

export async function ensureDaemon(
  configPath: string,
  deps: EnsureDaemonDeps = {},
): Promise<EnsureResult> {
  const lockHolderFn = deps.lockHolderFn ?? readLockHolder;
  const discoverServiceFn = deps.discoverServiceFn ?? ((p: string) => discoverService(p));
  const kickstartFn = deps.kickstartFn ?? ((svc: ServiceRef) => kickstartService(svc));
  const sleepFn = deps.sleepFn ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const print = deps.printFn ?? ((s: string) => process.stdout.write(s));
  const waitMs = deps.waitMs ?? 5000;
  const pollMs = deps.pollMs ?? 250;

  const lockPath = join(dirname(resolve(configPath)), "worker.lock");

  const existing = lockHolderFn(lockPath);
  if (existing !== null) {
    print(`daemon already running (pid ${existing})\n`);
    return { state: "running", pid: existing };
  }

  let svc: ServiceRef | null;
  try {
    svc = await discoverServiceFn(configPath);
  } catch {
    svc = null;
  }
  if (!svc) {
    print("no supervised daemon installed — run `junco service` to install one\n");
    return { state: "no-service" };
  }

  print(`daemon not running — starting via ${svc.platform}…\n`);
  try {
    const kick = await kickstartFn(svc);
    if (kick.code !== 0) {
      print(`could not start daemon (${svc.id}): ${kick.stderr.trim() || `exit ${kick.code}`}\n`);
      return { state: "start-failed", ref: svc };
    }
  } catch (e) {
    print(`could not start daemon (${svc.id}): ${e instanceof Error ? e.message : String(e)}\n`);
    return { state: "start-failed", ref: svc };
  }

  // Poll a fixed number of times so the wait is deterministic under a fake sleep.
  const maxPolls = Math.max(1, Math.ceil(waitMs / pollMs));
  for (let i = 0; i < maxPolls; i++) {
    const pid = lockHolderFn(lockPath);
    if (pid !== null) {
      print(`daemon up (pid ${pid})\n`);
      return { state: "started", pid };
    }
    await sleepFn(pollMs);
  }
  print(`daemon did not come up within ${Math.round(waitMs / 1000)}s — opening dashboard anyway\n`);
  return { state: "start-failed", ref: svc };
}
