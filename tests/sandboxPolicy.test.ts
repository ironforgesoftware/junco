import { describe, it, expect } from "vitest";
import { builtinDenyReadPaths, buildPolicy } from "../src/agent/sandbox/policy.js";

describe("builtinDenyReadPaths", () => {
  it("covers the standard secret locations under home", () => {
    const p = builtinDenyReadPaths("/home/x");
    expect(p).toContain("/home/x/.ssh");
    expect(p).toContain("/home/x/.aws");
    expect(p).toContain("/home/x/.config/gh");
    expect(p).toContain("/home/x/.gnupg");
    expect(p).toContain("/home/x/.pi");
  });
});

describe("buildPolicy", () => {
  const base = {
    cfg: {
      enabled: true,
      backend: "auto" as const,
      network: "deny" as const,
      extraDenyRead: ["/extra/secret"],
      extraAllowWrite: ["/extra/writable"],
    },
    cwd: "/work/tree",
    scratchDir: "/tmp/scratch1",
    home: "/home/x",
    stateDir: "/home/x/.local/state/junco",
    network: false,
  };

  it("writable roots = cwd + scratch + extras", () => {
    const pol = buildPolicy(base);
    expect(pol.writableRoots).toEqual(["/work/tree", "/tmp/scratch1", "/extra/writable"]);
  });

  it("read denials = builtins + stateDir + extras", () => {
    const pol = buildPolicy(base);
    expect(pol.readDenyPaths).toContain("/home/x/.ssh");
    expect(pol.readDenyPaths).toContain("/home/x/.local/state/junco");
    expect(pol.readDenyPaths).toContain("/extra/secret");
  });

  it("threads the network flag through", () => {
    expect(buildPolicy({ ...base, network: true }).network).toBe(true);
    expect(buildPolicy({ ...base, network: false }).network).toBe(false);
  });

  it("resolves relative/~ inputs to absolute", () => {
    const pol = buildPolicy({ ...base, cwd: "/work/../work/tree" });
    expect(pol.writableRoots[0]).toBe("/work/tree");
  });
});
