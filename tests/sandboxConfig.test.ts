import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../src/config.js";

const dirs: string[] = [];
function writeConfig(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "junco-sbxcfg-"));
  dirs.push(dir);
  const p = join(dir, "config.toml");
  writeFileSync(p, body);
  return p;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const BASE = `vault_root = "~/vault"\n[model]\nid = "x/y"\nbase_url = "http://127.0.0.1:1/v1"\napi_key = "k"\n`;

describe("[sandbox] config", () => {
  it("defaults: disabled, auto backend, network deny, empty lists", () => {
    const cfg = loadConfig(writeConfig(BASE));
    expect(cfg.sandbox).toEqual({
      enabled: false,
      backend: "auto",
      network: "deny",
      extraDenyRead: [],
      extraAllowWrite: [],
    });
  });

  it("parses an explicit section and expands ~ in path lists", () => {
    const cfg = loadConfig(
      writeConfig(
        BASE +
          `[sandbox]\nenabled = true\nbackend = "bwrap"\nnetwork = "allow"\nextra_deny_read = ["~/secrets"]\nextra_allow_write = ["~/scratch"]\n`,
      ),
    );
    expect(cfg.sandbox.enabled).toBe(true);
    expect(cfg.sandbox.backend).toBe("bwrap");
    expect(cfg.sandbox.network).toBe("allow");
    expect(cfg.sandbox.extraDenyRead[0].startsWith("~")).toBe(false);
    expect(cfg.sandbox.extraAllowWrite[0].endsWith("/scratch")).toBe(true);
  });

  it("rejects an unknown backend", () => {
    expect(() => loadConfig(writeConfig(BASE + `[sandbox]\nbackend = "docker"\n`))).toThrow();
  });
});
