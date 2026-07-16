import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeReviewStore } from "../src/reviewStore.js";
import type { Config } from "../src/types.js";

interface Item {
  id: string;
  note: string;
}
const store = makeReviewStore<Item>("test-review");
const cfg = (stateDir: string): Config => ({ dataDir: stateDir }) as unknown as Config;

describe("makeReviewStore", () => {
  it("writes, lists, reads, and archives to a named subdir", () => {
    const c = cfg(mkdtempSync(join(tmpdir(), "rvs-")));
    store.write(c, { id: "a-1", note: "x" });
    expect(store.count(c)).toBe(1);
    expect(store.list(c).map((e) => e.id)).toEqual(["a-1"]);
    expect(store.read(c, "a-1").entry?.note).toBe("x");
    store.remove(c, "a-1", "posted");
    expect(store.count(c)).toBe(0);
    expect(existsSync(join(store.archiveDir(c, "posted"), "a-1.json"))).toBe(true);
  });
  it("missing → {null,null}; corrupt → skipped in list, error in read; missing dir → empty", () => {
    const c = cfg(mkdtempSync(join(tmpdir(), "rvs-")));
    expect(store.read(c, "nope")).toEqual({ entry: null, error: null });
    expect(store.list(c)).toEqual([]);
    store.write(c, { id: "good", note: "g" });
    writeFileSync(join(store.dir(c), "bad.json"), "{nope");
    expect(store.list(c).map((e) => e.id)).toEqual(["good"]);
    expect(store.read(c, "bad").error).toMatch(/not valid JSON/);
  });
  it("slugifies traversal ids into inert filenames and round-trips the raw id", () => {
    const c = cfg(mkdtempSync(join(tmpdir(), "rvs-")));
    const dst = store.write(c, { id: "../../evil", note: "e" });
    expect(dst.startsWith(store.dir(c) + "/")).toBe(true);
    expect(dst.slice(store.dir(c).length + 1)).not.toContain("/");
    expect(store.read(c, "../../evil").entry?.id).toBe("../../evil");
    expect(readdirSync(store.dir(c)).filter((n) => n.endsWith(".json"))).toHaveLength(1);
  });
  it("same id overwrites", () => {
    const c = cfg(mkdtempSync(join(tmpdir(), "rvs-")));
    store.write(c, { id: "dup", note: "1" });
    store.write(c, { id: "dup", note: "2" });
    expect(store.list(c)).toHaveLength(1);
    expect(store.read(c, "dup").entry?.note).toBe("2");
  });

  it("remove on an already-archived/missing id is ENOENT-safe: returns false, never throws", () => {
    const c = cfg(mkdtempSync(join(tmpdir(), "rvs-")));
    store.write(c, { id: "a-1", note: "x" });
    expect(store.remove(c, "a-1", "posted")).toBe(true);
    expect(store.count(c)).toBe(0);
    // archiving again (already gone) must not throw
    expect(() => store.remove(c, "a-1", "posted")).not.toThrow();
    expect(store.remove(c, "a-1", "posted")).toBe(false);
    // an id that was never written is the same no-op case
    expect(store.remove(c, "never-written", "posted")).toBe(false);
  });

  describe("shape validation (requiredFields)", () => {
    const shaped = makeReviewStore<Item>("test-review-shaped", ["id", "note"]);

    it("a hand-tampered entry missing a required field is skipped in list(), errors in read()", () => {
      const c = cfg(mkdtempSync(join(tmpdir(), "rvs-shape-")));
      shaped.write(c, { id: "good", note: "g" });
      // Simulate hand-tampering: valid JSON, but missing the required `note`
      // field entirely (e.g. `{}` truncated by a partial write).
      writeFileSync(join(shaped.dir(c), "bad.json"), JSON.stringify({ id: "bad" }));

      expect(shaped.list(c).map((e) => e.id)).toEqual(["good"]);
      const { entry, error } = shaped.read(c, "bad");
      expect(entry).toBeNull();
      expect(error).toMatch(/missing required fields/);
    });

    it("a completely empty `{}` entry is rejected the same way (no undefined-field entries)", () => {
      const c = cfg(mkdtempSync(join(tmpdir(), "rvs-shape-")));
      mkdirSync(shaped.dir(c), { recursive: true });
      writeFileSync(join(shaped.dir(c), "empty.json"), "{}");
      expect(shaped.list(c)).toEqual([]);
      expect(shaped.read(c, "empty").error).toMatch(/missing required fields/);
    });

    it("default requiredFields (no arg) only checks `id` — unrelated to this store's stricter check", () => {
      const c = cfg(mkdtempSync(join(tmpdir(), "rvs-shape-default-")));
      mkdirSync(store.dir(c), { recursive: true });
      // The unshaped `store` from the top of this file defaults to ["id"] —
      // an entry with only `id` set is accepted (note is just undefined).
      writeFileSync(join(store.dir(c), "id-only.json"), JSON.stringify({ id: "x" }));
      expect(store.list(c).map((e) => e.id)).toEqual(["x"]);
      // but `{}` (no id at all) still fails even the default check
      writeFileSync(join(store.dir(c), "no-id.json"), "{}");
      expect(store.read(c, "no-id").error).toMatch(/missing required fields/);
    });
  });
});
