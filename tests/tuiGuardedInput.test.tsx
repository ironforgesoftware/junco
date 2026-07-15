import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { Text } from "ink";
import { render, cleanup } from "ink-testing-library";
import { useGuardedInput } from "../src/tui/useGuardedInput.js";
import { until } from "./helpers/until.js";

afterEach(cleanup);

describe("useGuardedInput", () => {
  it("drops leaked SGR mouse sequences, passes real keys through", async () => {
    const seen: string[] = [];
    function Probe() {
      useGuardedInput((input) => {
        seen.push(input);
      });
      return <Text>probe</Text>;
    }
    const r = render(<Probe />);
    await until(() => (r.lastFrame() ?? "").includes("probe"));
    // Ink strips the ESC from CSI sequences before handing them to useInput,
    // so a leaked mouse event arrives as "[<35;5;5M".
    r.stdin.write("[<35;5;5M");
    r.stdin.write("x");
    await until(() => seen.length > 0);
    expect(seen).toEqual(["x"]);
  });

  it("honors isActive", async () => {
    const spy = vi.fn();
    function Probe() {
      useGuardedInput(spy, { isActive: false });
      return <Text>probe</Text>;
    }
    const r = render(<Probe />);
    await until(() => (r.lastFrame() ?? "").includes("probe"));
    r.stdin.write("x");
    await new Promise((res) => setTimeout(res, 20));
    expect(spy).not.toHaveBeenCalled();
  });
});
