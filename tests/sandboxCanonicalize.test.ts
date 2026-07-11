import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, symlinkSync, mkdirSync } from "node:fs";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { canonicalize } from "../src/agent/sandbox/canonicalize.js";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "junco-canon-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("canonicalize", () => {
  it("collapses a symlinked prefix for an existing path", () => {
    const real = tmp();
    mkdirSync(join(real, "sub"));
    const link = join(tmp(), "link");
    symlinkSync(real, link);
    // link/sub resolves through the symlink to real/sub
    expect(canonicalize(join(link, "sub"))).toBe(realpathSync(join(real, "sub")));
  });

  it("appends a non-existent trailing segment to the resolved prefix", () => {
    const real = tmp();
    const link = join(tmp(), "link");
    symlinkSync(real, link);
    // new.txt does not exist yet; prefix (link → real) still canonicalizes
    expect(canonicalize(join(link, "new.txt"))).toBe(join(realpathSync(real), "new.txt"));
  });

  it("returns the resolved path unchanged when nothing exists", () => {
    expect(canonicalize("/no/such/path/here")).toBe("/no/such/path/here");
  });

  // Security (#158): a DANGLING symlink leaf (target missing) must resolve to
  // its target, not the link's own path — otherwise the write path-jail would
  // approve an in-jail link and fs.writeFile would escape through it.
  it("resolves a dangling symlink leaf to its (absolute) target", () => {
    const wt = realpathSync(tmp());
    const outsideTarget = join(realpathSync(tmpdir()), "junco-canon-escape-target-does-not-exist");
    symlinkSync(outsideTarget, join(wt, "innocent")); // dangling: target absent
    expect(canonicalize(join(wt, "innocent"))).toBe(outsideTarget);
  });

  it("resolves a dangling symlink leaf with a relative (../) target", () => {
    const parent = realpathSync(tmp());
    const wt = join(parent, "wt");
    mkdirSync(wt);
    symlinkSync("../escape-target", join(wt, "innocent")); // → parent/escape-target (absent)
    expect(canonicalize(join(wt, "innocent"))).toBe(join(parent, "escape-target"));
  });

  it("resolves a legit in-jail dangling symlink leaf to the in-jail target", () => {
    const wt = realpathSync(tmp());
    symlinkSync(join(wt, "real.txt"), join(wt, "link")); // → wt/real.txt (absent)
    expect(canonicalize(join(wt, "link"))).toBe(join(wt, "real.txt"));
  });

  it("does not hang on a symlink cycle (returns a path, never loops)", () => {
    const wt = realpathSync(tmp());
    symlinkSync(join(wt, "b"), join(wt, "a"));
    symlinkSync(join(wt, "a"), join(wt, "b"));
    // Must terminate; the exact result is unimportant (a real op would ELOOP).
    expect(typeof canonicalize(join(wt, "a"))).toBe("string");
  });
});
