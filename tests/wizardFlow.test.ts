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
      "Extras",
      "Review",
    ]);
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
    expect(loadRendered(a).vaultRoot).toBe('/tmp/we"ird\\path');
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
});
