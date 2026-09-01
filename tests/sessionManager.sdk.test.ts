import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeSessionManager } from "../src/agent/session.js";

// Uses the installed SDK's SessionManager on a tmp dir — a file contract we
// depend on (spec 2026-09-01 §2.1), not a network or model touch.
describe("makeSessionManager (SDK file-backed sessions under a junco-owned dir)", () => {
  it("create writes the session file under `dir` and open reads it back", async () => {
    const dir = mkdtempSync(join(tmpdir(), "junco-chat-sm-"));
    const created = await makeSessionManager({ create: { cwd: dir, dir } });
    expect(created.file.startsWith(dir)).toBe(true);
    expect(typeof created.manager).toBe("object");
    const opened = await makeSessionManager({ open: { file: created.file, dir, cwd: dir } });
    expect(opened.file).toBe(created.file);
  });
  it("open on a missing path never throws — it yields a fresh session at that path (the caller decides what a missing file means)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "junco-chat-sm-"));
    const thatPath = join(dir, "nope.jsonl");
    const opened = await makeSessionManager({ open: { file: thatPath, dir, cwd: dir } });
    expect(opened.file).toBe(thatPath);
    expect(typeof opened.manager).toBe("object");
  });
});
