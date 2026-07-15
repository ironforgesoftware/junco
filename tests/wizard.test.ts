import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runInitWizard, buildWizardIO } from "../src/wizard.js";
import { defaultAnswers, answersFromConfig } from "../src/wizard/flow.js";
import type { WizardIO } from "../src/wizard/io.js";

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
});

describe("runInitWizard --yes", () => {
  it("writes the default config and creates the queue dirs, no prompts", async () => {
    const dir = tmp();
    const cp = join(dir, "config.json");
    const prints: string[] = [];
    // mkdirFn spy, NOT the real mkdirSync: the default vaultRoot is "~/Junco",
    // so real dir creation would escape the tmpdir sandbox into $HOME (and on
    // a case-insensitive fs, into the maintainer's live "~/junco" vault).
    const dirs: string[] = [];
    const code = await runInitWizard(cp, {
      yes: true,
      printFn: (s) => prints.push(s),
      mkdirFn: (p) => dirs.push(p),
    });
    expect(code).toBe(0);
    const cfg = read(cp);
    expect(cfg.vaultRoot).toBe("~/Junco");
    expect((cfg.model as { id: string }).id).toBe("local/my-model");
    for (const box of ["inbox", "processing", "done", "failed"]) {
      expect(dirs.some((d) => d.endsWith(box))).toBe(true);
    }
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

  it("wires io.listCatalogProviders to the injected listCatalogProvidersFn", async () => {
    const dir = tmp();
    const cp = join(dir, "config.json");
    let calls = 0;
    const code = await runInitWizard(cp, {
      listCatalogProvidersFn: async () => {
        calls++;
        return [{ provider: "acme", ids: ["big", "small"] }];
      },
      collectFn: async (io: WizardIO) => {
        const catalog = await io.listCatalogProviders();
        expect(catalog).toEqual([{ provider: "acme", ids: ["big", "small"] }]);
        return "cancelled";
      },
    });
    expect(code).toBe(130);
    expect(calls).toBe(1);
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

  it("cancel after a successful write still reports the generic cancelled message (transitional)", async () => {
    // Was the #174 regression test ("...reports the config WAS written,
    // truthful exit"): io.write can succeed (file renamed into place) and
    // *then* throw further down the same call (ensureDirs -> loadConfigFn) —
    // e.g. a corrupt/unreadable config surfacing only once queuePaths reads
    // it back. runInitWizard used to track that with an outer `wroteFile`
    // flag so the cancel message stayed truthful about the on-disk state.
    //
    // Plan B Task 2 moved io.write into buildWizardIO's closure, so
    // runInitWizard no longer has visibility into whether the rename landed
    // before the later throw — per that task's brief, the flag is dropped
    // rather than threaded through WizardIoResult.
    //
    // Known transitional inaccuracy, accepted: this path IS reachable with
    // the real WizardApp, not just this fake collectFn — write() renames the
    // config into place BEFORE ensureDirs(loadConfigFn(...)), which can
    // throw independently; WizardApp catches that throw and leaves `result`
    // null, so a subsequent q/Esc/Ctrl-C maps to cancel() with the file
    // already on disk, and "Setup cancelled — nothing written." is wrong on
    // that narrow path. runInitWizard is deleted in the next tasks (B4), so
    // no release ever carries this; the dashboard host (B3) restores
    // truthful reporting via an existence check at print time.
    const dir = tmp();
    const cp = join(dir, "config.json");
    const prints: string[] = [];
    const code = await runInitWizard(cp, {
      printFn: (s) => prints.push(s),
      // Throw on the read-back that follows the successful rename: io.write's
      // file write lands and THEN the ensureDirs step blows up — the exact
      // partial-failure shape #174 is about. Throwing here also keeps the
      // test sandboxed: ensureDirs never runs, so the default "~/Junco"
      // vaultRoot never touches the real $HOME.
      loadConfigFn: () => {
        throw new Error("boom: unreadable after write");
      },
      collectFn: async (io: WizardIO) => {
        try {
          io.write(io.initialAnswers);
        } catch {
          // swallowed by the interactive layer, same as a real WizardApp
          // catching io.write and then the user quitting from Review.
        }
        return "cancelled";
      },
    });
    expect(code).toBe(130);
    expect(existsSync(cp)).toBe(true); // the write itself landed
    expect(prints.join("")).toBe("Setup cancelled — nothing written.\n");
  });

  it("rename failure cleans up the PID-suffixed temp file and rethrows", async () => {
    const dir = tmp();
    const cp = join(dir, "config.json");
    writeFileSync(
      cp,
      JSON.stringify({ vaultRoot: join(dir, "vault"), juncoSubdir: "", model: { id: "p/m" } }),
      "utf8",
    );
    const unlinked: string[] = [];
    let thrown: unknown;
    const code = await runInitWizard(cp, {
      renameFn: () => {
        throw new Error("EPERM: rename blocked");
      },
      unlinkFn: (p) => unlinked.push(p),
      collectFn: async (io: WizardIO) => {
        try {
          io.write({ ...io.initialAnswers, modelId: "p/m2" }); // real diff → write attempted
        } catch (e) {
          thrown = e;
        }
        return "cancelled";
      },
    });
    expect(code).toBe(130);
    expect(unlinked.length).toBe(1);
    expect(unlinked[0]).toMatch(/\.config\.json\.tmp-\d+$/);
    expect(unlinked[0]).toContain(String(process.pid));
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/EPERM/);
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
