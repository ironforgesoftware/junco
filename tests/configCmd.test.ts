import { describe, it, expect } from "vitest";
import { writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runConfigCommand } from "../src/configCmd.js";

function fixture(obj: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "cfgcmd-"));
  const p = join(dir, "config.json");
  writeFileSync(p, JSON.stringify(obj, null, 2), "utf8");
  return p;
}

describe("junco config", () => {
  it("path prints the resolved config path", () => {
    const p = fixture({ vaultRoot: "/v" });
    let out = "";
    expect(runConfigCommand(["path"], p, { printFn: (s) => (out += s) })).toBe(0);
    expect(out.trim()).toBe(p);
  });

  it("get prints the effective value (default when unset)", () => {
    const p = fixture({ vaultRoot: "/v" });
    let out = "";
    runConfigCommand(["get", "worker.maxConcurrent"], p, { printFn: (s) => (out += s) });
    expect(out.trim()).toBe("1");
  });

  it("set coerces a number and writes sparsely", () => {
    const p = fixture({ vaultRoot: "/v" });
    expect(runConfigCommand(["set", "worker.maxConcurrent", "3"], p, { printFn: () => {} })).toBe(
      0,
    );
    const raw = JSON.parse(readFileSync(p, "utf8"));
    expect(raw.worker.maxConcurrent).toBe(3);
    expect(raw.vaultRoot).toBe("/v"); // untouched keys preserved, nothing else added
    expect(Object.keys(raw)).toEqual(["vaultRoot", "worker"]);
  });

  it("set coerces booleans and enums", () => {
    const p = fixture({ vaultRoot: "/v" });
    runConfigCommand(["set", "verify.enabled", "false"], p, { printFn: () => {} });
    runConfigCommand(["set", "observability.logLevel", "debug"], p, { printFn: () => {} });
    const raw = JSON.parse(readFileSync(p, "utf8"));
    expect(raw.verify.enabled).toBe(false);
    expect(raw.observability.logLevel).toBe("debug");
  });

  it("set rejects a structured path", () => {
    const p = fixture({ vaultRoot: "/v" });
    let err = "";
    expect(runConfigCommand(["set", "tools", "read"], p, { errFn: (s) => (err += s) })).toBe(1);
    expect(err).toMatch(/edit config\.json directly/);
  });

  it("set rejects a bad enum value and writes nothing", () => {
    const p = fixture({ vaultRoot: "/v" });
    const before = readFileSync(p, "utf8");
    expect(
      runConfigCommand(["set", "observability.logLevel", "loud"], p, { errFn: () => {} }),
    ).toBe(1);
    expect(readFileSync(p, "utf8")).toBe(before);
  });

  it("set rejects an out-of-range number", () => {
    const p = fixture({ vaultRoot: "/v" });
    expect(runConfigCommand(["set", "worker.maxConcurrent", "0"], p, { errFn: () => {} })).toBe(1);
  });

  it("list masks secrets", () => {
    const p = fixture({ vaultRoot: "/v", model: { apiKey: "supersecret" } });
    let out = "";
    runConfigCommand(["list"], p, { printFn: (s) => (out += s) });
    expect(out).not.toContain("supersecret");
    expect(out).toContain("model.apiKey");
  });

  it("set warns to restart only for restart-kind levers", () => {
    const p = fixture({ vaultRoot: "/v" });
    let out = "";
    runConfigCommand(["set", "observability.healthPort", "9000"], p, {
      printFn: (s) => (out += s),
      daemonRunningFn: () => true,
    });
    expect(out).toMatch(/restart/i);
    out = "";
    runConfigCommand(["set", "worker.pollIntervalSeconds", "20"], p, {
      printFn: (s) => (out += s),
      daemonRunningFn: () => true,
    });
    expect(out).not.toMatch(/restart/i);
  });
});
