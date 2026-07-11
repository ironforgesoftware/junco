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
});
