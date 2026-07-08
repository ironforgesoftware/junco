import { describe, it, expect } from "vitest";
import { hyperlink, shortResourceRef } from "../src/tui/links.js";

describe("hyperlink", () => {
  it("wraps text in an OSC 8 sequence targeting the url", () => {
    expect(hyperlink("hi", "https://x.test/a")).toBe(
      "\u001b]8;;https://x.test/a\u0007hi\u001b]8;;\u0007",
    );
  });
});

describe("shortResourceRef", () => {
  it("compacts issue and PR urls to owner/repo#n", () => {
    expect(shortResourceRef("https://github.com/acme/api/issues/7")).toBe("acme/api#7");
    expect(shortResourceRef("https://github.com/acme/api/pull/123")).toBe("acme/api#123");
  });
  it("falls back to the scheme-less url for anything unexpected", () => {
    expect(shortResourceRef("https://github.example/acme/api/issues/7")).toBe(
      "github.example/acme/api/issues/7",
    );
  });
  it("falls back for a github.com path embedded after the real host (unanchored match)", () => {
    expect(shortResourceRef("https://evil.example/github.com/acme/api/issues/7")).toBe(
      "evil.example/github.com/acme/api/issues/7",
    );
  });
});
