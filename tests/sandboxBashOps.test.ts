import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { makeSandboxedBashOperations } from "../src/agent/sandbox/bashOps.js";
import { noneBackend, seatbeltBackend } from "../src/agent/sandbox/backend.js";
import type { SandboxPolicy } from "../src/agent/sandbox/policy.js";

const policy: SandboxPolicy = {
  writableRoots: ["/work/tree"],
  readDenyPaths: [],
  network: false,
  scratchDir: "/tmp/scratch",
};

/** A fake child process the fake spawn returns; drive it in the test. */
function fakeProc() {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  return proc;
}

describe("makeSandboxedBashOperations", () => {
  it("spawns the backend argv, scrubs env, redirects TMPDIR to scratch", async () => {
    const proc = fakeProc();
    const spawnFn = vi.fn(() => proc) as any;
    const ops = makeSandboxedBashOperations(seatbeltBackend, policy, {
      spawnFn,
      env: () => ({ PATH: "/usr/bin", GH_TOKEN: "leak" }),
    });
    const p = ops.exec("echo hi", "/work/tree", { onData: () => {} });
    proc.stdout.emit("data", Buffer.from("hi\n"));
    proc.emit("close", 0);
    const res = await p;

    expect(res.exitCode).toBe(0);
    const [bin, args, spawnOpts] = spawnFn.mock.calls[0];
    expect(bin).toBe("sandbox-exec");
    expect(args).toContain("/bin/bash");
    expect(spawnOpts.env.GH_TOKEN).toBeUndefined();
    expect(spawnOpts.env.PATH).toBe("/usr/bin");
    expect(spawnOpts.env.TMPDIR).toBe("/tmp/scratch");
    expect(spawnOpts.cwd).toBe("/work/tree");
  });

  it("streams stdout+stderr through onData", async () => {
    const proc = fakeProc();
    const chunks: string[] = [];
    const ops = makeSandboxedBashOperations(noneBackend, policy, { spawnFn: (() => proc) as any });
    const p = ops.exec("x", "/work/tree", { onData: (d) => chunks.push(d.toString()) });
    proc.stdout.emit("data", Buffer.from("out"));
    proc.stderr.emit("data", Buffer.from("err"));
    proc.emit("close", 3);
    const res = await p;
    expect(res.exitCode).toBe(3);
    expect(chunks.join("")).toBe("outerr");
  });

  it("kills the process on timeout and resolves exitCode null", async () => {
    vi.useFakeTimers();
    const proc = fakeProc();
    const ops = makeSandboxedBashOperations(noneBackend, policy, { spawnFn: (() => proc) as any });
    const p = ops.exec("sleep", "/work/tree", { onData: () => {}, timeout: 1000 });
    vi.advanceTimersByTime(1001);
    expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
    proc.emit("close", null);
    const res = await p;
    expect(res.exitCode).toBeNull();
    vi.useRealTimers();
  });

  it("kills on abort signal", async () => {
    const proc = fakeProc();
    const ac = new AbortController();
    const ops = makeSandboxedBashOperations(noneBackend, policy, { spawnFn: (() => proc) as any });
    const p = ops.exec("x", "/work/tree", { onData: () => {}, signal: ac.signal });
    ac.abort();
    expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
    proc.emit("close", null);
    await p;
  });
});
