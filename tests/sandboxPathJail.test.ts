import { describe, it, expect } from "vitest";
import {
  resolveWithin,
  isUnderAnyRoot,
  assertWriteAllowed,
  assertReadAllowed,
  SandboxViolation,
} from "../src/agent/sandbox/pathJail.js";
import type { SandboxPolicy } from "../src/agent/sandbox/policy.js";

const policy: SandboxPolicy = {
  writableRoots: ["/work/tree", "/tmp/scratch"],
  readDenyPaths: ["/home/x/.ssh", "/home/x/.local/state/junco"],
  network: false,
  scratchDir: "/tmp/scratch",
};

describe("resolveWithin", () => {
  it("resolves cwd-relative paths", () => {
    expect(resolveWithin("src/a.ts", "/work/tree")).toBe("/work/tree/src/a.ts");
  });
  it("keeps absolute paths", () => {
    expect(resolveWithin("/etc/passwd", "/work/tree")).toBe("/etc/passwd");
  });
  it("normalizes traversal", () => {
    expect(resolveWithin("../../etc/passwd", "/work/tree")).toBe("/etc/passwd");
  });
});

describe("isUnderAnyRoot", () => {
  it("true for a child, false for a sibling prefix", () => {
    expect(isUnderAnyRoot("/work/tree/src/a", ["/work/tree"])).toBe(true);
    expect(isUnderAnyRoot("/work/tree", ["/work/tree"])).toBe(true);
    expect(isUnderAnyRoot("/work/tree-evil/a", ["/work/tree"])).toBe(false);
  });
});

describe("assertWriteAllowed", () => {
  it("allows writes inside a writable root", () => {
    expect(assertWriteAllowed("src/a.ts", "/work/tree", policy)).toBe("/work/tree/src/a.ts");
  });
  it("blocks writes outside all roots (incl. traversal escape)", () => {
    expect(() => assertWriteAllowed("../../etc/x", "/work/tree", policy)).toThrow(SandboxViolation);
    expect(() => assertWriteAllowed("/home/x/.bashrc", "/work/tree", policy)).toThrow(
      SandboxViolation,
    );
  });
});

describe("assertReadAllowed", () => {
  it("allows a normal read", () => {
    expect(assertReadAllowed("/usr/lib/node", "/work/tree", policy)).toBe("/usr/lib/node");
  });
  it("blocks reads of denied subpaths", () => {
    expect(() => assertReadAllowed("/home/x/.ssh/id_rsa", "/work/tree", policy)).toThrow(
      SandboxViolation,
    );
    expect(() =>
      assertReadAllowed("~/.ssh/id_rsa".replace("~", "/home/x"), "/work/tree", policy),
    ).toThrow(SandboxViolation);
  });
});
