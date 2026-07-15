import { describe, it, expect } from "vitest";
import { writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runConfigCommand } from "../src/configCmd.js";
import type { Config } from "../src/types.js";

function fixture(obj: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "cfgcmd-"));
  const p = join(dir, "config.json");
  writeFileSync(p, JSON.stringify(obj, null, 2), "utf8");
  return p;
}

/** Minimal Config literal for `config init` tests — queue paths under /tmp/q. */
function makeFakeConfig(): Config {
  return {
    vaultRoot: "/tmp/q",
    juncoSubdir: "Junco",
    model: {
      id: "m",
      source: "auto",
      baseUrlExplicit: false,
      retry: { maxRetries: null, baseDelayMs: null },
      modelsJson: null,
      api: "openai-completions",
      baseUrl: "u",
      apiKey: "k",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 131072,
      maxTokens: 49152,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      thinkingLevel: "medium",
      compat: { maxTokensField: "max_tokens", thinkingFormat: "qwen-chat-template" },
    },
    tools: ["read"],
    defaultTimeoutMinutes: 1,
    pollIntervalSeconds: 15,
    startupPollSeconds: 30,
    startupWait: true,
    endpointProbe: "auto",
    maxTransientRetries: 2,
    retryBackoffSeconds: 60,
    maxConcurrent: 1,
    supervisorEnabled: true,
    supervisorBudgetPerKind: 1,
    supervisorEscalationWindow: 3,
    supervisorOutputBudgetPerTurn: 12000,
    supervisorOutputBudgetPostCommit: 24000,
    gitBin: "git",
    ghBin: "gh",
    defaultBaseBranch: "main",
    branchPrefix: "junco/",
    worktreeRoot: "/tmp/q/worktrees",
    removeWorktreeOnSuccess: true,
    allowedRepoRoots: [],
    draftByDefault: true,
    defaultLabels: [],
    verifyEnabled: true,
    verifyCommandTimeout: 60,
    verifyBlockOnFail: false,
    criticEnabled: true,
    criticMaxRetries: 1,
    criticThinking: "minimal",
    planLintEnabled: true,
    planLintBlockOnError: true,
    planLintCheckLabels: true,
    commitLeftoversEnabled: false,
    dailyBudgetUsd: 0,
    healthEnabled: false,
    healthHost: "127.0.0.1",
    healthPort: 8787,
    logLevel: "info",
    github: {
      enabled: false,
      triggerLabel: "junco",
      askLabel: "junco:ask",
      pollIntervalSeconds: 60,
      repos: [],
      requireApproval: true,
      plannerModelId: null,
      externalReposRoot: "/tmp/q-external",
    },
    assess: { maxIssuesPerRun: 20, minSeverity: "low", npmBin: "npm" },
    sandbox: {
      enabled: false,
      backend: "auto",
      network: "deny",
      extraDenyRead: [],
      extraAllowWrite: [],
    },
    botAccount: { enabled: false, configDir: "/tmp/junco-gh" },
    stateDir: "/tmp/q/state",
    logToFile: false,
    transcriptsEnabled: false,
  };
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

describe("config init", () => {
  it("fresh: writes the default config, ensures queue dirs, prints the summary", () => {
    const written = new Map<string, string>();
    const made: string[] = [];
    const out: string[] = [];
    const code = runConfigCommand(["init"], "/tmp/cfg/config.json", {
      existsFn: () => false,
      writeFileFn: (p, s) => void written.set(p, s),
      mkdirFn: (p) => void made.push(p),
      loadConfigFn: () => makeFakeConfig(), // helper with queue paths under /tmp/q
      printFn: (s) => void out.push(s),
    });
    expect(code).toBe(0);
    expect([...written.keys()]).toEqual(["/tmp/cfg/config.json"]);
    expect(JSON.parse(written.get("/tmp/cfg/config.json") ?? "")).toBeTypeOf("object");
    expect(made.length).toBeGreaterThan(0); // inbox/processing/done/failed/worktrees
    expect(out.join("")).toContain("Wrote config");
  });

  it("existing config: never overwrites, still ensures dirs", () => {
    const written: string[] = [];
    const out: string[] = [];
    const code = runConfigCommand(["init"], "/tmp/cfg/config.json", {
      existsFn: () => true,
      writeFileFn: (p) => void written.push(p),
      mkdirFn: () => {},
      loadConfigFn: () => makeFakeConfig(),
      printFn: (s) => void out.push(s),
    });
    expect(code).toBe(0);
    expect(written).toEqual([]);
    expect(out.join("")).toContain("Config already exists");
  });
});
