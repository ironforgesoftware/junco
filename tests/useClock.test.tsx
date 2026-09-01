// tests/useClock.test.tsx
import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { useClock } from "../src/tui/hooks/useClock.js";
import { until } from "./helpers/until.js";

function Probe({ ms }: { ms: number }): React.JSX.Element {
  const now = useClock(ms);
  return <Text>{String(now.getTime())}</Text>;
}

describe("useClock", () => {
  it("starts at mount time and advances on its own interval", async () => {
    const before = Date.now();
    const r = render(<Probe ms={15} />);
    const first = Number(r.lastFrame());
    expect(first).toBeGreaterThanOrEqual(before);
    await until(() => Number(r.lastFrame()) > first);
    r.unmount();
  });

  it("a frozen interval never ticks", async () => {
    const r = render(<Probe ms={999_999} />);
    const first = r.lastFrame();
    await new Promise((res) => setTimeout(res, 60));
    expect(r.lastFrame()).toBe(first);
    r.unmount();
  });
});
