import { describe, it, expect } from "vitest";
import { chatSlug, isWatchedKey } from "../src/chat/chatKey.js";

describe("chatKey (spec 2026-09-01 §1.2)", () => {
  it("classifies watched (owner/repo) vs local (absolute path) keys", () => {
    expect(isWatchedKey("acme/api")).toBe(true);
    expect(isWatchedKey("/home/me/api")).toBe(false);
    expect(isWatchedKey("C:\\repos\\api")).toBe(false);
  });
  it("slugs a watched key as owner__repo, lowercased", () => {
    expect(chatSlug("Acme/API")).toBe("acme__api");
  });
  it("slugs a local key as local-<basename>-<sha1 prefix>, stable and collision-free", () => {
    const a = chatSlug("/home/me/api");
    const b = chatSlug("/srv/other/api");
    expect(a).toMatch(/^local-api-[0-9a-f]{8}$/);
    expect(b).toMatch(/^local-api-[0-9a-f]{8}$/);
    expect(a).not.toBe(b);
    expect(chatSlug("/home/me/api")).toBe(a);
  });
  it("never lets a slug escape its dir", () => {
    expect(chatSlug("../x/../y")).not.toContain("/");
    expect(chatSlug("/a/../b")).not.toContain("..");
  });
});
