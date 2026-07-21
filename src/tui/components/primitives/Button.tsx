import React from "react";
import { Text } from "ink";
import { theme } from "../../theme.js";
import { ClickableBox } from "../../ClickableBox.js";

export type ButtonTone = "danger" | "neutral" | "primary";

/** Clickable dialog button. Toned buttons are pills (colored background,
 * black text); neutral is dim brackets with the key in accent. NO_COLOR keeps
 * the bracket/pad structure and bold key. */
export function Button({
  keyHint,
  label,
  tone,
  onPress,
}: {
  keyHint: string;
  label: string;
  tone: ButtonTone;
  onPress?: () => void;
}): React.JSX.Element {
  const bg = tone === "danger" ? theme.error : tone === "primary" ? theme.accent : undefined;
  const body =
    bg !== undefined ? (
      <Text backgroundColor={bg} color="black">
        {" "}
        <Text bold>{keyHint}</Text> {label}{" "}
      </Text>
    ) : (
      <Text>
        <Text dimColor>[ </Text>
        <Text bold color={theme.accent}>
          {keyHint}
        </Text>
        <Text> {label}</Text>
        <Text dimColor> ]</Text>
      </Text>
    );
  return (
    <ClickableBox onPress={onPress} hoverBg={theme.hoverBg}>
      {body}
    </ClickableBox>
  );
}
