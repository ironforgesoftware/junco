import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverTasks, claim } from "../src/queue.js";

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "junco-q-"));
  const inbox = join(root, "inbox");
  const processing = join(root, "processing");
  mkdirSync(inbox);
  mkdirSync(processing);
  return { inbox, processing };
}

describe("queue", () => {
  it("discovers .md files in inbox", () => {
    const { inbox } = sandbox();
    writeFileSync(join(inbox, "a.md"), "x");
    writeFileSync(join(inbox, "b.txt"), "y");
    expect(discoverTasks(inbox).map((p) => p.endsWith("a.md"))).toContain(true);
    expect(discoverTasks(inbox)).toHaveLength(1);
  });

  it("claim atomically moves inbox→processing with ts prefix", () => {
    const { inbox, processing } = sandbox();
    const src = join(inbox, "t.md");
    writeFileSync(src, "body");
    const dst = claim(src, processing);
    expect(dst).not.toBeNull();
    expect(existsSync(src)).toBe(false);
    expect(readdirSync(processing)[0]).toMatch(/__t\.md$/);
  });

  it("claim returns null when the source vanished", () => {
    const { processing } = sandbox();
    expect(claim("/nope/missing.md", processing)).toBeNull();
  });

  it("claim destination carries a UTC minute-resolution stamp prefix", () => {
    const { inbox, processing } = sandbox();
    const src = join(inbox, "t.md");
    writeFileSync(src, "body");
    const dst = claim(src, processing);
    expect(dst).not.toBeNull();
    expect(readdirSync(processing)[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{4}Z__t\.md$/);
  });

  it("claim does not clobber an in-flight processing file on a same-minute resubmit (issue #109)", () => {
    const { inbox, processing } = sandbox();
    // Freeze the clock so both claims compute the identical minute-stamped dest.
    const fixedNow = () => new Date("2026-07-10T14:30:12.000Z");

    const src1 = join(inbox, "t.md");
    writeFileSync(src1, "in-flight");
    const dst1 = claim(src1, processing, { now: fixedNow });
    expect(dst1).not.toBeNull();
    expect(readFileSync(dst1!, "utf8")).toBe("in-flight");

    // Same id resubmitted and claimed within the same UTC minute → identical dest.
    const src2 = join(inbox, "t.md");
    writeFileSync(src2, "resubmit");
    const dst2 = claim(src2, processing, { now: fixedNow });

    // The guard must refuse the claim rather than silently replace the in-flight file.
    expect(dst2).toBeNull();
    expect(readFileSync(dst1!, "utf8")).toBe("in-flight"); // untouched
    expect(existsSync(src2)).toBe(true); // left in inbox for a later, fresh-minute claim
    expect(readdirSync(processing)).toHaveLength(1); // no duplicate processing entry
  });

  it("discoverTasks returns [] for a non-existent inbox", () => {
    expect(discoverTasks("/nope/does-not-exist")).toEqual([]);
  });

  it("discoverTasks returns paths sorted", () => {
    const { inbox } = sandbox();
    writeFileSync(join(inbox, "z.md"), "1");
    writeFileSync(join(inbox, "a.md"), "2");
    const found = discoverTasks(inbox);
    expect(found).toHaveLength(2);
    expect(found[0].endsWith("a.md")).toBe(true);
    expect(found[1].endsWith("z.md")).toBe(true);
  });
});
