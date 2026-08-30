import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../src/config.js";

const dirs: string[] = [];
function writeConfig(obj: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "junco-sbxcfg-"));
  dirs.push(dir);
  const p = join(dir, "config.json");
  writeFileSync(p, JSON.stringify(obj));
  return p;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const BASE = {
  vaultRoot: "~/vault",
  model: { id: "x/y", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k" },
};

describe("sandbox config", () => {
  it("defaults: enabled, auto backend, network deny, empty lists", () => {
    const cfg = loadConfig(writeConfig(BASE));
    expect(cfg.sandbox).toEqual({
      enabled: true,
      backend: "auto",
      network: "deny",
      extraDenyRead: [],
      extraAllowWrite: [],
      bashTimeoutSeconds: 600,
    });
  });

  it("parses an explicit section and expands ~ in path lists", () => {
    const cfg = loadConfig(
      writeConfig({
        ...BASE,
        sandbox: {
          enabled: true,
          backend: "bwrap",
          network: "allow",
          extraDenyRead: ["~/secrets"],
          extraAllowWrite: ["~/scratch"],
        },
      }),
    );
    expect(cfg.sandbox.enabled).toBe(true);
    expect(cfg.sandbox.backend).toBe("bwrap");
    expect(cfg.sandbox.network).toBe("allow");
    expect(cfg.sandbox.extraDenyRead[0].startsWith("~")).toBe(false);
    expect(cfg.sandbox.extraAllowWrite[0].endsWith("/scratch")).toBe(true);
  });

  it("accepts sandbox.bashTimeoutSeconds (0 = no ceiling) and rejects negatives", () => {
    expect(
      loadConfig(writeConfig({ ...BASE, sandbox: { bashTimeoutSeconds: 0 } })).sandbox
        .bashTimeoutSeconds,
    ).toBe(0);
    expect(
      loadConfig(writeConfig({ ...BASE, sandbox: { bashTimeoutSeconds: 90 } })).sandbox
        .bashTimeoutSeconds,
    ).toBe(90);
    expect(() =>
      loadConfig(writeConfig({ ...BASE, sandbox: { bashTimeoutSeconds: -1 } })),
    ).toThrow();
  });

  it("rejects an unknown backend", () => {
    expect(() => loadConfig(writeConfig({ ...BASE, sandbox: { backend: "docker" } }))).toThrow();
  });
});
