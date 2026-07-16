import { describe, it, expect } from "vitest";
import type { Config } from "../src/types.js";

describe("toolchain", () => {
  it("compiles and runs typed code", () => {
    const c: Config["dataDir"] = "Junco";
    expect(c).toBe("Junco");
  });
});
