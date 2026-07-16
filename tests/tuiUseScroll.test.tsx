import React from "react";
import { describe, it, expect, afterEach } from "vitest";
import { Text, useInput } from "ink";
import { render, cleanup } from "ink-testing-library";
import { useScroll } from "../src/tui/useScroll.js";
import { until } from "./helpers/until.js";

afterEach(cleanup);

/** A scroll surface in miniature: `total` rows in a `height`-row viewport,
 * reporting its own max during render exactly as the real components do. `]`
 * and `[` are the App's own scroll recipe. */
function Probe({ k, total, height }: { k: string; total: number; height: number }) {
  const { scroll, scrollBy, onScrollMax } = useScroll(k);
  onScrollMax(Math.max(0, total - height));
  useInput((input) => {
    if (input === "]") scrollBy(1);
    if (input === "[") scrollBy(-1);
  });
  return <Text>scroll={scroll}</Text>;
}

describe("useScroll", () => {
  it("stops at the bottom instead of scrolling past it", async () => {
    const r = render(<Probe k="a" total={8} height={4} />);
    await until(() => (r.lastFrame() ?? "").includes("scroll=0"));
    for (let i = 0; i < 10; i++) r.stdin.write("]");
    // max = 8 - 4 = 4, however many times you press.
    await until(() => (r.lastFrame() ?? "").includes("scroll=4"));
    expect(r.lastFrame()).toContain("scroll=4");
  });

  it("does not scroll at all when the content fits", async () => {
    const r = render(<Probe k="a" total={3} height={10} />);
    await until(() => (r.lastFrame() ?? "").includes("scroll=0"));
    for (let i = 0; i < 5; i++) r.stdin.write("]");
    await new Promise((res) => setTimeout(res, 40));
    expect(r.lastFrame()).toContain("scroll=0");
  });

  it("clamps at the top", async () => {
    const r = render(<Probe k="a" total={8} height={4} />);
    await until(() => (r.lastFrame() ?? "").includes("scroll=0"));
    for (let i = 0; i < 5; i++) r.stdin.write("[");
    await new Promise((res) => setTimeout(res, 40));
    expect(r.lastFrame()).toContain("scroll=0");
  });

  it("resets to the top when the key changes", async () => {
    const r = render(<Probe k="a" total={8} height={4} />);
    r.stdin.write("]");
    await until(() => (r.lastFrame() ?? "").includes("scroll=1"));
    r.rerender(<Probe k="b" total={8} height={4} />);
    await until(() => (r.lastFrame() ?? "").includes("scroll=0"));
  });

  it("keeps the offset when the key is unchanged", async () => {
    const r = render(<Probe k="a" total={8} height={4} />);
    r.stdin.write("]");
    await until(() => (r.lastFrame() ?? "").includes("scroll=1"));
    r.rerender(<Probe k="a" total={8} height={4} />);
    await new Promise((res) => setTimeout(res, 40));
    expect(r.lastFrame()).toContain("scroll=1");
  });

  it("a surface that shrinks under the offset self-heals on the next press", async () => {
    const r = render(<Probe k="a" total={8} height={4} />);
    for (let i = 0; i < 10; i++) r.stdin.write("]");
    await until(() => (r.lastFrame() ?? "").includes("scroll=4"));
    // Same surface (same key), fewer rows: max is now 0. The next press must
    // renormalize rather than step down from the stale 4.
    r.rerender(<Probe k="a" total={4} height={4} />);
    r.stdin.write("]");
    await until(() => (r.lastFrame() ?? "").includes("scroll=0"));
  });
});
