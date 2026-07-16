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
  /** Absolute subpaths whose reads are denied (secrets, sensitive data-tree
   *  subtrees, extras). Subtree semantics: the path and everything under it. */
  readDenyPaths: string[];
  /** Absolute files whose reads are denied exactly (the data root's receipt
   *  files — watchlist/spend/metrics/log/journal). Separate from
   *  readDenyPaths because the OS backends enforce files differently
   *  (Seatbelt literal vs subpath; bwrap /dev/null bind vs tmpfs). */
  readDenyFiles: string[];
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
  /** Sensitive data-tree paths (from dataTree.sandboxDenyPaths) — the
   *  SUBTREES/files to deny, never the dataDir root itself: the default
   *  layout puts the worktree (cwd) and the clone gitdirs under that root. */
  dataDenyPaths: { dirs: string[]; files: string[] };
  network: boolean;
  botGhConfigDir?: string;
}): SandboxPolicy {
  const { cfg, cwd, scratchDir, home, dataDenyPaths, network, botGhConfigDir } = opts;
  // Canonicalize so the OS-sandbox profile and the JS jail agree with the
  // kernel's symlink-resolved view (macOS /var→/private/var, /tmp→/private/tmp).
  const writableRoots = [
    canonicalize(cwd),
    canonicalize(scratchDir),
    ...cfg.extraAllowWrite.map(canonicalize),
  ];
  const readDenyPaths = [
    ...builtinDenyReadPaths(home).map(canonicalize),
    ...dataDenyPaths.dirs.map(canonicalize),
    ...(botGhConfigDir ? [canonicalize(botGhConfigDir)] : []),
    ...cfg.extraDenyRead.map(canonicalize),
  ];
  const readDenyFiles = dataDenyPaths.files.map(canonicalize);
  return {
    writableRoots,
    readDenyPaths,
    readDenyFiles,
    network,
    scratchDir: canonicalize(scratchDir),
  };
}
