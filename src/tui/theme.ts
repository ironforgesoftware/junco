/** "Slate & rose" — the junco palette (slate bird, pink bill). ONE accent;
 * structure tones are slate/gray; status colors stay semantic (state.ts).
 * Hex passes through chalk, which downsamples on 256/16-color terminals and
 * honors NO_COLOR (the ▌ selection glyph keeps selection legible colorless). */
export const theme = {
  accent: "#eb6f92",
  selectionBg: "#2a2e3a",
  border: "gray",
  success: "green",
  warn: "yellow",
  error: "red",
  info: "cyan",
} as const;

export type ToastKind = "info" | "success" | "error";

export function toastColor(k: ToastKind): string {
  return k === "error" ? theme.error : k === "success" ? theme.success : theme.info;
}
