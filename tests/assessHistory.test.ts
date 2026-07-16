import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  recordRun,
  listHistory,
  readHistory,
  assessHistoryDir,
  type AssessHistory,
} from "../src/assessHistory.js";
import type { Config } from "../src/types.js";

function cfg(stateDir: string): Config {
  return { stateDir } as unknown as Config; // only stateDir is read by this module
}
function sandbox(): string {
  return mkdtempSync(join(tmpdir(), "junco-hist-"));
}

describe("assessHistory", () => {
  it("records a success with counts and no failure", () => {
    const s = sandbox();
    recordRun(cfg(s), "o/r", { ok: true, at: "2026-07-16T00:00:00.000Z", found: 4, parked: 3 });
    const h = readHistory(cfg(s), "o/r");
    expect(h).toEqual<AssessHistory>({
      id: "o/r",
      lastSuccessAt: "2026-07-16T00:00:00.000Z",
      lastFound: 4,
      lastParked: 3,
      lastFailureAt: null,
      lastFailureReason: null,
    });
  });

  it("upserts by nwo — a second run replaces, never duplicates", () => {
    const s = sandbox();
    recordRun(cfg(s), "o/r", { ok: true, at: "2026-07-15T00:00:00.000Z", found: 4, parked: 4 });
    recordRun(cfg(s), "o/r", { ok: true, at: "2026-07-16T00:00:00.000Z", found: 0, parked: 0 });
    const all = listHistory(cfg(s));
    expect(all).toHaveLength(1);
    expect(all[0].lastSuccessAt).toBe("2026-07-16T00:00:00.000Z");
    expect(all[0].lastFound).toBe(0);
  });

  it("a failure preserves the last success and stamps the failure fields", () => {
    const s = sandbox();
    recordRun(cfg(s), "o/r", { ok: true, at: "2026-07-15T00:00:00.000Z", found: 4, parked: 3 });
    recordRun(cfg(s), "o/r", { ok: false, at: "2026-07-16T00:00:00.000Z", reason: "boom" });
    const h = readHistory(cfg(s), "o/r")!;
    expect(h.lastSuccessAt).toBe("2026-07-15T00:00:00.000Z"); // age still tracks the success
    expect(h.lastFound).toBe(4);
    expect(h.lastParked).toBe(3);
    expect(h.lastFailureAt).toBe("2026-07-16T00:00:00.000Z");
    expect(h.lastFailureReason).toBe("boom");
  });

  it("a success clears a prior failure", () => {
    const s = sandbox();
    recordRun(cfg(s), "o/r", { ok: false, at: "2026-07-15T00:00:00.000Z", reason: "boom" });
    recordRun(cfg(s), "o/r", { ok: true, at: "2026-07-16T00:00:00.000Z", found: 1, parked: 1 });
    const h = readHistory(cfg(s), "o/r")!;
    expect(h.lastFailureAt).toBeNull();
    expect(h.lastFailureReason).toBeNull();
    expect(h.lastSuccessAt).toBe("2026-07-16T00:00:00.000Z");
  });

  it("a failure with no prior history leaves the success fields null", () => {
    const s = sandbox();
    recordRun(cfg(s), "o/r", { ok: false, at: "2026-07-16T00:00:00.000Z", reason: "boom" });
    const h = readHistory(cfg(s), "o/r")!;
    expect(h.lastSuccessAt).toBeNull();
    expect(h.lastFound).toBeNull();
    expect(h.lastFailureAt).toBe("2026-07-16T00:00:00.000Z");
  });

  it("keeps separate repos in separate files (no shared-map lost update)", () => {
    const s = sandbox();
    recordRun(cfg(s), "o/one", { ok: true, at: "2026-07-16T00:00:00.000Z", found: 1, parked: 1 });
    recordRun(cfg(s), "o/two", { ok: true, at: "2026-07-16T00:00:00.000Z", found: 2, parked: 2 });
    expect(listHistory(cfg(s))).toHaveLength(2);
    expect(readHistory(cfg(s), "o/one")!.lastFound).toBe(1);
    expect(readHistory(cfg(s), "o/two")!.lastFound).toBe(2);
  });

  it("never throws on a missing store: unknown nwo → null, empty dir → []", () => {
    const s = sandbox();
    expect(readHistory(cfg(s), "nope/nope")).toBeNull();
    expect(listHistory(cfg(s))).toEqual([]);
    expect(assessHistoryDir(cfg(s))).toBe(join(s, "assess-history"));
  });
});
