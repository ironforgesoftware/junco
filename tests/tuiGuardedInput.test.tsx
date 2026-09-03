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

describe("useGuardedInput — held-key runs", () => {
  function mount(opts?: { text?: boolean }): { seen: string[]; r: ReturnType<typeof render> } {
    const seen: string[] = [];
    function Probe() {
      useGuardedInput((input) => {
        seen.push(input);
      }, opts);
      return <Text>probe</Text>;
    }
    return { seen, r: render(<Probe />) };
  }

  it("replays a run of one repeated key (auto-repeat coalesced into one chunk) as one press each", async () => {
    // ink's parser splits a stdin chunk only at escape sequences and
    // backspace bytes, so a held `k` under load arrives as input === "kkk" —
    // which no key branch matches. Every press in the run used to vanish.
    const { seen, r } = mount();
    await until(() => (r.lastFrame() ?? "").includes("probe"));
    r.stdin.write("kkk");
    await until(() => seen.length === 3);
    expect(seen).toEqual(["k", "k", "k"]);
  });

  it("leaves a mixed chunk whole — that is a paste, not a held key", async () => {
    const { seen, r } = mount();
    await until(() => (r.lastFrame() ?? "").includes("probe"));
    r.stdin.write("jk");
    await until(() => seen.length > 0);
    expect(seen).toEqual(["jk"]);
  });

  it("text entry opts out: a field appending from its prop closure needs the whole chunk", async () => {
    const { seen, r } = mount({ text: true });
    await until(() => (r.lastFrame() ?? "").includes("probe"));
    r.stdin.write("aaa");
    await until(() => seen.length > 0);
    expect(seen).toEqual(["aaa"]);
  });
});
