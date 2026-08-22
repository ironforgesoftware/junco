import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildWizardIO } from "../src/wizard.js";
import { defaultAnswers, answersFromConfig } from "../src/wizard/flow.js";
import type { SkillLinksReport } from "../src/skillLinks.js";

// No-op by default across this file: the real ensureSkillLinks would fall
// through to actual fs symlink calls (harmless when cfg.dataDir resolves
// into a test tmp dir, but for the fresh/rerun cases that leave dataDir at
// its schema default with no env override, `write`'s `loadConfigFn(resolved)`
// re-resolves against the REAL process.env — i.e. this machine's actual
// ~/.junco — same trap the effectiveDataDir tests already guard against for
// ensureDirs's mkdirFn). Tests exercising the skill-link wiring itself
// override this.
const NOOP_SKILL_LINKS: SkillLinksReport = { created: [], repaired: [], skipped: [], warnings: [] };
const noopEnsureSkillLinksFn = (): SkillLinksReport => NOOP_SKILL_LINKS;

const tmp = (): string => mkdtempSync(join(tmpdir(), "wiz-"));
const read = (p: string): Record<string, unknown> =>
  JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;

describe("buildWizardIO", () => {
  it("fresh mode when no config exists; io.write scaffolds it", () => {
    const dir = tmp();
    const cp = join(dir, "config.json");
    const r = buildWizardIO(cp, {
      existsFn: () => false,
      ensureSkillLinksFn: noopEnsureSkillLinksFn,
    });
    expect(r.ok && r.mode).toBe("fresh");
    if (!r.ok) throw new Error("expected ok:true");
    expect(r.io.mode).toBe("fresh");
    expect(r.io.currentRaw).toBeNull();
    expect(r.io.initialAnswers).toEqual(defaultAnswers());
    const a = { ...r.io.initialAnswers, dataDir: join(dir, "vault") };
    const result = r.io.write(a);
    expect(result.written).toBe(true);
    expect(read(cp).dataDir).toBe(join(dir, "vault"));
    expect(existsSync(join(dir, "vault", "queue", "inbox"))).toBe(true);
  });

  it("fresh mode: write with harnessDirs calls ensureSkillLinksFn once and writes the skills block", () => {
    const dir = tmp();
    const cp = join(dir, "config.json");
    const seen: unknown[] = [];
    let calls = 0;
    const r = buildWizardIO(cp, {
      existsFn: () => false,
      ensureSkillLinksFn: (cfg) => {
        calls++;
        seen.push(cfg.dataDir);
        return NOOP_SKILL_LINKS;
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok:true");
    const a = {
      ...r.io.initialAnswers,
      dataDir: join(dir, "vault"),
      harnessDirs: ["~/.claude/skills"],
    };
    const result = r.io.write(a);
    expect(result.written).toBe(true);
    expect(calls).toBe(1);
    expect(seen).toEqual([join(dir, "vault")]);
    expect(read(cp).skills).toEqual({ harnessDirs: ["~/.claude/skills"] });
  });

  it("fresh mode: write creates the data dirs BEFORE ensuring skill links", () => {
    const dir = tmp();
    const cp = join(dir, "config.json");
    const order: string[] = [];
    const r = buildWizardIO(cp, {
      existsFn: () => false,
      mkdirFn: () => {
        order.push("mkdir");
      },
      ensureSkillLinksFn: () => {
        order.push("links");
        return NOOP_SKILL_LINKS;
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok:true");
    r.io.write({ ...r.io.initialAnswers, dataDir: join(dir, "vault") });

    // ensureSkillLinks symlinks <dataDir>/skills; if it ran before the dirs
    // existed, symlinkSync would fail into a warning ensureSkillLinks never
    // throws and wizard.ts discards — an invisible regression. Pin the order.
    expect(order.length).toBeGreaterThan(1);
    expect(order.at(-1)).toBe("links");
    expect(order.filter((s) => s === "links")).toEqual(["links"]);
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
    const r = buildWizardIO(cp, { ensureSkillLinksFn: noopEnsureSkillLinksFn });
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
    const r = buildWizardIO(cp, { ensureSkillLinksFn: noopEnsureSkillLinksFn });
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
      ensureSkillLinksFn: noopEnsureSkillLinksFn,
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

  it("fresh mode: botGhConfigDir is the expanded ~/.junco/gh default", () => {
    const dir = tmp();
    const cp = join(dir, "config.json");
    const r = buildWizardIO(cp, { existsFn: () => false });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok:true");
    expect(r.io.botGhConfigDir).not.toContain("~");
    expect(r.io.botGhConfigDir.endsWith(".junco/gh")).toBe(true);
  });

  // Critical fix (Task 3 review): the dashboard-hosted Account chapter must
  // resolve botGhConfigDir through the SAME probe assembleConfig uses, or an
  // upgrader with a live legacy login gets the wizard targeting ~/.junco/gh
  // while the daemon keeps reading ~/.config/junco/gh — planting a second
  // hosts.yml that silently reroutes later resolutions (split-brain).
  it("fresh mode: targets the legacy gh config dir when a legacy login is live (env-injected, hermetic existsFn)", () => {
    const dir = tmp();
    const cp = join(dir, "config.json");
    const legacyHosts = "/h/.config/junco/gh/hosts.yml";
    const r = buildWizardIO(cp, {
      env: { HOME: "/h" },
      // Hermetic: config file itself is absent (→ fresh mode); only the
      // injected legacy hosts.yml "exists" — the canonical one does not.
      existsFn: (p) => p === legacyHosts,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok:true");
    expect(r.io.mode).toBe("fresh");
    expect(r.io.botGhConfigDir).toBe("/h/.config/junco/gh");
  });

  it("never probes an explicitly non-default configDir, even with a legacy login live", () => {
    const dir = tmp();
    const cp = join(dir, "config.json");
    const legacyHosts = "/h/.config/junco/gh/hosts.yml";
    writeFileSync(
      cp,
      JSON.stringify({
        vaultRoot: join(dir, "vault"),
        juncoSubdir: "",
        model: { id: "p/m" },
        // An absolute, non-tilde explicit override — sidesteps expandHome's
        // homedir()-vs-env(HOME) ambiguity entirely.
        botAccount: { configDir: "/explicit/custom/gh" },
      }),
      "utf8",
    );
    const r = buildWizardIO(cp, {
      env: { HOME: "/h" },
      // Even though the legacy hosts.yml "exists", an explicit configDir
      // must never be probed against it.
      existsFn: (p) => p === cp || p === legacyHosts,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok:true");
    expect(r.io.botGhConfigDir).toBe("/explicit/custom/gh");
  });

  it("rerun mode: botGhConfigDir reads botAccount.configDir / git.ghBin from the raw config", () => {
    const dir = tmp();
    const cp = join(dir, "config.json");
    writeFileSync(
      cp,
      JSON.stringify({
        vaultRoot: join(dir, "vault"),
        juncoSubdir: "",
        model: { id: "p/m" },
        botAccount: { configDir: join(dir, "custom-gh") },
        git: { ghBin: "/opt/homebrew/bin/gh" },
      }),
      "utf8",
    );
    let seenGhBin = "";
    let seenConfigDir = "";
    const r = buildWizardIO(cp, {
      detectBotLoginFn: async (ghBin, configDir) => {
        seenGhBin = ghBin;
        seenConfigDir = configDir;
        return "junco-agent";
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok:true");
    expect(r.io.botGhConfigDir).toBe(join(dir, "custom-gh"));
    return r.io.detectBotLogin().then((login) => {
      expect(login).toBe("junco-agent");
      expect(seenGhBin).toBe("/opt/homebrew/bin/gh");
      expect(seenConfigDir).toBe(join(dir, "custom-gh"));
    });
  });

  it("wires io.runGhLogin to the injected runGhLoginFn with (ghBin, botGhConfigDir)", async () => {
    const dir = tmp();
    const cp = join(dir, "config.json");
    let seenArgs: [string, string] | null = null;
    const r = buildWizardIO(cp, {
      existsFn: () => false,
      runGhLoginFn: async (ghBin, configDir) => {
        seenArgs = [ghBin, configDir];
        return 0;
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok:true");
    const code = await r.io.runGhLogin();
    expect(code).toBe(0);
    expect(seenArgs).toEqual(["gh", r.io.botGhConfigDir]);
  });
});

// Regression (task review): the wizard must display the data root the
// daemon will ACTUALLY resolve to, even during the legacy-fallback window
// (assembleConfig's single-root probe, config.ts's resolveDataRoot) — not
// the bare "~/.junco" default. Same legacy-aware pattern as botGhConfigDir
// above, but the write-side field (WizardAnswers.dataDir / initialAnswers)
// must stay the pure sentinel regardless, so a save on defaults never plants
// an explicit dataDir key pinning the legacy root.
describe("effectiveDataDir (legacy-fallback display, never fed back into a write)", () => {
  it("fresh mode, fresh machine: effectiveDataDir is the expanded ~/.junco default", () => {
    const dir = tmp();
    const cp = join(dir, "config.json");
    const r = buildWizardIO(cp, { env: { HOME: "/h" }, existsFn: () => false });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok:true");
    expect(r.io.mode).toBe("fresh");
    expect(r.io.effectiveDataDir).toBe("/h/.junco");
    expect(r.io.dataDirLegacyFallback).toBe(false);
  });

  it("fresh mode, legacy-fallback machine: effectiveDataDir surfaces the legacy root (hermetic existsFn)", () => {
    const dir = tmp();
    const cp = join(dir, "config.json");
    const legacyRoot = "/h/.local/state/junco";
    const r = buildWizardIO(cp, {
      env: { HOME: "/h" },
      // Canonical ~/.junco holds no tree; only the legacy root "exists".
      existsFn: (p) => p === legacyRoot,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok:true");
    expect(r.io.mode).toBe("fresh");
    expect(r.io.effectiveDataDir).toBe(legacyRoot);
    expect(r.io.dataDirLegacyFallback).toBe(true);
    // The write-side sentinel is UNAFFECTED by the probe above.
    expect(r.io.initialAnswers.dataDir).toBe("~/.junco");
  });

  it("legacy-fallback machine: accepting every default still writes NO dataDir key", () => {
    const dir = tmp();
    const cp = join(dir, "config.json");
    const legacyRoot = "/h/.local/state/junco";
    const r = buildWizardIO(cp, {
      env: { HOME: "/h" },
      existsFn: (p) => p === legacyRoot,
      // The post-write ensureDirs step re-loads the config with the REAL
      // env/fs (loadConfigFn isn't overridden here) — neutralize mkdir AND
      // ensureSkillLinks so this test can never touch this machine's actual
      // resolved root (ensureSkillLinks has its own real-fs defaults, not
      // threaded through this deps.mkdirFn seam).
      mkdirFn: () => {},
      ensureSkillLinksFn: noopEnsureSkillLinksFn,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok:true");
    expect(r.io.effectiveDataDir).toBe(legacyRoot); // displayed to the user
    const result = r.io.write(r.io.initialAnswers); // user touched nothing
    expect(result.written).toBe(true); // fresh mode always scaffolds the file
    const saved = read(cp);
    expect("dataDir" in saved).toBe(false);
  });

  it("rerun mode, legacy-fallback machine: same display, same no-op write", () => {
    const dir = tmp();
    const cp = join(dir, "config.json");
    const legacyRoot = "/h/.local/state/junco";
    // No dataDir/observability.stateDir key at all — the exact shape this
    // regression is about.
    writeFileSync(cp, JSON.stringify({ model: { id: "p/m" } }), "utf8");
    const r = buildWizardIO(cp, {
      env: { HOME: "/h" },
      existsFn: (p) => p === cp || p === legacyRoot,
      mkdirFn: () => {},
      // Same rationale as the sibling fresh-mode test above.
      ensureSkillLinksFn: noopEnsureSkillLinksFn,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok:true");
    expect(r.io.mode).toBe("rerun");
    expect(r.io.effectiveDataDir).toBe(legacyRoot);
    expect(r.io.dataDirLegacyFallback).toBe(true);
    const before = readFileSync(cp, "utf8");
    const result = r.io.write(r.io.initialAnswers); // zero-diff rerun
    expect(result.written).toBe(false);
    expect(readFileSync(cp, "utf8")).toBe(before); // byte-identical: still no dataDir key
  });

  it("an explicit dataDir key is honored verbatim — no legacy probe, no fallback flag", () => {
    const dir = tmp();
    const cp = join(dir, "config.json");
    const legacyRoot = "/h/.local/state/junco";
    writeFileSync(cp, JSON.stringify({ dataDir: "/custom/root", model: { id: "p/m" } }), "utf8");
    // Even though the legacy root "exists", an explicit dataDir must win
    // outright — resolveDataRoot never probes when explicitRoot is set.
    const existsFn = (p: string) => p === cp || p === legacyRoot;
    const r = buildWizardIO(cp, { env: { HOME: "/h" }, existsFn });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok:true");
    expect(r.io.effectiveDataDir).toBe("/custom/root");
    expect(r.io.dataDirLegacyFallback).toBe(false);
  });
});
