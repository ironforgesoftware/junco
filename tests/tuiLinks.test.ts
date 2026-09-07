import { describe, it, expect } from "vitest";
import { hyperlink, linkifyLine, shortResourceRef } from "../src/tui/links.js";

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

// F3 (#512): a markdown row's recorded links, applied post-layout to the
// painted line by TranscriptBody's <Transform>.
describe("linkifyLine", () => {
  const DIM = "[2m";
  const UNDIM = "[22m";
  it("wraps the link text in OSC 8 and dims the trailing (url)", () => {
    const line = " see the docs (https://x.test/d) now";
    expect(linkifyLine(line, [{ text: "the docs", url: "https://x.test/d" }], true)).toBe(
      ` see ${hyperlink("the docs", "https://x.test/d")} ${DIM}(https://x.test/d)${UNDIM} now`,
    );
  });
  it("leaves the (url) alone when dimming is off, and links a bare text occurrence", () => {
    expect(linkifyLine("a (https://a) b", [{ text: "a", url: "https://a" }], false)).toBe(
      `${hyperlink("a", "https://a")} (https://a) b`,
    );
    expect(linkifyLine("x https://u y", [{ text: "https://u", url: "https://u" }], true)).toBe(
      `x ${hyperlink("https://u", "https://u")} y`,
    );
  });
  it("skips a link whose text is not on the line (wrapped away or truncated) and empty text", () => {
    const links = [
      { text: "gone", url: "https://g" },
      { text: "", url: "https://e" },
    ];
    expect(linkifyLine("nothing here", links, true)).toBe("nothing here");
  });
});
