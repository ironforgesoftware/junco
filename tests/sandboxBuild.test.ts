import { describe, it, expect } from "vitest";
import { buildSandbox, toolOptionsFor } from "../src/agent/sandbox/index.js";
import { noneBackend } from "../src/agent/sandbox/backend.js";
import { makeOpLock, lockOps } from "../src/agent/sandbox/opLock.js";
import type { SandboxPolicy } from "../src/agent/sandbox/policy.js";

const policy: SandboxPolicy = {
  writableRoots: ["/work/tree"],
  readDenyPaths: ["/home/x/.ssh"],
  readDenyFiles: [],
  readAllowPaths: [],
  network: false,
  scratchDir: "/tmp/s",
  bashTimeoutMs: undefined,
};

describe("toolOptionsFor", () => {
  it("wires bash operations for bash", () => {
    const o = toolOptionsFor("bash", "/work/tree", noneBackend, policy) as any;
    expect(typeof o.operations.exec).toBe("function");
  });
  it("wires read/write/edit/ls/find/grep operations", () => {
    for (const name of ["read", "write", "edit", "ls", "find", "grep"] as const) {
      const o = toolOptionsFor(name, "/work/tree", noneBackend, policy) as any;
      expect(o.operations).toBeTruthy();
    }
  });
});

/** Fake the seven per-tool factories + DefaultResourceLoader, recording calls. */
function fakeFactories() {
  const calls: Array<{ name: string; cwd: string; options: any }> = [];
  const loaderOpts: any[] = [];
  const mk =
    (name: string) =>
    (cwd: string, options: unknown): unknown => {
      calls.push({ name, cwd, options });
      return { __tool: name };
    };
  const factories = {
    createBashToolDefinition: mk("bash"),
    createReadToolDefinition: mk("read"),
    createWriteToolDefinition: mk("write"),
    createEditToolDefinition: mk("edit"),
    createGrepToolDefinition: mk("grep"),
    createFindToolDefinition: mk("find"),
    createLsToolDefinition: mk("ls"),
    DefaultResourceLoader: class {
      constructor(o: any) {
        loaderOpts.push(o);
      }
    },
  };
  return { factories, calls, loaderOpts };
}

describe("buildSandbox", () => {
  it("builds one custom tool per allowlisted name and a noExtensions loader", () => {
    const { factories, calls, loaderOpts } = fakeFactories();
    const res = buildSandbox(factories as any, {
      cwd: "/work/tree",
      toolNames: ["read", "bash", "write"],
      backend: noneBackend,
      policy,
      home: "/home/x",
    });
    expect(calls.map((c) => c.name)).toEqual(["read", "bash", "write"]);
    expect(calls.every((c) => c.cwd === "/work/tree")).toBe(true);
    expect(res.customTools).toEqual([{ __tool: "read" }, { __tool: "bash" }, { __tool: "write" }]);
    expect(loaderOpts[0]).toMatchObject({
      cwd: "/work/tree",
      agentDir: "/home/x/.pi/agent",
      noExtensions: true,
    });
    expect(res.resourceLoader).toBeInstanceOf(factories.DefaultResourceLoader);
  });

  it("ignores tool names the SDK does not know (e.g. todo_write)", () => {
    const { factories, calls } = fakeFactories();
    const res = buildSandbox(factories as any, {
      cwd: "/work/tree",
      toolNames: ["read", "todo_write"],
      backend: noneBackend,
      policy,
      home: "/home/x",
    });
    expect(calls.map((c) => c.name)).toEqual(["read"]);
    expect(res.customTools).toEqual([{ __tool: "read" }]);
  });
});

describe("sandbox op mutual-exclusion (#159)", () => {
  it("a bash exec never overlaps an fs-op", async () => {
    const lock = makeOpLock();
    const events: string[] = [];
    const gate = (() => {
      let r!: () => void;
      const p = new Promise<void>((x) => (r = x));
      return { p, r };
    })();

    const fs = lockOps(
      {
        writeFile: async (): Promise<void> => {
          events.push("fs-in");
          events.push("fs-out");
        },
      },
      lock,
      "shared",
    );
    const bash = lockOps(
      {
        exec: async (): Promise<{ exitCode: number }> => {
          events.push("bash-in");
          await gate.p;
          events.push("bash-out");
          return { exitCode: 0 };
        },
      },
      lock,
      "exclusive",
    );

    const b = (bash as { exec: () => Promise<unknown> }).exec();
    await Promise.resolve(); // let bash acquire exclusive
    const f = (fs as { writeFile: () => Promise<void> }).writeFile(); // must queue behind bash
    gate.r();
    await Promise.all([b, f]);
    // bash fully brackets before fs starts — no interleave
    expect(events).toEqual(["bash-in", "bash-out", "fs-in", "fs-out"]);
  });
});
