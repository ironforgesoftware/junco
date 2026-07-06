import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { Smoke } from "../src/tui/Smoke.js";

describe("tsx toolchain smoke", () => {
  it("renders an ink component to a string frame", () => {
    const { lastFrame } = render(<Smoke label="junco" />);
    expect(lastFrame()).toContain("junco dashboard smoke");
  });
});
