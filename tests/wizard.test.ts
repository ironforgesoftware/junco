import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildWizardIO } from "../src/wizard.js";
import { defaultAnswers, answersFromConfig } from "../src/wizard/flow.js";

const tmp = (): string => mkdtempSync(join(tmpdir(), "wiz-"));
const read = (p: string): Record<string, unknown> =>
  JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;

describe("buildWizardIO", () => {
  it("fresh mode when no config exists; io.write scaffolds it", () => {
    const dir = tmp();
    const cp = join(dir, "config.json");
    const r = buildWizardIO(cp, { existsFn: () => false });
    expect(r.ok && r.mode).toBe("fresh");
    if (!r.ok) throw new Error("expected ok:true");
    expect(r.io.mode).toBe("fresh");
    expect(r.io.currentRaw).toBeNull();
    expect(r.io.initialAnswers).toEqual(defaultAnswers());
    const a = { ...r.io.initialAnswers, vaultRoot: join(dir, "vault") };
    const result = r.io.write(a);
    expect(result.written).toBe(true);
    expect(read(cp).vaultRoot).toBe(join(dir, "vault"));
    expect(existsSync(join(dir, "vault", "inbox"))).toBe(true);
  });

  it("rerun mode reads the existing raw config into initialAnswers", () => {
    const dir = tmp();
    const cp = join(dir, "config.json");
    const raw = {
      vaultRoot: join(dir, "vault"),
      juncoSubdir: "",
      model: { id: "p/m", baseUrl: "http://h:1/v1", apiKey: "k" },
      worker: { maxConcurrent: 4 },
    };
    writeFileSync(cp, JSON.stringify(raw), "utf8");
    const r = buildWizardIO(cp);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok:true");
    expect(r.mode).toBe("rerun");
    expect(r.io.mode).toBe("rerun");
    expect(r.io.initialAnswers.modelId).toBe("p/m");
    expect(r.io.currentRaw).toEqual(raw);
  });

  it("invalid existing config → ok:false with the parse reason", () => {
    const dir = tmp();
    const cp = join(dir, "config.json");
    writeFileSync(cp, "not json{", "utf8");
    const r = buildWizardIO(cp);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected ok:false");
    expect(r.error).toMatch(/not a valid config/);
  });

  it("non-object existing config → ok:false", () => {
    const dir = tmp();
    const cp = join(dir, "config.json");
    writeFileSync(cp, "42", "utf8");
    const r = buildWizardIO(cp);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected ok:false");
    expect(r.error).toMatch(/not a valid config/);
  });

  it("wires io.listCatalogProviders to the injected listCatalogProvidersFn", async () => {
    const dir = tmp();
    const cp = join(dir, "config.json");
    let calls = 0;
    const r = buildWizardIO(cp, {
      listCatalogProvidersFn: async () => {
        calls++;
        return [{ provider: "acme", ids: ["big", "small"] }];
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok:true");
    const catalog = await r.io.listCatalogProviders();
    expect(catalog).toEqual([{ provider: "acme", ids: ["big", "small"] }]);
    expect(calls).toBe(1);
  });

  it("rerun mode write preserves uncovered keys and applies only the diff", () => {
    const dir = tmp();
    const cp = join(dir, "config.json");
    writeFileSync(
      cp,
      JSON.stringify({
        vaultRoot: join(dir, "vault"),
        juncoSubdir: "",
        model: { id: "p/m", baseUrl: "http://h:1/v1", apiKey: "k" },
        worker: { maxConcurrent: 4 },
      }),
      "utf8",
    );
    const r = buildWizardIO(cp);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok:true");
    const a = { ...r.io.initialAnswers, modelId: "p/m2" };
    expect(r.io.write(a).written).toBe(true);
    const cfg = read(cp);
    expect((cfg.model as { id: string }).id).toBe("p/m2");
    expect((cfg.worker as { maxConcurrent: number }).maxConcurrent).toBe(4); // preserved
  });

  it("zero-diff rerun write leaves the file byte-identical and reports written:false", () => {
    const dir = tmp();
    const cp = join(dir, "config.json");
    writeFileSync(
      cp,
      JSON.stringify({ vaultRoot: join(dir, "vault"), juncoSubdir: "", model: { id: "p/m" } }),
      "utf8",
    );
    const before = readFileSync(cp, "utf8");
    const r = buildWizardIO(cp);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok:true");
    const result = r.io.write(answersFromConfig(r.io.currentRaw ?? {}));
    expect(result.written).toBe(false);
    expect(readFileSync(cp, "utf8")).toBe(before);
    expect(existsSync(join(dir, "vault", "inbox"))).toBe(true); // dirs still ensured
  });

  it("rename failure cleans up the PID-suffixed temp file and rethrows", () => {
    const dir = tmp();
    const cp = join(dir, "config.json");
    writeFileSync(
      cp,
      JSON.stringify({ vaultRoot: join(dir, "vault"), juncoSubdir: "", model: { id: "p/m" } }),
      "utf8",
    );
    const unlinked: string[] = [];
    const r = buildWizardIO(cp, {
      renameFn: () => {
        throw new Error("EPERM: rename blocked");
      },
      unlinkFn: (p) => unlinked.push(p),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok:true");
    let thrown: unknown;
    try {
      r.io.write({ ...r.io.initialAnswers, modelId: "p/m2" }); // real diff → write attempted
    } catch (e) {
      thrown = e;
    }
    expect(unlinked.length).toBe(1);
    expect(unlinked[0]).toMatch(/\.config\.json\.tmp-\d+$/);
    expect(unlinked[0]).toContain(String(process.pid));
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/EPERM/);
  });
});
