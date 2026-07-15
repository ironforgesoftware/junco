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

/**
 * Fire a one-shot input sequence, retrying until an observable condition holds.
 * A mouse press/wheel can race a freshly-mounted ClickableBox's registration
 * effect under load: the event resolves to no region and is silently dropped,
 * and no amount of polling recovers a lost event. Re-sending it makes it land
 * once the region registers. The 50ms spacing guarantees a LANDED event's frame
 * commits before the next check, so `cond` flips and the loop stops before a
 * second event lands — safe only for idempotent / self-terminating sequences
 * (select-to-a-fixed-row, clamped wheel, a click that unmounts its own target,
 * a browser-open counted with `=== 1`). A missed event is a no-op.
 */
export async function fireUntil(
  stdin: { write: (s: string) => void },
  seq: string,
  cond: () => boolean,
  tries = 50,
): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (cond()) return;
    stdin.write(seq);
    await new Promise((r) => setTimeout(r, 50));
  }
  expect(cond()).toBe(true); // final assert with a real failure message
}
