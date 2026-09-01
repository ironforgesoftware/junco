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

/** Resolve after `ms` — a plain sleep for the few tests that need a fixed delay. */
export const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * One keystroke's settle window. A single native `data` event (one
 * `stdin.write` call) is one keypress, and Ink schedules its resulting state
 * update as a React "discrete" update — a SECOND write issued before that
 * update has committed can race a stale closure (confirmed empirically:
 * chained writes with no tick between them silently dropped keystrokes).
 * Every multi-key `press()` helper in the suite ticks between writes.
 */
export const tick = (): Promise<void> => wait(30);

/**
 * Press `key` repeatedly — but only while `fromMarker` is still showing —
 * until `toMarker` appears. Plain `press()` + `until()` is unsafe for one
 * specific transition in the wizard walkthroughs: the Model chapter's "pick"
 * step (see src/tui/wizard/chapters/Model.tsx) is the only step in the whole
 * flow mounted from a bare Promise `.then()` (the `probe` effect's
 * `io.discoverModels().then(...)`) rather than from a keystroke handler,
 * which Ink wraps in `reconciler.discreteUpdates` (src/hooks/use-input.js in
 * ink) and flushes synchronously. A step mounted off-cycle like this can
 * still be rendering (its marker text visible via lastFrame()) a tick before
 * its own `useInput` effect has subscribed to Ink's internal input emitter —
 * and that emitter is fire-and-forget: a keystroke arriving in that gap is
 * dropped for good, no replay, so a plain `until()` afterward would spin
 * until it exhausts its whole budget no matter how generous. Confirmed by
 * capturing the exact pre/post frames on a reproduced stall: they were
 * byte-for-byte identical, i.e. the Enter never reached the Select at all.
 * Resending is safe specifically because every resend is gated on still
 * seeing `fromMarker`: a first press that landed but just hasn't rendered
 * yet is never double-submitted, since we stop the instant `toMarker` shows.
 * (fireUntil's sibling: same rationale, with the re-send additionally gated
 * on the source step being on screen.)
 */
export async function pressUntilAdvanced(
  stdin: { write: (s: string) => void },
  key: string,
  lastFrame: () => string | undefined,
  fromMarker: string,
  toMarker: string,
  tries = UNTIL_TRIES,
): Promise<void> {
  for (let i = 0; i < tries; i++) {
    const frame = lastFrame() ?? "";
    if (frame.includes(toMarker)) return;
    if (frame.includes(fromMarker)) stdin.write(key);
    await tick();
  }
  expect(lastFrame() ?? "").toContain(toMarker); // final assert with a real failure message
}
