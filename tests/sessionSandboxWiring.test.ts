import { describe, it, expect } from "vitest";
import { resolveSandbox } from "../src/agent/session.js";
import { SandboxUnavailableError } from "../src/agent/sandbox/index.js";
import type { Config } from "../src/types.js";

function cfgWith(sandbox: Partial<Config["sandbox"]>): Config {
  // resolveSandbox reads cfg.sandbox, cfg.botAccount.configDir, and the data
  // tree fields consumed by dataTree.sandboxDenyPaths (dataDir, queueRoot,
  // worktreeRoot, github.externalReposRoot, legacy).
  return {
    dataDir: "/sbxroot/state",
    queueRoot: "/sbxroot/state/queue",
    worktreeRoot: "/sbxroot/state/worktrees",
    legacy: { vaultRoot: false, stateDir: false, worktreeRoot: false, externalReposRoot: false },
    github: { externalReposRoot: "/sbxroot/state/clones/external" },
    botAccount: {
      enabled: false,
      configDir: "/sbxroot/junco-gh",
    },
    sandbox: {
      enabled: true,
      backend: "none",
      network: "deny",
      extraDenyRead: [],
      extraAllowWrite: [],
      ...sandbox,
    },
  } as unknown as Config;
}

// Synthetic, guaranteed-nonexistent paths so canonicalize() (real fs) is a
// deterministic no-op — /tmp is a symlink on macOS.
const okDeps = {
  probe: async () => ({ code: 0 }),
  makeScratch: () => "/sbxroot/scratch",
  platform: "linux" as NodeJS.Platform,
  home: "/sbxroot/home/x",
};

describe("resolveSandbox", () => {
  it("returns null when disabled (no-op path)", async () => {
    const r = await resolveSandbox(cfgWith({ enabled: false }), "/work", undefined, okDeps);
    expect(r).toBeNull();
  });

  it("builds policy + backend when enabled and available", async () => {
    const r = await resolveSandbox(
      cfgWith({ backend: "none" }),
      "/sbxroot/work",
      undefined,
      okDeps,
    );
    expect(r?.backend.name).toBe("none");
    expect(r?.policy.writableRoots).toContain("/sbxroot/work");
    expect(r?.policy.scratchDir).toBe("/sbxroot/scratch");
    expect(r?.policy.network).toBe(false);
    // The bot gh config dir is denied even with botAccount.enabled=false in the
    // fixture — a token may sit in the dir while the feature is off, so the
    // pass-through must stay unconditional.
    expect(r?.policy.readDenyPaths).toContain("/sbxroot/junco-gh");
  });

  it("denies the sensitive data subtrees but NOT the data root (worktrees/clones live under it)", async () => {
    const r = await resolveSandbox(
      cfgWith({ backend: "none" }),
      "/sbxroot/state/worktrees/tkt-1",
      undefined,
      okDeps,
    );
    expect(r?.policy.readDenyPaths).toContain("/sbxroot/state/queue");
    expect(r?.policy.readDenyPaths).toContain("/sbxroot/state/review");
    expect(r?.policy.readDenyPaths).toContain("/sbxroot/state/transcripts");
    expect(r?.policy.readDenyFiles).toContain("/sbxroot/state/watchlist.json");
    expect(r?.policy.readDenyPaths).not.toContain("/sbxroot/state");
  });

  it("per-ticket network override widens egress", async () => {
    const r = await resolveSandbox(cfgWith({}), "/work", { network: true }, okDeps);
    expect(r?.policy.network).toBe(true);
  });

  it("config network=allow widens egress without a per-ticket flag", async () => {
    const r = await resolveSandbox(cfgWith({ network: "allow" }), "/work", undefined, okDeps);
    expect(r?.policy.network).toBe(true);
  });

  it("fails closed when an EXPLICIT backend is unavailable", async () => {
    await expect(
      resolveSandbox(cfgWith({ backend: "bwrap" }), "/work", undefined, {
        ...okDeps,
        probe: async () => ({ code: 127 }),
      }),
    ).rejects.toBeInstanceOf(SandboxUnavailableError);
  });

  it("backend=auto degrades to none (not fail-closed) when no OS backend is available", async () => {
    const r = await resolveSandbox(cfgWith({ backend: "auto" }), "/sbxroot/work", undefined, {
      ...okDeps,
      platform: "linux", // auto → bwrap
      probe: async () => ({ code: 127 }), // bwrap unavailable
    });
    // Degraded, not thrown: still returns a sandbox, but with the none backend.
    expect(r).not.toBeNull();
    expect(r?.backend.name).toBe("none");
    // The policy (env scrub + fs jail) is still built.
    expect(r?.policy.writableRoots).toContain("/sbxroot/work");
  });

  it("backend=none never fails closed even if a probe would fail", async () => {
    const r = await resolveSandbox(cfgWith({ backend: "none" }), "/work", undefined, {
      ...okDeps,
      probe: async () => ({ code: 127 }),
    });
    expect(r?.backend.name).toBe("none");
  });
});
