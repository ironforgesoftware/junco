import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverTasks, claim } from "../src/queue.js";

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "junco-q-"));
  const inbox = join(root, "inbox"); const processing = join(root, "processing");
  mkdirSync(inbox); mkdirSync(processing);
  return { inbox, processing };
}

describe("queue", () => {
  it("discovers .md files in inbox", () => {
    const { inbox } = sandbox();
    writeFileSync(join(inbox, "a.md"), "x"); writeFileSync(join(inbox, "b.txt"), "y");
    expect(discoverTasks(inbox).map((p) => p.endsWith("a.md"))).toContain(true);
    expect(discoverTasks(inbox)).toHaveLength(1);
  });

  it("claim atomically moves inbox→processing with ts prefix", () => {
    const { inbox, processing } = sandbox();
    const src = join(inbox, "t.md"); writeFileSync(src, "body");
    const dst = claim(src, processing);
    expect(dst).not.toBeNull();
    expect(existsSync(src)).toBe(false);
    expect(readdirSync(processing)[0]).toMatch(/__t\.md$/);
  });

  it("claim returns null when the source vanished", () => {
    const { processing } = sandbox();
    expect(claim("/nope/missing.md", processing)).toBeNull();
  });
});
