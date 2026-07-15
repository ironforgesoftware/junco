import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { Text } from "ink";
import { render, cleanup } from "ink-testing-library";
import { MouseProvider, useOnMouseMiss, useOnAnyMousePress } from "../src/tui/MouseProvider.js";
import { ClickableBox } from "../src/tui/ClickableBox.js";
import { until } from "./helpers/until.js";

afterEach(cleanup);

const press = (x: number, y: number) => `[<0;${x + 1};${y + 1}M`;
const move = (x: number, y: number) => `[<35;${x + 1};${y + 1}M`;
const wheelDown = (x: number, y: number) => `[<65;${x + 1};${y + 1}M`;

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
