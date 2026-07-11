import { describe, it, expect } from "vitest";
import { buildSandbox, toolsOptionsFor } from "../src/agent/sandbox/index.js";
import { noneBackend } from "../src/agent/sandbox/backend.js";
import type { SandboxPolicy } from "../src/agent/sandbox/policy.js";

const policy: SandboxPolicy = {
  writableRoots: ["/work/tree"],
  readDenyPaths: ["/home/x/.ssh"],
  network: false,
  scratchDir: "/tmp/s",
};

describe("toolsOptionsFor", () => {
  it("wires bash operations for bash", () => {
    const o = toolsOptionsFor("bash", "/work/tree", noneBackend, policy) as any;
    expect(typeof o.bash.operations.exec).toBe("function");
  });
  it("wires read/write/edit/ls/find/grep operations", () => {
    for (const name of ["read", "write", "edit", "ls", "find", "grep"] as const) {
      const o = toolsOptionsFor(name, "/work/tree", noneBackend, policy) as any;
      expect(o[name].operations).toBeTruthy();
    }
  });
});

describe("buildSandbox", () => {
  it("builds one custom tool per allowlisted name and a noExtensions loader", () => {
    const created: Array<{ name: string; cwd: string; options: any }> = [];
    const loaderOpts: any[] = [];
    const factories = {
      createToolDefinition: (name: string, cwd: string, options: unknown) => {
        created.push({ name, cwd, options });
        return { __tool: name };
      },
      DefaultResourceLoader: class {
        constructor(o: any) {
          loaderOpts.push(o);
        }
      },
    };
    const res = buildSandbox(factories as any, {
      cwd: "/work/tree",
      toolNames: ["read", "bash", "write"],
      backend: noneBackend,
      policy,
      home: "/home/x",
    });
    expect(created.map((c) => c.name)).toEqual(["read", "bash", "write"]);
    expect(res.customTools).toEqual([{ __tool: "read" }, { __tool: "bash" }, { __tool: "write" }]);
    expect(loaderOpts[0]).toMatchObject({
      cwd: "/work/tree",
      agentDir: "/home/x/.pi/agent",
      noExtensions: true,
    });
    expect(res.resourceLoader).toBeInstanceOf(factories.DefaultResourceLoader);
  });

  it("ignores tool names the SDK does not know (e.g. todo_write)", () => {
    const factories = {
      createToolDefinition: (name: string) => ({ __tool: name }),
      DefaultResourceLoader: class {
        constructor(_: any) {}
      },
    };
    const res = buildSandbox(factories as any, {
      cwd: "/work/tree",
      toolNames: ["read", "todo_write"],
      backend: noneBackend,
      policy,
      home: "/home/x",
    });
    expect(res.customTools).toEqual([{ __tool: "read" }]);
  });
});
