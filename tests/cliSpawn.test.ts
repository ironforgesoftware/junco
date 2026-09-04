import { describe, it, expect } from "vitest";
import type { spawn } from "node:child_process";
import { spawnCli } from "../src/cliSpawn.js";
import { fakeSpawn } from "./helpers/fakeSpawn.js";

describe("spawnCli", () => {
  it("spawns node <cliPath> <argv> and merges stdout+stderr into output", async () => {
    const { spawnFn, calls } = fakeSpawn((c) => {
      c.stdout.emit("data", Buffer.from("queued\n"));
      c.stderr.emit("data", Buffer.from("warn\n"));
      c.emit("close", 0);
    });
    const r = await spawnCli(["submit", "/d/t.md"], { spawnFn, cliPath: "/dist/cli.js" });
    expect(calls[0]).toEqual(["/dist/cli.js", "submit", "/d/t.md"]);
    expect(r).toEqual({ code: 0, output: "queued\nwarn\n", timedOut: false });
  });

  it("times out with SIGKILL and code null", async () => {
    const { spawnFn } = fakeSpawn(() => {});
    const r = await spawnCli(["status"], { spawnFn, cliPath: "/dist/cli.js", timeoutMs: 20 });
    expect(r.timedOut).toBe(true);
    expect(r.code).toBeNull();
  });

  // Both failure branches of "resolves ALWAYS": these were reached only
  // through tuiCliRunner's delegation test, never against spawnCli itself.
  it("a spawn that THROWS resolves with the message as output, never rejects", async () => {
    const spawnFn = (() => {
      throw new Error("EACCES");
    }) as unknown as typeof spawn;
    expect(await spawnCli(["submit", "/d/t.md"], { spawnFn, cliPath: "/dist/cli.js" })).toEqual({
      code: null,
      output: "EACCES",
      timedOut: false,
    });
  });

  it("a process 'error' event settles with code null and the message appended", async () => {
    const { spawnFn } = fakeSpawn((c) => {
      c.stdout.emit("data", Buffer.from("partial\n"));
      c.emit("error", new Error("ENOENT"));
      // A close AFTER the error must not re-settle the promise.
      c.emit("close", 0);
    });
    expect(await spawnCli(["status"], { spawnFn, cliPath: "/dist/cli.js" })).toEqual({
      code: null,
      output: "partial\nENOENT",
      timedOut: false,
    });
  });
});
