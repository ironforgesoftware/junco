import { describe, it, expect } from "vitest";
import { greetingName, preflightChecks, flightChecks } from "../src/wizard/detect.js";
import { loadConfig } from "../src/config.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

type Exec = (
  cmd: string,
  args: string[],
) => Promise<{ code: number; stdout: string; stderr: string }>;
const okExec =
  (table: Record<string, { code: number; stdout: string }>): Exec =>
  async (cmd, args) => {
    const key = [cmd, ...args].join(" ");
    const hit = table[key] ?? { code: 127, stdout: "" };
    return { ...hit, stderr: "" };
  };

function tmpCfg(extra: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "wizdetect-"));
  const p = join(dir, "config.json");
  writeFileSync(
    p,
    JSON.stringify({ vaultRoot: join(dir, "vault"), juncoSubdir: "", ...extra }),
    "utf8",
  );
  return loadConfig(p);
}

describe("greetingName", () => {
  it("returns the git first name, or 'friend' when unset", async () => {
    expect(
      await greetingName({
        execFn: okExec({ "git config user.name": { code: 0, stdout: "Ada Lovelace\n" } }),
      }),
    ).toBe("Ada");
    expect(await greetingName({ execFn: okExec({}) })).toBe("friend");
  });
});

describe("preflightChecks", () => {
  it("reports node/git/gh receipts with authenticated gh", async () => {
    const res = await preflightChecks({
      nodeVersion: "22.19.0",
      execFn: okExec({
        "git --version": { code: 0, stdout: "git version 2.44.0\n" },
        "gh --version": { code: 0, stdout: "gh version 2.49.0\n" },
        "gh auth status": { code: 0, stdout: "" },
      }),
    });
    expect(res.map((r) => [r.label, r.verdict])).toEqual([
      ["node", "ok"],
      ["git", "ok"],
      ["gh", "ok"],
    ]);
    expect(res[2].detail).toContain("authenticated");
  });

  it("warns on missing gh and fails on old node", async () => {
    const res = await preflightChecks({ nodeVersion: "20.1.0", execFn: okExec({}) });
    expect(res.find((r) => r.label === "node")?.verdict).toBe("fail");
    expect(res.find((r) => r.label === "git")?.verdict).toBe("fail");
    expect(res.find((r) => r.label === "gh")?.verdict).toBe("warn");
  });
});

describe("flightChecks", () => {
  it("covers endpoint, model, dirs; warns when model not advertised", async () => {
    const cfg = tmpCfg({ sandbox: { enabled: false } });
    const res = await flightChecks(cfg, {
      reachableFn: async () => true,
      fetchModelsFn: async () => ["other-model"],
      accessOkFn: () => true,
      execFn: okExec({
        "gh auth status": { code: 0, stdout: "" },
        "gh --version": { code: 0, stdout: "x" },
      }),
    });
    expect(res.find((r) => r.label === "inference endpoint")?.verdict).toBe("ok");
    expect(res.find((r) => r.label === "model")?.verdict).toBe("warn");
    expect(res.filter((r) => r.label.includes("dir")).every((r) => r.verdict === "ok")).toBe(true);
  });

  it("fails endpoint receipt when unreachable and skips model check", async () => {
    const cfg = tmpCfg({ sandbox: { enabled: false } });
    const res = await flightChecks(cfg, {
      reachableFn: async () => false,
      accessOkFn: () => true,
      execFn: okExec({}),
    });
    expect(res.find((r) => r.label === "inference endpoint")?.verdict).toBe("fail");
    expect(res.find((r) => r.label === "model")).toBeUndefined();
  });

  it("sandbox enabled + available backend -> ok, mentions the backend name", async () => {
    const cfg = tmpCfg({ sandbox: { enabled: true, backend: "seatbelt" } });
    const res = await flightChecks(cfg, {
      reachableFn: async () => false,
      accessOkFn: () => true,
      execFn: okExec({
        "sandbox-exec -p (version 1)(allow default) /usr/bin/true": { code: 0, stdout: "" },
      }),
    });
    expect(res.find((r) => r.label === "sandbox")).toEqual({
      verdict: "ok",
      label: "sandbox",
      detail: expect.stringContaining("seatbelt"),
    });
  });

  it("sandbox enabled + auto backend unavailable -> warn (degrade to none)", async () => {
    const cfg = tmpCfg({ sandbox: { enabled: true, backend: "auto" } });
    const res = await flightChecks(cfg, {
      reachableFn: async () => false,
      accessOkFn: () => true,
      platform: "darwin",
      execFn: okExec({}), // no table hit -> code 127, unavailable
    });
    const sandbox = res.find((r) => r.label === "sandbox");
    expect(sandbox?.verdict).toBe("warn");
    expect(sandbox?.detail).toContain("seatbelt");
    expect(sandbox?.detail).toContain("degrading to none");
  });

  it("sandbox enabled + explicit backend unavailable -> fail (fail-closed)", async () => {
    const cfg = tmpCfg({ sandbox: { enabled: true, backend: "bwrap" } });
    const res = await flightChecks(cfg, {
      reachableFn: async () => false,
      accessOkFn: () => true,
      platform: "linux",
      execFn: okExec({}), // no table hit -> code 127, unavailable
    });
    const sandbox = res.find((r) => r.label === "sandbox");
    expect(sandbox?.verdict).toBe("fail");
    expect(sandbox?.detail).toContain("bwrap");
    expect(sandbox?.detail).toContain("fail closed");
  });

  it("sandbox enabled + backend none -> warn (env-scrub only)", async () => {
    const cfg = tmpCfg({ sandbox: { enabled: true, backend: "none" } });
    const res = await flightChecks(cfg, {
      reachableFn: async () => false,
      accessOkFn: () => true,
      execFn: okExec({}),
    });
    expect(res.find((r) => r.label === "sandbox")).toEqual({
      verdict: "warn",
      label: "sandbox",
      detail: "backend=none — env scrub + fs jail only",
    });
  });
});
