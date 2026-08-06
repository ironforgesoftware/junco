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

  // #188.1: a pre-existing schema-invalid config must surface a one-line
  // message and exit 1 cleanly, not propagate a raw ZodError stack.
  it("prints a one-line error (not a ZodError stack) when the pre-existing config is schema-invalid", async () => {
    const dir = mkdtempSync(join(tmpdir(), "junco-auth-"));
    const configPath = writeConfig(dir, { vaultRoot: 123 }); // JSON-valid, schema-invalid
    const errs: string[] = [];
    const code = await runAuthCommand(["login"], configPath, {
      runGhLoginFn: async () => 0,
      detectBotLoginFn: async () => "junco-agent",
      printFn: () => {},
      printErrFn: (s) => errs.push(s),
    });
    expect(code).toBe(1);
    expect(errs.join("")).toContain("config invalid — not modified");
    // On-disk config untouched — no botAccount added, bad value preserved.
    const raw = JSON.parse(readFileSync(configPath, "utf8"));
    expect(raw.botAccount).toBeUndefined();
    expect(raw.vaultRoot).toBe(123);
  });

  // Critical fix (Task 3 review): `junco auth login` must resolve the bot gh
  // config dir through the SAME probe assembleConfig uses, or an upgrader
  // with a live legacy login gets this command targeting ~/.junco/gh while
  // the daemon keeps reading ~/.config/junco/gh — planting a second
  // hosts.yml that silently reroutes later resolutions (split-brain).
  it("targets the legacy gh config dir when configDir is unset and a legacy login is live (env-injected, hermetic existsFn)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "junco-auth-"));
    const configPath = writeConfig(dir, BASE); // no botAccount.configDir set — defaulted
    const legacyHosts = "/h/.config/junco/gh/hosts.yml";
    const seenConfigDirs: string[] = [];
    const code = await runAuthCommand(["login"], configPath, {
      env: { HOME: "/h" },
      // Hermetic: only the real config file and the injected legacy hosts.yml
      // exist — the canonical ~/.junco/gh/hosts.yml does not.
      existsFn: (p) => p === configPath || p === legacyHosts,
      runGhLoginFn: async (_ghBin, configDir) => {
        seenConfigDirs.push(configDir);
        return 0;
      },
      detectBotLoginFn: async (_ghBin, configDir) => {
        seenConfigDirs.push(configDir);
        return "junco-agent";
      },
      printFn: () => {},
    });
    expect(code).toBe(0);
    expect(seenConfigDirs).toEqual(["/h/.config/junco/gh", "/h/.config/junco/gh"]);
  });

  it("never probes an explicitly non-default configDir, even with a legacy login live", async () => {
    const dir = mkdtempSync(join(tmpdir(), "junco-auth-"));
    // An absolute, non-tilde explicit override — sidesteps expandHome's
    // homedir()-vs-env(HOME) ambiguity (see resolveBotGhConfigDir's NOTE)
    // entirely, so this test asserts passthrough unambiguously.
    const configPath = writeConfig(dir, {
      ...BASE,
      botAccount: { configDir: "/explicit/custom/gh" },
    });
    const legacyHosts = "/h/.config/junco/gh/hosts.yml";
    const seenConfigDirs: string[] = [];
    const code = await runAuthCommand(["login"], configPath, {
      env: { HOME: "/h" },
      // Even though the legacy hosts.yml "exists", an explicit configDir must
      // never be probed against it.
      existsFn: (p) => p === configPath || p === legacyHosts,
      runGhLoginFn: async (_ghBin, configDir) => {
        seenConfigDirs.push(configDir);
        return 0;
      },
      detectBotLoginFn: async (_ghBin, configDir) => {
        seenConfigDirs.push(configDir);
        return "junco-agent";
      },
      printFn: () => {},
    });
    expect(code).toBe(0);
    expect(seenConfigDirs).toEqual(["/explicit/custom/gh", "/explicit/custom/gh"]);
  });

  // #188.2: exercise the rename-failure / temp-cleanup branch.
  it("on a write/rename failure, cleans up the temp file and reports without modifying the config", async () => {
    const dir = mkdtempSync(join(tmpdir(), "junco-auth-"));
    const configPath = writeConfig(dir, BASE);
    const errs: string[] = [];
    const unlinked: string[] = [];
    const code = await runAuthCommand(["login"], configPath, {
      runGhLoginFn: async () => 0,
      detectBotLoginFn: async () => "junco-agent",
      printFn: () => {},
      printErrFn: (s) => errs.push(s),
      writeFileFn: () => {}, // pretend the temp write succeeded
      renameFn: () => {
        throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
      },
      unlinkFn: (p) => unlinked.push(p),
    });
    expect(code).toBe(1);
    expect(errs.join("")).toMatch(/not modified/);
    expect(unlinked).toHaveLength(1); // temp file cleaned up
    expect(unlinked[0]).toContain(".config.json.tmp-");
  });
});

describe("junco auth grant", () => {
  it("grants and prints the identity", async () => {
    const dir = mkdtempSync(join(tmpdir(), "junco-auth-"));
    const configPath = writeConfig(dir, { vaultRoot: "/tmp/v", botAccount: { enabled: true } });
    const out: string[] = [];
    const code = await runAuthCommand(["grant", "acme/api"], configPath, {
      grantFn: async () => ({ login: "junco-agent" }),
      printFn: (s) => out.push(s),
    });
    expect(code).toBe(0);
    expect(out.join("")).toContain("junco-agent has write on acme/api");
  });

  it("malformed or missing nwo → usage, exit 2", async () => {
    expect(await runAuthCommand(["grant"], "/nonexistent", { printErrFn: () => {} })).toBe(2);
    expect(
      await runAuthCommand(["grant", "not-a-repo"], "/nonexistent", { printErrFn: () => {} }),
    ).toBe(2);
  });

  it("grant failure → exit 1 with the mapped message", async () => {
    const dir = mkdtempSync(join(tmpdir(), "junco-auth-"));
    const configPath = writeConfig(dir, { vaultRoot: "/tmp/v", botAccount: { enabled: true } });
    const errs: string[] = [];
    const code = await runAuthCommand(["grant", "acme/api"], configPath, {
      grantFn: async () => {
        throw new Error("granting on acme/api needs admin — ask an org admin");
      },
      printErrFn: (s) => errs.push(s),
    });
    expect(code).toBe(1);
    expect(errs.join("")).toContain("needs admin");
  });
});
