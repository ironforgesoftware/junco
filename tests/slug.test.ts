import { describe, it, expect } from "vitest";
import { slugifyId } from "../src/slug.js";

describe("slugifyId", () => {
  it("keeps alphanumerics, dots, underscores, and hyphens", () => {
    expect(slugifyId("my-cool.task_01")).toBe("my-cool.task_01");
  });

  it("collapses path separators and other characters to '-'", () => {
    expect(slugifyId("a/b\\c d")).toBe("a-b-c-d");
  });

  it("neutralizes a path-traversal id into a single filename", () => {
    expect(slugifyId("../../../../Users/x/anything")).toBe("..-..-..-..-Users-x-anything");
  });

  it("strips leading/trailing dashes", () => {
    expect(slugifyId("(hello)")).toBe("hello");
  });

  it("falls back to 'ticket' for empty or symbol-only ids", () => {
    expect(slugifyId("")).toBe("ticket");
    expect(slugifyId("!!!")).toBe("ticket");
  });
});
