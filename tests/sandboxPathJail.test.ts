import { describe, it, expect } from "vitest";
import {
  resolveWithin,
  isUnderAnyRoot,
  assertWriteAllowed,
  assertReadAllowed,
  SandboxViolation,
} from "../src/agent/sandbox/pathJail.js";
import type { SandboxPolicy } from "../src/agent/sandbox/policy.js";

// Synthetic, guaranteed-nonexistent paths so canonicalize() in the assert
// helpers is a deterministic no-op across machines.
const policy: SandboxPolicy = {
  writableRoots: ["/sbxroot/work/tree", "/sbxroot/scratch"],
  readDenyPaths: ["/sbxroot/home/x/.ssh", "/sbxroot/data/queue"],
  readDenyFiles: ["/sbxroot/data/watchlist.json"],
  readAllowPaths: [],
  network: false,
  scratchDir: "/sbxroot/scratch",
  bashTimeoutMs: undefined,
};

describe("resolveWithin", () => {
  it("resolves cwd-relative paths", () => {
    expect(resolveWithin("src/a.ts", "/sbxroot/work/tree")).toBe("/sbxroot/work/tree/src/a.ts");
  });
  it("keeps absolute paths", () => {
    expect(resolveWithin("/sbxroot/etc/passwd", "/sbxroot/work/tree")).toBe("/sbxroot/etc/passwd");
  });
  it("normalizes traversal", () => {
    expect(resolveWithin("../../etc/passwd", "/sbxroot/work/tree")).toBe("/sbxroot/etc/passwd");
  });
});

describe("isUnderAnyRoot", () => {
  it("true for a child, false for a sibling prefix", () => {
    expect(isUnderAnyRoot("/sbxroot/work/tree/src/a", ["/sbxroot/work/tree"])).toBe(true);
    expect(isUnderAnyRoot("/sbxroot/work/tree", ["/sbxroot/work/tree"])).toBe(true);
    expect(isUnderAnyRoot("/sbxroot/work/tree-evil/a", ["/sbxroot/work/tree"])).toBe(false);
  });
});

describe("assertWriteAllowed", () => {
  it("allows writes inside a writable root", () => {
    expect(assertWriteAllowed("src/a.ts", "/sbxroot/work/tree", policy)).toBe(
      "/sbxroot/work/tree/src/a.ts",
    );
  });
  it("blocks writes outside all roots (incl. traversal escape)", () => {
    expect(() => assertWriteAllowed("../../etc/x", "/sbxroot/work/tree", policy)).toThrow(
      SandboxViolation,
    );
    expect(() =>
      assertWriteAllowed("/sbxroot/home/x/.bashrc", "/sbxroot/work/tree", policy),
    ).toThrow(SandboxViolation);
  });
});

describe("assertReadAllowed", () => {
  it("allows a normal read", () => {
    expect(assertReadAllowed("/sbxroot/usr/lib/node", "/sbxroot/work/tree", policy)).toBe(
      "/sbxroot/usr/lib/node",
    );
  });
  it("blocks reads of denied subpaths", () => {
    expect(() =>
      assertReadAllowed("/sbxroot/home/x/.ssh/id_rsa", "/sbxroot/work/tree", policy),
    ).toThrow(SandboxViolation);
    expect(() =>
      assertReadAllowed("/sbxroot/data/queue/inbox/x.md", "/sbxroot/work/tree", policy),
    ).toThrow(SandboxViolation);
  });
  it("blocks reads of exact denied files, but not their siblings", () => {
    expect(() =>
      assertReadAllowed("/sbxroot/data/watchlist.json", "/sbxroot/work/tree", policy),
    ).toThrow(SandboxViolation);
    // A sibling under the same parent is NOT denied — file denies are exact.
    expect(assertReadAllowed("/sbxroot/data/other.json", "/sbxroot/work/tree", policy)).toBe(
      "/sbxroot/data/other.json",
    );
  });

  // The real #277 shape, three levels deep, exercised end-to-end through
  // assertReadAllowed (not just resolveRead directly): deny the root, allow
  // cache/ back, re-deny cache/mirror nested inside that allow-back. A flat
  // "any deny wins" check (the pre-Task-3 behavior) would deny cache/ too; a
  // flat "any allow wins" check would wrongly let mirror/ back in.
  describe("three-deep allow-over-deny (~/.junco shape)", () => {
    const nested: SandboxPolicy = {
      writableRoots: ["/sbxroot/work/tree"],
      readDenyPaths: ["/sbxroot/.junco", "/sbxroot/.junco/cache/mirror"],
      readDenyFiles: [],
      readAllowPaths: ["/sbxroot/.junco/cache"],
      network: false,
      scratchDir: "/sbxroot/scratch",
      bashTimeoutMs: undefined,
    };

    it("denies the wholesale root", () => {
      expect(() =>
        assertReadAllowed("/sbxroot/.junco/config.json", "/sbxroot/work/tree", nested),
      ).toThrow(SandboxViolation);
    });

    it("allows the subtree that overrides the root deny", () => {
      expect(
        assertReadAllowed("/sbxroot/.junco/cache/worktrees/t1/a.ts", "/sbxroot/work/tree", nested),
      ).toBe("/sbxroot/.junco/cache/worktrees/t1/a.ts");
    });

    it("re-denies the subtree nested inside the allow-back (longest prefix wins)", () => {
      expect(() =>
        assertReadAllowed("/sbxroot/.junco/cache/mirror/repo.git", "/sbxroot/work/tree", nested),
      ).toThrow(SandboxViolation);
    });
  });
});
