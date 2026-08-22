import { describe, it, expect } from "vitest";
import {
  seatbeltProfile,
  bwrapArgs,
  seatbeltBackend,
  bwrapBackend,
  noneBackend,
  selectBackend,
  classifyAvailability,
} from "../src/agent/sandbox/backend.js";
import type { SandboxPolicy } from "../src/agent/sandbox/policy.js";

const denyNet: SandboxPolicy = {
  writableRoots: ["/work/tree", "/tmp/scratch"],
  readDenyPaths: ["/home/x/.ssh"],
  readDenyFiles: [],
  readAllowPaths: [],
  network: false,
  scratchDir: "/tmp/scratch",
};
const allowNet: SandboxPolicy = { ...denyNet, network: true };

// The C1 regression shape: the worktree (cwd) and clones live UNDER the data
// root; only the sensitive subtrees/files are denied — never the root itself.
const dataDir = "/sbxroot/home/x/.local/state/junco";
const dataPolicy: SandboxPolicy = {
  writableRoots: [`${dataDir}/worktrees/tkt-1`, "/sbxroot/scratch"],
  readDenyPaths: [`${dataDir}/queue`, `${dataDir}/review`, `${dataDir}/transcripts`],
  readDenyFiles: [`${dataDir}/watchlist.json`],
  readAllowPaths: [],
  network: false,
  scratchDir: "/sbxroot/scratch",
};

describe("seatbeltProfile", () => {
  it("denies default, allows writes only under the roots, and denies network", () => {
    const p = seatbeltProfile(denyNet);
    expect(p).toContain("(version 1)");
    expect(p).toContain("(deny default)");
    expect(p).toContain('(subpath "/work/tree")');
    expect(p).toContain('(subpath "/tmp/scratch")');
    expect(p).toContain('(deny file-read* (subpath "/home/x/.ssh"))');
    expect(p).toContain("(deny network*)");
  });
  it("allows network when policy.network is true", () => {
    const p = seatbeltProfile(allowNet);
    expect(p).toContain("(allow network*)");
    expect(p).not.toContain("(deny network*)");
  });
  it("denies the sensitive data subtrees (subpath) + files (literal), never the data root", () => {
    const p = seatbeltProfile(dataPolicy);
    expect(p).toContain(`(deny file-read* (subpath "${dataDir}/queue"))`);
    expect(p).toContain(`(deny file-read* (subpath "${dataDir}/review"))`);
    expect(p).toContain(`(deny file-read* (literal "${dataDir}/watchlist.json"))`);
    // The root itself is NOT denied — the worktree the agent runs in and the
    // clone gitdirs live under it, and a subpath deny overrides the broad allow.
    expect(p).not.toContain(`(deny file-read* (subpath "${dataDir}"))`);
  });
});

describe("seatbeltBackend.spawnArgv", () => {
  it("passes the profile inline and runs bash -c", () => {
    const argv = seatbeltBackend.spawnArgv("echo hi", denyNet);
    expect(argv[0]).toBe("sandbox-exec");
    expect(argv[1]).toBe("-p");
    expect(argv[2]).toContain("(deny default)");
    expect(argv.slice(3)).toEqual(["/bin/bash", "-c", "echo hi"]);
  });
});

describe("bwrapArgs", () => {
  it("ro-binds root, rw-binds writable roots, masks denials, unshares net when denied", () => {
    const a = bwrapArgs(denyNet, () => true).join(" ");
    expect(a).toContain("--ro-bind / /");
    expect(a).toContain("--bind /work/tree /work/tree");
    expect(a).toContain("--bind /tmp/scratch /tmp/scratch");
    expect(a).toContain("--tmpfs /home/x/.ssh");
    expect(a).toContain("--unshare-net");
  });
  it("does not unshare net when network is allowed", () => {
    expect(bwrapArgs(allowNet, () => true).join(" ")).not.toContain("--unshare-net");
  });
  it("never tmpfs-masks the data root — the worktree bind must not be shadowed", () => {
    const args = bwrapArgs(dataPolicy, () => true);
    const a = args.join(" ");
    // The worktree stays rw-bound and NO tmpfs mounts over it or any of its
    // ancestors (mounts apply in argv order — a later tmpfs of an ancestor
    // would mount OVER the bind and the worktree would appear empty).
    expect(a).toContain(`--bind ${dataDir}/worktrees/tkt-1 ${dataDir}/worktrees/tkt-1`);
    const tmpfsTargets = args.flatMap((v, i) => (args[i - 1] === "--tmpfs" ? [v] : []));
    expect(tmpfsTargets).not.toContain(dataDir);
    for (const t of tmpfsTargets) {
      expect(`${dataDir}/worktrees/tkt-1/`.startsWith(`${t}/`)).toBe(false);
    }
    // The sensitive subtrees are still masked.
    expect(tmpfsTargets).toContain(`${dataDir}/queue`);
    expect(tmpfsTargets).toContain(`${dataDir}/review`);
  });
  it("masks denied files that exist with a /dev/null ro-bind; skips missing paths", () => {
    const exists = (p: string): boolean => p !== `${dataDir}/review`;
    const a = bwrapArgs(dataPolicy, exists).join(" ");
    expect(a).toContain(`--ro-bind /dev/null ${dataDir}/watchlist.json`);
    // A missing deny target gets no mount: bwrap cannot create mountpoints
    // under the read-only root bind, and a path that does not exist cannot
    // be read anyway (the JS jail still denies it by name).
    expect(a).not.toContain(`--tmpfs ${dataDir}/review`);
    expect(a).toContain(`--tmpfs ${dataDir}/queue`);
  });
});

describe("bwrapBackend.spawnArgv", () => {
  it("prefixes bwrap args and runs bash -c", () => {
    const argv = bwrapBackend.spawnArgv("echo hi", denyNet);
    expect(argv[0]).toBe("bwrap");
    expect(argv.slice(-3)).toEqual(["/bin/bash", "-c", "echo hi"]);
  });
});

describe("noneBackend", () => {
  it("runs bash -c directly and is always available", async () => {
    expect(noneBackend.spawnArgv("echo hi", denyNet)).toEqual(["/bin/bash", "-c", "echo hi"]);
    expect(await noneBackend.isAvailable(async () => ({ code: 127 }))).toBe(true);
  });
});

describe("selectBackend", () => {
  it("auto → seatbelt on darwin, bwrap on linux", () => {
    expect(selectBackend("auto", "darwin").name).toBe("seatbelt");
    expect(selectBackend("auto", "linux").name).toBe("bwrap");
  });
  it("explicit backends win regardless of platform", () => {
    expect(selectBackend("bwrap", "darwin").name).toBe("bwrap");
    expect(selectBackend("seatbelt", "linux").name).toBe("seatbelt");
    expect(selectBackend("none", "darwin").name).toBe("none");
  });
  it("auto on an unsupported platform yields none", () => {
    expect(selectBackend("auto", "win32").name).toBe("none");
  });
});

describe("isAvailable", () => {
  it("seatbelt available when probe exits 0", async () => {
    expect(await seatbeltBackend.isAvailable(async () => ({ code: 0 }))).toBe(true);
    expect(await seatbeltBackend.isAvailable(async () => ({ code: 127 }))).toBe(false);
  });
});

describe("classifyAvailability", () => {
  it("none is always ok (no OS isolation by design)", () => {
    expect(classifyAvailability("none", "none", false)).toBe("ok");
    expect(classifyAvailability("auto", "none", false)).toBe("ok"); // auto on an unsupported platform
  });
  it("available backend is ok", () => {
    expect(classifyAvailability("bwrap", "bwrap", true)).toBe("ok");
    expect(classifyAvailability("auto", "seatbelt", true)).toBe("ok");
  });
  it("auto + unavailable degrades (best-available → none)", () => {
    expect(classifyAvailability("auto", "bwrap", false)).toBe("degrade");
    expect(classifyAvailability("auto", "seatbelt", false)).toBe("degrade");
  });
  it("an explicit backend + unavailable fails closed", () => {
    expect(classifyAvailability("bwrap", "bwrap", false)).toBe("fail-closed");
    expect(classifyAvailability("seatbelt", "seatbelt", false)).toBe("fail-closed");
  });
});
