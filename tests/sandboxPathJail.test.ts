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
});
