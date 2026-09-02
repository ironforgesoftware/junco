import { describe, it, expect } from "vitest";
import type { Result } from "../src/types.js";
import type { ApplyOutcome } from "../src/applyPatch.js";
import type { WizardIoResult } from "../src/wizard.js";
import { recordRun } from "../src/assessHistory.js";

// #359: seven ad-hoc result unions spelled their failure message three ways
// (`reason`, `error`, `errors`). The adopters below now share one shape, and
// these are compile-time pins — `npm run typecheck` covers tests/, so a drift
// back to a bespoke union fails the gate rather than this run.
type Failure<R> = Extract<R, { ok: false }>;

const wizardFailure: Failure<WizardIoResult> = { ok: false, error: "config unreadable" };
const applyFailure: Failure<ApplyOutcome> = { ok: false, error: "conflict", refused: false };
const assessFailure: Failure<Parameters<typeof recordRun>[2]> = {
  ok: false,
  at: "2026-09-01T00:00:00.000Z",
  error: "boom",
};

// The shared failure arm carries a plain message and nothing else: a
// `reason`-shaped union member must NOT satisfy it. (planCompiler's
// `errors[]` and unwatchCmd's refusal enum keep their own types on purpose —
// their failure payloads are structured, not a message.)
const _reasonShaped: { ok: false; reason: string } = { ok: false, reason: "conflict" };
// @ts-expect-error the shared failure arm has no `reason`
const _rejected: Failure<Result<number>> = _reasonShaped;

describe("shared Result<T> (#359)", () => {
  it("spells every adopted failure's message `error`", () => {
    expect([wizardFailure.error, applyFailure.error, assessFailure.error]).toEqual([
      "config unreadable",
      "conflict",
      "boom",
    ]);
  });

  it("keeps each adopter's extra failure context alongside the message", () => {
    // applyPatch's `refused` decides whether prFlow may escalate to the agent;
    // assessHistory stamps `at` on both arms.
    expect(applyFailure.refused).toBe(false);
    expect(assessFailure.at).toBe("2026-09-01T00:00:00.000Z");
  });
});
