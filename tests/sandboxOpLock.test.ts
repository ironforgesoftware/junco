import { describe, it, expect } from "vitest";
import { makeOpLock } from "../src/agent/sandbox/opLock.js";

/** A promise you resolve by hand, to gate an in-flight critical section. */
function gate() {
  let release!: () => void;
  const p = new Promise<void>((r) => (release = r));
  return { p, release };
}

describe("makeOpLock", () => {
  it("runs shared sections concurrently", async () => {
    const lock = makeOpLock();
    const g1 = gate();
    let bothInside = false;
    const a = lock.runShared(async () => {
      // if b can enter while a is held, they overlap
      await g1.p;
    });
    const b = lock.runShared(async () => {
      bothInside = true; // reached only if not blocked by a's shared hold
    });
    await b; // b completes without waiting for a
    expect(bothInside).toBe(true);
    g1.release();
    await a;
  });

  it("exclusive excludes shared (and vice versa)", async () => {
    const lock = makeOpLock();
    const order: string[] = [];
    const g = gate();
    const excl = lock.runExclusive(async () => {
      order.push("excl-start");
      await g.p;
      order.push("excl-end");
    });
    // give excl a tick to acquire
    await Promise.resolve();
    const shared = lock.runShared(async () => {
      order.push("shared");
    });
    g.release();
    await Promise.all([excl, shared]);
    // shared must not run until excl fully released
    expect(order).toEqual(["excl-start", "excl-end", "shared"]);
  });

  it("writer-priority: a pending exclusive blocks a newly-arriving shared", async () => {
    const lock = makeOpLock();
    const order: string[] = [];
    const g = gate();
    const s1 = lock.runShared(async () => {
      order.push("s1-start");
      await g.p; // hold shared open
      order.push("s1-end");
    });
    await Promise.resolve();
    const w = lock.runExclusive(async () => order.push("w")); // queues, waits for s1
    await Promise.resolve();
    const s2 = lock.runShared(async () => order.push("s2")); // arrives AFTER w
    g.release();
    await Promise.all([s1, w, s2]);
    // s2 must wait behind the queued writer, not slip in with s1
    expect(order).toEqual(["s1-start", "s1-end", "w", "s2"]);
  });

  it("releases the lock even if the body throws", async () => {
    const lock = makeOpLock();
    await expect(
      lock.runExclusive(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // lock is free again:
    await expect(lock.runShared(async () => 42)).resolves.toBe(42);
  });
});
