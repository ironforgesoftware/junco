import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CHAPTERS,
  defaultAnswers,
  buildConfigObject,
  renderConfigJson,
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
