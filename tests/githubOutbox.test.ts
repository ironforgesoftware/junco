import { describe, it, expect } from "vitest";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { outboxPaths, enqueueOp, listOps, outboxDepth } from "../src/githubOutbox.js";
import type { Config } from "../src/types.js";

function cfgAt(root: string): Config {
  return { stateDir: root } as unknown as Config;
}
const LABELS = {
  kind: "labels",
  nwo: "a/b",
  issue: 7,
  add: ["junco:approved"],
  remove: [],
} as const;

describe("outbox store", () => {
  it("enqueue writes one atomic JSON file; list round-trips the envelope", () => {
    const root = mkdtempSync(join(tmpdir(), "junco-obx-"));
    const cfg = cfgAt(root);
    const id = enqueueOp(cfg, "dashboard", { ...LABELS });
    const files = readdirSync(outboxPaths(cfg).dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toBe(`${id}.json`);
    const [stored] = listOps(cfg);
    expect(stored.origin).toBe("dashboard");
    expect(stored.issueKey).toBe("a/b#7");
    expect(stored.attempts).toBe(0);
    expect(stored.op).toMatchObject({ kind: "labels", add: ["junco:approved"] });
    expect(Date.parse(stored.createdAt)).toBeGreaterThan(0);
  });

  it("list is FIFO by filename even with same-millisecond enqueues", () => {
    const root = mkdtempSync(join(tmpdir(), "junco-obx2-"));
    const cfg = cfgAt(root);
    const t = new Date("2026-07-07T10:00:00Z");
    const deps = { nowFn: () => t };
    const a = enqueueOp(cfg, "reporter", { ...LABELS }, deps);
    const b = enqueueOp(cfg, "reporter", { ...LABELS, issue: 8 }, deps);
    const c = enqueueOp(cfg, "reporter", { ...LABELS, issue: 9 }, deps);
    expect(listOps(cfg).map((s) => s.id)).toEqual([a, b, c]); // seq breaks the tie
  });

  it("issueKey is null for push ops; depth counts only .json in the live dir", () => {
    const root = mkdtempSync(join(tmpdir(), "junco-obx3-"));
    const cfg = cfgAt(root);
    enqueueOp(cfg, "prflow", { kind: "push", repoPath: "/r", branch: "junco/x" });
    writeFileSync(join(outboxPaths(cfg).dir, "junk.txt"), "x");
    expect(listOps(cfg)[0].issueKey).toBeNull();
    expect(outboxDepth(cfg)).toBe(1);
  });

  it("unparseable op files are skipped, not fatal", () => {
    const root = mkdtempSync(join(tmpdir(), "junco-obx4-"));
    const cfg = cfgAt(root);
    enqueueOp(cfg, "dashboard", { ...LABELS });
    writeFileSync(join(outboxPaths(cfg).dir, "0000-bad.json"), "{nope");
    expect(listOps(cfg)).toHaveLength(1);
  });

  it("missing dir (fresh install) → empty list, depth 0", () => {
    const cfg = cfgAt(join(tmpdir(), "junco-obx-nonexistent-xyz"));
    expect(listOps(cfg)).toEqual([]);
    expect(outboxDepth(cfg)).toBe(0);
  });
});
