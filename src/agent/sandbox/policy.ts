import { join, sep } from "node:path";
import type { SandboxConfig } from "../../types.js";
import { canonicalize } from "./canonicalize.js";
import type { ReadRule } from "./precedence.js";

/** Thrown (fail-closed) when the requested policy cannot be enforced on every
 *  backend — see `assertNoAllowAboveDenyFile`. Refusing to build is deliberate:
 *  the alternative is emitting a policy whose meaning differs per backend. */
export class SandboxPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxPolicyError";
  }
}

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
  assertNoAllowAboveDenyFile(
    [
      ...writableRoots.map((path) => ({ path, what: "writable root" })),
      ...readAllowPaths.map((path) => ({ path, what: "read allow-back" })),
    ],
    readDenyFiles,
  );
  return {
    writableRoots,
    readDenyPaths,
    readDenyFiles,
    readAllowPaths,
    network,
    scratchDir: canonicalize(scratchDir),
  };
}

/**
 * #311: refuse a policy in which an allow subtree is a STRICT ancestor of a
 * by-name deny file. Both allow sources count — `readRules` turns writable
 * roots into allow/subtree rules exactly like allow-backs, and bwrap binds
 * them read-WRITE, so the shape is worse there, not better.
 *
 * Why it cannot be expressed: bwrap must skip a deny mount whose target does
 * not exist (it cannot create a mountpoint under the read-only root bind, nor
 * under an allow-back's ro-bind — see backend.ts's `bwrapArgs`). Every file in
 * this list is a lazily-written receipt, absent until its first write, so
 * inside an allow-back the mask is dropped while the ro-bind stays — and the
 * receipt becomes readable the moment the daemon writes it. Seatbelt and the
 * JS path-jail deny by name regardless of existence, so such a policy means
 * three different things on three backends.
 *
 * Why refuse rather than repair. Dropping the offending allow would silently
 * cost the agent a tier it may need — and for a WRITABLE root that is the C1
 * regression (#277) by another name: the agent walled out of its own worktree,
 * which `bwrapArgs` deliberately refuses to risk by never existence-guarding a
 * writable root. Narrowing the allow to "everything under it except the file"
 * is not expressible without enumerating the directory at spawn time, which
 * would make the policy depend on what happened to exist. So the honest answer
 * is that the configuration is self-contradictory — it asks for the tier to be
 * readable and for a file inside it not to be — and only its author can
 * resolve it. Same fail-closed stance as `classifyAvailability` on an explicit
 * backend: never silently deliver less isolation than was asked for.
 *
 * Deny DIRECTORIES are deliberately NOT covered. A deny dir nested inside an
 * allow-back is #308's central mechanism (deny <root> > allow cache/ > deny
 * cache/mirror), it out-specifies the allow on all three backends, and
 * `ensureDataTree` materializes every one of them before any spawn so bwrap's
 * existence guard never drops one. Firing here would outlaw the design.
 *
 * An EXACT tie (allow path === deny file) is not an ancestor and is not
 * refused: `orderRules` breaks a same-depth tie in favour of the narrower
 * "file" rule, so the deny wins in the resolver, in the SBPL profile and in
 * bwrap's mount order alike.
 */
function assertNoAllowAboveDenyFile(
  allows: { path: string; what: string }[],
  denyFiles: string[],
): void {
  for (const file of denyFiles) {
    for (const allow of allows) {
      // Strict: path-boundary match, never a raw string prefix (mirrors
      // precedence.ts's `isUnder`), and the equal case is excluded above.
      if (!file.startsWith(allow.path + sep)) continue;
      throw new SandboxPolicyError(
        `sandbox policy: ${allow.what} "${allow.path}" is an ancestor of denied file ` +
          `"${file}". bwrap skips a deny mount whose target does not exist, so the file ` +
          `would be readable inside that allow the moment it is written — while Seatbelt ` +
          `and the tool jail still deny it. Point the allow below the file (or move the ` +
          `file out of it): check git.worktreeRoot, github.externalReposRoot and ` +
          `sandbox.extra_allow_write.`,
      );
    }
  }
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
