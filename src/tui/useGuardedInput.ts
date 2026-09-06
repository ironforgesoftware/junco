/**
 * useInput minus leaked mouse CSI: with reporting enabled, ink parses each
 * SGR sequence as one keypress and hands "[<b;x;yM" to every handler. This
 * wrapper is the ONE place that drops them — every TUI input handler goes
 * through it (convention; MouseProvider owns the real events via stdin).
 *
 * It is also the one place a held key is put back together. Key auto-repeat
 * under load lands as ONE stdin chunk — "kkk" — and ink's parser splits a
 * chunk only at escape sequences and backspace bytes (`splitBackspaceBytes`,
 * node_modules/ink/build/input-parser.js), so useInput reports a single
 * keypress with `input === "kkk"`. No key branch matches that: every press in
 * the run vanished, which is why holding `j`/`k` on the rail or in the chat
 * felt like dropped scroll keys. A run of ONE repeated printable byte is
 * replayed as one call per byte; that shape is what auto-repeat produces and
 * what pasted prose never is (a chunk like "jk" stays whole — and unmatched —
 * as before). Text entry opts out with `text`: a field appending `input` from
 * its prop closure would keep one byte of the run.
 */
import { useInput, type Key } from "ink";
import { isMouseInput } from "./mouse.js";

export interface GuardedInputOptions {
  isActive?: boolean;
  /** The handler consumes typed text (a field): never split a chunk. */
  text?: boolean;
}

/** True for "kkk"-shaped input: two or more copies of one printable byte with
 * no modifier — a held key that auto-repeat coalesced into a single chunk. */
function isHeldKeyRun(input: string, key: Key): boolean {
  if (input.length < 2 || key.ctrl || key.meta) return false;
  const code = input.charCodeAt(0);
  if (code < 0x20 || code === 0x7f) return false;
  for (let i = 1; i < input.length; i++) if (input[i] !== input[0]) return false;
  return true;
}

export function useGuardedInput(
  handler: (input: string, key: Key) => void,
  options?: GuardedInputOptions,
): void {
  useInput(
    (input, key) => {
      if (isMouseInput(input)) return;
      if (!options?.text && isHeldKeyRun(input, key)) {
        for (const press of input) handler(press, key);
        return;
      }
      handler(input, key);
    },
    { isActive: options?.isActive },
  );
}
