// Covers tests/helpers/config.ts — the single Config fixture.
import { describe, it, expect } from "vitest";
import { makeConfig, READ_ONLY_TOOLS, type ConfigSeams } from "./helpers/config.js";

const seams: ConfigSeams = {
  dataDir: "/sbxroot/data",
  queueRoot: "/sbxroot/queue",
  worktreeRoot: "/sbxroot/wts",
  tools: [],
  criticEnabled: false,
  planLintEnabled: false,
  verifyEnabled: false,
  supervisorEnabled: false,
  healthEnabled: false,
  removeWorktreeOnSuccess: true,
};

describe("makeConfig", () => {
  it("returns the stated seams verbatim", () => {
    const c = makeConfig(seams);
    expect(c.dataDir).toBe("/sbxroot/data");
    expect(c.queueRoot).toBe("/sbxroot/queue");
    expect(c.worktreeRoot).toBe("/sbxroot/wts");
    expect(c.criticEnabled).toBe(false);
    expect(c.removeWorktreeOnSuccess).toBe(true);
  });

  it("fills the ballast keys", () => {
    const c = makeConfig(seams);
    expect(c.branchPrefix).toBe("junco/");
    expect(c.defaultBaseBranch).toBe("main");
    expect(c.maxTransientRetries).toBe(2);
    expect(c.legacy).toEqual({
      vaultRoot: false,
      stateDir: false,
      worktreeRoot: false,
      externalReposRoot: false,
    });
  });

  // A test that forgets to point ghBin at a fake must fail loudly, never reach
  // the maintainer's real authenticated gh — this repo is a live runtime.
  it("defaults ghBin to a non-existent path", () => {
    expect(makeConfig(seams).ghBin).toBe("/nonexistent/gh");
  });

  it("lets overrides win over ballast", () => {
    const c = makeConfig(seams, { branchPrefix: "x/", dailyBudgetUsd: 5, ghBin: "/tmp/fake-gh" });
    expect(c.branchPrefix).toBe("x/");
    expect(c.dailyBudgetUsd).toBe(5);
    expect(c.ghBin).toBe("/tmp/fake-gh");
  });

  it("exposes the read-only Q&A tool set", () => {
    expect(READ_ONLY_TOOLS).toEqual(["read", "grep", "find", "ls"]);
  });
});
