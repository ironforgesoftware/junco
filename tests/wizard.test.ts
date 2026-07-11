import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runInitWizard } from "../src/wizard.js";
import { defaultAnswers, answersFromConfig } from "../src/wizard/flow.js";
import type { WizardIO } from "../src/wizard/io.js";

const tmp = (): string => mkdtempSync(join(tmpdir(), "wiz-"));
const read = (p: string): Record<string, unknown> =>
  JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;

describe("runInitWizard --yes", () => {
  it("writes the default config and creates the queue dirs, no prompts", async () => {
    const dir = tmp();
    const cp = join(dir, "config.json");
    const prints: string[] = [];
    const code = await runInitWizard(cp, { yes: true, printFn: (s) => prints.push(s) });
    expect(code).toBe(0);
    const cfg = read(cp);
    expect(cfg.vaultRoot).toBe("~/Junco");
    expect((cfg.model as { id: string }).id).toBe("local/my-model");
    expect(prints.join("")).toContain("Wrote config");
    expect(prints.join("")).toContain("junco start");
  });
});

describe("runInitWizard interactive (collectFn seam)", () => {
  it("cancellation returns 130 and writes nothing", async () => {
    const dir = tmp();
    const cp = join(dir, "config.json");
    const code = await runInitWizard(cp, { collectFn: async () => "cancelled" });
    expect(code).toBe(130);
    expect(existsSync(cp)).toBe(false);
  });

  it("fresh mode hands collectFn a fresh io; write lands config + dirs", async () => {
    const dir = tmp();
    const cp = join(dir, "config.json");
    const code = await runInitWizard(cp, {
      collectFn: async (io: WizardIO) => {
        expect(io.mode).toBe("fresh");
        expect(io.initialAnswers).toEqual(defaultAnswers());
        const a = { ...io.initialAnswers, vaultRoot: join(dir, "vault") };
        const r = io.write(a);
        expect(r.written).toBe(true);
        return "written";
      },
    });
    expect(code).toBe(0);
    expect(read(cp).vaultRoot).toBe(join(dir, "vault"));
    expect(existsSync(join(dir, "vault", "inbox"))).toBe(true);
  });

  it("rerun mode prefills from the file and preserves uncovered keys", async () => {
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
    const code = await runInitWizard(cp, {
      collectFn: async (io: WizardIO) => {
        expect(io.mode).toBe("rerun");
        expect(io.initialAnswers.modelId).toBe("p/m");
        const a = { ...io.initialAnswers, modelId: "p/m2" };
        expect(io.write(a).written).toBe(true);
        return "written";
      },
    });
    expect(code).toBe(0);
    const cfg = read(cp);
    expect((cfg.model as { id: string }).id).toBe("p/m2");
    expect((cfg.worker as { maxConcurrent: number }).maxConcurrent).toBe(4); // preserved
  });

  it("zero-diff rerun leaves the file byte-identical and returns 0", async () => {
    const dir = tmp();
    const cp = join(dir, "config.json");
    writeFileSync(
      cp,
      JSON.stringify({ vaultRoot: join(dir, "vault"), juncoSubdir: "", model: { id: "p/m" } }),
      "utf8",
    );
    const before = readFileSync(cp, "utf8");
    const code = await runInitWizard(cp, {
      collectFn: async (io: WizardIO) => {
        const r = io.write(answersFromConfig(io.currentRaw ?? {}));
        expect(r.written).toBe(false);
        return "unchanged";
      },
    });
    expect(code).toBe(0);
    expect(readFileSync(cp, "utf8")).toBe(before);
    expect(existsSync(join(dir, "vault", "inbox"))).toBe(true); // dirs still ensured
  });

  it("corrupt (non-JSON) existing config prints guidance, exits 1, never invokes collectFn", async () => {
    const dir = tmp();
    const cp = join(dir, "config.json");
    writeFileSync(cp, "not json{", "utf8");
    const prints: string[] = [];
    let collectCalled = false;
    const code = await runInitWizard(cp, {
      printFn: (s) => prints.push(s),
      collectFn: async () => {
        collectCalled = true;
        return "cancelled";
      },
    });
    expect(code).toBe(1);
    expect(collectCalled).toBe(false);
    expect(prints.join("")).toMatch(/not a valid config/);
  });

  it("non-object existing config (e.g. a bare number) is rejected the same way", async () => {
    const dir = tmp();
    const cp = join(dir, "config.json");
    writeFileSync(cp, "42", "utf8");
    const prints: string[] = [];
    let collectCalled = false;
    const code = await runInitWizard(cp, {
      printFn: (s) => prints.push(s),
      collectFn: async () => {
        collectCalled = true;
        return "cancelled";
      },
    });
    expect(code).toBe(1);
    expect(collectCalled).toBe(false);
    expect(prints.join("")).toMatch(/not a valid config/);
  });
});

describe("runInitWizard raw-mode guard", () => {
  it("non-interactive terminal without collectFn returns 1 and prints guidance, no config written", async () => {
    const dir = tmp();
    const cp = join(dir, "config.json");
    const prints: string[] = [];
    const code = await runInitWizard(cp, {
      isInteractiveFn: () => false,
      printFn: (s) => prints.push(s),
    });
    expect(code).toBe(1);
    expect(prints.join("")).toMatch(/cannot run the interactive walkthrough/);
    expect(existsSync(cp)).toBe(false);
  });
});
