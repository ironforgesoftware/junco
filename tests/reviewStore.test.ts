import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeReviewStore } from "../src/reviewStore.js";
import type { Config } from "../src/types.js";

interface Item {
  id: string;
  note: string;
}
const store = makeReviewStore<Item>("test-review");
const cfg = (stateDir: string): Config => ({ stateDir }) as unknown as Config;

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
});
