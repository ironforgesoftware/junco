import type { Segment } from "./footerModel.js";

/** "Slate & rose" — the junco palette (slate bird, pink bill). ONE accent;
 * structure tones are slate/gray; status colors stay semantic (state.ts).
 * Hex passes through chalk, which downsamples on 256/16-color terminals and
 * honors NO_COLOR (the ▌ selection glyph keeps selection legible colorless). */
export const theme = {
  accent: "#eb6f92",
  selectionBg: "#2a2e3a",
  hoverBg: "#20242f",
  border: "gray",
  success: "green",
  warn: "yellow",
  error: "red",
  info: "cyan",
  /** Footer structural keycaps (spec 2026-09-02 §3.4): a muted slate fill…  */
  keycapBg: "#3b4261",
  /** …and its own light foreground. Stated, not inherited (#465): the keycap
   * used to draw the terminal's DEFAULT text on that dark fill, which on a
   * light terminal theme is dark-on-dark — the structural keys, the one part
   * of the bar that is identical in every view, became the unreadable part. */
  keycapFg: "#c0caf5",
  /** Text on the accent-filled chat pill — the dark terminal ground. */
  pillFg: "#16161e",
} as const;

/** The footer's ONE segment → colour mapping (spec §3.4), so the renderer and
 * the tests read the same table: frames carry no ANSI off a TTY, which makes
 * this the only place a test can see what `Chrome.tsx` paints. Both filled
 * kinds state a foreground AND a background; the rest inherit, which is
 * correct for them — they sit on the terminal's own ground. */
export function segmentColors(s: Segment): { color?: string; backgroundColor?: string } {
  if (s.pill) return { color: theme.pillFg, backgroundColor: theme.accent };
  if (s.keycap) return { color: theme.keycapFg, backgroundColor: theme.keycapBg };
  return s.accent ? { color: theme.accent } : {};
}

export type ToastKind = "info" | "success" | "error";

export function toastColor(k: ToastKind): string {
  return k === "error" ? theme.error : k === "success" ? theme.success : theme.info;
}
