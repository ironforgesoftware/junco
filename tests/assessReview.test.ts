import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  writePending,
  listPending,
  readPending,
  removePending,
  pendingCount,
  assessReviewPaths,
  type PendingAssess,
} from "../src/assessReview.js";
import type { Config } from "../src/types.js";

function cfg(stateDir: string): Config {
  return { stateDir } as unknown as Config; // only stateDir is read by this module
}
function batch(id: string): PendingAssess {
  return {
    id,
    nwo: "o/r",
    external: true,
    autoPlan: false,
    repoPath: "/x",
    createdAt: "2026-07-09T00:00:00.000Z",
    findings: [
      {
        fingerprint: "abc123",
        kind: "code",
        severity: "high",
        ruleId: "R",
        title: "T",
        description: "d",
        references: [],
      },
    ],
  };
}

describe("assessReview store", () => {
  it("writes, lists, reads, and archives a batch", () => {
    const dir = mkdtempSync(join(tmpdir(), "arv-"));
    const c = cfg(dir);
    writePending(c, batch("assess-x-1"));
    expect(pendingCount(c)).toBe(1);
    expect(listPending(c).map((b) => b.id)).toEqual(["assess-x-1"]);
    expect(readPending(c, "assess-x-1").batch?.nwo).toBe("o/r");

    removePending(c, "assess-x-1");
    expect(pendingCount(c)).toBe(0);
    expect(existsSync(join(assessReviewPaths(c).filed, "assess-x-1.json"))).toBe(true);
  });

  it("missing batch reads as {null,null}; corrupt as error; missing dir → empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "arv-"));
    const c = cfg(dir);
    expect(readPending(c, "nope")).toEqual({ batch: null, error: null });
    expect(listPending(c)).toEqual([]);
    expect(pendingCount(c)).toBe(0);

    writePending(c, batch("good"));
    writeFileSync(join(assessReviewPaths(c).dir, "bad.json"), "{not json");
    expect(listPending(c).map((b) => b.id)).toEqual(["good"]); // bad skipped, not thrown
    expect(readPending(c, "bad").error).toMatch(/not valid JSON/);
  });

  it("re-writing the same id overwrites (no duplicate file)", () => {
    const dir = mkdtempSync(join(tmpdir(), "arv-"));
    const c = cfg(dir);
    writePending(c, batch("dup"));
    writePending(c, { ...batch("dup"), nwo: "o/r2" });
    expect(readdirSync(assessReviewPaths(c).dir).filter((n) => n.endsWith(".json"))).toHaveLength(
      1,
    );
    expect(readPending(c, "dup").batch?.nwo).toBe("o/r2");
  });

  it("contains a path-traversal id to a single filename inside the dir (issue #32 class)", () => {
    const dir = mkdtempSync(join(tmpdir(), "arv-"));
    const c = cfg(dir);
    const evilId = "../../evil";
    const { dir: reviewDir } = assessReviewPaths(c);

    const dst = writePending(c, batch(evilId));
    // The written file must stay inside the assess-review dir: a single inert
    // filename component, not a traversal out of it.
    expect(dst.startsWith(reviewDir + "/")).toBe(true);
    expect(dst.slice(reviewDir.length + 1)).not.toMatch(/[\\/]/);
    expect(existsSync(dst)).toBe(true);

    // A raw id round-trips: read/remove find the same slugified file.
    const { batch: read, error } = readPending(c, evilId);
    expect(error).toBeNull();
    expect(read?.id).toBe(evilId); // stored field stays the raw, human-facing id

    removePending(c, evilId);
    const { filed } = assessReviewPaths(c);
    const filedNames = readdirSync(filed);
    expect(filedNames).toHaveLength(1);
    expect(filedNames[0]).not.toMatch(/[\\/]/);
  });
});
