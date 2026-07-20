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
function Probe({
  k,
  total,
  height,
  report = true,
}: {
  k: string;
  total: number;
  height: number;
  /** When false the surface never reports its max — proves `toEnd()` reads the
   * (unreported) `maxRef`, which is 0 until a render reports it. */
  report?: boolean;
}) {
  const { scroll, scrollBy, onScrollMax, toEnd } = useScroll(k);
  if (report) onScrollMax(Math.max(0, total - height));
  useInput((input) => {
    if (input === "]") scrollBy(1);
    if (input === "[") scrollBy(-1);
    if (input === "e") toEnd();
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

  it("toEnd() jumps to the last-reported max", async () => {
    const r = render(<Probe k="a" total={8} height={4} />); // max = 8 - 4 = 4
    await until(() => (r.lastFrame() ?? "").includes("scroll=0"));
    r.stdin.write("e");
    await until(() => (r.lastFrame() ?? "").includes("scroll=4"));
    expect(r.lastFrame()).toContain("scroll=4");
  });

  it("toEnd() renormalizes to a shorter surface's max after a key change", async () => {
    const r = render(<Probe k="a" total={8} height={4} />); // max 4
    r.stdin.write("e");
    await until(() => (r.lastFrame() ?? "").includes("scroll=4"));
    // New content (key change) resets the offset AND maxRef; the shorter
    // surface reports max=2, so toEnd must land at 2, never the stale 4.
    r.rerender(<Probe k="b" total={6} height={4} />); // max 2
    await until(() => (r.lastFrame() ?? "").includes("scroll=0"));
    r.stdin.write("e");
    await until(() => (r.lastFrame() ?? "").includes("scroll=2"));
    expect(r.lastFrame()).toContain("scroll=2");
  });

  it("toEnd() is a no-op at 0 until the surface reports a max", async () => {
    // The surface never reports (report=false), so maxRef stays 0: toEnd lands
    // at 0 rather than jumping anywhere.
    const r = render(<Probe k="a" total={8} height={4} report={false} />);
    await until(() => (r.lastFrame() ?? "").includes("scroll=0"));
    r.stdin.write("e");
    await new Promise((res) => setTimeout(res, 40));
    expect(r.lastFrame()).toContain("scroll=0");
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
