import { describe, it, expect } from "vitest";
import { resolveSandbox } from "../src/agent/session.js";
import { SandboxUnavailableError } from "../src/agent/sandbox/index.js";
import type { Config } from "../src/types.js";

function cfgWith(sandbox: Partial<Config["sandbox"]>): Config {
  // resolveSandbox only reads cfg.sandbox and cfg.stateDir.
  return {
    stateDir: "/tmp/state",
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
  });

  it("per-ticket network override widens egress", async () => {
    const r = await resolveSandbox(cfgWith({}), "/work", { network: true }, okDeps);
    expect(r?.policy.network).toBe(true);
  });

  it("config network=allow widens egress without a per-ticket flag", async () => {
    const r = await resolveSandbox(cfgWith({ network: "allow" }), "/work", undefined, okDeps);
    expect(r?.policy.network).toBe(true);
  });

  it("fails closed when a required backend is unavailable", async () => {
    await expect(
      resolveSandbox(cfgWith({ backend: "bwrap" }), "/work", undefined, {
        ...okDeps,
        probe: async () => ({ code: 127 }),
      }),
    ).rejects.toBeInstanceOf(SandboxUnavailableError);
  });

  it("backend=none never fails closed even if a probe would fail", async () => {
    const r = await resolveSandbox(cfgWith({ backend: "none" }), "/work", undefined, {
      ...okDeps,
      probe: async () => ({ code: 127 }),
    });
    expect(r?.backend.name).toBe("none");
  });
});
