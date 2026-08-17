import { describe, it, expect } from "vitest";
import { guardOptionsFromConfig, buildGuardManager } from "../src/agent/runEnvelope.js";
import { makeConfig, type ConfigSeams } from "./helpers/config.js";

// makeConfig requires the ten ConfigSeams explicitly (see tests/helpers/config.ts) —
// supervisorEnabled is a seam, the other four supervisor knobs are ballast overrides.
const seams: ConfigSeams = {
  dataDir: "/sbxroot/data",
  queueRoot: "/sbxroot/queue",
  worktreeRoot: "/sbxroot/wts",
  tools: [],
  criticEnabled: false,
  planLintEnabled: false,
  verifyEnabled: false,
  supervisorEnabled: true,
  healthEnabled: false,
  removeWorktreeOnSuccess: true,
};

describe("guardOptionsFromConfig", () => {
  it("threads the four supervisor knobs verbatim", () => {
    const cfg = makeConfig(seams, {
      supervisorBudgetPerKind: 2,
      supervisorEscalationWindow: 5,
      supervisorOutputBudgetPerTurn: 9000,
      supervisorOutputBudgetPostCommit: 18000,
    });
    expect(guardOptionsFromConfig(cfg)).toEqual({
      supervisorConfig: { budgetPerKind: 2, escalationWindowTurns: 5 },
      outputBudgetPerTurn: 9000,
      outputBudgetPostCommit: 18000,
    });
  });
});

describe("buildGuardManager", () => {
  it("returns undefined when the supervisor is disabled", () => {
    expect(buildGuardManager(makeConfig({ ...seams, supervisorEnabled: false }))).toBeUndefined();
  });
  it("returns a GuardManager when enabled", () => {
    const gm = buildGuardManager(makeConfig({ ...seams, supervisorEnabled: true }));
    expect(gm).toBeDefined();
    expect(gm!.supervisorSummary).toBe("no nudges issued");
  });
});
