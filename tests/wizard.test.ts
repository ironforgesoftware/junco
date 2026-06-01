import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  renderConfigToml,
  collectAnswers,
  defaultAnswers,
  runInitWizard,
  type AskFn,
  type WizardAnswers,
} from "../src/wizard.js";
import { loadConfig, queuePaths } from "../src/config.js";

// A scripted ask: pops queued answers in order (empty string => caller's default).
function scriptedAsk(answers: string[]): AskFn {
  let i = 0;
  return async (_q, opts) => {
    const raw = i < answers.length ? answers[i++] : "";
    return raw || (opts?.default ?? "");
  };
}

describe("renderConfigToml — round-trips through loadConfig", () => {
  let dir: string | null = null;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = null; });

  function parse(toml: string) {
    dir = mkdtempSync(join(tmpdir(), "junco-wiz-"));
    const p = join(dir, "config.toml");
    writeFileSync(p, toml);
    return loadConfig(p);
  }

  it("inline mode", () => {
    const a: WizardAnswers = {
      vaultRoot: "~/jv", mode: "inline", modelId: "prov/m",
      baseUrl: "http://h:1/v1", apiKey: "k",
    };
    const cfg = parse(renderConfigToml(a));
    expect(cfg.model.id).toBe("prov/m");
    expect(cfg.model.baseUrl).toBe("http://h:1/v1");
    expect(cfg.model.apiKey).toBe("k");
    expect(cfg.model.modelsJson).toBeNull();
    expect(cfg.vaultRoot).not.toContain("~"); // expandHome applied on load
  });

  it("models_json mode", () => {
    const a: WizardAnswers = {
      vaultRoot: "~/jv", mode: "models_json", modelId: "omlx/x",
      modelsJson: "~/.pi/agent/models.json",
    };
    const cfg = parse(renderConfigToml(a));
    expect(cfg.model.id).toBe("omlx/x");
    expect(cfg.model.modelsJson).toContain("models.json");
  });

  it("escapes quotes/backslashes in values", () => {
    const a: WizardAnswers = {
      vaultRoot: '/path/with "quote"', mode: "inline", modelId: "p/m",
      baseUrl: "http://h/v1", apiKey: "a\\b",
    };
    const cfg = parse(renderConfigToml(a)); // must not throw on parse
    expect(cfg.model.apiKey).toBe("a\\b");
  });
});

describe("collectAnswers", () => {
  it("inline branch with explicit answers", async () => {
    const ask = scriptedAsk(["~/v", "inline", "prov/model", "http://e/v1", "secret"]);
    expect(await collectAnswers(ask)).toEqual({
      vaultRoot: "~/v", mode: "inline", modelId: "prov/model",
      baseUrl: "http://e/v1", apiKey: "secret",
    });
  });

  it("models-json branch (mode detected by leading 'm')", async () => {
    const ask = scriptedAsk(["~/v", "models-json", "omlx/x", "~/m.json"]);
    expect(await collectAnswers(ask)).toEqual({
      vaultRoot: "~/v", mode: "models_json", modelId: "omlx/x", modelsJson: "~/m.json",
    });
  });

  it("empty input falls back to defaults (inline)", async () => {
    const ask = scriptedAsk([]); // everything empty → defaults
    const a = await collectAnswers(ask);
    expect(a).toEqual({
      vaultRoot: "~/junco-vault", mode: "inline", modelId: "omlx/my-model",
      baseUrl: "http://127.0.0.1:1234/v1", apiKey: "1234",
    });
  });
});

describe("runInitWizard", () => {
  let dir: string | null = null;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = null; });

  it("writes config + requests the queue dirs (scripted ask)", async () => {
    dir = mkdtempSync(join(tmpdir(), "junco-wiz-run-"));
    const cfgPath = join(dir, "config.toml");
    const printed: string[] = [];
    const made: string[] = [];
    // Record mkdir calls instead of creating real dirs (worktreeRoot defaults
    // outside the temp dir); the config write still uses the real writeFileSync.
    const code = await runInitWizard(cfgPath, {
      ask: scriptedAsk([`${dir}/vault`, "inline", "prov/m", "http://h:1/v1", "k"]),
      mkdirFn: (p) => made.push(p),
      printFn: (s) => printed.push(s),
    });
    expect(code).toBe(0);
    expect(existsSync(cfgPath)).toBe(true);
    const paths = queuePaths(loadConfig(cfgPath));
    for (const d of [paths.inbox, paths.processing, paths.done, paths.failed]) {
      expect(made).toContain(d);
    }
    expect(printed.join("")).toMatch(/Wrote config/);
  });

  it("--yes scaffolds a valid config with no prompts", async () => {
    dir = mkdtempSync(join(tmpdir(), "junco-wiz-yes-"));
    const cfgPath = join(dir, "config.toml");
    const askThatThrows: AskFn = async () => { throw new Error("should not prompt with --yes"); };
    // mkdirFn is a no-op so the default-vault config doesn't create real dirs
    // (~/junco-vault, ~/junco/worktrees) on the test machine.
    const code = await runInitWizard(cfgPath, {
      yes: true, ask: askThatThrows, mkdirFn: () => {}, printFn: () => {},
    });
    expect(code).toBe(0);
    const cfg = loadConfig(cfgPath); // parses → valid
    expect(cfg.model.id).toBe("omlx/my-model");
    expect(readFileSync(cfgPath, "utf8")).toMatch(/\[model\]/);
  });
});
