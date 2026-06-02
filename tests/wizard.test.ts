import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  renderConfigToml,
  collectAnswers,
  defaultAnswers,
  runInitWizard,
  type WizardAnswers,
} from "../src/wizard.js";
import { loadConfig, queuePaths } from "../src/config.js";
import { type Prompter, WizardCancelled } from "../src/wizard/prompter.js";

// A scripted Prompter: pops queued text()/select() answers in order; empty queue
// falls back to the prompt's default / first option. The spinner runs inline.
function scriptedPrompter(a: { text?: string[]; select?: string[] } = {}): Prompter {
  const text = [...(a.text ?? [])];
  const select = [...(a.select ?? [])];
  return {
    intro() {},
    note() {},
    async text(o) {
      return text.length ? text.shift()! : (o.default ?? "");
    },
    async select(o) {
      return select.length ? select.shift()! : o.options[0].value;
    },
    async spinner(_s, task) {
      return task();
    },
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

  it("inline mode — queue directly under vault_root (no /Junco)", () => {
    const a: WizardAnswers = {
      vaultRoot: "/tmp/jv", mode: "inline", modelId: "prov/m",
      baseUrl: "http://h:1/v1", apiKey: "k",
    };
    const cfg = parse(renderConfigToml(a));
    expect(cfg.model.id).toBe("prov/m");
    expect(cfg.model.baseUrl).toBe("http://h:1/v1");
    expect(cfg.model.apiKey).toBe("k");
    expect(cfg.model.modelsJson).toBeNull();
    expect(cfg.juncoSubdir).toBe("");
    expect(queuePaths(cfg).inbox).toBe("/tmp/jv/inbox"); // no "Junco" segment
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

describe("defaultAnswers", () => {
  it("→ ~/Junco + neutral model (no personal-stack strings)", () => {
    expect(defaultAnswers()).toEqual({
      vaultRoot: "~/Junco", mode: "inline", modelId: "local/my-model",
      baseUrl: "http://127.0.0.1:1234/v1", apiKey: "1234",
    });
  });
});

describe("collectAnswers", () => {
  it("inline: picks a discovered model, prefixed by the inferred provider", async () => {
    const p = scriptedPrompter({
      text: ["~/v", "http://127.0.0.1:1234/v1", "secret"], select: ["inline", "m-fast"],
    });
    const a = await collectAnswers(p, { fetchModelsFn: async () => ["m-fast", "m-slow"] });
    expect(a).toEqual({
      vaultRoot: "~/v", mode: "inline", modelId: "local/m-fast",
      baseUrl: "http://127.0.0.1:1234/v1", apiKey: "secret",
    });
  });

  it("inline: manual entry keeps a slash-containing id unprefixed", async () => {
    const p = scriptedPrompter({
      text: ["~/v", "https://openrouter.ai/api/v1", "k", "anthropic/claude"],
      select: ["inline", " manual"],
    });
    const a = await collectAnswers(p, { fetchModelsFn: async () => ["x"] });
    expect(a.modelId).toBe("anthropic/claude");
  });

  it("inline: empty discovery falls straight to a manual prompt, prefixed", async () => {
    const p = scriptedPrompter({
      text: ["~/v", "https://api.openai.com/v1", "k", "gpt-z"], select: ["inline"],
    });
    const a = await collectAnswers(p, { fetchModelsFn: async () => [] });
    expect(a.modelId).toBe("openai/gpt-z");
  });

  it("models_json: lists file entries", async () => {
    const p = scriptedPrompter({ text: ["~/v", "~/m.json"], select: ["models_json", "omlx/alpha"] });
    const a = await collectAnswers(p, { parseModelsJsonFn: () => ["omlx/alpha", "omlx/beta"] });
    expect(a).toEqual({ vaultRoot: "~/v", mode: "models_json", modelId: "omlx/alpha", modelsJson: "~/m.json" });
  });
});

describe("runInitWizard", () => {
  let dir: string | null = null;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = null; });

  it("writes config + requests the queue dirs", async () => {
    dir = mkdtempSync(join(tmpdir(), "junco-wiz-run-"));
    const cfgPath = join(dir, "config.toml");
    const printed: string[] = [];
    const made: string[] = [];
    const code = await runInitWizard(cfgPath, {
      prompter: scriptedPrompter({
        text: [`${dir}/vault`, "http://127.0.0.1:1234/v1", "k"], select: ["inline", "m-a"],
      }),
      fetchModelsFn: async () => ["m-a"],
      mkdirFn: (p) => made.push(p),
      printFn: (s) => printed.push(s),
    });
    expect(code).toBe(0);
    expect(existsSync(cfgPath)).toBe(true);
    const cfg = loadConfig(cfgPath);
    expect(cfg.juncoSubdir).toBe("");
    const paths = queuePaths(cfg);
    for (const d of [paths.inbox, paths.processing, paths.done, paths.failed]) {
      expect(made).toContain(d);
    }
    expect(printed.join("")).toMatch(/Wrote config/);
  });

  it("--yes scaffolds a valid config with no prompts", async () => {
    dir = mkdtempSync(join(tmpdir(), "junco-wiz-yes-"));
    const cfgPath = join(dir, "config.toml");
    const code = await runInitWizard(cfgPath, { yes: true, mkdirFn: () => {}, printFn: () => {} });
    expect(code).toBe(0);
    const cfg = loadConfig(cfgPath); // parses → valid
    expect(cfg.model.id).toBe("local/my-model");
    expect(readFileSync(cfgPath, "utf8")).toMatch(/\[model\]/);
  });

  it("returns 130 on cancel and writes nothing", async () => {
    dir = mkdtempSync(join(tmpdir(), "junco-wiz-cancel-"));
    const cfgPath = join(dir, "config.toml");
    const written: string[] = [];
    const cancelling: Prompter = {
      ...scriptedPrompter(),
      async text() { throw new WizardCancelled(); },
    };
    const code = await runInitWizard(cfgPath, {
      prompter: cancelling, writeFileFn: (p) => written.push(p), mkdirFn: () => {}, printFn: () => {},
    });
    expect(code).toBe(130);
    expect(written).toEqual([]);
  });
});
