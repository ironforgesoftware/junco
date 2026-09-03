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
   * Ignored while a modal is open (Ruling R6): the footer renders BELOW the
   * modal rather than behind it, so its chips would otherwise stay clickable
   * through one — and under the help modal they are the chips of the surface
   * underneath (the log overlay), which made `? help` a trap. A modal owns the
   * pointer; the rows still render, they just stop resolving to handlers. */
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
      <Box flexGrow={1}>
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
      <Footer rows={footer} toast={toast} chipActions={modal === null ? chipActions : undefined} />
    </Box>
  );
}
