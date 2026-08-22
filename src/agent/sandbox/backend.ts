import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { type SandboxPolicy, readRules } from "./policy.js";
import { orderRules, type ReadRule } from "./precedence.js";

export type ExecProbe = (cmd: string, args: string[]) => Promise<{ code: number }>;

export interface SandboxBackend {
  name: "seatbelt" | "bwrap" | "none";
  /** Full argv (binary + args) that runs `command` under the sandbox. */
  spawnArgv(command: string, policy: SandboxPolicy): string[];
  /** Whether the backend can actually run here (binary present + functional). */
  isAvailable(exec: ExecProbe): Promise<boolean>;
}

/** Default probe: run a binary, treat ENOENT as code 127 (mirrors doctor.ts). */
export const defaultExecProbe: ExecProbe = (cmd, args) =>
  new Promise((res) => {
    execFile(cmd, args, { timeout: 10_000 }, (err) => {
      const code = err ? ((err as NodeJS.ErrnoException).code === "ENOENT" ? 127 : 1) : 0;
      res({ code });
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
 *  order they're emitted in. */
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
  async isAvailable(exec) {
    // A trivial allow-all profile that must run `true` successfully.
    const r = await exec("sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"]);
    return r.code === 0;
  },
};

// ---- Linux bubblewrap ----------------------------------------------------

/** bwrap args: read-only root, rw-bind writable roots, tmpfs-mask denied
 *  read dirs, /dev/null-mask denied files, private /dev+/proc+/tmp, unshare
 *  net when denied. Deny mounts are emitted only for paths that EXIST
 *  (`existsFn` injectable for tests): bwrap cannot create a mountpoint under
 *  the read-only root bind, so a mount aimed at a missing path (e.g. a
 *  github-cache/ nobody has populated, or an absent ~/.gnupg) would abort
 *  the whole spawn — and a path that does not exist cannot be read anyway
 *  (the JS path-jail still denies it by name if it appears later). Mounts
 *  apply in argv order, which is why the denies come AFTER the writable-root
 *  binds and why the deny list must never contain an ancestor of a writable
 *  root (policy.ts denies the data root's sensitive SUBTREES, not the root):
 *  a later tmpfs over an ancestor would shadow the bind entirely. */
export function bwrapArgs(
  policy: SandboxPolicy,
  existsFn: (p: string) => boolean = existsSync,
): string[] {
  const args = ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp"];
  for (const r of policy.writableRoots) args.push("--bind", r, r);
  for (const d of policy.readDenyPaths) {
    if (existsFn(d)) args.push("--tmpfs", d);
  }
  for (const f of policy.readDenyFiles) {
    // tmpfs needs a directory; an existing file is masked by binding
    // /dev/null over it (reads see empty content, the data is protected).
    if (existsFn(f)) args.push("--ro-bind", "/dev/null", f);
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
  async isAvailable(exec) {
    const r = await exec("bwrap", ["--ro-bind", "/", "/", "--unshare-net", "/usr/bin/true"]);
    return r.code === 0;
  },
};

// ---- No OS wrapping ------------------------------------------------------

export const noneBackend: SandboxBackend = {
  name: "none",
  spawnArgv(command) {
    return ["/bin/bash", "-c", command];
  },
  async isAvailable() {
    return true;
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
