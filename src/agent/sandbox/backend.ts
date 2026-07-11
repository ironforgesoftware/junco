import { execFile } from "node:child_process";
import type { SandboxPolicy } from "./policy.js";

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

/** Generate an SBPL profile: deny by default; broad read minus denied
 *  subpaths; write only under the writable roots; network per policy. */
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
  for (const d of policy.readDenyPaths) lines.push(`(deny file-read* (subpath ${q(d)}))`);
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
 *  read paths, private /dev+/proc+/tmp, unshare net when denied. */
export function bwrapArgs(policy: SandboxPolicy): string[] {
  const args = ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp"];
  for (const r of policy.writableRoots) args.push("--bind", r, r);
  for (const d of policy.readDenyPaths) args.push("--tmpfs", d);
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
