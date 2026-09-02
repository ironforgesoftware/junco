import { describe, it, expect } from "vitest";
import { buildSandbox, toolOptionsFor } from "../src/agent/sandbox/index.js";
import { noneBackend } from "../src/agent/sandbox/backend.js";
import { makeOpLock, lockOps } from "../src/agent/sandbox/opLock.js";
import { SandboxViolation } from "../src/agent/sandbox/pathJail.js";
import type { SandboxPolicy } from "../src/agent/sandbox/policy.js";

// Synthetic, non-existent roots: canonicalize() realpaths whatever exists, and
// on macOS a real /home resolves to /System/Volumes/Data/home — which would
// silently miss a deny rule spelled /home/... and turn the probes below green.
const policy: SandboxPolicy = {
  writableRoots: ["/work/tree"],
  readDenyPaths: ["/sbxroot/home/x/.ssh"],
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
  it("wires read/write/edit/ls/find/grep operations to the path jail", async () => {
    // One target denies every tool: under readDenyPaths for the read jail and
    // outside writableRoots for the write jail. "Wired" means "must throw".
    const denied = "/sbxroot/home/x/.ssh/id_rsa";
    const probes: Record<string, (ops: any) => Promise<unknown>> = {
      read: (o) => o.readFile(denied),
      write: (o) => o.writeFile(denied, ""),
      edit: (o) => o.readFile(denied),
      ls: (o) => o.readdir(denied),
      find: (o) => o.glob("*", denied, { ignore: [], limit: 1 }),
      grep: (o) => o.readFile(denied),
    };
    for (const [name, probe] of Object.entries(probes)) {
      const o = toolOptionsFor(name, "/work/tree", noneBackend, policy) as any;
      await expect(probe(o.operations)).rejects.toBeInstanceOf(SandboxViolation);
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

  it("threads appendSystemPrompt into the loader as an override plus the four no* flags; absent, the args are unchanged", () => {
    const { factories, loaderOpts } = fakeFactories();
    buildSandbox(factories as any, {
      cwd: "/work/tree",
      toolNames: ["read"],
      backend: noneBackend,
      policy,
      home: "/home/x",
      appendSystemPrompt: "X",
    });
    expect(loaderOpts[0]).toMatchObject({
      cwd: "/work/tree",
      agentDir: "/home/x/.pi/agent",
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    expect(typeof loaderOpts[0].appendSystemPromptOverride).toBe("function");
    expect(loaderOpts[0].appendSystemPromptOverride([])).toEqual(["X"]);

    const { factories: factories2, loaderOpts: loaderOpts2 } = fakeFactories();
    buildSandbox(factories2 as any, {
      cwd: "/work/tree",
      toolNames: ["read"],
      backend: noneBackend,
      policy,
      home: "/home/x",
    });
    expect(loaderOpts2[0]).toEqual({
      cwd: "/work/tree",
      agentDir: "/home/x/.pi/agent",
      noExtensions: true,
    });
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
