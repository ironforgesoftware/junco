// tests/tuiUseMouse.test.tsx
import { describe, it, expect } from "vitest";
import React from "react";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { useMouse } from "../src/tui/useMouse.js";
import type { MouseEvent } from "../src/tui/mouse.js";

async function until(cond: () => boolean, tries = 50): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  expect(cond()).toBe(true);
}

function Probe({ events }: { events: MouseEvent[] }): React.JSX.Element {
  useMouse((ev) => events.push(ev));
  return <Text>probe</Text>;
}

describe("useMouse", () => {
  it("enables reporting, delivers parsed events, disables on unmount", async () => {
    const events: MouseEvent[] = [];
    const r = render(<Probe events={events} />);
    await until(() => r.stdout.frames.some((f) => f.includes("probe")));
    // Mount wrote the enable sequence to stdout.
    expect(r.stdout.frames.some((f) => f.includes("\u001b[?1000;1006h"))).toBe(true);
    r.stdin.write("\u001b[<0;30;4M");
    await until(() => events.length === 1);
    expect(events[0]).toEqual({ kind: "press", x: 29, y: 3 });
    r.unmount();
    await until(() => r.stdout.frames.some((f) => f.includes("\u001b[?1000;1006l")));
  });

  it("multiple events in one chunk all arrive, in order", async () => {
    const events: MouseEvent[] = [];
    const r = render(<Probe events={events} />);
    await until(() => r.stdout.frames.some((f) => f.includes("probe")));
    r.stdin.write("\u001b[<64;1;1M\u001b[<65;1;1M");
    await until(() => events.length === 2);
    expect(events.map((e) => e.kind)).toEqual(["wheelUp", "wheelDown"]);
    r.unmount();
  });
});
