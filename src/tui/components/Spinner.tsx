import React, { useEffect, useState } from "react";
import { Text } from "ink";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Hand-rolled braille spinner (no new deps) — ~10fps, cyan. */
export function Spinner(): React.JSX.Element {
  const [i, setI] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setI((n) => (n + 1) % FRAMES.length), 100);
    return () => clearInterval(id);
  }, []);
  return <Text color="cyan">{FRAMES[i]}</Text>;
}

export const SPINNER_FRAMES = FRAMES;
