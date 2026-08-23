import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { sep } from "node:path";
import { type SandboxPolicy, readRules, traversalMetadataPaths } from "./policy.js";
import { orderRules, type ReadRule } from "./precedence.js";

export interface ProbeResult {
  /** Exit status — 127 for a missing binary (mirrors doctor.ts). */
  code: number;
  /** Whatever the child said on stderr. DIAGNOSTIC ONLY: `code` remains the
   *  sole decision input (see `availabilityFrom`); this exists so a refusal the
   *  child explained is not thrown away (#312). Optional — a probe that has
   *  nothing to add simply omits it. */
  stderr?: string;
}

export type ExecProbe = (cmd: string, args: string[]) => Promise<ProbeResult>;

/** A backend's availability plus, when the probe failed and the child said
 *  something, WHY. `reason` is never set when `available` is true. */
export interface BackendAvailability {
  available: boolean;
  reason?: string;
}

/** Max characters of probe stderr kept as a `reason`. A backend's refusal is one
 *  line; a runaway child must not push a megabyte into one log entry. */
export const PROBE_STDERR_LIMIT = 400;

/** Collapse a child's stderr into a bounded single-line diagnostic, or
 *  `undefined` when it said nothing worth repeating. */
export function summarizeProbeStderr(raw: string | undefined): string | undefined {
  const line = (raw ?? "").replace(/\s+/g, " ").trim();
  if (line === "") return undefined;
  return line.length > PROBE_STDERR_LIMIT ? `${line.slice(0, PROBE_STDERR_LIMIT)}…` : line;
}

/** The one place a probe result becomes an availability verdict: `code === 0`
 *  decides, stderr only explains a failure. */
function availabilityFrom(r: ProbeResult): BackendAvailability {
  if (r.code === 0) return { available: true };
  const reason = summarizeProbeStderr(r.stderr);
  return reason === undefined ? { available: false } : { available: false, reason };
}

export interface SandboxBackend {
  name: "seatbelt" | "bwrap" | "none";
  /** Full argv (binary + args) that runs `command` under the sandbox. */
  spawnArgv(command: string, policy: SandboxPolicy): string[];
  /** Whether the backend can actually run here (binary present + functional),
   *  and — when it cannot and the probe's child explained itself — why. */
  checkAvailability(exec: ExecProbe): Promise<BackendAvailability>;
}

/** Default probe: run a binary, treat ENOENT as code 127 (mirrors doctor.ts),
 *  and keep the child's stderr for diagnostics (#312). Without it a backend
 *  that refuses for a REASON — an installed bwrap blocked from creating a user
 *  namespace by `kernel.apparmor_restrict_unprivileged_userns=1`, say — is
 *  indistinguishable from one that is not installed at all. */
export const defaultExecProbe: ExecProbe = (cmd, args) =>
  new Promise((res) => {
    execFile(cmd, args, { timeout: 10_000 }, (err, _stdout, stderr) => {
      const errno = err as NodeJS.ErrnoException | null;
      const code = errno ? (errno.code === "ENOENT" ? 127 : 1) : 0;
      // A spawn failure (ENOENT/EACCES — a string `code`) produces no child and
      // therefore no stderr, so its message IS the diagnosis. For a non-zero
      // EXIT, Node's message is "Command failed: <argv>" with the same stderr
      // appended, so preferring stderr avoids echoing the argv back.
      const detail =
        summarizeProbeStderr(stderr) ??
        (typeof errno?.code === "string" ? summarizeProbeStderr(errno.message) : undefined);
      res(detail === undefined ? { code } : { code, stderr: detail });
    });
  });

// ---- macOS Seatbelt (sandbox-exec + SBPL) --------------------------------

/** Quote a path for SBPL (double-quoted string literal). */
function q(p: string): string {
  return `"${p.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** SBPL line for one read rule. Only the three combinations `readRules`
 *  actually produces are mapped (allow/subtree, deny/subtree, deny/file) —
 *  see policy.ts's `readRules`. */
function readRuleLine(rule: ReadRule): string {
  if (rule.effect === "allow") return `(allow file-read* (subpath ${q(rule.path)}))`;
  return rule.kind === "file"
    ? `(deny file-read* (literal ${q(rule.path)}))`
    : `(deny file-read* (subpath ${q(rule.path)}))`;
}

/** Generate an SBPL profile: deny by default; broad read minus denied
 *  subpaths/files (with allow-backs re-overridden by nested denies); write
 *  only under the writable roots; network per policy.
 *
 *  SBPL is last-match-wins, and the broad `(allow file-read*)` above already
 *  depends on that: every rule emitted below beats it for the paths it
 *  covers. Read rules are emitted via `orderRules(readRules(policy))` —
 *  least-specific first (see precedence.ts) — so a rule nested inside a
 *  broader one always appears later and wins, matching what `resolveRead`
 *  computes for the JS path-jail. Order among non-overlapping (sibling)
 *  rules is otherwise irrelevant to meaning: SBPL rules whose subpaths never
 *  contain the same file don't compete for last-match, regardless of the
 *  order they're emitted in.
 *
 *  One block follows the read rules: a `file-read-metadata` literal for every
 *  denied directory that is a path COMPONENT of an allowed path
 *  (`traversalMetadataPaths` — read its comment; without it the agent's git
 *  cannot open its own gitdir). It must come after the denies precisely because
 *  the profile is last-match-wins: `(deny file-read* (subpath <root>))` covers
 *  the metadata operation too, so only a later, narrower rule can carve it back
 *  out. `file-read-data` on those nodes stays denied, so nothing is listed or
 *  read — only stat'd. */
export function seatbeltProfile(policy: SandboxPolicy): string {
  const lines: string[] = [
    "(version 1)",
    "(deny default)",
    "(allow process-exec)",
    "(allow process-fork)",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    "(allow signal (target self))",
    "(allow file-read*)",
  ];
  for (const rule of orderRules(readRules(policy))) lines.push(readRuleLine(rule));
  for (const path of traversalMetadataPaths(policy))
    lines.push(`(allow file-read-metadata (literal ${q(path)}))`);
  const writes = policy.writableRoots.map((r) => `(subpath ${q(r)})`).join(" ");
  lines.push(`(allow file-write* ${writes} (literal "/dev/null") (literal "/dev/dtracehelper"))`);
  lines.push(policy.network ? "(allow network*)" : "(deny network*)");
  return lines.join("\n");
}

export const seatbeltBackend: SandboxBackend = {
  name: "seatbelt",
  spawnArgv(command, policy) {
    return ["sandbox-exec", "-p", seatbeltProfile(policy), "/bin/bash", "-c", command];
  },
  async checkAvailability(exec) {
    // A trivial allow-all profile that must run `true` successfully.
    return availabilityFrom(
      await exec("sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"]),
    );
  },
};

// ---- Linux bubblewrap ----------------------------------------------------

/** True when `abs` is `root` or lies inside it, matched on path boundaries.
 *  Same shape as precedence.ts's private `isUnder` / pathJail.ts:24-27. */
function isUnder(abs: string, root: string): boolean {
  return abs === root || abs.startsWith(root + sep);
}

/** bwrap mounts for one read rule. Destinations are newroot paths; bind
 *  sources come from bwrap's pristine view of the host, so an allow-back
 *  re-exposes real content even through a tmpfs mounted over its ancestor.
 *  Only the combinations `readRules` produces are mapped (allow/subtree,
 *  deny/subtree, deny/file) — see policy.ts's `readRules`. */
function readRuleMounts(rule: ReadRule, writable: boolean): string[] {
  if (rule.effect === "allow") {
    return writable ? ["--bind", rule.path, rule.path] : ["--ro-bind", rule.path, rule.path];
  }
  // tmpfs needs a directory; an existing file is masked by binding /dev/null
  // over it (reads see empty content, the data is protected).
  return rule.kind === "file" ? ["--ro-bind", "/dev/null", rule.path] : ["--tmpfs", rule.path];
}

/** The order bwrap's mounts must be emitted in: `orderRules` specificity
 *  order (least specific first), with the writable-root binds hoisted as late
 *  as that ordering permits — after every rule that does not lie inside them,
 *  but still before the rules that do. Each entry carries whether it is a
 *  writable root, because `readRules` maps writable roots and read allow-backs
 *  to the same allow/subtree rule and only the former binds read-write.
 *
 *  The hoist CAN reorder overlapping rules. This comment used to claim it could
 *  not; that was false, corrected at final review 2026-08-22 by execution.
 *  Bucket 2 is "under a writable root", which is not the same as "deeper than
 *  every writable root": with nested writable roots (an `extra_allow_write` that
 *  contains the worktree), a deny under the outer root that CONTAINS the inner
 *  one is bucket 2 yet shallower than the inner root's bind, so it is emitted
 *  after that bind and tmpfs-masks it:
 *
 *    writableRoots ["/a", "/a/b/c"], readDenyPaths ["/a/b"]
 *      → --bind /a/b/c … then --tmpfs /a/b, wiping the worktree,
 *
 *  while `resolveRead` and the Seatbelt profile both answer "allow" for
 *  /a/b/c/file.
 *
 *  Tolerated, not overlooked, because the divergence only ever runs one way.
 *  For an allow to wrongly beat a deny that `resolveRead` says should win, that
 *  deny would have to be at least as specific AND emitted earlier — and a deny
 *  more specific than an overlapping allow necessarily lies under a writable
 *  root whenever that allow does, putting it in bucket 2 and therefore after it;
 *  within a bucket `orderRules` order is preserved. So bwrap can come out
 *  STRICTER than the other two backends, never looser, and the symptom is loud
 *  (the agent's worktree comes up empty and the build fails) rather than a
 *  silent over-permission. Moving a bucket-2 rule that contains a writable root
 *  into bucket 0 would close the gap; not done, because it takes a shape nothing
 *  produces today — nested writable roots separated by an `extra_deny_read`. */
function mountOrder(policy: SandboxPolicy): { rule: ReadRule; writable: boolean }[] {
  const writableRoots = new Set(policy.writableRoots);
  const entries = orderRules(readRules(policy)).map((rule) => ({
    rule,
    writable: rule.effect === "allow" && writableRoots.has(rule.path),
  }));
  const bucket = (e: { rule: ReadRule; writable: boolean }): number => {
    if (e.writable) return 1;
    return policy.writableRoots.some((w) => isUnder(e.rule.path, w)) ? 2 : 0;
  };
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => bucket(a.entry) - bucket(b.entry) || a.index - b.index)
    .map(({ entry }) => entry);
}

/** bwrap args: read-only root, private /dev+/proc+/tmp, then one mount per
 *  read rule (tmpfs-mask a denied dir, /dev/null-mask a denied file, ro-bind
 *  an allow-back, rw-bind a writable root), then unshare net when denied.
 *
 *  Mounts apply in argv ORDER and later mounts are destructive, so order is
 *  meaning. Rules are emitted via `mountOrder`, i.e. `orderRules` order (see
 *  precedence.ts) — least specific first, so a rule nested inside a broader
 *  one always lands later and wins, matching what `resolveRead` computes for
 *  the JS path-jail and what the seatbelt profile emits. Concretely, for a
 *  wholesale data-root deny (#277): tmpfs over the root, then the cache/
 *  allow-back ro-bound back on top of it, then a tmpfs over cache/mirror
 *  nested inside that, then the worktree rw-bound LAST so nothing shadows it.
 *  Writable roots go as late as the specificity ordering permits, but a deny
 *  *inside* a writable root (an operator's extra_deny_read in their own
 *  worktree) is deeper still and stays after that bind — otherwise re-binding
 *  the pristine host subtree would silently un-deny it. (Deeper than the root it
 *  is inside; see `mountOrder` for the nested-writable-roots case where such a
 *  deny is shallower than a DIFFERENT writable root.)
 *
 *  Mounts are emitted only for paths that EXIST (`existsFn` injectable for
 *  tests), with one exception. A deny needs its target present because bwrap
 *  cannot create a mountpoint under the read-only root bind (nor under an
 *  allow-back's ro-bind), so a mount aimed at a missing path — an unpopulated
 *  github-cache/, an absent ~/.gnupg — would abort the whole spawn, and a path
 *  that does not exist cannot be read anyway (the JS path-jail still denies it
 *  by name if it appears later). An allow-back needs its SOURCE present for
 *  the same fatal reason: `--ro-bind` of a missing source aborts the spawn,
 *  and re-allowing a path that does not exist grants nothing. Writable roots
 *  are the exception and are never guarded: the caller creates the worktree
 *  and scratch dir before spawning, and a missing one must abort loudly rather
 *  than be silently dropped, which would leave the agent's own worktree masked
 *  by whatever deny sits above it. */
export function bwrapArgs(
  policy: SandboxPolicy,
  existsFn: (p: string) => boolean = existsSync,
): string[] {
  const args = ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp"];
  for (const { rule, writable } of mountOrder(policy)) {
    if (!writable && !existsFn(rule.path)) continue;
    args.push(...readRuleMounts(rule, writable));
  }
  args.push("--unshare-pid");
  if (!policy.network) args.push("--unshare-net");
  args.push("--die-with-parent");
  return args;
}

export const bwrapBackend: SandboxBackend = {
  name: "bwrap",
  spawnArgv(command, policy) {
    return ["bwrap", ...bwrapArgs(policy), "/bin/bash", "-c", command];
  },
  async checkAvailability(exec) {
    return availabilityFrom(
      await exec("bwrap", ["--ro-bind", "/", "/", "--unshare-net", "/usr/bin/true"]),
    );
  },
};

// ---- No OS wrapping ------------------------------------------------------

export const noneBackend: SandboxBackend = {
  name: "none",
  spawnArgv(command) {
    return ["/bin/bash", "-c", command];
  },
  async checkAvailability() {
    return { available: true };
  },
};

/** What to do about the selected backend once its availability is known. */
export type SandboxOutcome = "ok" | "degrade" | "fail-closed";

/**
 * Decide the outcome when the selected backend may be unavailable:
 * - `none` is always OK (no OS isolation by design).
 * - available → OK.
 * - unavailable + configured `"auto"` → **degrade**: `auto` means "best
 *   available", so fall back to `none` (env scrub + filesystem tool-jail still
 *   apply; agent bash is not OS-confined) rather than failing the ticket.
 * - unavailable + an EXPLICIT backend → **fail-closed**: honor the operator's
 *   explicit choice; never silently downgrade what they demanded.
 */
export function classifyAvailability(
  configured: "auto" | "seatbelt" | "bwrap" | "none",
  selected: SandboxBackend["name"],
  available: boolean,
): SandboxOutcome {
  if (selected === "none") return "ok";
  if (available) return "ok";
  return configured === "auto" ? "degrade" : "fail-closed";
}

export function selectBackend(
  backend: "auto" | "seatbelt" | "bwrap" | "none",
  platform: NodeJS.Platform,
): SandboxBackend {
  if (backend === "seatbelt") return seatbeltBackend;
  if (backend === "bwrap") return bwrapBackend;
  if (backend === "none") return noneBackend;
  // auto:
  if (platform === "darwin") return seatbeltBackend;
  if (platform === "linux") return bwrapBackend;
  return noneBackend;
}
