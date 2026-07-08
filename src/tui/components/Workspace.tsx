import React from "react";
import { Box, Text } from "ink";
import type { Layout } from "../layout.js";
import type { TerminalSize } from "../useTerminalSize.js";
import type { ToastKind } from "../theme.js";
import { Toast, Footer } from "./Chrome.js";
import { Center } from "./Modal.js";

/** The fullscreen frame: header row, body (panes OR centered modal OR
 * too-small guidance), reserved toast row, footer row. Exactly size.rows tall. */
export function Workspace({
  size,
  layout,
  header,
  toast,
  hints,
  modal,
  modalAlign = "center",
  children,
}: {
  size: TerminalSize;
  layout: Layout;
  header: React.ReactNode;
  toast: { kind: ToastKind; text: string } | null;
  hints: [string, string][];
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
      <Toast toast={toast} />
      <Footer hints={hints} />
    </Box>
  );
}
