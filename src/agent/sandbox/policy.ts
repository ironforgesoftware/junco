import { resolve, join } from "node:path";
import type { SandboxConfig } from "../../types.js";

/** Absolute paths whose reads are always denied inside the sandbox. Not
 *  operator-removable (extra_deny_read only adds). */
export function builtinDenyReadPaths(home: string): string[] {
  return [
    join(home, ".ssh"),
    join(home, ".aws"),
    join(home, ".config", "gh"),
    join(home, ".gnupg"),
    join(home, ".pi"),
  ];
}

export interface SandboxPolicy {
  /** Absolute roots the agent may write under (worktree, scratch, extras). */
  writableRoots: string[];
  /** Absolute subpaths whose reads are denied (secrets, state, extras). */
  readDenyPaths: string[];
  /** true = network egress permitted; false = denied. */
  network: boolean;
  /** Per-session scratch dir (also the redirected TMPDIR). */
  scratchDir: string;
}

export function buildPolicy(opts: {
  cfg: SandboxConfig;
  cwd: string;
  scratchDir: string;
  home: string;
  stateDir: string;
  network: boolean;
}): SandboxPolicy {
  const { cfg, cwd, scratchDir, home, stateDir, network } = opts;
  const writableRoots = [
    resolve(cwd),
    resolve(scratchDir),
    ...cfg.extraAllowWrite.map((p) => resolve(p)),
  ];
  const readDenyPaths = [
    ...builtinDenyReadPaths(home).map((p) => resolve(p)),
    resolve(stateDir),
    ...cfg.extraDenyRead.map((p) => resolve(p)),
  ];
  return { writableRoots, readDenyPaths, network, scratchDir: resolve(scratchDir) };
}
