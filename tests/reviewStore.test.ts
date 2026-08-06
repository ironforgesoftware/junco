import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeReviewStore } from "../src/reviewStore.js";

interface Item {
  id: string;
  note: string;
}
const store = makeReviewStore<Item>();

// makeReviewStore's methods now take the absolute entry dir itself (a caller
// passes dataTreePaths(cfg).reviewAssess / .reviewComments / .assessHistory —
// dataTree.ts is the only place that joins those subdirs onto the data root),
// not a `Config` + subdir baked into the factory at construction. Call shape
// only: every asserted value below is unchanged from before this signature
// change — `dirIn(root)` is exactly what `dir(cfg)` used to compute
// internally (`join(cfg.dataDir, "test-review")`).
function dirIn(root: string): string {
  return join(root, "test-review");
}
function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "rvs-"));
}

describe("makeReviewStore", () => {
  it("writes, lists, reads, and archives to a named subdir", () => {
    const dir = dirIn(tmpRoot());
    store.write(dir, { id: "a-1", note: "x" });
    expect(store.count(dir)).toBe(1);
    expect(store.list(dir).map((e) => e.id)).toEqual(["a-1"]);
    expect(store.read(dir, "a-1").entry?.note).toBe("x");
    store.remove(dir, "a-1", "posted");
    expect(store.count(dir)).toBe(0);
    expect(existsSync(join(store.archiveDir(dir, "posted"), "a-1.json"))).toBe(true);
  });
  // #202: a custom keyOf controls the on-disk filename while the raw id still
  // round-trips (used by assessHistory to avoid slugifyId nwo collisions).
  it("a custom keyOf controls the on-disk filename and round-trips the id", () => {
    const keyed = makeReviewStore<Item>(["id"], (id) => `k-${id.length}`);
    const dir = dirIn(tmpRoot());
    keyed.write(dir, { id: "abcd", note: "x" });
    expect(readdirSync(dir)).toEqual(["k-4.json"]); // keyOf, not slugifyId
    expect(keyed.read(dir, "abcd").entry?.note).toBe("x"); // same keyOf on read
  });
  it("missing → {null,null}; corrupt → skipped in list, error in read; missing dir → empty", () => {
    const dir = dirIn(tmpRoot());
    expect(store.read(dir, "nope")).toEqual({ entry: null, error: null });
    expect(store.list(dir)).toEqual([]);
    store.write(dir, { id: "good", note: "g" });
    writeFileSync(join(dir, "bad.json"), "{nope");
    expect(store.list(dir).map((e) => e.id)).toEqual(["good"]);
    expect(store.read(dir, "bad").error).toMatch(/not valid JSON/);
  });
  it("slugifies traversal ids into inert filenames and round-trips the raw id", () => {
    const dir = dirIn(tmpRoot());
    const dst = store.write(dir, { id: "../../evil", note: "e" });
    expect(dst.startsWith(dir + "/")).toBe(true);
    expect(dst.slice(dir.length + 1)).not.toContain("/");
    expect(store.read(dir, "../../evil").entry?.id).toBe("../../evil");
    expect(readdirSync(dir).filter((n) => n.endsWith(".json"))).toHaveLength(1);
  });
  it("same id overwrites", () => {
    const dir = dirIn(tmpRoot());
    store.write(dir, { id: "dup", note: "1" });
    store.write(dir, { id: "dup", note: "2" });
    expect(store.list(dir)).toHaveLength(1);
    expect(store.read(dir, "dup").entry?.note).toBe("2");
  });

  it("remove on an already-archived/missing id is ENOENT-safe: returns false, never throws", () => {
    const dir = dirIn(tmpRoot());
    store.write(dir, { id: "a-1", note: "x" });
    expect(store.remove(dir, "a-1", "posted")).toBe(true);
    expect(store.count(dir)).toBe(0);
    // archiving again (already gone) must not throw
    expect(() => store.remove(dir, "a-1", "posted")).not.toThrow();
    expect(store.remove(dir, "a-1", "posted")).toBe(false);
    // an id that was never written is the same no-op case
    expect(store.remove(dir, "never-written", "posted")).toBe(false);
  });

  describe("shape validation (requiredFields)", () => {
    const shaped = makeReviewStore<Item>(["id", "note"]);

    it("a hand-tampered entry missing a required field is skipped in list(), errors in read()", () => {
      const dir = join(mkdtempSync(join(tmpdir(), "rvs-shape-")), "test-review-shaped");
      shaped.write(dir, { id: "good", note: "g" });
      // Simulate hand-tampering: valid JSON, but missing the required `note`
      // field entirely (e.g. `{}` truncated by a partial write).
      writeFileSync(join(dir, "bad.json"), JSON.stringify({ id: "bad" }));

      expect(shaped.list(dir).map((e) => e.id)).toEqual(["good"]);
      const { entry, error } = shaped.read(dir, "bad");
      expect(entry).toBeNull();
      expect(error).toMatch(/missing required fields/);
    });

    it("a completely empty `{}` entry is rejected the same way (no undefined-field entries)", () => {
      const dir = join(mkdtempSync(join(tmpdir(), "rvs-shape-")), "test-review-shaped");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "empty.json"), "{}");
      expect(shaped.list(dir)).toEqual([]);
      expect(shaped.read(dir, "empty").error).toMatch(/missing required fields/);
    });

    it("default requiredFields (no arg) only checks `id` — unrelated to this store's stricter check", () => {
      const dir = dirIn(mkdtempSync(join(tmpdir(), "rvs-shape-default-")));
      mkdirSync(dir, { recursive: true });
      // The unshaped `store` from the top of this file defaults to ["id"] —
      // an entry with only `id` set is accepted (note is just undefined).
      writeFileSync(join(dir, "id-only.json"), JSON.stringify({ id: "x" }));
      expect(store.list(dir).map((e) => e.id)).toEqual(["x"]);
      // but `{}` (no id at all) still fails even the default check
      writeFileSync(join(dir, "no-id.json"), "{}");
      expect(store.read(dir, "no-id").error).toMatch(/missing required fields/);
    });
  });
});
