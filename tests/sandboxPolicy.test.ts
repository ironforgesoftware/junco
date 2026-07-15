import { describe, it, expect } from "vitest";
import { builtinDenyReadPaths, buildPolicy } from "../src/agent/sandbox/policy.js";

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
    stateDir: "/sbxroot/home/x/.local/state/junco",
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

  it("read denials = builtins + stateDir + extras", () => {
    const pol = buildPolicy(base);
    expect(pol.readDenyPaths).toContain("/sbxroot/home/x/.ssh");
    expect(pol.readDenyPaths).toContain("/sbxroot/home/x/.local/state/junco");
    expect(pol.readDenyPaths).toContain("/sbxroot/extra/secret");
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
      stateDir: "/sbxroot/state",
      network: false,
      botGhConfigDir: "/sbxroot/home/.config/junco/gh",
    });
    expect(p.readDenyPaths).toContain("/sbxroot/home/.config/junco/gh");
  });
});
