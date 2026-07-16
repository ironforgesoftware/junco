import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CHAPTERS,
  defaultAnswers,
  buildConfigObject,
  renderConfigJson,
  answersFromConfig,
  diffAnswers,
  applyAnswers,
  COVERED_LEVER_COUNT,
  type WizardAnswers,
} from "../src/wizard/flow.js";
import { loadConfig, queuePaths } from "../src/config.js";

function loadRendered(a: WizardAnswers) {
  const dir = mkdtempSync(join(tmpdir(), "wizflow-"));
  const p = join(dir, "config.json");
  writeFileSync(p, renderConfigJson(a), "utf8");
  return loadConfig(p);
}

describe("chapters", () => {
  it("is the approved rail order", () => {
    expect(CHAPTERS).toEqual([
      "Welcome",
      "Workspace",
      "Model",
      "Repo safety",
      "GitHub",
      "Account",
      "Extras",
      "Review",
    ]);
  });

  it("CHAPTERS includes Account between GitHub and Extras", () => {
    expect(CHAPTERS.indexOf("Account")).toBe(CHAPTERS.indexOf("GitHub") + 1);
    expect(CHAPTERS.indexOf("Extras")).toBe(CHAPTERS.indexOf("Account") + 1);
  });
});

describe("defaultAnswers", () => {
  it("keeps today's --yes pins and adds safe walkthrough defaults", () => {
    const a = defaultAnswers();
    expect(a.vaultRoot).toBe("~/Junco");
    expect(a.modelId).toBe("local/my-model");
    expect(a.baseUrl).toBe("http://127.0.0.1:1234/v1");
    expect(a.apiKey).toBe("1234");
    expect(a.repoRoots).toEqual([]);
    expect(a.github).toEqual({ enabled: false, repos: [], requireApproval: true });
    expect(a.extras).toEqual({ sandbox: true, verify: true, health: true, transcripts: true });
  });
});

describe("buildConfigObject / renderConfigJson", () => {
  it("defaults render the same minimal config as today's --yes", () => {
    const obj = buildConfigObject(defaultAnswers());
    expect(Object.keys(obj).sort()).toEqual(["juncoSubdir", "model", "vaultRoot"]);
    const cfg = loadRendered(defaultAnswers());
    expect(cfg.model.id).toBe("local/my-model");
    expect(queuePaths(cfg).inbox.endsWith("Junco/inbox")).toBe(true);
  });

  it("non-default answers land in the right sections and round-trip", () => {
    const a: WizardAnswers = {
      ...defaultAnswers(),
      vaultRoot: "/tmp/jv",
      repoRoots: ["~/code"],
      github: {
        enabled: true,
        repos: [{ nwo: "acme/api", path: "/tmp/acme" }],
        requireApproval: false,
      },
      extras: { sandbox: false, verify: true, health: false, transcripts: true },
    };
    const cfg = loadRendered(a);
    expect(cfg.allowedRepoRoots.length).toBe(1);
    expect(cfg.github.enabled).toBe(true);
    expect(cfg.github.repos).toEqual([{ nwo: "acme/api", path: "/tmp/acme" }]);
    expect(cfg.github.requireApproval).toBe(false);
    expect(cfg.sandbox.enabled).toBe(false);
    expect(cfg.healthEnabled).toBe(false);
    // checked extras are OMITTED (schema default already true)
    const obj = buildConfigObject(a);
    expect((obj.verify as undefined) === undefined).toBe(true);
    expect((obj.observability as Record<string, unknown>).transcripts).toBeUndefined();
  });

  it("models_json mode writes model.modelsJson and no inline fields", () => {
    const a: WizardAnswers = {
      ...defaultAnswers(),
      mode: "models_json",
      modelsJson: "~/.pi/agent/models.json",
      modelId: "prov/m1",
    };
    const obj = buildConfigObject(a);
    const model = obj.model as Record<string, unknown>;
    expect(model.modelsJson).toBe("~/.pi/agent/models.json");
    expect(model.baseUrl).toBeUndefined();
    expect(model.apiKey).toBeUndefined();
    expect(loadRendered(a).model.id).toBe("prov/m1");
  });

  it("escapes JSON-hostile strings", () => {
    const a = { ...defaultAnswers(), vaultRoot: '/tmp/we"ird\\path' };
    expect(loadRendered(a).queueRoot).toBe('/tmp/we"ird\\path');
  });
});

describe("hosted mode — fresh build (must PRESERVE catalog eligibility)", () => {
  it("emits model.id only — no baseUrl, no apiKey when blank, never a source key", () => {
    const a: WizardAnswers = {
      ...defaultAnswers(),
      mode: "hosted",
      modelId: "anthropic/claude-sonnet-4-5",
      apiKey: undefined,
    };
    const obj = buildConfigObject(a);
    const model = obj.model as Record<string, unknown>;
    expect(model).toEqual({ id: "anthropic/claude-sonnet-4-5" });
    expect("baseUrl" in model).toBe(false);
    expect("apiKey" in model).toBe(false);
    expect("source" in model).toBe(false);
  });

  it("includes model.apiKey when the user pasted a literal key", () => {
    const a: WizardAnswers = {
      ...defaultAnswers(),
      mode: "hosted",
      modelId: "openai/gpt-4o",
      apiKey: "sk-live-abc123",
    };
    const model = buildConfigObject(a).model as Record<string, unknown>;
    expect(model).toEqual({ id: "openai/gpt-4o", apiKey: "sk-live-abc123" });
  });

  it("includes model.apiKey verbatim for a $VAR reference", () => {
    const a: WizardAnswers = {
      ...defaultAnswers(),
      mode: "hosted",
      modelId: "openai/gpt-4o",
      apiKey: "$OPENAI_API_KEY",
    };
    const model = buildConfigObject(a).model as Record<string, unknown>;
    expect(model.apiKey).toBe("$OPENAI_API_KEY");
  });

  it("round-trips catalog-eligible: no baseUrl key means baseUrlExplicit stays false", () => {
    const a: WizardAnswers = {
      ...defaultAnswers(),
      mode: "hosted",
      modelId: "anthropic/claude-sonnet-4-5",
      apiKey: undefined,
    };
    const cfg = loadRendered(a);
    expect(cfg.model.id).toBe("anthropic/claude-sonnet-4-5");
    expect(cfg.model.baseUrlExplicit).toBe(false);
  });
});

describe("re-run mode", () => {
  const raw = {
    vaultRoot: "/v",
    juncoSubdir: "",
    model: { id: "prov/m", baseUrl: "http://h:1/v1", apiKey: "k" },
    worker: { maxConcurrent: 3 }, // NOT wizard-covered — must survive untouched
    git: { allowedRepoRoots: ["/code"], branchPrefix: "junco/" },
    sandbox: { enabled: false },
  };

  it("answersFromConfig prefills covered levers and defaults the rest", () => {
    const a = answersFromConfig(raw);
    expect(a.vaultRoot).toBe("/v");
    expect(a.mode).toBe("inline");
    expect(a.modelId).toBe("prov/m");
    expect(a.repoRoots).toEqual(["/code"]);
    expect(a.extras.sandbox).toBe(false);
    expect(a.extras.verify).toBe(true); // schema default
    expect(a.github.enabled).toBe(false);
  });

  it("prefers models_json mode when the file sets it", () => {
    const a = answersFromConfig({ model: { id: "p/m", modelsJson: "/mj.json" } });
    expect(a.mode).toBe("models_json");
    expect(a.modelsJson).toBe("/mj.json");
  });

  it("diffAnswers reports only changed paths", () => {
    const a = answersFromConfig(raw);
    a.vaultRoot = "/v2";
    a.extras.sandbox = true;
    const d = diffAnswers(raw, a);
    expect(d).toContainEqual({ path: "vaultRoot", from: "/v", to: "/v2" });
    expect(d).toContainEqual({ path: "sandbox.enabled", from: false, to: true });
    expect(d.length).toBe(2);
  });

  it("diffAnswers is empty when nothing changed", () => {
    expect(diffAnswers(raw, answersFromConfig(raw))).toEqual([]);
  });

  it("applyAnswers preserves uncovered keys verbatim and does not mutate input", () => {
    const a = answersFromConfig(raw);
    a.vaultRoot = "/v2";
    const out = applyAnswers(raw, a);
    expect(out.vaultRoot).toBe("/v2");
    expect((out.worker as { maxConcurrent: number }).maxConcurrent).toBe(3);
    expect((out.git as { branchPrefix: string }).branchPrefix).toBe("junco/");
    expect(raw.vaultRoot).toBe("/v"); // input untouched
  });

  it("switching models_json → inline clears model.modelsJson in the output", () => {
    const mjRaw = { vaultRoot: "/v", model: { id: "p/m", modelsJson: "/mj.json" } };
    const a = answersFromConfig(mjRaw);
    a.mode = "inline";
    a.baseUrl = "http://h:1/v1";
    a.apiKey = "k";
    const out = applyAnswers(mjRaw, a);
    expect(JSON.stringify(out)).not.toContain("modelsJson");
    expect((out.model as { baseUrl: string }).baseUrl).toBe("http://h:1/v1");
  });

  it("switching inline → models_json clears model.baseUrl and model.apiKey in the output", () => {
    const inlineRaw = {
      vaultRoot: "/v",
      model: { id: "p/m", baseUrl: "http://h:1/v1", apiKey: "k" },
    };
    const a = answersFromConfig(inlineRaw);
    a.mode = "models_json";
    a.modelsJson = "/mj.json";
    const out = applyAnswers(inlineRaw, a);
    expect((out.model as { modelsJson: string }).modelsJson).toBe("/mj.json");
    expect(JSON.stringify(out)).not.toContain("baseUrl");
    expect(JSON.stringify(out)).not.toContain("apiKey");
  });

  it("COVERED_LEVER_COUNT is mode-independent and matches the covered surface", () => {
    expect(COVERED_LEVER_COUNT).toBe(14);
    // The pin makes coverage changes conscious: it must be updated when the
    // wizard's covered-lever surface expands or contracts.
  });

  it("regression: inline config rerun still writes model.baseUrl (an unrelated change doesn't drop it)", () => {
    const out = applyAnswers(raw, { ...answersFromConfig(raw), modelId: "prov/m2" });
    expect((out.model as { baseUrl: string }).baseUrl).toBe("http://h:1/v1");
  });

  it("botAccount answer round-trips: build, prefill, diff", () => {
    const a = { ...defaultAnswers(), botAccount: true };
    const obj = buildConfigObject(a);
    expect(obj.botAccount).toEqual({ enabled: true });
    // fresh default omits the block entirely
    expect(buildConfigObject(defaultAnswers()).botAccount).toBeUndefined();
    // prefill
    expect(answersFromConfig({ vaultRoot: "/v", botAccount: { enabled: true } }).botAccount).toBe(
      true,
    );
    expect(answersFromConfig({ vaultRoot: "/v" }).botAccount).toBe(false);
    // rerun diff: flipping it registers exactly one change at the lever path
    const diffs = diffAnswers(
      { vaultRoot: "/v" },
      { ...answersFromConfig({ vaultRoot: "/v" }), botAccount: true },
    );
    expect(diffs).toEqual([{ path: "botAccount.enabled", from: undefined, to: true }]);
  });
});

describe("hosted mode — re-run detection (the trap: misclassifying as inline destroys catalog eligibility)", () => {
  it("classifies hosted when the raw config has no modelsJson and no baseUrl key", () => {
    const a = answersFromConfig({ vaultRoot: "/v", model: { id: "anthropic/claude-sonnet-4-5" } });
    expect(a.mode).toBe("hosted");
    expect(a.modelId).toBe("anthropic/claude-sonnet-4-5");
    expect(a.baseUrl).toBeUndefined(); // NO localhost baseUrl prefill
  });

  it("prefills a hosted apiKey verbatim (literal or $VAR ref), never the inline placeholder when absent", () => {
    const withKey = answersFromConfig({ model: { id: "p/m", apiKey: "$OPENAI_API_KEY" } });
    expect(withKey.apiKey).toBe("$OPENAI_API_KEY");
    const withoutKey = answersFromConfig({ model: { id: "p/m" } });
    expect(withoutKey.apiKey).toBeUndefined(); // NOT "1234" (defaultAnswers' inline placeholder)
  });

  it("still prefers models_json mode when the file sets it, even with no baseUrl key", () => {
    const a = answersFromConfig({ model: { id: "p/m", modelsJson: "/mj.json" } });
    expect(a.mode).toBe("models_json");
  });

  it("hosted rerun coveredPaths never write model.baseUrl, even when the id changes", () => {
    const hostedRaw = { vaultRoot: "/v", model: { id: "p/m" } };
    const a = answersFromConfig(hostedRaw);
    a.modelId = "p/m2";
    expect(diffAnswers(hostedRaw, a)).toEqual([{ path: "model.id", from: "p/m", to: "p/m2" }]);
    const out = applyAnswers(hostedRaw, a);
    expect((out.model as { id: string }).id).toBe("p/m2");
    expect(JSON.stringify(out)).not.toContain("baseUrl");
  });

  it("hosted rerun surfaces model.apiKey only when it actually changes", () => {
    const hostedRaw = { vaultRoot: "/v", model: { id: "p/m", apiKey: "$OLD_VAR" } };
    const a = answersFromConfig(hostedRaw);
    expect(diffAnswers(hostedRaw, a)).toEqual([]); // untouched rerun is a true no-op
    a.apiKey = "$NEW_VAR";
    expect(diffAnswers(hostedRaw, a)).toEqual([
      { path: "model.apiKey", from: "$OLD_VAR", to: "$NEW_VAR" },
    ]);
    const out = applyAnswers(hostedRaw, a);
    expect((out.model as { apiKey: string }).apiKey).toBe("$NEW_VAR");
    expect(JSON.stringify(out)).not.toContain("baseUrl");
  });

  it("switching inline → hosted clears model.baseUrl and model.apiKey in the output", () => {
    const inlineRaw = {
      vaultRoot: "/v",
      model: { id: "p/m", baseUrl: "http://h:1/v1", apiKey: "k" },
    };
    const a = answersFromConfig(inlineRaw);
    a.mode = "hosted";
    a.baseUrl = undefined;
    a.apiKey = undefined;
    const out = applyAnswers(inlineRaw, a);
    expect((out.model as { id: string }).id).toBe("p/m");
    expect(JSON.stringify(out)).not.toContain("baseUrl");
    expect(JSON.stringify(out)).not.toContain("apiKey");
  });

  it("switching hosted → inline writes model.baseUrl and model.apiKey in the output", () => {
    const hostedRaw = { vaultRoot: "/v", model: { id: "p/m" } };
    const a = answersFromConfig(hostedRaw);
    a.mode = "inline";
    a.baseUrl = "http://h:1/v1";
    a.apiKey = "k";
    const out = applyAnswers(hostedRaw, a);
    expect((out.model as { baseUrl: string; apiKey: string }).baseUrl).toBe("http://h:1/v1");
    expect((out.model as { baseUrl: string; apiKey: string }).apiKey).toBe("k");
  });
});
