import React from "react";
import { describe, it, expect } from "vitest";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { useFollowLatch, type FollowLatch } from "../src/tui/useFollowLatch.js";
import { until } from "./helpers/until.js";

function mount(follow: boolean): {
  latch: () => FollowLatch;
  log: string[];
  rerender: (follow: boolean) => void;
} {
  const log: string[] = [];
  let latch!: FollowLatch;
  function Probe({ follow }: { follow: boolean }): React.JSX.Element {
    latch = useFollowLatch(follow, {
      pause: () => log.push("pause"),
      resume: () => log.push("resume"),
    });
    return <Text>{follow ? "on" : "off"}</Text>;
  }
  const r = render(<Probe follow={follow} />);
  return { latch: () => latch, log, rerender: (f) => r.rerender(<Probe follow={f} />) };
}

describe("useFollowLatch", () => {
  it("pauses once per closure, however many presses replay inside it", () => {
    const m = mount(true);
    expect(m.latch().pause()).toBe(true);
    expect(m.latch().pause()).toBe(false);
    expect(m.latch().pause()).toBe(false);
    expect(m.log).toEqual(["pause"]);
  });

  it("does nothing while follow is off, and re-arms from the next render's value", async () => {
    const m = mount(false);
    expect(m.latch().pause()).toBe(false);
    expect(m.log).toEqual([]);
    m.rerender(true);
    await until(() => m.latch().pause() === true);
    expect(m.log).toEqual(["pause"]);
  });

  it("resume re-arms the latch inside the same closure (a replayed ff: off, on, off)", () => {
    const m = mount(true);
    m.latch().pause();
    m.latch().resume();
    expect(m.latch().pause()).toBe(true);
    expect(m.log).toEqual(["pause", "resume", "pause"]);
  });
});
