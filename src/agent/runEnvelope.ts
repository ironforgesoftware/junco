/**
 * runEnvelope — the single wrapper every junco agent run goes through.
 *
 * Grows over this plan into: guard construction (this task), transcript
 * lifecycle + junco_run records, the runAgent call, and spend recording —
 * replacing the five hand-copied wrappers (runOnce Q&A, assessFlow,
 * analyzeFlow, prFlow main, prFlow corrective) whose parity previously
 * rested on comments (#180.3).
 */
import type { Config } from "../types.js";
import { GuardManager, type GuardManagerOptions } from "./guardManager.js";

/** The four supervisor knobs, mapped verbatim — one site instead of five. */
export function guardOptionsFromConfig(cfg: Config): GuardManagerOptions {
  return {
    supervisorConfig: {
      budgetPerKind: cfg.supervisorBudgetPerKind,
      escalationWindowTurns: cfg.supervisorEscalationWindow,
    },
    outputBudgetPerTurn: cfg.supervisorOutputBudgetPerTurn,
    outputBudgetPostCommit: cfg.supervisorOutputBudgetPostCommit,
  };
}

export function buildGuardManager(cfg: Config): GuardManager | undefined {
  return cfg.supervisorEnabled ? new GuardManager(guardOptionsFromConfig(cfg)) : undefined;
}
