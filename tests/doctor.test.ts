import { describe, it, expect } from "vitest";
import { runDoctor, type DoctorDeps } from "../src/doctor.js";
import type { Config } from "../src/types.js";

const okConfig = {
  model: { id: "local/m", baseUrl: "http://127.0.0.1:1234/v1", apiKey: "k", modelsJson: null },
  vaultRoot: "/tmp/junco-doc-vault",
  juncoSubdir: "",
  worktreeRoot: "/tmp/junco-doc-wt",
  stateDir: "/tmp/junco-doc-state",
  gitBin: "git",
  ghBin: "gh",
} as unknown as Config;

function deps(over: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    loadConfigFn: () => okConfig,
    execFn: async () => ({ code: 0, stdout: "ok", stderr: "" }),
    reachableFn: async () => true,
    fetchModelsFn: async () => ["m"],
    accessOkFn: () => true,
    lockHolderFn: () => null,
    printFn: () => {},
    ...over,
  };
}

describe("runDoctor", () => {
  it("all green → exit 0", async () => {
    expect(await runDoctor("/x/config.toml", deps())).toBe(0);
  });

  it("unreachable endpoint → ✗ and exit 1", async () => {
    const lines: string[] = [];
    const code = await runDoctor(
      "/x/config.toml",
      deps({ reachableFn: async () => false, printFn: (s) => lines.push(s) }),
    );
    expect(code).toBe(1);
    expect(lines.join("")).toMatch(/✗ inference endpoint/);
    expect(lines.join("")).toMatch(/NOT ready/);
  });

  it("missing gh is a warning, not a failure (Q&A-only setups are valid)", async () => {
    const lines: string[] = [];
    const code = await runDoctor(
      "/x/config.toml",
      deps({
        execFn: async (cmd: string) =>
          cmd === "gh"
            ? { code: 127, stdout: "", stderr: "not found" }
            : { code: 0, stdout: "ok", stderr: "" },
        printFn: (s) => lines.push(s),
      }),
    );
    expect(code).toBe(0);
    expect(lines.join("")).toMatch(/⚠ gh/);
  });

  it("gh installed but unauthenticated → warning with the login hint", async () => {
    const lines: string[] = [];
    const code = await runDoctor(
      "/x/config.toml",
      deps({
        execFn: async (_cmd: string, args: string[]) =>
          args[0] === "auth"
            ? { code: 1, stdout: "", stderr: "not logged in" }
            : { code: 0, stdout: "ok", stderr: "" },
        printFn: (s) => lines.push(s),
      }),
    );
    expect(code).toBe(0);
    expect(lines.join("")).toMatch(/gh auth login/);
  });

  it("unparseable config → ✗ and exit 1, later checks skipped", async () => {
    const code = await runDoctor(
      "/x/config.toml",
      deps({
        loadConfigFn: () => {
          throw new Error("bad toml");
        },
      }),
    );
    expect(code).toBe(1);
  });

  it("model missing from the endpoint listing → warning only", async () => {
    const lines: string[] = [];
    const code = await runDoctor(
      "/x/config.toml",
      deps({ fetchModelsFn: async () => ["other"], printFn: (s) => lines.push(s) }),
    );
    expect(code).toBe(0);
    expect(lines.join("")).toMatch(/⚠ model/);
  });

  it("unwritable queue dir → ✗ and exit 1", async () => {
    const code = await runDoctor("/x/config.toml", deps({ accessOkFn: () => false }));
    expect(code).toBe(1);
  });

  it("running daemon is reported informationally", async () => {
    const lines: string[] = [];
    await runDoctor(
      "/x/config.toml",
      deps({ lockHolderFn: () => 4242, printFn: (s) => lines.push(s) }),
    );
    expect(lines.join("")).toMatch(/✓ daemon — running \(pid 4242\)/);
  });
});
