import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { Box, Text } from "ink";
import { render, cleanup } from "ink-testing-library";
import { MouseProvider, useOnMouseMiss, useOnAnyMousePress } from "../src/tui/MouseProvider.js";
import { ClickableBox } from "../src/tui/ClickableBox.js";
import { until } from "./helpers/until.js";

afterEach(cleanup);

const press = (x: number, y: number) => `[<0;${x + 1};${y + 1}M`;
const move = (x: number, y: number) => `[<35;${x + 1};${y + 1}M`;
const wheelDown = (x: number, y: number) => `[<65;${x + 1};${y + 1}M`;
const drag = (x: number, y: number) => `[<32;${x + 1};${y + 1}M`;
const release = (x: number, y: number) => `[<0;${x + 1};${y + 1}m`;

function Rows({
  onA,
  onB,
  onWheel,
}: {
  onA: () => void;
  onB: () => void;
  onWheel?: (d: 1 | -1) => void;
}) {
  return (
    <MouseProvider>
      <ClickableBox onWheel={onWheel} flexDirection="column">
        <ClickableBox onPress={onA}>
          {(hovered) => <Text>{hovered ? "A*" : "A"}</Text>}
        </ClickableBox>
        <ClickableBox onPress={onB}>
          <Text>B</Text>
        </ClickableBox>
      </ClickableBox>
    </MouseProvider>
  );
}

/** A 3×4 press-and-drag target (the Scrollbar's shape) under a one-row header,
 * so the region's rect starts at y=1 and local ≠ absolute coordinates. */
function Bar({
  onPressAt,
  onDrag,
  onMiss,
}: {
  onPressAt: (x: number, y: number) => void;
  onDrag: (x: number, y: number) => void;
  onMiss: () => void;
}) {
  function Inner() {
    useOnMouseMiss(onMiss);
    return (
      <Box flexDirection="column">
        <Text>hdr</Text>
        <ClickableBox onPressAt={onPressAt} onDrag={onDrag} flexDirection="column" width={3}>
          {["r1", "r2", "r3", "r4"].map((t) => (
            <Text key={t}>{t}</Text>
          ))}
        </ClickableBox>
      </Box>
    );
  }
  return (
    <MouseProvider>
      <Inner />
    </MouseProvider>
  );
}

describe("ClickableBox + MouseProvider", () => {
  it("press dispatches to the row under the pointer (deepest region)", async () => {
    const onA = vi.fn();
    const onB = vi.fn();
    const r = render(<Rows onA={onA} onB={onB} />);
    await until(() => (r.lastFrame() ?? "").includes("B"));
    r.stdin.write(press(0, 0));
    await until(() => onA.mock.calls.length === 1);
    r.stdin.write(press(0, 1));
    await until(() => onB.mock.calls.length === 1);
    expect(onA).toHaveBeenCalledTimes(1);
  });

  it("wheel bubbles to the nearest ancestor with onWheel", async () => {
    const onWheel = vi.fn();
    const r = render(<Rows onA={() => {}} onB={() => {}} onWheel={onWheel} />);
    await until(() => (r.lastFrame() ?? "").includes("B"));
    r.stdin.write(wheelDown(0, 0)); // over row A, which has no onWheel
    await until(() => onWheel.mock.calls.length === 1);
    expect(onWheel).toHaveBeenCalledWith(1);
  });

  it("hover: render-prop children see the hover flag flip", async () => {
    const r = render(<Rows onA={() => {}} onB={() => {}} />);
    await until(() => (r.lastFrame() ?? "").includes("A"));
    r.stdin.write(move(0, 0));
    await until(() => (r.lastFrame() ?? "").includes("A*"));
    r.stdin.write(move(0, 1));
    await until(() => !(r.lastFrame() ?? "").includes("A*"));
  });

  it("miss handler fires on a press outside every region; press observer fires on every press", async () => {
    const onMiss = vi.fn();
    const onAny = vi.fn();
    function App() {
      useOnMouseMiss(onMiss);
      useOnAnyMousePress(onAny);
      return (
        <ClickableBox onPress={() => {}}>
          <Text>hit</Text>
        </ClickableBox>
      );
    }
    const r = render(
      <MouseProvider>
        <App />
      </MouseProvider>,
    );
    await until(() => (r.lastFrame() ?? "").includes("hit"));
    r.stdin.write(press(0, 0)); // on the region
    r.stdin.write(press(50, 10)); // off it
    await until(() => onMiss.mock.calls.length === 1);
    expect(onAny).toHaveBeenCalledTimes(2);
  });

  it("onPressAt reports the cell INSIDE the region, is not a miss, and arms the drag capture", async () => {
    const onPressAt = vi.fn();
    const onDrag = vi.fn();
    const onMiss = vi.fn();
    const r = render(<Bar onPressAt={onPressAt} onDrag={onDrag} onMiss={onMiss} />);
    await until(() => (r.lastFrame() ?? "").includes("r4"));
    // The bar occupies rows 1..4 (row 0 is the header), columns 0..2.
    r.stdin.write(press(1, 3));
    await until(() => onPressAt.mock.calls.length === 1);
    expect(onPressAt).toHaveBeenCalledWith(1, 2);
    // A region that answers presses is never a miss, even with no `onPress`.
    expect(onMiss).not.toHaveBeenCalled();
    // The capture holds while the pointer wanders off the bar — the far corner
    // clamps to the bar's own last row/column, which is what makes a drag past
    // the bottom of the track scroll to the end rather than stop dead.
    r.stdin.write(drag(40, 20));
    await until(() => onDrag.mock.calls.length === 1);
    expect(onDrag).toHaveBeenCalledWith(2, 3);
    // Release drops the capture: further motion belongs to nobody.
    r.stdin.write(release(1, 2));
    r.stdin.write(drag(1, 1));
    await new Promise((res) => setTimeout(res, 50));
    expect(onDrag).toHaveBeenCalledTimes(1);
  });

  it("drag: nothing captured (or the press missed every region) dispatches nothing", async () => {
    const onDrag = vi.fn();
    const onMiss = vi.fn();
    const r = render(<Bar onPressAt={() => {}} onDrag={onDrag} onMiss={onMiss} />);
    await until(() => (r.lastFrame() ?? "").includes("r4"));
    r.stdin.write(drag(1, 2)); // no press first: nothing is captured
    r.stdin.write(press(40, 20)); // a press that hits nothing captures nothing
    await until(() => onMiss.mock.calls.length === 1);
    r.stdin.write(drag(1, 2));
    await new Promise((res) => setTimeout(res, 50));
    expect(onDrag).not.toHaveBeenCalled();
  });

  it("drags coalesce per stdin chunk: only the final position of a burst dispatches", async () => {
    const onDrag = vi.fn();
    const r = render(<Bar onPressAt={() => {}} onDrag={onDrag} onMiss={() => {}} />);
    await until(() => (r.lastFrame() ?? "").includes("r4"));
    r.stdin.write(press(0, 1) + drag(0, 2) + drag(0, 3) + drag(0, 4));
    await until(() => onDrag.mock.calls.length === 1);
    expect(onDrag).toHaveBeenCalledWith(0, 3); // the last row of the burst
    expect(onDrag).toHaveBeenCalledTimes(1);
  });

  it("without a MouseProvider it renders as a plain Box: no crash, no dispatch, no hover", async () => {
    const onPress = vi.fn();
    const r = render(
      <ClickableBox onPress={onPress}>
        {(hovered) => <Text>{hovered ? "H*" : "H"}</Text>}
      </ClickableBox>,
    );
    await until(() => (r.lastFrame() ?? "").includes("H"));
    r.stdin.write(press(0, 0)); // nothing is listening — must not throw or dispatch
    r.stdin.write(move(0, 0)); // nor flip hover
    // Negative assertions: give any (buggy) listener a bounded window to act.
    await new Promise((res) => setTimeout(res, 50));
    expect(onPress).not.toHaveBeenCalled();
    expect(r.lastFrame()).toContain("H");
    expect(r.lastFrame()).not.toContain("H*");
  });
});
