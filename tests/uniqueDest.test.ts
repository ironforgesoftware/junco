import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { uniqueDestPath } from "../src/uniqueDest.js";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "junco-uniq-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("uniqueDestPath", () => {
  it("returns the bare path when nothing collides", () => {
    const d = tmp();
    expect(uniqueDestPath(d, "a.md")).toBe(join(d, "a.md"));
  });

  it("appends -2 on the first collision, preserving the extension", () => {
    const d = tmp();
    writeFileSync(join(d, "a.md"), "x", "utf8");
    expect(uniqueDestPath(d, "a.md")).toBe(join(d, "a-2.md"));
  });

  it("walks -2, -3, … until a free name is found", () => {
    const d = tmp();
    writeFileSync(join(d, "a.md"), "x", "utf8");
    writeFileSync(join(d, "a-2.md"), "x", "utf8");
    expect(uniqueDestPath(d, "a.md")).toBe(join(d, "a-3.md"));
  });

  it("handles an extensionless name", () => {
    const d = tmp();
    writeFileSync(join(d, "README"), "x", "utf8");
    expect(uniqueDestPath(d, "README")).toBe(join(d, "README-2"));
  });
});
