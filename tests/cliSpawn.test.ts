import { describe, it, expect } from "vitest";
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
});
