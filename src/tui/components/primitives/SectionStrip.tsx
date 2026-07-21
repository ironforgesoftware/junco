import React from "react";
import { Box, Text } from "ink";
import { theme } from "../../theme.js";

/** One-row section band: a hover-tinted strip carrying a bold accent label plus
 * an optional dim extra (counts, a poll heartbeat). The narrative sibling of
 * TableHeader — same visual language, no columns. One row in, one row out, so
 * callers that window a flat row array keep their arithmetic. */
export function SectionStrip({
  label,
  extra,
}: {
  label: string;
  extra?: React.JSX.Element | null;
}): React.JSX.Element {
  return (
    <Box width="100%" backgroundColor={theme.hoverBg} overflow="hidden">
      <Text bold color={theme.accent}>
        {label}
      </Text>
      {extra ?? null}
    </Box>
  );
}
