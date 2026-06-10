import { describe, it, expect } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, queuePaths, resolveConfigPath, defaultUserConfigPath } from "../src/config.js";

function writeToml(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "junco-cfg-"));
  const p = join(dir, "config.toml");
  writeFileSync(p, body, "utf8");
  return p;
}

describe("loadConfig", () => {
  it("parses a minimal config with defaults", () => {
    const p = writeToml(
      `vault_root = "/tmp/vault"\n[pi]\nmodel_id = "omlx/m"\n[oMLX]\nurl = "http://127.0.0.1:1234/v1"\napi_key = "k"\n`,
    );
    const cfg = loadConfig(p);
    expect(cfg.vaultRoot).toBe("/tmp/vault");
    expect(cfg.juncoSubdir).toBe("Junco");
    // [pi].model_id and [oMLX] fall back into the resolved model config.
    expect(cfg.model.id).toBe("omlx/m");
    expect(cfg.model.baseUrl).toBe("http://127.0.0.1:1234/v1");
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
    const p = writeToml(
      `vault_root = "/tmp/vault"\n[omlx]\nurl = "http://host:9/v1"\napi_key = "low"\n`,
    );
    const cfg = loadConfig(p);
    expect(cfg.model.baseUrl).toBe("http://host:9/v1");
    expect(cfg.model.apiKey).toBe("low");
  });

  it("[model] defaults reproduce the previously-hardcoded values", () => {
    const p = writeToml(`vault_root = "/tmp/vault"\n`);
    const cfg = loadConfig(p);
    expect(cfg.model.id).toBe("local/my-model");
    expect(cfg.model.modelsJson).toBeNull();
    expect(cfg.model.api).toBe("openai-completions");
    expect(cfg.model.baseUrl).toBe("http://127.0.0.1:1234/v1");
    expect(cfg.model.reasoning).toBe(true);
    expect(cfg.model.input).toEqual(["text", "image"]);
    expect(cfg.model.contextWindow).toBe(131072);
    expect(cfg.model.maxTokens).toBe(49152);
    expect(cfg.model.thinkingLevel).toBe("medium");
    expect(cfg.model.compat.maxTokensField).toBe("max_tokens");
    expect(cfg.model.compat.thinkingFormat).toBe("qwen-chat-template");
  });

  it("[model] fields override the defaults and the legacy fallbacks; compat keys camelize", () => {
    const p = writeToml(
      `vault_root = "/tmp/vault"\n` +
        `[pi]\nmodel_id = "legacy/should-be-overridden"\n` +
        `[oMLX]\nurl = "http://legacy:1/v1"\n` +
        `[model]\n` +
        `id = "anthropic/claude"\napi = "anthropic-messages"\n` +
        `base_url = "https://api.example.com/v1"\napi_key = "sk-x"\n` +
        `context_window = 200000\nmax_tokens = 8192\nreasoning = false\nthinking_level = "high"\n` +
        `models_json = "~/models.json"\n` +
        `[model.compat]\nthinking_format = "anthropic"\nmax_tokens_field = "max_completion_tokens"\n`,
    );
    const cfg = loadConfig(p);
    expect(cfg.model.id).toBe("anthropic/claude");
    expect(cfg.model.api).toBe("anthropic-messages");
    expect(cfg.model.baseUrl).toBe("https://api.example.com/v1");
    expect(cfg.model.apiKey).toBe("sk-x");
    expect(cfg.model.contextWindow).toBe(200000);
    expect(cfg.model.maxTokens).toBe(8192);
    expect(cfg.model.reasoning).toBe(false);
    expect(cfg.model.thinkingLevel).toBe("high");
    expect(cfg.model.modelsJson).toBe(join(homedir(), "models.json"));
    // snake_case TOML keys camelized; defaults still present for unset keys.
    expect(cfg.model.compat.thinkingFormat).toBe("anthropic");
    expect(cfg.model.compat.maxTokensField).toBe("max_completion_tokens");
    expect(cfg.model.compat.supportsUsageInStreaming).toBe(true);
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

  it("applies supervisor defaults when [supervisor] is absent", () => {
    const p = writeToml(`vault_root = "/v"\n`);
    const cfg = loadConfig(p);
    expect(cfg.supervisorEnabled).toBe(true);
    expect(cfg.supervisorBudgetPerKind).toBe(1);
    expect(cfg.supervisorEscalationWindow).toBe(3);
    expect(cfg.supervisorOutputBudgetPerTurn).toBe(12000);
    expect(cfg.supervisorOutputBudgetPostCommit).toBe(24000);
  });

  it("reads the [supervisor] knobs from config.toml", () => {
    const p = writeToml(
      `vault_root = "/v"\n[supervisor]\nenabled = false\nbudget_per_kind = 2\n` +
        `escalation_window_turns = 5\noutput_budget_per_turn = 8000\noutput_budget_post_commit = 16000\n`,
    );
    const cfg = loadConfig(p);
    expect(cfg.supervisorEnabled).toBe(false);
    expect(cfg.supervisorBudgetPerKind).toBe(2);
    expect(cfg.supervisorEscalationWindow).toBe(5);
    expect(cfg.supervisorOutputBudgetPerTurn).toBe(8000);
    expect(cfg.supervisorOutputBudgetPostCommit).toBe(16000);
  });

  it("applies critic defaults when [critic] is absent", () => {
    const p = writeToml(`vault_root = "/v"\n`);
    const cfg = loadConfig(p);
    expect(cfg.criticEnabled).toBe(true);
    expect(cfg.criticMaxRetries).toBe(1);
    expect(cfg.criticThinking).toBe("minimal");
  });

  it("reads the [critic] knobs from config.toml", () => {
    const p = writeToml(
      `vault_root = "/v"\n[critic]\nenabled = false\nmax_retries = 2\nthinking = "high"\n`,
    );
    const cfg = loadConfig(p);
    expect(cfg.criticEnabled).toBe(false);
    expect(cfg.criticMaxRetries).toBe(2);
    expect(cfg.criticThinking).toBe("high");
  });

  it("applies plan-lint + commit_leftovers defaults when sections are absent", () => {
    const p = writeToml(`vault_root = "/v"\n`);
    const cfg = loadConfig(p);
    expect(cfg.planLintEnabled).toBe(true);
    expect(cfg.planLintBlockOnError).toBe(true);
    expect(cfg.planLintCheckLabels).toBe(true);
    expect(cfg.commitLeftoversEnabled).toBe(false);
  });

  it("reads the [plan_lint] knobs and [pi].commit_leftovers from config.toml", () => {
    const p = writeToml(
      `vault_root = "/v"\n[pi]\ncommit_leftovers = true\n[plan_lint]\nenabled = false\nblock_on_error = false\ncheck_labels = false\n`,
    );
    const cfg = loadConfig(p);
    expect(cfg.planLintEnabled).toBe(false);
    expect(cfg.planLintBlockOnError).toBe(false);
    expect(cfg.planLintCheckLabels).toBe(false);
    expect(cfg.commitLeftoversEnabled).toBe(true);
  });

  it("applies [observability] defaults when the section is absent", () => {
    const p = writeToml(`vault_root = "/v"\n`);
    const cfg = loadConfig(p);
    expect(cfg.healthEnabled).toBe(true);
    expect(cfg.healthHost).toBe("127.0.0.1");
    expect(cfg.healthPort).toBe(8787);
    expect(cfg.logLevel).toBe("info");
  });

  it("reads the [observability] knobs from config.toml", () => {
    const p = writeToml(
      `vault_root = "/v"\n[observability]\nhealth_enabled = false\nhealth_host = "0.0.0.0"\n` +
        `health_port = 9999\nlog_level = "warn"\n`,
    );
    const cfg = loadConfig(p);
    expect(cfg.healthEnabled).toBe(false);
    expect(cfg.healthHost).toBe("0.0.0.0");
    expect(cfg.healthPort).toBe(9999);
    expect(cfg.logLevel).toBe("warn");
  });

  it("rejects an out-of-range [observability].log_level", () => {
    const p = writeToml(`vault_root = "/v"\n[observability]\nlog_level = "verbose"\n`);
    expect(() => loadConfig(p)).toThrow();
  });

  it("resilience + observability + concurrency defaults", () => {
    const p = writeToml(`vault_root = "/v"\n`);
    const cfg = loadConfig(p);
    expect(cfg.maxTransientRetries).toBe(2);
    expect(cfg.retryBackoffSeconds).toBe(60);
    expect(cfg.maxConcurrent).toBe(1);
    expect(cfg.stateDir).toBe(join(homedir(), ".local/state/junco"));
    expect(cfg.logToFile).toBe(true);
    expect(cfg.transcriptsEnabled).toBe(true);
    expect(cfg.allowedRepoRoots).toEqual([]);
  });

  it("resilience keys are configurable", () => {
    const p = writeToml(
      `vault_root = "/v"\n` +
        `[worker]\nmax_transient_retries = 0\nretry_backoff_seconds = 5\nmax_concurrent = 3\n` +
        `[observability]\nstate_dir = "~/x"\nlog_to_file = false\ntranscripts = false\n` +
        `[git]\nallowed_repo_roots = ["~/code"]\n`,
    );
    const cfg = loadConfig(p);
    expect(cfg.maxTransientRetries).toBe(0);
    expect(cfg.retryBackoffSeconds).toBe(5);
    expect(cfg.maxConcurrent).toBe(3);
    expect(cfg.stateDir).toBe(join(homedir(), "x"));
    expect(cfg.logToFile).toBe(false);
    expect(cfg.transcriptsEnabled).toBe(false);
    expect(cfg.allowedRepoRoots).toEqual([join(homedir(), "code")]);
  });

  it("rejects max_concurrent < 1 and negative retry knobs", () => {
    expect(() =>
      loadConfig(writeToml(`vault_root = "/v"\n[worker]\nmax_concurrent = 0\n`)),
    ).toThrow();
    expect(() =>
      loadConfig(writeToml(`vault_root = "/v"\n[worker]\nmax_transient_retries = -1\n`)),
    ).toThrow();
  });
});

describe("resolveConfigPath", () => {
  it("explicit path wins, resolved against cwd", () => {
    expect(resolveConfigPath("rel/c.toml", { cwd: () => "/base" })).toBe("/base/rel/c.toml");
    expect(resolveConfigPath("/abs/c.toml", { cwd: () => "/base" })).toBe("/abs/c.toml");
  });

  it("falls back to ./config.toml when it exists", () => {
    const p = resolveConfigPath(undefined, {
      cwd: () => "/base",
      existsFn: (x) => x === "/base/config.toml",
    });
    expect(p).toBe("/base/config.toml");
  });

  it("otherwise resolves the XDG user path", () => {
    const p = resolveConfigPath(undefined, {
      cwd: () => "/base",
      existsFn: () => false,
      env: { XDG_CONFIG_HOME: "/xdg" },
    });
    expect(p).toBe("/xdg/junco/config.toml");
  });

  it("defaultUserConfigPath honors XDG_CONFIG_HOME and falls back to ~/.config", () => {
    expect(defaultUserConfigPath({ XDG_CONFIG_HOME: "/xdg" })).toBe("/xdg/junco/config.toml");
    expect(defaultUserConfigPath({})).toBe(join(homedir(), ".config/junco/config.toml"));
    expect(defaultUserConfigPath({ XDG_CONFIG_HOME: "  " })).toBe(
      join(homedir(), ".config/junco/config.toml"),
    );
  });
});
