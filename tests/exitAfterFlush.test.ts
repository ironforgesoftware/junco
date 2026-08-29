/**
 * Tests for `exitAfterFlush` (src/cli.ts) — the top-level exit must wait for
 * stdout to drain. Pipe writes are asynchronous in Node, so exiting straight
 * from `run()`'s resolution dropped everything past one pipe buffer (64 KB):
 * `junco transcript --json | jq` was cut mid-string.
 */
import { describe, it, expect } from "vitest";
import { exitAfterFlush } from "../src/cli.js";

describe("exitAfterFlush", () => {
  it("exits only once the queued stdout write has flushed", () => {
    const exits: number[] = [];
    const pending: (() => void)[] = [];
    exitAfterFlush(3, {
      write: (_chunk, cb) => pending.push(cb),
      exit: (code) => exits.push(code),
    });
    expect(pending).toHaveLength(1); // the write is queued…
    expect(exits).toEqual([]); // …and nothing has exited yet
    pending[0]!();
    expect(exits).toEqual([3]);
  });
});
