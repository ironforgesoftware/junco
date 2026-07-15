/**
 * SGR mouse protocol (DECSET 1000 click+wheel, 1003 any-motion, 1006 SGR
 * encoding). The dashboard writes MOUSE_ENABLE on mount, parses stdin chunks
 * for `ESC[<b;x;yM|m`, and restores with MOUSE_DISABLE.
 * Reference: xterm ctlseqs "SGR (1006)" / "Any-event tracking (1003)".
 */

export const MOUSE_ENABLE = "\u001b[?1000;1003;1006h";
export const MOUSE_DISABLE = "\u001b[?1000;1003;1006l";

export type MouseEventKind = "press" | "release" | "wheelUp" | "wheelDown" | "move";

export interface MouseEvent {
  kind: MouseEventKind;
  /** 0-based terminal cell (the wire format is 1-based). */
  x: number;
  y: number;
}

const SGR = /\u001b\[<(\d+);(\d+);(\d+)([Mm])/g;

/** Every SGR mouse event in a stdin chunk (one chunk may carry several).
 * Left button, wheel, and button-less motion; right/middle and drag-motion are dropped.
 * Wheel is bit 64 with the low bit picking the direction. Malformed sequences never throw
 * — they simply don't match. */
export function parseMouse(data: string): MouseEvent[] {
  const out: MouseEvent[] = [];
  for (const m of data.matchAll(SGR)) {
    const b = Number(m[1]);
    const x = Number(m[2]) - 1;
    const y = Number(m[3]) - 1;
    if (b & 64) {
      out.push({ kind: (b & 1) === 0 ? "wheelUp" : "wheelDown", x, y });
    } else if (b & 32) {
      // Motion (1003). Button bits 3 = no button held → hover move; a held
      // button (drag, bits 0-2) stays dropped like right/middle clicks.
      if ((b & 3) === 3) out.push({ kind: "move", x, y });
    } else if ((b & 3) === 0) {
      out.push({ kind: m[4] === "M" ? "press" : "release", x, y });
    }
  }
  return out;
}

/** True when a `useInput` string is a leaked mouse sequence: with reporting
 * enabled, ink parses `ESC[<b;x;yM` as one CSI keypress, strips the ESC, and
 * hands "[<b;x;yM" to handlers — which would otherwise land in text fields.
 * useGuardedInput drops these; MouseProvider owns the real events via stdin. */
export function isMouseInput(input: string): boolean {
  return /^\[<\d+;\d+;\d+[Mm]/.test(input);
}
