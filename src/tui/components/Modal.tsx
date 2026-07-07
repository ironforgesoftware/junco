import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.js";

/** Centering wrapper for the body area (Ink has no z-axis; modals replace the
 * body rather than floating over it — header/footer stay visible around them).
 * `align="top"` anchors the modal to the top instead — for modals taller than
 * common terminal heights, centering clips BOTH ends (title and footer alike);
 * top alignment guarantees the title survives, clipping only the bottom. */
export function Center({
  children,
  align = "center",
}: {
  children: React.ReactNode;
  align?: "center" | "top";
}): React.JSX.Element {
  return (
    <Box
      flexGrow={1}
      justifyContent="center"
      alignItems={align === "top" ? "flex-start" : "center"}
    >
      {children}
    </Box>
  );
}

export function Modal({
  title,
  minWidth = 50,
  children,
}: {
  title: string;
  minWidth?: number;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor={theme.accent}
      paddingX={2}
      paddingY={1}
      minWidth={minWidth}
    >
      <Text bold color={theme.accent}>
        {title}
      </Text>
      {children}
    </Box>
  );
}
