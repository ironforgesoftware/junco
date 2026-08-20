import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ticketState, findTicketFile } from "../src/ticketDeps.js";
import type { Paths } from "../src/types.js";

let root: string;
let paths: Paths;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "junco-deps-"));
  paths = {
    inbox: join(root, "inbox"),
    processing: join(root, "processing"),
    done: join(root, "done"),
    failed: join(root, "failed"),
  };
  for (const d of Object.values(paths)) mkdirSync(d, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("ticketState", () => {
  it("absent when the id is nowhere", () => {
    expect(ticketState(paths, "t1")).toBe("absent");
  });

  it("resolves each directory by exact filename", () => {
    writeFileSync(join(paths.inbox, "t1.md"), "x");
    expect(ticketState(paths, "t1")).toBe("inbox");
  });

  it("matches through the claim-stamp prefix", () => {
    writeFileSync(join(paths.processing, "2026-08-20T1200Z__t1.md"), "x");
    expect(ticketState(paths, "t1")).toBe("processing");
  });

  it("matches worker suffixes: -r1 (requeue) and -2 (uniqueDest)", () => {
    writeFileSync(join(paths.inbox, "t1-r1.md"), "x");
    expect(ticketState(paths, "t1")).toBe("inbox");
    rmSync(join(paths.inbox, "t1-r1.md"));
    writeFileSync(join(paths.done, "2026-08-20T1200Z__t1-2.md"), "x");
    expect(ticketState(paths, "t1")).toBe("done");
  });

  it("does NOT match a different id sharing a prefix", () => {
    writeFileSync(join(paths.done, "t1-extra.md"), "x");
    expect(ticketState(paths, "t1")).toBe("absent");
  });

  it("precedence: done > processing > inbox > failed (satisfaction is monotone)", () => {
    writeFileSync(join(paths.failed, "t1.md"), "x");
    writeFileSync(join(paths.inbox, "t1-r1.md"), "x");
    expect(ticketState(paths, "t1")).toBe("inbox");
    writeFileSync(join(paths.done, "2026-08-20T1200Z__t1.md"), "x");
    expect(ticketState(paths, "t1")).toBe("done");
  });

  it("findTicketFile returns the matched path", () => {
    const p = join(paths.done, "2026-08-20T1200Z__t1.md");
    writeFileSync(p, "x");
    expect(findTicketFile(paths.done, "t1")).toBe(p);
  });

  it("rethrows ENOTDIR when a queue dir path is a file, not a directory", () => {
    // Create a FILE where a directory is expected
    rmSync(paths.done, { recursive: true, force: true });
    writeFileSync(paths.done, "x");
    // ticketState should throw ENOTDIR, not silently return "absent"
    expect(() => ticketState(paths, "t1")).toThrow(/ENOTDIR/);
  });

  it("missing queue directory resolves to absent", () => {
    // Delete the directory
    rmSync(paths.done, { recursive: true, force: true });
    // Should resolve to "absent" (not throw), since ENOENT is expected
    expect(ticketState(paths, "t1")).toBe("absent");
  });
});
