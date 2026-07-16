import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runListCommand, ticketStatusOf } from "../src/listCmd.js";
import type { Config } from "../src/types.js";

describe("ticketStatusOf", () => {
  it("reads the LAST junco-result status", () => {
    const c =
      "body\n---\n<!-- junco-result\nstatus: failed\n-->\nmore\n---\n<!-- junco-result\nstatus: completed\n-->\n";
    expect(ticketStatusOf(c)).toBe("completed");
  });
  it("null when no result block", () => expect(ticketStatusOf("plain")).toBeNull());
});

describe("runListCommand", () => {
  let root: string;
  let cfg: Config;
  let out: string[];
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "junco-list-"));
    for (const d of ["inbox", "processing", "done", "failed"])
      mkdirSync(join(root, d), { recursive: true });
    writeFileSync(join(root, "inbox", "i1.md"), "x");
    writeFileSync(
      join(root, "failed", "f1.md"),
      "x\n---\n<!-- junco-result\nstatus: timeout\n-->\n",
    );
    cfg = { queueRoot: root } as unknown as Config;
    out = [];
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("lists all four boxes by default with counts, names, ages, and terminal statuses", async () => {
    const code = await runListCommand(cfg, undefined, { printFn: (s) => out.push(s) });
    expect(code).toBe(0);
    const text = out.join("");
    expect(text).toMatch(/inbox \(1\)/);
    expect(text).toMatch(/i1\.md {2}\(\d+[smhd]\)/);
    expect(text).toMatch(/processing \(0\)/);
    expect(text).toMatch(/failed \(1\)/);
    expect(text).toMatch(/f1\.md.*\[timeout\]/);
  });

  it("lists a single box when named; unknown box → exit 2", async () => {
    expect(await runListCommand(cfg, "inbox", { printFn: (s) => out.push(s) })).toBe(0);
    expect(out.join("")).not.toMatch(/failed \(/);
    out = [];
    expect(await runListCommand(cfg, "nope", { printFn: (s) => out.push(s) })).toBe(2);
    expect(out.join("")).toMatch(/unknown box/);
  });

  it("skips an entry that vanishes between readdir and stat, not fatal (#120)", async () => {
    // A dangling symlink is returned by readdir but statSync throws ENOENT —
    // the same shape as a ticket the daemon renames out of the box mid-listing.
    symlinkSync(join(root, "inbox", "gone-target.md"), join(root, "inbox", "ghost.md"));
    const code = await runListCommand(cfg, "inbox", { printFn: (s) => out.push(s) });
    expect(code).toBe(0);
    const text = out.join("");
    // The live ticket still lists; the vanished entry is silently skipped.
    expect(text).toMatch(/i1\.md/);
    expect(text).not.toMatch(/ghost\.md/);
    expect(text).toMatch(/inbox \(1\)/);
  });

  it("caps each box at the limit and reports the remainder", async () => {
    for (let i = 0; i < 5; i++) writeFileSync(join(root, "inbox", `bulk-${i}.md`), "x");
    const code = await runListCommand(cfg, "inbox", { printFn: (s) => out.push(s), limit: 3 });
    expect(code).toBe(0);
    const text = out.join("");
    expect(text).toMatch(/inbox \(6\)/);
    expect(text).toMatch(/… 3 more/);
  });
});
