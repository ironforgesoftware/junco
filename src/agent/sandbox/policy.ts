import { statSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import type { SandboxConfig } from "../../types.js";
import { canonicalize } from "./canonicalize.js";
import { resolveRead, type ReadRule } from "./precedence.js";

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
 *  operator-removable (extra_deny_read only adds).
 *
 *  Mixed shapes on purpose (#336): where a toolchain keeps its credential in
 *  one FILE inside a directory the agent legitimately needs — cargo's `bin/`
 *  and `registry/`, docker's `cli-plugins/` — only that file is named, not the
 *  directory. `buildPolicy` splits the list by observation (`classifyDenyRead`)
 *  because an existing file cannot be a subtree deny on bwrap. */
export function builtinDenyReadPaths(home: string): string[] {
  return [
    join(home, ".ssh"),
    join(home, ".aws"),
    join(home, ".config", "gh"),
    join(home, ".gnupg"),
    join(home, ".pi"),
    join(home, ".npmrc"),
    join(home, ".git-credentials"),
    join(home, ".netrc"),
    join(home, ".docker", "config.json"),
    join(home, ".kube"),
    join(home, ".config", "gcloud"),
    join(home, ".cargo", "credentials.toml"),
    join(home, ".pypirc"),
    join(home, ".gem", "credentials"),
    join(home, ".claude"),
  ];
}

/** The two answers of `git rev-parse --path-format=absolute --git-dir
 *  --git-common-dir`, run in the agent's cwd. */
export interface GitDirs {
  gitDir: string;
  commonDir: string;
}

/** `a` is `b` or lies strictly inside it (path-component-wise: `/x/y-2` is not
 *  under `/x/y`). Local on purpose — pathJail.ts imports this module's types. */
function isWithin(a: string, b: string): boolean {
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);
}

/**
 * Extra writable roots a LINKED worktree needs (#320). junco hands the agent
 * `git worktree add`'s output: `<cwd>/.git` is a FILE pointing at
 * `<repo>/.git/worktrees/<name>` (the gitdir — index, HEAD, COMMIT_EDITMSG,
 * the per-worktree reflog), and every commit writes `<repo>/.git/objects`,
 * `<repo>/.git/refs` and `<repo>/.git/logs` (the common dir). None of that is
 * under the cwd, so a cwd-only write policy makes the very first `git commit`
 * fail with "Unable to create '…/index.lock': Operation not permitted" —
 * which is what #320 is.
 *
 * The grant is the MINIMAL set: the gitdir, plus `objects/`, `refs/` and
 * `logs/` of the common dir — never the common dir itself. `hooks/`, `config`,
 * `info/`, the main worktree's `HEAD` and `packed-refs` stay unwritable, so an
 * agent cannot plant a hook or set `core.hooksPath` / `core.fsmonitor` /
 * `core.sshCommand` that junco's own unsandboxed git calls (status, commit,
 * push, worktree add — daemon identity) would then execute. The cost: an
 * in-session `git config`, `gc`, `pack-refs` or ref DELETION fails loud; none
 * is needed (identity is pre-seeded, and ref updates write loose refs).
 * A standalone repo — common dir inside the cwd — is already writable through
 * the cwd root and adds nothing. The rare `GIT_DIR`-style layout where the
 * gitdir IS the common dir gets that dir wholesale; a linked worktree never
 * has that shape.
 *
 * Callers must ensure the three subdirs exist — session.ts mkdir -p's a
 * missing one — because bwrap aborts on a missing bind source (backend.ts,
 * bwrapArgs), and a fresh bare clone has no `logs/` until the first commit on
 * a branch writes its reflog.
 */
export function linkedWorktreeWritePaths(opts: { cwd: string } & GitDirs): string[] {
  const cwd = canonicalize(opts.cwd);
  const commonDir = canonicalize(opts.commonDir);
  const gitDir = canonicalize(opts.gitDir);
  if (gitDir === commonDir) return isWithin(gitDir, cwd) ? [] : [gitDir];
  const roots: string[] = [];
  if (!isWithin(gitDir, cwd)) roots.push(gitDir);
  if (!isWithin(commonDir, cwd)) {
    roots.push(join(commonDir, "objects"), join(commonDir, "refs"), join(commonDir, "logs"));
  }
  return roots;
}

export interface SandboxPolicy {
  /** Absolute roots the agent may write under: the worktree, scratch, the
   *  linked worktree's git metadata (gitdir + objects/refs/logs, #320), and
   *  the operator's extras. */
  writableRoots: string[];
  /** Absolute subpaths whose reads are denied (secrets, sensitive data-tree
   *  subtrees, extras). Subtree semantics: the path and everything under it. */
  readDenyPaths: string[];
  /** Absolute files whose reads are denied exactly (the data root's receipt
   *  files — watchlist/spend/metrics/log/journal, plus any `extra_deny_read`
   *  entry observed to BE a regular file). Separate from readDenyPaths because
   *  the OS backends enforce files differently (Seatbelt literal vs subpath;
   *  bwrap /dev/null bind vs tmpfs — and tmpfs cannot mount on a file at all). */
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
  /** Default wall-clock ceiling for one bash call, ms; undefined = no ceiling.
   *  The agent's explicit `timeout` (seconds) always overrides it. */
  bashTimeoutMs: number | undefined;
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
  /** Extra writable roots for a LINKED worktree's git metadata — the owning
   *  repo's common dir (and, rarely, an out-of-tree gitdir), as computed by
   *  `linkedWorktreeWritePaths`. Threaded in by session.ts's resolveSandbox;
   *  callers that build stand-in policies (doctor, tests) leave it empty. */
  gitWritePaths?: string[];
  /** #311/F5: how `buildPolicy` tells a builtin or `extra_deny_read` entry
   *  that names a FILE from one that names a directory. Defaults to a real
   *  `statSync`; injected by tests so synthetic `/sbxroot/...` paths can state
   *  their kind. See `classifyDenyRead` for why observation (and not a
   *  syntactic guess) is the rule, and what a path that does not exist yet
   *  resolves to. */
  isFile?: (p: string) => boolean;
}): SandboxPolicy {
  const { cfg, cwd, scratchDir, home, dataDenyPaths, dataAllowPaths, network, botGhConfigDir } =
    opts;
  const isFile = opts.isFile ?? defaultIsFile;
  // Canonicalize so the OS-sandbox profile and the JS jail agree with the
  // kernel's symlink-resolved view (macOS /var→/private/var, /tmp→/private/tmp).
  const writableRoots = [
    canonicalize(cwd),
    canonicalize(scratchDir),
    ...(opts.gitWritePaths ?? []).map(canonicalize),
    ...cfg.extraAllowWrite.map(canonicalize),
  ];
  const builtinDenyRead = classifyDenyRead(builtinDenyReadPaths(home).map(canonicalize), isFile);
  const extraDenyRead = classifyDenyRead(cfg.extraDenyRead.map(canonicalize), isFile);
  const readDenyPaths = [
    ...builtinDenyRead.dirs,
    ...dataDenyPaths.dirs.map(canonicalize),
    ...(botGhConfigDir ? [canonicalize(botGhConfigDir)] : []),
    ...extraDenyRead.dirs,
  ];
  const dataDenyFiles = dataDenyPaths.files.map(canonicalize);
  const readDenyFiles = [...builtinDenyRead.files, ...dataDenyFiles, ...extraDenyRead.files];
  // Same canonicalization as the deny lists above — otherwise precedence
  // would compare a canonicalized deny against a raw allow and a
  // /tmp-vs-/private/tmp-style mismatch would silently flip the answer.
  const readAllowPaths = (dataAllowPaths ?? []).map(canonicalize);
  // Only the DATA-TREE deny files are guarded, not the composed list — the
  // guard's premise is that the file is absent (see assertNoAllowAboveDenyFile),
  // which is true of every receipt here by construction and NOT true of a
  // builtin or an operator's `extra_deny_read`, which only ever reach
  // `readDenyFiles` by having been OBSERVED to exist (classifyDenyRead). Denying an existing
  // `.env` inside the agent's own worktree is a supported, documented use case
  // and all three backends already agree on it: bwrap emits the file's
  // /dev/null mask deeper than — therefore after — the worktree's rw bind.
  assertNoAllowAboveDenyFile(
    [
      ...writableRoots.map((path) => ({ path, what: "writable root" })),
      ...readAllowPaths.map((path) => ({ path, what: "read allow-back" })),
    ],
    dataDenyFiles,
  );
  return {
    writableRoots,
    readDenyPaths,
    readDenyFiles,
    readAllowPaths,
    network,
    scratchDir: canonicalize(scratchDir),
    bashTimeoutMs: cfg.bashTimeoutSeconds > 0 ? cfg.bashTimeoutSeconds * 1000 : undefined,
  };
}

/** Does this path name a regular file RIGHT NOW? `false` for a directory, a
 *  path that does not exist, and anything unstattable — see
 *  `classifyDenyRead` for why every one of those is the safe answer. */
function defaultIsFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * #311/F5: split a deny list — `sandbox.extra_deny_read`, and since #336 the
 * builtins too — into the two deny kinds the backends actually have, instead
 * of forcing every entry through the subtree kind.
 *
 * How we tell: by OBSERVATION (`statSync`), never by spelling. A trailing `/`
 * is not a promise and its absence is not one either — `extra_deny_read:
 * ["~/.netrc"]` and `["~/.aws"]` are typed identically — so a syntactic guess
 * would misclassify at least as often as it helped.
 *
 * Why an observed FILE must not stay a subtree deny: bwrap renders a subtree
 * deny as `--tmpfs <path>`, and tmpfs can only be mounted on a DIRECTORY, so an
 * existing `extra_deny_read` file makes bwrap abort the whole spawn — every
 * ticket dies at sandbox setup on Linux. As a `readDenyFiles` entry it becomes
 * `--ro-bind /dev/null <file>`, which is what that list exists for, and the
 * three backends then agree exactly (Seatbelt `literal`, bwrap /dev/null mask,
 * path-jail exact match) — including inside the agent's own worktree, the
 * documented use case: the mask is deeper than the rw bind, so `mountOrder`
 * emits it after and it survives. That agreement is also why an entry that
 * lands here is deliberately NOT put through `assertNoAllowAboveDenyFile` — see
 * the call site in `buildPolicy`.
 *
 * Why everything else stays a SUBTREE deny — including a path that does not
 * exist yet, which is the case that has no observation to go on. A subtree rule
 * is the strictly stronger of the two wherever the NAME is what's enforced
 * (Seatbelt, path-jail): `(deny file-read* (subpath p))` denies `p` and
 * everything under it, so it is correct whichever kind `p` turns out to be,
 * while a `literal` would silently expose the contents of a directory created
 * later. On bwrap a mount at a missing target is skipped either way
 * (`bwrapArgs`' existence guard), so guessing "file" buys nothing there and
 * loosens the other two. Residual, unchanged by this split (an absent `~/.aws`
 * or `~/.npmrc`): under bwrap's `--ro-bind / /` a deny whose target is absent
 * at spawn emits no mask at all, so a path created mid-run by something
 * outside the sandbox is readable on bwrap while Seatbelt and the path-jail
 * still deny it by name.
 */
function classifyDenyRead(
  paths: string[],
  isFile: (p: string) => boolean,
): { dirs: string[]; files: string[] } {
  const dirs: string[] = [];
  const files: string[] = [];
  for (const p of paths) (isFile(p) ? files : dirs).push(p);
  return { dirs, files };
}

/** True when `child` lies STRICTLY inside the subtree rooted at `dir` — the
 *  equal case is excluded, and the filesystem root is handled: `"/" + sep` is
 *  `"//"`, which nothing starts with, so the naive idiom lets an allow at `/`
 *  slip past every boundary test (#311/F4 — and on bwrap that allow is emitted
 *  as `--bind / /` AFTER the denies, re-exposing the whole host). */
function isStrictlyUnder(child: string, dir: string): boolean {
  if (child === dir) return false;
  return child.startsWith(dir.endsWith(sep) ? dir : dir + sep);
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
  /** The DATA-TREE deny files only — the list whose "lazily written, absent
   *  until first write" premise above actually holds. See the call site. */
  denyFiles: string[],
): void {
  for (const file of denyFiles) {
    for (const allow of allows) {
      // Strict: path-boundary match, never a raw string prefix, and the equal
      // case is excluded — including at the filesystem root (see isStrictlyUnder).
      if (!isStrictlyUnder(file, allow.path)) continue;
      throw new SandboxPolicyError(
        `sandbox policy: ${allow.what} "${allow.path}" is an ancestor of denied file ` +
          `"${file}". bwrap skips a deny mount whose target does not exist, so the file ` +
          `would be readable inside that allow the moment it is written — while Seatbelt ` +
          `and the tool jail still deny it. This is a sandbox-setup refusal, not a ticket ` +
          `failure: no ticket can run until it is resolved. Point the allow below the file ` +
          `(or move the file out of it): check git.worktreeRoot, github.externalReposRoot, ` +
          `sandbox.extra_allow_write, and the JUNCO_CONFIG environment variable (it names a ` +
          `config file that is denied by name wherever it points, so an allow above THAT ` +
          `location trips this too).`,
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

/**
 * The denied directories the agent must still be able to `stat()` in order to
 * REACH an allowed path — every proper ancestor of an allow rule that the
 * policy's own rules resolve to "deny". Returned so a backend can grant
 * METADATA-only access to exactly those nodes; contents stay denied.
 *
 * Why this exists (#308 regression, found at final review 2026-08-22). The data
 * root is denied wholesale and the agent's execution roots are allowed back
 * inside it, so `<root>` — and, since the v2 allow-back narrowed to
 * `cache/clones`, `<root>/cache` as well — are denied path COMPONENTS of paths
 * the agent legitimately reads. `junco` hands the agent a linked worktree
 * (`git worktree add`), whose `.git` is a FILE holding an absolute `gitdir:`
 * path under the clones tier, and git resolves that with `strbuf_realpath`,
 * which lstats every component. Under a Seatbelt profile that denies
 * `file-read*` on `<root>`, that lstat is EPERM and git aborts outright:
 *
 *     fatal: Invalid path '<root>': Operation not permitted
 *
 * — i.e. `git rev-parse` / `status` / `diff` all failed for the agent while
 * `cat` kept working, which is why only a test that runs `git` catches it
 * (tests/sandbox.integration.test.ts).
 *
 * Metadata-only is the whole point: Seatbelt separates `file-read-metadata`
 * from `file-read-data`, so `(allow file-read-metadata (literal <dir>))` grants
 * `stat()` on that one directory node and nothing else — not its listing, not
 * any file under it, and not the same node's contents. Nothing that was denied
 * becomes readable.
 *
 * The other two backends need nothing equivalent, for structural reasons:
 *  - **bwrap** renders a denied directory as `--tmpfs <dir>`, which REPLACES it
 *    with an empty directory rather than blocking access to it. The node still
 *    exists and stats fine, and the allow-back is then `--ro-bind`ed at a
 *    destination inside it, so traversal never fails. (This is also why the
 *    outage was macOS-only.) Confirmed on a real bwrap by CI, PR #316.
 *
 *    That replacement is not free, and the difference is deliberate rather than
 *    overlooked (found by PR #316's ubuntu leg, which is the first real bwrap
 *    run of this shape). A tmpfs mask is a different DIRECTORY, not a denied
 *    permission, so it is listable: `ls <denied dir>` fails on Seatbelt and
 *    SUCCEEDS on bwrap. What it prints is the mountpoint skeleton bwrap itself
 *    creates for the deeper mounts the policy asks for — the policy's own path
 *    names, all of them empty tmpfs dirs, /dev/null-masked files, or the
 *    allow-backs. No host child of the masked directory appears, no content is
 *    readable through it, and the stubs' own metadata is the tmpfs's, not the
 *    real files'. So bwrap leaks EXISTENCE of paths junco itself names (they are
 *    the shipped layout, and `bwrapArgs` skips a mount whose target is absent,
 *    so the skeleton tracks which of them are materialized) and nothing else.
 *    tests/sandbox.integration.test.ts pins the boundary that matters on both
 *    backends: a host file inside the denied root that no policy rule names is
 *    neither listed nor readable.
 *
 *    Closing even the existence gap was considered and rejected. `--perms 0111
 *    --tmpfs <dir>` would make the mask execute-only — traversable but not
 *    listable, i.e. exactly Seatbelt's semantics — but `--perms` is a newer
 *    bwrap option and an older bwrap aborts on an option it does not know, which
 *    turns a cosmetic hardening into every ticket on that host dying at sandbox
 *    setup. It would also have to be applied to the parent mountpoints bwrap
 *    creates implicitly (v2's `<root>/cache`), which are not emitted as ops at
 *    all. Not worth an unverifiable spawn-abort risk to hide names that are in
 *    the documentation.
 *  - **the JS path-jail** answers one whole path at a time through
 *    `resolveRead`; it has no traversal step, and the tools it guards never
 *    stat an ancestor. The agent's `git` runs through bash, i.e. the OS backend.
 *
 * A deny FILE that happens to sit on the path is skipped rather than opened up:
 * an allow nested under a deny file is a self-contradictory configuration, and
 * `stat()` on a receipt would still leak its size and mtime.
 */
export function traversalMetadataPaths(policy: SandboxPolicy): string[] {
  const rules = readRules(policy);
  const denyFiles = new Set(policy.readDenyFiles);
  const out = new Set<string>();
  for (const rule of rules) {
    if (rule.effect !== "allow") continue;
    let p = dirname(rule.path);
    for (;;) {
      if (!denyFiles.has(p) && resolveRead(p, rules) === "deny") out.add(p);
      const parent = dirname(p);
      if (parent === p) break; // reached the filesystem root
      p = parent;
    }
  }
  // Sorted for a deterministic profile: ancestors sort before their children.
  return [...out].sort();
}
