import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultExec, defaultAccessOk } from "../src/execProbe.js";

// Pass-through recorder over the real execFile. Every caller of this seam
// injects its own execFn (doctor.ts, ghAuth.ts, wizard/detect.ts), so the
// wrapper's own options — the 10 s timeout, the env merge — had no executing
// test (#369); the recorder is the only way to observe them without waiting
// out a real timeout.
const execFileSeen = vi.hoisted(() => ({ opts: [] as any[] }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: (...args: any[]) => {
      execFileSeen.opts.push(args[2]);
      return (actual.execFile as any)(...args);
    },
  };
});

const node = process.execPath;

describe("defaultExec", () => {
  it("resolves code 0 with stdout and stderr captured as strings", async () => {
    const r = await defaultExec(node, [
      "-e",
      "process.stdout.write('out'); process.stderr.write('err')",
    ]);
    expect(r).toEqual({ code: 0, stdout: "out", stderr: "err" });
  });

  it("maps a missing binary (ENOENT) to code 127 instead of rejecting", async () => {
    const r = await defaultExec("/nonexistent/junco-probe-bin", ["--version"]);
    expect(r.code).toBe(127);
  });

  it("collapses any other failure to code 1 — the child's own exit status is not surfaced", async () => {
    const r = await defaultExec(node, ["-e", "process.stderr.write('boom'); process.exit(3)"]);
    expect(r).toEqual({ code: 1, stdout: "", stderr: "boom" });
  });

  it("merges opts.env over the inherited environment rather than replacing it", async () => {
    const script =
      "process.stdout.write(process.env.JUNCO_PROBE_VAR + ':' + typeof process.env.PATH)";
    const withEnv = await defaultExec(node, ["-e", script], { env: { JUNCO_PROBE_VAR: "set" } });
    expect(withEnv.stdout).toBe("set:string");

    const inherited = await defaultExec(node, ["-e", script]);
    expect(inherited.stdout).toBe("undefined:string");
    // Absent opts.env the wrapper passes env: undefined (inherit), not {}.
    expect(execFileSeen.opts.at(-1).env).toBeUndefined();
  });

  it("arms a 10 s timeout on every probe", async () => {
    await defaultExec(node, ["-e", ""]);
    expect(execFileSeen.opts.at(-1)).toMatchObject({ timeout: 10_000 });
  });
});

describe("defaultAccessOk", () => {
  it("creates a missing nested dir and reports it writable", () => {
    const root = mkdtempSync(join(tmpdir(), "junco-probe-"));
    try {
      const dir = join(root, "a", "b");
      expect(defaultAccessOk(dir)).toBe(true);
      expect(statSync(dir).isDirectory()).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports false when the dir cannot be created — a file sits where a parent should be", () => {
    const root = mkdtempSync(join(tmpdir(), "junco-probe-"));
    try {
      const blocker = join(root, "blocker");
      writeFileSync(blocker, "");
      expect(defaultAccessOk(join(blocker, "child"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
