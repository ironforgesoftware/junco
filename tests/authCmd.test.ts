import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAuthCommand } from "../src/authCmd.js";

function writeConfig(dir: string, obj: unknown): string {
  const p = join(dir, "config.json");
  writeFileSync(p, JSON.stringify(obj, null, 2));
  return p;
}

const BASE = { vaultRoot: "/tmp/v" };

describe("junco auth login", () => {
  it("logs in, flips botAccount.enabled, prints the identity", async () => {
    const dir = mkdtempSync(join(tmpdir(), "junco-auth-"));
    const configPath = writeConfig(dir, BASE);
    const out: string[] = [];
    const code = await runAuthCommand(["login"], configPath, {
      runGhLoginFn: async () => 0,
      detectBotLoginFn: async () => "junco-agent",
      printFn: (s) => out.push(s),
    });
    expect(code).toBe(0);
    const raw = JSON.parse(readFileSync(configPath, "utf8"));
    expect(raw.botAccount.enabled).toBe(true);
    expect(out.join("")).toContain("junco-agent");
  });

  it("fails without flipping config when gh login exits non-zero", async () => {
    const dir = mkdtempSync(join(tmpdir(), "junco-auth-"));
    const configPath = writeConfig(dir, BASE);
    const code = await runAuthCommand(["login"], configPath, {
      runGhLoginFn: async () => 1,
      detectBotLoginFn: async () => null,
      printFn: () => {},
    });
    expect(code).toBe(1);
    expect(JSON.parse(readFileSync(configPath, "utf8")).botAccount).toBeUndefined();
  });

  it("fails without flipping config when login succeeds but the identity cannot be resolved", async () => {
    const dir = mkdtempSync(join(tmpdir(), "junco-auth-"));
    const configPath = writeConfig(dir, BASE);
    const errs: string[] = [];
    const code = await runAuthCommand(["login"], configPath, {
      runGhLoginFn: async () => 0,
      detectBotLoginFn: async () => null,
      printFn: () => {},
      printErrFn: (s) => errs.push(s),
    });
    expect(code).toBe(1);
    expect(errs.join("")).toContain("identity could not be resolved");
    expect(JSON.parse(readFileSync(configPath, "utf8")).botAccount).toBeUndefined();
  });

  it("errors when no config exists yet", async () => {
    const dir = mkdtempSync(join(tmpdir(), "junco-auth-"));
    const errs: string[] = [];
    const code = await runAuthCommand(["login"], join(dir, "config.json"), {
      printErrFn: (s) => errs.push(s),
    });
    expect(code).toBe(1);
    expect(errs.join("")).toContain("junco dashboard");
  });

  it("prints usage on unknown verb", async () => {
    const code = await runAuthCommand(["logout"], "/nonexistent", { printErrFn: () => {} });
    expect(code).toBe(2);
  });
});
