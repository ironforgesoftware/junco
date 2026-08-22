import { join } from "node:path";
import type { SandboxConfig } from "../../types.js";
import { canonicalize } from "./canonicalize.js";
import type { ReadRule } from "./precedence.js";

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
  /** Absolute subtrees that override a broader deny (e.g. cache/ inside a
   *  denied ~/.junco). Precedence between this, readDenyPaths, readDenyFiles
   *  and writableRoots is by specificity (see readRules/precedence.ts),
   *  never by list order — a deny deeper than an entry here still wins. */
  readAllowPaths: string[];
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
  /** Paths to deny reads on (from dataTree.sandboxDenyPaths) — since #277 this
   *  INCLUDES the dataDir root itself, denied wholesale. That is safe because
   *  `dataAllowPaths` and the writable roots below out-specify it; see
   *  readRules and precedence.ts. */
  dataDenyPaths: { dirs: string[]; files: string[] };
  /** Subtrees that allow-back territory inside a broader deny above — the
   *  agent's execution roots inside the wholesale data-root deny
   *  (dataTree.sandboxDenyPaths().allowDirs: `cache/` under v2, `worktrees/`
   *  and `clones/` under flat). Optional: callers that deny nothing broad
   *  (tests, degraded fixtures) leave readAllowPaths empty. */
  dataAllowPaths?: string[];
  network: boolean;
  botGhConfigDir?: string;
}): SandboxPolicy {
  const { cfg, cwd, scratchDir, home, dataDenyPaths, dataAllowPaths, network, botGhConfigDir } =
    opts;
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
  // Same canonicalization as the deny lists above — otherwise precedence
  // would compare a canonicalized deny against a raw allow and a
  // /tmp-vs-/private/tmp-style mismatch would silently flip the answer.
  const readAllowPaths = (dataAllowPaths ?? []).map(canonicalize);
  return {
    writableRoots,
    readDenyPaths,
    readDenyFiles,
    readAllowPaths,
    network,
    scratchDir: canonicalize(scratchDir),
  };
}

/** The policy's read rules as one ordered-by-specificity-agnostic list — the
 *  single source both the OS profiles (Tasks 4-5) and the JS jail
 *  (pathJail.ts's assertReadAllowed) are generated from. Composition order
 *  here doesn't matter: orderRules sorts by specificity, not list position.
 *  Writable roots are included as allow/subtree rules — a root the agent may
 *  write but not read is incoherent, and this is what makes denying a
 *  writable root's ancestor (the whole data root, as dataTree does since #277)
 *  safe: the writable root out-specifies the ancestor deny. It is NOT an
 *  unconditional
 *  override — a deny deeper than a writable root (an operator's
 *  extra_deny_read inside their own worktree) still wins. */
export function readRules(policy: SandboxPolicy): ReadRule[] {
  return [
    ...policy.readDenyPaths.map((path): ReadRule => ({ path, effect: "deny", kind: "subtree" })),
    ...policy.readDenyFiles.map((path): ReadRule => ({ path, effect: "deny", kind: "file" })),
    ...policy.readAllowPaths.map((path): ReadRule => ({ path, effect: "allow", kind: "subtree" })),
    ...policy.writableRoots.map((path): ReadRule => ({ path, effect: "allow", kind: "subtree" })),
  ];
}
