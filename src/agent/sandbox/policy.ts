import { join } from "node:path";
import type { SandboxConfig } from "../../types.js";
import { canonicalize } from "./canonicalize.js";

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
  botGhConfigDir?: string;
}): SandboxPolicy {
  const { cfg, cwd, scratchDir, home, stateDir, network, botGhConfigDir } = opts;
  // Canonicalize so the OS-sandbox profile and the JS jail agree with the
  // kernel's symlink-resolved view (macOS /var→/private/var, /tmp→/private/tmp).
  const writableRoots = [
    canonicalize(cwd),
    canonicalize(scratchDir),
    ...cfg.extraAllowWrite.map(canonicalize),
  ];
  const readDenyPaths = [
    ...builtinDenyReadPaths(home).map(canonicalize),
    canonicalize(stateDir),
    ...(botGhConfigDir ? [canonicalize(botGhConfigDir)] : []),
    ...cfg.extraDenyRead.map(canonicalize),
  ];
  return { writableRoots, readDenyPaths, network, scratchDir: canonicalize(scratchDir) };
}
