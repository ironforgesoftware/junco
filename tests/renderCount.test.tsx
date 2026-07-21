import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { bumpRender, renderCounts, resetRenderCounts } from "../src/tui/renderCount.js";

describe("renderCount", () => {
  beforeEach(() => resetRenderCounts());
  afterEach(() => {
    delete process.env.JUNCO_RENDER_COUNT;
  });

  it("is a no-op unless the env flag is set", () => {
    delete process.env.JUNCO_RENDER_COUNT;
    bumpRender("X");
    expect(renderCounts()).toEqual({});
  });

  it("counts per name when enabled", () => {
    process.env.JUNCO_RENDER_COUNT = "1";
    bumpRender("A");
    bumpRender("A");
    bumpRender("B");
    expect(renderCounts()).toEqual({ A: 2, B: 1 });
  });

  it("resetRenderCounts clears the tallies", () => {
    process.env.JUNCO_RENDER_COUNT = "1";
    bumpRender("A");
    resetRenderCounts();
    expect(renderCounts()).toEqual({});
  });
});
