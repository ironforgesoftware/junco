// tests/helpers/until.ts — shared bounded loop-until-condition for the TUI suites.
//
// Never assert one fixed setTimeout tick after a state change: a loaded CI
// runner can delay React's commit past any fixed delay (this exact flake class
// burned a release gate once). Poll the observable condition with a bounded
// retry instead; the final iteration asserts so a genuine failure still fails.
import { expect } from "vitest";

export async function until(cond: () => boolean, tries = 50): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  expect(cond()).toBe(true); // final assert with a real failure message
}
