import React from "react";
import { Text, useAnimation } from "ink";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Braille spinner on Ink's shared animation timer (ink 7.1 useAnimation):
 * every mounted spinner ticks from ONE interval, coalesced with Ink's render
 * throttle, so N spinners cost one commit per tick — not N — and a spinner
 * never schedules a commit inside a throttled window. ~10fps, cyan. */
export function Spinner(): React.JSX.Element {
  const { frame } = useAnimation({ interval: 100 });
  return <Text color="cyan">{FRAMES[frame % FRAMES.length]}</Text>;
}

export const SPINNER_FRAMES = FRAMES;
