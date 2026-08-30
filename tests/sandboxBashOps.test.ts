import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { makeSandboxedBashOperations } from "../src/agent/sandbox/bashOps.js";
import { noneBackend, seatbeltBackend } from "../src/agent/sandbox/backend.js";
import type { SandboxPolicy } from "../src/agent/sandbox/policy.js";

const policy: SandboxPolicy = {
  writableRoots: ["/work/tree"],
  readDenyPaths: [],
  readDenyFiles: [],
  readAllowPaths: [],
  network: false,
  scratchDir: "/tmp/scratch",
  bashTimeoutMs: undefined,
};

/** A fake child process the fake spawn returns; drive it in the test. */
function fakeProc() {
  const proc = new EventEmitter() as any;
  proc.pid = 4242;
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

  it("treats the agent's timeout as SECONDS (Pi passes the raw schema value) and rejects with timeout:<secs>", async () => {
    vi.useFakeTimers();
    const proc = fakeProc();
    const kills: Array<[number, string]> = [];
    const ops = makeSandboxedBashOperations(noneBackend, policy, {
      spawnFn: (() => proc) as any,
      killFn: (pid, sig) => kills.push([pid, sig]),
    });
    const p = ops.exec("sleep", "/work/tree", { onData: () => {}, timeout: 2 });
    vi.advanceTimersByTime(1999);
    expect(kills).toEqual([]); // 2 s, not 2 ms
    vi.advanceTimersByTime(2);
    expect(kills).toContainEqual([-4242, "SIGKILL"]); // negative pid = the group
    proc.emit("close", null);
    await expect(p).rejects.toThrow("timeout:2");
    vi.useRealTimers();
  });

  it("applies the policy's default ceiling when the agent passes no timeout", async () => {
    vi.useFakeTimers();
    const proc = fakeProc();
    const kills: Array<[number, string]> = [];
    const ops = makeSandboxedBashOperations(
      noneBackend,
      { ...policy, bashTimeoutMs: 3_000 },
      {
        spawnFn: (() => proc) as any,
        killFn: (pid, sig) => kills.push([pid, sig]),
      },
    );
    const p = ops.exec("sleep", "/work/tree", { onData: () => {} });
    vi.advanceTimersByTime(3_001);
    expect(kills).toContainEqual([-4242, "SIGKILL"]);
    proc.emit("close", null);
    await expect(p).rejects.toThrow("timeout:3");
    vi.useRealTimers();
  });

  it("the agent's explicit timeout overrides the default ceiling in both directions", async () => {
    vi.useFakeTimers();
    const proc = fakeProc();
    const kills: Array<[number, string]> = [];
    const ops = makeSandboxedBashOperations(
      noneBackend,
      { ...policy, bashTimeoutMs: 1_000 },
      {
        spawnFn: (() => proc) as any,
        killFn: (pid, sig) => kills.push([pid, sig]),
      },
    );
    const p = ops.exec("sleep", "/work/tree", { onData: () => {}, timeout: 5 });
    vi.advanceTimersByTime(4_999);
    expect(kills).toEqual([]); // the 1 s default did not fire
    vi.advanceTimersByTime(2);
    expect(kills).toContainEqual([-4242, "SIGKILL"]);
    proc.emit("close", null);
    await expect(p).rejects.toThrow("timeout:5");
    vi.useRealTimers();
  });

  it("a non-positive or non-finite explicit timeout counts as absent — the default ceiling still applies", async () => {
    vi.useFakeTimers();
    for (const bad of [0, -5, Number.NaN]) {
      const proc = fakeProc();
      const kills: Array<[number, string]> = [];
      const ops = makeSandboxedBashOperations(
        noneBackend,
        { ...policy, bashTimeoutMs: 3_000 },
        {
          spawnFn: (() => proc) as any,
          killFn: (pid, sig) => kills.push([pid, sig]),
        },
      );
      const p = ops.exec("sleep", "/work/tree", { onData: () => {}, timeout: bad });
      vi.advanceTimersByTime(3_001);
      expect(kills).toContainEqual([-4242, "SIGKILL"]);
      proc.emit("close", null);
      await expect(p).rejects.toThrow("timeout:3");
    }
    vi.useRealTimers();
  });

  it("a sub-second ceiling reports at least 1 second", async () => {
    vi.useFakeTimers();
    const proc = fakeProc();
    const ops = makeSandboxedBashOperations(
      noneBackend,
      { ...policy, bashTimeoutMs: 400 },
      {
        spawnFn: (() => proc) as any,
        killFn: () => {},
      },
    );
    const p = ops.exec("sleep", "/work/tree", { onData: () => {} });
    vi.advanceTimersByTime(401);
    proc.emit("close", null);
    await expect(p).rejects.toThrow("timeout:1");
    vi.useRealTimers();
  });

  it("clamps an over-2^31-1 ms limit instead of letting Node fire it after 1 ms", async () => {
    vi.useFakeTimers();
    const proc = fakeProc();
    const kills: Array<[number, string]> = [];
    const ops = makeSandboxedBashOperations(noneBackend, policy, {
      spawnFn: (() => proc) as any,
      killFn: (pid, sig) => kills.push([pid, sig]),
    });
    const p = ops.exec("sleep", "/work/tree", { onData: () => {}, timeout: 9_999_999 });
    vi.advanceTimersByTime(60_000);
    expect(kills).toEqual([]); // NOT killed after 1 ms
    vi.advanceTimersByTime(2_147_483_647);
    expect(kills).toContainEqual([-4242, "SIGKILL"]);
    proc.emit("close", null);
    await expect(p).rejects.toThrow("timeout:2147484");
    vi.useRealTimers();
  });

  it("reports 'aborted' when the session aborts after the timer already fired", async () => {
    vi.useFakeTimers();
    const proc = fakeProc();
    const ac = new AbortController();
    const ops = makeSandboxedBashOperations(
      noneBackend,
      { ...policy, bashTimeoutMs: 1_000 },
      {
        spawnFn: (() => proc) as any,
        killFn: () => {},
      },
    );
    const p = ops.exec("sleep", "/work/tree", { onData: () => {}, signal: ac.signal });
    vi.advanceTimersByTime(1_001);
    ac.abort();
    proc.emit("close", null);
    await expect(p).rejects.toThrow("aborted");
    vi.useRealTimers();
  });

  it("settles on exit + grace when a reaped child's pipes never close (escaped descendant)", async () => {
    vi.useFakeTimers();
    const proc = fakeProc();
    const ops = makeSandboxedBashOperations(
      noneBackend,
      { ...policy, bashTimeoutMs: 1_000 },
      {
        spawnFn: (() => proc) as any,
        killFn: () => {},
      },
    );
    const p = ops.exec("sleep", "/work/tree", { onData: () => {} });
    vi.advanceTimersByTime(1_001); // reaped
    proc.emit("exit", null); // …but no `close` ever arrives
    vi.advanceTimersByTime(101);
    await expect(p).rejects.toThrow("timeout:1");
    vi.useRealTimers();
  });

  it("a normal exit without close does not settle early (only a reaped child takes the grace path)", async () => {
    vi.useFakeTimers();
    const proc = fakeProc();
    const ops = makeSandboxedBashOperations(noneBackend, policy, { spawnFn: (() => proc) as any });
    let settled = false;
    const p = ops.exec("x", "/work/tree", { onData: () => {} }).then(() => (settled = true));
    proc.emit("exit", 0);
    vi.advanceTimersByTime(1_000);
    await Promise.resolve();
    expect(settled).toBe(false);
    proc.emit("close", 0);
    await p;
    expect(settled).toBe(true);
    vi.useRealTimers();
  });

  it("no ceiling at all when the policy has none and the agent passes no timeout", async () => {
    vi.useFakeTimers();
    const proc = fakeProc();
    const kills: Array<[number, string]> = [];
    const ops = makeSandboxedBashOperations(
      noneBackend,
      { ...policy, bashTimeoutMs: undefined },
      {
        spawnFn: (() => proc) as any,
        killFn: (pid, sig) => kills.push([pid, sig]),
      },
    );
    const p = ops.exec("sleep", "/work/tree", { onData: () => {} });
    vi.advanceTimersByTime(3_600_000);
    expect(kills.filter(([pid]) => pid === -4242)).toEqual([]);
    proc.emit("close", 0);
    await expect(p).resolves.toEqual({ exitCode: 0 });
    vi.useRealTimers();
  });

  it("kills the process group on abort and rejects with 'aborted' (Pi renders 'Command aborted')", async () => {
    const proc = fakeProc();
    const kills: Array<[number, string]> = [];
    const ac = new AbortController();
    const ops = makeSandboxedBashOperations(noneBackend, policy, {
      spawnFn: (() => proc) as any,
      killFn: (pid, sig) => kills.push([pid, sig]),
    });
    const p = ops.exec("x", "/work/tree", { onData: () => {}, signal: ac.signal });
    ac.abort();
    expect(kills).toContainEqual([-4242, "SIGKILL"]);
    proc.emit("close", null);
    await expect(p).rejects.toThrow("aborted");
  });

  it("a command killed by something else still resolves exitCode null (not a timeout, not an abort)", async () => {
    const proc = fakeProc();
    const ops = makeSandboxedBashOperations(noneBackend, policy, { spawnFn: (() => proc) as any });
    const p = ops.exec("x", "/work/tree", { onData: () => {} });
    proc.emit("close", null); // e.g. OOM-killed
    await expect(p).resolves.toEqual({ exitCode: null });
  });

  it("spawns detached and reaps the process group on completion so a backgrounded child can't survive (#159)", async () => {
    const proc = fakeProc();
    const kills: Array<[number, string]> = [];
    const spawnFn = vi.fn(() => proc) as any;
    const ops = makeSandboxedBashOperations(noneBackend, policy, {
      spawnFn,
      killFn: (pid, sig) => kills.push([pid, sig]),
    });
    const done = ops.exec("echo hi & ", "/work/tree", { onData: () => {} });
    proc.emit("close", 0);
    await done;
    // spawned in its own process group, and the group was reaped on close
    expect(spawnFn.mock.calls[0][2].detached).toBe(true);
    expect(kills).toContainEqual([-4242, "SIGKILL"]);
  });
});
