// tests/helpers/until.ts — shared bounded loop-until-condition for the TUI suites.
//
// Never assert one fixed setTimeout tick after a state change: a loaded CI
// runner can delay React's commit past any fixed delay (this exact flake class
// burned a release gate once). Poll the observable condition with a bounded
// retry instead; the final iteration asserts so a genuine failure still fails.
import { expect } from "vitest";

/**
 * Default poll budget: 150 × 20 ms = 3 s. The loop returns the instant the
 * condition holds, so a generous ceiling costs nothing on the passing path —
 * only a genuinely failing test pays it — while the old 1 s budget let a
 * React commit miss its window under full-suite CPU oversubscription (#365).
 */
export const UNTIL_TRIES = 150;

export async function until(cond: () => boolean, tries = UNTIL_TRIES): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  expect(cond()).toBe(true); // final assert with a real failure message
}

/**
 * Fire a one-shot input sequence, retrying until an observable condition holds.
 * A mouse press/wheel can race a freshly-mounted ClickableBox's registration
 * effect under load — and a KEYSTROKE can race a freshly-mounted useInput's
 * subscribe effect the same way (ink attaches input listeners in a passive
 * useEffect, ink/build/hooks/use-input.js:115-123, so a frame is visible
 * before any handler exists; ink-testing-library delivers stdin.write
 * synchronously). Either way the event is silently dropped, and no amount of
 * polling recovers a lost event. Re-sending it makes it land once the
 * effect runs. The 50ms spacing guarantees a LANDED event's frame
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
