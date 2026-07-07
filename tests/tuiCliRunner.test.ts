import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { PALETTE_COMMANDS, runCliCommand, type CliRunnerDeps } from "../src/tui/cliRunner.js";

/** Minimal fake ChildProcess: emit stdout/stderr data + close/error on cue. */
function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: (sig?: string) => boolean;
    killed: boolean;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    // A killed process still closes — mirror the real lifecycle.
    setTimeout(() => child.emit("close", null), 1);
    return true;
  };
  return child;
}

function deps(child: ReturnType<typeof fakeChild>, timeoutMs = 5_000) {
  const spawned: { cmd: string; args: string[] }[] = [];
  const d: CliRunnerDeps = {
    cliPath: "/fake/dist/cli.js",
    timeoutMs,
    spawnFn: ((cmd: string, args: string[]) => {
      spawned.push({ cmd, args });
      return child;
    }) as never,
  };
  return { d, spawned };
}

describe("PALETTE_COMMANDS roster", () => {
  it("carries 11 runnable and 3 excluded-with-reason entries", () => {
    const runnable = PALETTE_COMMANDS.filter((c) => c.excluded === null);
    const excluded = PALETTE_COMMANDS.filter((c) => c.excluded !== null);
    expect(runnable.map((c) => c.name).sort()).toEqual(
      [
        "doctor",
        "inbox-path",
        "list",
        "logs",
        "restart",
        "retry",
        "run-once",
        "schema",
        "service",
        "status",
        "submit",
      ].sort(),
    );
    expect(excluded.map((c) => c.name).sort()).toEqual(["dashboard", "init", "start"]);
    for (const c of excluded) expect((c.excluded ?? "").length).toBeGreaterThan(4);
  });

  it("logs runs bounded by default (never -f)", () => {
    const logs = PALETTE_COMMANDS.find((c) => c.name === "logs")!;
    expect(logs.defaultArgs).toEqual(["-n", "200"]);
    expect(logs.defaultArgs).not.toContain("-f");
  });
});

describe("runCliCommand", () => {
  it("spawns node + cliPath + subcommand + args + --config, merges output in order", async () => {
    const child = fakeChild();
    const { d, spawned } = deps(child);
    const p = runCliCommand("/cfg/config.toml", "list", ["failed"], d);
    child.stdout.emit("data", Buffer.from("one\n"));
    child.stderr.emit("data", Buffer.from("warn!\n"));
    child.stdout.emit("data", Buffer.from("two\n"));
    child.emit("close", 0);
    const r = await p;
    expect(spawned[0].cmd).toBe(process.execPath);
    expect(spawned[0].args).toEqual([
      "/fake/dist/cli.js",
      "list",
      "failed",
      "--config",
      "/cfg/config.toml",
    ]);
    expect(r).toEqual({ code: 0, output: "one\nwarn!\ntwo\n", timedOut: false });
  });

  it("non-zero exit surfaces the code", async () => {
    const child = fakeChild();
    const { d } = deps(child);
    const p = runCliCommand("/cfg/config.toml", "doctor", [], d);
    child.stderr.emit("data", Buffer.from("NOT ready\n"));
    child.emit("close", 1);
    expect(await p).toEqual({ code: 1, output: "NOT ready\n", timedOut: false });
  });

  it("kills at the timeout and reports timedOut", async () => {
    const child = fakeChild();
    const { d } = deps(child, 30); // never closes on its own
    const r = await runCliCommand("/cfg/config.toml", "run-once", [], d);
    expect(child.killed).toBe(true);
    expect(r.timedOut).toBe(true);
    expect(r.code).toBeNull();
  });

  it("spawn error (ENOENT) resolves with the message, never throws", async () => {
    const child = fakeChild();
    const { d } = deps(child);
    const p = runCliCommand("/cfg/config.toml", "status", [], d);
    child.emit("error", new Error("spawn node ENOENT"));
    const r = await p;
    expect(r.code).toBeNull();
    expect(r.output).toContain("ENOENT");
  });
});
