import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runRmCommand } from "../src/rmCmd.js";
import type { Config } from "../src/types.js";

describe("runRmCommand", () => {
  let root: string;
  let cfg: Config;
  let out: string[];
  const queued = "2026-06-10T1200Z__fix-thing.md";
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "junco-rm-"));
    for (const d of ["inbox", "processing", "done", "failed"])
      mkdirSync(join(root, d), { recursive: true });
    writeFileSync(join(root, "inbox", queued), "---\nid: fix-thing\n---\nfix\n", "utf8");
    cfg = { queueRoot: root, defaultTimeoutMinutes: 30 } as unknown as Config;
    out = [];
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("deletes a fuzzy-matched inbox ticket and exits 0", async () => {
    const code = await runRmCommand(cfg, ["fix-thing"], { printFn: (s) => out.push(s) });
    expect(code).toBe(0);
    expect(existsSync(join(root, "inbox", queued))).toBe(false);
    expect(out.join("")).toMatch(/removed:/);
  });

  it("ambiguous substring → exit 2, nothing deleted", async () => {
    writeFileSync(join(root, "inbox", "fix-thing-2.md"), "x", "utf8");
    const code = await runRmCommand(cfg, ["fix"], { printFn: (s) => out.push(s) });
    expect(code).toBe(2);
    expect(readdirSync(join(root, "inbox"))).toHaveLength(2);
    expect(out.join("")).toMatch(/ambiguous/);
  });

  it("no inbox match → exit 0 with the truthful 'may reappear' message", async () => {
    const code = await runRmCommand(cfg, ["nonesuch"], { printFn: (s) => out.push(s) });
    expect(code).toBe(0);
    expect(out.join("")).toMatch(/not present in inbox — it may be claimed or mid-requeue/);
  });

  it("ENOENT at unlink (daemon claimed it mid-delete) → exit 0, 'may reappear'", async () => {
    const enoent = Object.assign(new Error("gone"), { code: "ENOENT" });
    const code = await runRmCommand(cfg, ["fix-thing"], {
      printFn: (s) => out.push(s),
      unlinkFn: () => {
        throw enoent;
      },
    });
    expect(code).toBe(0);
    expect(out.join("")).toMatch(/could reappear/);
  });

  it("refuses an out-of-inbox / processing name outright → exit 2, no delete", async () => {
    for (const bad of ["../processing/x", "a/b", "/etc/passwd"]) {
      const code = await runRmCommand(cfg, [bad], { printFn: (s) => out.push(s) });
      expect(code).toBe(2);
      expect(out.join("")).toMatch(/not a plain inbox ticket name/);
    }
    expect(existsSync(join(root, "inbox", queued))).toBe(true);
  });

  it("no name → usage + exit 2", async () => {
    expect(await runRmCommand(cfg, [], { printFn: (s) => out.push(s) })).toBe(2);
    expect(out.join("")).toMatch(/Usage: junco rm/);
  });
});
