import React from "react";
import { Box, Text } from "ink";
import type { Layout } from "../layout.js";
import type { TerminalSize } from "../useTerminalSize.js";
import type { ToastKind } from "../theme.js";
import { Footer } from "./Chrome.js";
import type { FooterRows } from "../footerModel.js";
import { Center } from "./Modal.js";

/** The fullscreen frame: header row, body (panes OR centered modal OR
 * too-small guidance), then the two footer rows (spec 2026-09-02 §3 — a live
 * toast paints over the actions row instead of claiming one of its own).
 * Exactly size.rows tall. */
export function Workspace({
  size,
  layout,
  header,
  toast,
  footer,
  chipActions,
  modal,
  modalAlign = "center",
  children,
}: {
  size: TerminalSize;
  layout: Layout;
  header: React.ReactNode;
  toast: { kind: ToastKind; text: string } | null;
  /** The two footer rows (footerModel.buildFooterRows). */
  footer: FooterRows;
  /** Chip click handlers — pill/mnemonic chips by ID, structural by KEY.
   * Wired through unconditionally, modal or not: an open modal's footer IS
   * that modal's own context (palette/addRepo/help are structuralOnly; a
   * confirm empties the handlers), so there is nothing of the surface
   * underneath left to click — see hooks/useFooterBindings.ts, Ruling R6'.
   * Blanket-disarming here instead would also kill the palette's own ⏎ run. */
  chipActions?: Record<string, () => void>;
  modal: React.ReactNode | null;
  /** Vertical alignment for the modal body — "top" for modals taller than
   * common terminal heights, where centering would clip the title. */
  modalAlign?: "center" | "top";
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Box flexDirection="column" width={size.columns} height={size.rows}>
      {header}
      {/* Fixed `height` + `overflow="hidden"` are both load-bearing (#463): a
          body taller than its band — the 21-command palette at 30 rows — grew
          this Box past its share under `flexGrow`, pushing the footer off the
          frame and painting the modal's bottom border over the actions row. It
          used to bleed invisibly into the blank toast row #457 removed.
          `layout.bodyRows` is `rows - CHROME_ROWS`, i.e. exactly the band left
          between the 1-row header and the 2-row footer. */}
      <Box height={layout.bodyRows} overflow="hidden">
        {layout.mode === "tooSmall" ? (
          <Center>
            <Text dimColor>terminal too small — junco needs at least 60×14</Text>
          </Center>
        ) : modal !== null ? (
          <Center align={modalAlign}>{modal}</Center>
        ) : (
          children
        )}
      </Box>
      <Footer rows={footer} toast={toast} chipActions={chipActions} />
    </Box>
  );
}
