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
  /** Chip click handlers — pill/mnemonic chips by ID, structural by KEY. */
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
      <Footer rows={footer} toast={toast} chipActions={chipActions} />
    </Box>
  );
}
