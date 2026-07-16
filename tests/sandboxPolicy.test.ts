import { describe, it, expect } from "vitest";
import { builtinDenyReadPaths, buildPolicy } from "../src/agent/sandbox/policy.js";
import {
  assertReadAllowed,
  assertWriteAllowed,
  SandboxViolation,
} from "../src/agent/sandbox/pathJail.js";

describe("builtinDenyReadPaths", () => {
  it("covers the standard secret locations under home", () => {
    const p = builtinDenyReadPaths("/sbxroot/home/x");
    expect(p).toContain("/sbxroot/home/x/.ssh");
    expect(p).toContain("/sbxroot/home/x/.aws");
    expect(p).toContain("/sbxroot/home/x/.config/gh");
    expect(p).toContain("/sbxroot/home/x/.gnupg");
    expect(p).toContain("/sbxroot/home/x/.pi");
  });
});

// Synthetic, guaranteed-nonexistent paths so canonicalize() is a deterministic
// no-op (real system paths like /home, /tmp resolve differently per machine).
describe("buildPolicy", () => {
  const base = {
    cfg: {
      enabled: true,
      backend: "auto" as const,
      network: "deny" as const,
      extraDenyRead: ["/sbxroot/extra/secret"],
      extraAllowWrite: ["/sbxroot/extra/writable"],
    },
    cwd: "/sbxroot/work/tree",
    scratchDir: "/sbxroot/nowhere/scratch1",
    home: "/sbxroot/home/x",
    dataDenyPaths: {
      dirs: ["/sbxroot/data/queue", "/sbxroot/data/review"],
      files: ["/sbxroot/data/watchlist.json"],
    },
    network: false,
  };

  it("writable roots = cwd + scratch + extras", () => {
    const pol = buildPolicy(base);
    expect(pol.writableRoots).toEqual([
      "/sbxroot/work/tree",
      "/sbxroot/nowhere/scratch1",
      "/sbxroot/extra/writable",
    ]);
  });

  it("read denials = builtins + sensitive data subtrees + extras; data files land in readDenyFiles", () => {
    const pol = buildPolicy(base);
    expect(pol.readDenyPaths).toContain("/sbxroot/home/x/.ssh");
    expect(pol.readDenyPaths).toContain("/sbxroot/data/queue");
    expect(pol.readDenyPaths).toContain("/sbxroot/data/review");
    expect(pol.readDenyPaths).toContain("/sbxroot/extra/secret");
    expect(pol.readDenyFiles).toEqual(["/sbxroot/data/watchlist.json"]);
    // Never the data root itself — worktrees/ and clones/ live under it.
    expect(pol.readDenyPaths).not.toContain("/sbxroot/data");
  });

  it("threads the network flag through", () => {
    expect(buildPolicy({ ...base, network: true }).network).toBe(true);
    expect(buildPolicy({ ...base, network: false }).network).toBe(false);
  });

  it("resolves relative/.. inputs to absolute", () => {
    const pol = buildPolicy({ ...base, cwd: "/sbxroot/work/../work/tree" });
    expect(pol.writableRoots[0]).toBe("/sbxroot/work/tree");
  });

  it("denies reads of the bot gh config dir when provided", () => {
    const p = buildPolicy({
      cfg: {
        enabled: true,
        backend: "none",
        network: "deny",
        extraDenyRead: [],
        extraAllowWrite: [],
      },
      cwd: "/sbxroot/wt",
      scratchDir: "/sbxroot/scratch",
      home: "/sbxroot/home",
      dataDenyPaths: { dirs: [], files: [] },
      network: false,
      botGhConfigDir: "/sbxroot/home/.config/junco/gh",
    });
    expect(p.readDenyPaths).toContain("/sbxroot/home/.config/junco/gh");
  });
});

// The C1 regression (default unified layout): the worktree the agent runs in
// and the watched-clone gitdirs live UNDER dataDir — a policy that denied the
// whole root made every in-worktree read a SandboxViolation. Sensitive
// subtrees stay denied; the execution roots must stay readable/writable.
describe("buildPolicy — default <dataDir>-rooted layout (JS jail)", () => {
  const dataDir = "/sbxroot/home/x/.local/state/junco";
  const cwd = `${dataDir}/worktrees/tkt-1`;
  const policy = buildPolicy({
    cfg: {
      enabled: true,
      backend: "auto" as const,
      network: "deny" as const,
      extraDenyRead: [],
      extraAllowWrite: [],
    },
    cwd,
    scratchDir: "/sbxroot/nowhere/scratch1",
    home: "/sbxroot/home/x",
    dataDenyPaths: {
      dirs: [
        `${dataDir}/queue`,
        `${dataDir}/review`,
        `${dataDir}/outbox`,
        `${dataDir}/mirror`,
        `${dataDir}/transcripts`,
        `${dataDir}/github-cache`,
      ],
      files: [`${dataDir}/watchlist.json`],
    },
    network: false,
  });

  it("allows reads and writes inside the agent's own worktree under <dataDir>/worktrees", () => {
    expect(assertReadAllowed(`${cwd}/src/a.ts`, cwd, policy)).toBe(`${cwd}/src/a.ts`);
    expect(assertWriteAllowed(`${cwd}/src/a.ts`, cwd, policy)).toBe(`${cwd}/src/a.ts`);
  });

  it("allows reads of the watched-clone gitdirs under <dataDir>/clones", () => {
    expect(assertReadAllowed(`${dataDir}/clones/watched/o/r/.git/HEAD`, cwd, policy)).toBe(
      `${dataDir}/clones/watched/o/r/.git/HEAD`,
    );
    expect(assertReadAllowed(`${dataDir}/clones/external/o2/r2/.git/HEAD`, cwd, policy)).toBe(
      `${dataDir}/clones/external/o2/r2/.git/HEAD`,
    );
  });

  it("still denies the sensitive subtrees and root receipt files", () => {
    expect(() => assertReadAllowed(`${dataDir}/queue/inbox/x.md`, cwd, policy)).toThrow(
      SandboxViolation,
    );
    expect(() => assertReadAllowed(`${dataDir}/review/assess/y.json`, cwd, policy)).toThrow(
      SandboxViolation,
    );
    expect(() => assertReadAllowed(`${dataDir}/watchlist.json`, cwd, policy)).toThrow(
      SandboxViolation,
    );
  });
});
