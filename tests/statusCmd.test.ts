import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runStatusCommand, fmtUptime } from "../src/statusCmd.js";
import type { Config } from "../src/types.js";

describe("fmtUptime", () => {
  it("renders s / m / h forms", () => {
    expect(fmtUptime(42)).toBe("42s");
    expect(fmtUptime(150)).toBe("2m30s");
    expect(fmtUptime(120)).toBe("2m");
    expect(fmtUptime(8010)).toBe("2h13m");
  });
});

describe("runStatusCommand", () => {
  let root: string;
  let cfg: Config;
  let out: string[];
  const print = (s: string): void => {
    out.push(s);
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "junco-status-"));
    for (const d of ["inbox", "processing", "done", "failed"])
      mkdirSync(join(root, d), { recursive: true });
    writeFileSync(join(root, "inbox", "a.md"), "x");
    writeFileSync(join(root, "failed", "b.md"), "x");
    cfg = {
      vaultRoot: root,
      juncoSubdir: "",
      healthHost: "127.0.0.1",
      healthPort: 8787,
    } as unknown as Config;
    out = [];
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("daemon running: renders /health fields + queue counts", async () => {
    const fetchFn = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        status: "ok",
        ready: true,
        metrics: {
          pid: 42,
          uptimeSeconds: 150,
          currentTicket: "t-1",
          currentTickets: ["t-1"],
          tasksProcessed: 3,
          tasksSucceeded: 2,
          tasksFailed: 1,
          totalTokensIn: 10,
          totalTokensOut: 20,
          lastTaskStatus: "completed",
          lastTaskAt: "2026-06-10T12:00:00Z",
        },
      }),
    })) as unknown as typeof fetch;
    const code = await runStatusCommand(cfg, { fetchFn, printFn: print, lockHolderFn: () => 42 });
    expect(code).toBe(0);
    const text = out.join("");
    expect(text).toMatch(/daemon: {4}running \(pid 42, up 2m30s\)/);
    expect(text).toMatch(/endpoint: {2}ready/);
    expect(text).toMatch(/current: {3}t-1/);
    expect(text).toMatch(/processed: 3 \(2 ok \/ 1 failed\)/);
    expect(text).toMatch(/inbox 1 · processing 0 · done 0 · failed 1/);
  });

  it("shows a bridge line when the daemon reports bridge sweeps", async () => {
    const fetchFn = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        status: "ok",
        ready: true,
        metrics: {
          pid: 42,
          uptimeSeconds: 150,
          currentTickets: [],
          tasksProcessed: 0,
          tasksSucceeded: 0,
          tasksFailed: 0,
          totalTokensIn: 0,
          totalTokensOut: 0,
          lastTaskStatus: null,
          lastTaskAt: null,
          bridgeSweeps: 5,
          ticketsBridged: 2,
          bridgeErrors: 1,
          lastBridgeSweepAt: "2026-07-02T00:00:00.000Z",
        },
      }),
    })) as unknown as typeof fetch;
    const code = await runStatusCommand(cfg, { fetchFn, printFn: print, lockHolderFn: () => 42 });
    expect(code).toBe(0);
    expect(out.join("")).toMatch(/bridge: {4}5 sweeps · 2 bridged · 1 errors/);
  });

  it("omits the bridge line when the bridge has never swept", async () => {
    const fetchFn = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        status: "ok",
        ready: true,
        metrics: {
          pid: 42,
          uptimeSeconds: 1,
          currentTickets: [],
          tasksProcessed: 0,
          tasksSucceeded: 0,
          tasksFailed: 0,
          totalTokensIn: 0,
          totalTokensOut: 0,
          lastTaskStatus: null,
          lastTaskAt: null,
          bridgeSweeps: 0,
          ticketsBridged: 0,
          bridgeErrors: 0,
          lastBridgeSweepAt: null,
        },
      }),
    })) as unknown as typeof fetch;
    await runStatusCommand(cfg, { fetchFn, printFn: print, lockHolderFn: () => 42 });
    expect(out.join("")).not.toMatch(/bridge:/);
  });

  it("daemon down: says not running and still prints queue counts", async () => {
    const fetchFn = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const code = await runStatusCommand(cfg, { fetchFn, printFn: print, lockHolderFn: () => null });
    expect(code).toBe(0);
    const text = out.join("");
    expect(text).toMatch(/daemon: {4}not running/);
    expect(text).toMatch(/inbox 1/);
  });

  it("lock held but /health unreachable → 'not responding'", async () => {
    const fetchFn = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const code = await runStatusCommand(cfg, {
      fetchFn,
      printFn: print,
      lockHolderFn: () => 777,
      lockPath: "/x/worker.lock",
    });
    expect(code).toBe(0);
    expect(out.join("")).toMatch(/not responding \(lock held by pid 777/);
  });
});
