import { describe, it, expect } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, queuePaths } from "../src/config.js";

function writeToml(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "junco-cfg-"));
  const p = join(dir, "config.toml");
  writeFileSync(p, body, "utf8");
  return p;
}

describe("loadConfig", () => {
  it("parses a minimal config with defaults", () => {
    const p = writeToml(`vault_root = "/tmp/vault"\n[pi]\nmodel_id = "omlx/m"\n[oMLX]\nurl = "http://127.0.0.1:1234/v1"\napi_key = "k"\n`);
    const cfg = loadConfig(p);
    expect(cfg.vaultRoot).toBe("/tmp/vault");
    expect(cfg.juncoSubdir).toBe("Junco");
    expect(cfg.modelId).toBe("omlx/m");
    expect(cfg.omlx.url).toBe("http://127.0.0.1:1234/v1");
    expect(cfg.defaultTimeoutMinutes).toBe(30);
    expect(cfg.tools).toContain("read");
  });

  it("throws a clear error when vault_root is missing", () => {
    const p = writeToml(`[oMLX]\nurl = "u"\napi_key = "k"\n`);
    expect(() => loadConfig(p)).toThrow(/vault_root/);
  });

  it("derives queue paths under vaultRoot/juncoSubdir", () => {
    const paths = queuePaths({ vaultRoot: "/v", juncoSubdir: "Junco" } as any);
    expect(paths.inbox).toBe("/v/Junco/inbox");
    expect(paths.failed).toBe("/v/Junco/failed");
  });

  it("accepts a lowercase [omlx] section (Python parity)", () => {
    const p = writeToml(`vault_root = "/tmp/vault"\n[omlx]\nurl = "http://host:9/v1"\napi_key = "low"\n`);
    const cfg = loadConfig(p);
    expect(cfg.omlx.url).toBe("http://host:9/v1");
    expect(cfg.omlx.apiKey).toBe("low");
  });

  it("expands a leading ~ in vault_root to the home dir", () => {
    const p = writeToml(`vault_root = "~/vault"\n[oMLX]\nurl = "u"\napi_key = "k"\n`);
    const cfg = loadConfig(p);
    expect(cfg.vaultRoot).not.toContain("~");
    expect(cfg.vaultRoot).toBe(join(homedir(), "vault"));
  });

  it("reads the tool allowlist from [pi].extra_args --tools", () => {
    const p = writeToml(`vault_root = "/v"\n[pi]\nextra_args = ["--tools", "read,bash,grep"]\n`);
    expect(loadConfig(p).tools).toEqual(["read", "bash", "grep"]);
  });

  it("falls back to default tools when extra_args has no --tools", () => {
    const p = writeToml(`vault_root = "/v"\n[pi]\nextra_args = ["--model", "x"]\n`);
    expect(loadConfig(p).tools).toContain("read");
    expect(loadConfig(p).tools).toContain("write");
  });
});
