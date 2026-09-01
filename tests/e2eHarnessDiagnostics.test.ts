import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { snapshotDiagnostics, type Sandbox } from "./e2e/harness.js";

describe("snapshotDiagnostics (e2e harness)", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it("reads the queue listing, gh.log, and the worker.log tail from disk", () => {
    dir = mkdtempSync(join(tmpdir(), "junco-diag-"));
    const dataDir = join(dir, ".junco");
    const queueRoot = join(dataDir, "queue");
    mkdirSync(join(dataDir, "logs"), { recursive: true });
    mkdirSync(join(queueRoot, "done"), { recursive: true });

    writeFileSync(join(dataDir, "logs", "worker.log"), "line1\nline2\nline3\n");
    writeFileSync(join(dir, "gh.log"), "gh call 1\ngh call 2\n");
    writeFileSync(join(queueRoot, "done", "2026-01-01T0000Z__t1.md"), "---\nid: t1\n---\n\nbody\n");

    // Only `home`, `dataDir`, and `queueRoot` are read by snapshotDiagnostics
    // (via listQueue / readIfExists / firstExisting) — a minimal Sandbox-shaped
    // object is enough without spinning up a real sandbox.
    const sb = { home: dir, dataDir, queueRoot } as unknown as Sandbox;

    const snap = snapshotDiagnostics(sb);

    expect(snap.queue).toEqual({
      inbox: [],
      processing: [],
      done: ["2026-01-01T0000Z__t1.md"],
      failed: [],
    });
    expect(snap.ghLog).toBe("gh call 1\ngh call 2\n");
    expect(snap.workerLogTail).toContain("line3");
  });
});
