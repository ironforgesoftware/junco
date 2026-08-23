import { describe, it, expect, vi } from "vitest";
import { join, isAbsolute } from "node:path";
import { ensureDaemon, type EnsureDaemonDeps } from "../src/ensureDaemon.js";
import { workerLockPath } from "../src/lock.js";
import type { ServiceRef } from "../src/restartCmd.js";

const CONFIG = "/Users/u/junco/config.json";
const SVC: ServiceRef = { platform: "launchd", id: "com.edelweiss.junco-worker" };

/** Base deps: no real launchctl/lock, instant sleep, captured prints. */
function base(over: Partial<EnsureDaemonDeps> = {}): {
  deps: EnsureDaemonDeps;
  prints: string[];
  kick: ReturnType<typeof vi.fn>;
} {
  const prints: string[] = [];
  const kick = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
  const deps: EnsureDaemonDeps = {
    lockHolderFn: () => null,
    discoverServiceFn: async () => SVC,
    kickstartFn: kick,
    sleepFn: async () => {},
    printFn: (s) => prints.push(s),
    waitMs: 1000,
    pollMs: 250,
    ...over,
  };
  return { deps, prints, kick };
}

describe("ensureDaemon", () => {
  it("reads the ONE derived lock path, absolute even for a relative config (#310)", async () => {
    const REL = join("sbx-rel", "config.json");
    const seen: string[] = [];
    const { deps } = base({
      lockHolderFn: (p) => {
        seen.push(p);
        return 4242;
      },
    });
    await ensureDaemon(REL, deps);
    expect(seen).toEqual([workerLockPath(REL)]);
    expect(isAbsolute(seen[0])).toBe(true);
  });

  it("running: lock already held → no discover/kickstart", async () => {
    const discover = vi.fn(async () => SVC);
    const { deps, kick } = base({ lockHolderFn: () => 4242, discoverServiceFn: discover });
    const r = await ensureDaemon(CONFIG, deps);
    expect(r).toEqual({ state: "running", pid: 4242 });
    expect(discover).not.toHaveBeenCalled();
    expect(kick).not.toHaveBeenCalled();
  });

  it("started: down + unit → kickstart, lock appears on a later poll", async () => {
    // null (initial), null (poll 1), then 999 (poll 2)
    const seq = [null, null, 999] as (number | null)[];
    const { deps, kick } = base({ lockHolderFn: () => (seq.length > 1 ? seq.shift()! : seq[0]) });
    const r = await ensureDaemon(CONFIG, deps);
    expect(r).toEqual({ state: "started", pid: 999 });
    expect(kick).toHaveBeenCalledWith(SVC);
  });

  it("start-failed: down + unit → kickstart, lock never appears within the ceiling", async () => {
    const { deps } = base({ lockHolderFn: () => null, waitMs: 500, pollMs: 250 });
    const r = await ensureDaemon(CONFIG, deps);
    expect(r).toEqual({ state: "start-failed", ref: SVC });
  });

  it("start-failed: kickstart returns non-zero", async () => {
    const { deps } = base({ kickstartFn: async () => ({ code: 1, stdout: "", stderr: "boom" }) });
    const r = await ensureDaemon(CONFIG, deps);
    expect(r).toEqual({ state: "start-failed", ref: SVC });
  });

  it("start-failed: kickstart rejects (never throws out of ensureDaemon)", async () => {
    const { deps } = base({
      kickstartFn: async () => {
        throw new Error("launchctl exploded");
      },
    });
    const r = await ensureDaemon(CONFIG, deps);
    expect(r).toEqual({ state: "start-failed", ref: SVC });
  });

  it("no-service: no unit references this config", async () => {
    const { deps, kick } = base({ discoverServiceFn: async () => null });
    const r = await ensureDaemon(CONFIG, deps);
    expect(r).toEqual({ state: "no-service" });
    expect(kick).not.toHaveBeenCalled();
  });

  it("no-service: discover rejects → mapped, never throws", async () => {
    const { deps } = base({
      discoverServiceFn: async () => {
        throw new Error("plutil exploded");
      },
    });
    const r = await ensureDaemon(CONFIG, deps);
    expect(r).toEqual({ state: "no-service" });
  });

  it("prints the 'no supervised daemon' guidance on no-service", async () => {
    const { deps, prints } = base({ discoverServiceFn: async () => null });
    await ensureDaemon(CONFIG, deps);
    expect(prints.join("")).toMatch(/junco service/);
  });
});
