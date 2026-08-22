/**
 * The guided setup walkthrough's non-interactive core. All side effects live
 * in the WizardIO built by `buildWizardIO` — a standalone entry point the
 * dashboard-hosted Root (src/tui/Root.tsx) calls to drive the Ink WizardApp
 * without this module touching stdin/Ink itself.
 */

import {
  writeFileSync,
  readFileSync,
  renameSync,
  mkdirSync,
  existsSync,
  unlinkSync,
} from "node:fs";
import { resolve, dirname, join } from "node:path";
import type { Config } from "./types.js";
import {
  loadConfig,
  queuePaths,
  expandHome,
  validateConfigObject,
  resolveBotGhConfigDir,
  resolveDataRoot,
} from "./config.js";
import {
  defaultAnswers,
  renderConfigJson,
  buildConfigObject,
  answersFromConfig,
  diffAnswers,
  applyAnswers,
  type WizardAnswers,
  type AnswerDiff,
} from "./wizard/flow.js";
import type { WizardIO } from "./wizard/io.js";
import { greetingName, preflightChecks, flightChecks, type DetectDeps } from "./wizard/detect.js";
import { fetchModels, parseModelsJson } from "./wizard/models.js";
import { listCatalogProviders, type CatalogEntry } from "./agent/session.js";
import { NEXT_STEPS } from "./wizard/tips.js";
import { getAtPath } from "./configLevers.js";
import { detectBotLogin, runGhLogin } from "./ghAuth.js";
import {
  detectInstalledHarnesses,
  ensureSkillLinks,
  isSkillLinkFailure,
  renderSkillLinkEntry,
  type SkillLinksReport,
} from "./skillLinks.js";
import { log } from "./logging.js";

export interface WizardDeps {
  detectDeps?: DetectDeps;
  fetchModelsFn?: typeof fetchModels;
  parseModelsJsonFn?: typeof parseModelsJson;
  listCatalogProvidersFn?: () => Promise<CatalogEntry[]>;
  writeFileFn?: (path: string, content: string) => void;
  renameFn?: (from: string, to: string) => void;
  /** Best-effort cleanup of the PID-suffixed temp file when renameFn throws
   * after the temp write succeeded. */
  unlinkFn?: (p: string) => void;
  readFileFn?: (path: string) => string;
  existsFn?: (path: string) => boolean;
  loadConfigFn?: (path: string) => Config;
  mkdirFn?: (path: string) => void;
  detectBotLoginFn?: typeof detectBotLogin;
  runGhLoginFn?: typeof runGhLogin;
  /** Injected for the botGhConfigDir legacy-liveness probe (resolveBotGhConfigDir);
   * defaults to process.env. */
  env?: Record<string, string | undefined>;
  ensureSkillLinksFn?: (cfg: Config) => SkillLinksReport;
}

export type WizardIoResult =
  | { ok: true; io: WizardIO; mode: "fresh" | "rerun" }
  | { ok: false; error: string };

/** Builds the WizardIO (fresh-scaffold or rerun-prefill, plus the atomic
 * write path) without touching stdin/Ink — the standalone entry point the
 * dashboard-hosted Root builds on. Returns `ok:false` instead of printing so
 * every caller controls its own message. */
export function buildWizardIO(configPath: string, deps: WizardDeps = {}): WizardIoResult {
  const resolved = resolve(configPath);
  const existsFn = deps.existsFn ?? existsSync;
  const mkdirFn = deps.mkdirFn ?? ((p) => mkdirSync(p, { recursive: true }));
  const writeFileFn = deps.writeFileFn ?? ((p, c) => writeFileSync(p, c, "utf8"));
  const readFileFn = deps.readFileFn ?? ((p) => readFileSync(p, "utf8"));
  const renameFn = deps.renameFn ?? renameSync;
  const unlinkFn = deps.unlinkFn ?? unlinkSync;
  const loadConfigFn = deps.loadConfigFn ?? loadConfig;

  const ensureDirs = (cfg: Config): string => {
    const paths = queuePaths(cfg);
    for (const d of [paths.inbox, paths.processing, paths.done, paths.failed, cfg.worktreeRoot]) {
      mkdirFn(d);
    }
    return dirname(paths.inbox);
  };

  const mode: "fresh" | "rerun" = existsFn(resolved) ? "rerun" : "fresh";
  let raw: Record<string, unknown> | null = null;
  if (mode === "rerun") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileFn(resolved));
    } catch (e) {
      return {
        ok: false,
        error: `${resolved} is not a valid config (${e instanceof Error ? e.message : String(e)})`,
      };
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      const kind = parsed === null ? "null" : Array.isArray(parsed) ? "an array" : typeof parsed;
      return {
        ok: false,
        error: `${resolved} is not a valid config (expected a JSON object, got ${kind})`,
      };
    }
    raw = parsed as Record<string, unknown>;
  }

  const rawBotDir =
    raw !== null ? (getAtPath(raw, "botAccount.configDir") as string | undefined) : undefined;
  const rawGhBin = raw !== null ? (getAtPath(raw, "git.ghBin") as string | undefined) : undefined;
  // Same resolution assembleConfig uses (never re-derive the default here) —
  // the dashboard-hosted Account chapter must target the SAME dir the daemon
  // reads, or this plants a second hosts.yml (split-brain).
  const { dir: botGhConfigDir } = resolveBotGhConfigDir(rawBotDir, deps.env, existsFn);
  const wizGhBin = rawGhBin ?? "gh";

  // Same legacy-aware pattern as botGhConfigDir just above, for the data
  // root: WizardAnswers.dataDir (answersFromConfig) stays the pure write-side
  // sentinel ("~/.junco" when unset — see flow.ts's doc comment on that
  // field), but the Workspace chapter needs the EFFECTIVE root assembleConfig
  // will actually resolve to, which requires the same filesystem probe
  // assembleConfig itself runs (resolveDataRoot) — this module is the IO-
  // aware layer, so it's the only place that can do that probe. Presence
  // check mirrors assembleConfig's own `nStateDir ?? d.dataDir` precedence;
  // trim-empty is normalized the same way assembleConfig's local `norm`
  // does (an explicitly-set-but-empty key counts as unset).
  const normPath = (v: unknown): string | undefined =>
    typeof v === "string" && v.trim() !== "" ? v : undefined;
  const explicitDataRoot =
    raw !== null
      ? (normPath(getAtPath(raw, "observability.stateDir")) ?? normPath(getAtPath(raw, "dataDir")))
      : undefined;
  const { dataDir: effectiveDataDir, legacyDataRoot: dataDirLegacyFallback } = resolveDataRoot(
    explicitDataRoot,
    deps.env,
    existsFn,
  );

  const io: WizardIO = {
    mode,
    configPath: resolved,
    initialAnswers: raw ? answersFromConfig(raw) : defaultAnswers(),
    currentRaw: raw,
    greetName: () => greetingName(deps.detectDeps),
    preflight: () => preflightChecks(deps.detectDeps),
    discoverModels: (baseUrl, apiKey) => (deps.fetchModelsFn ?? fetchModels)(baseUrl, apiKey),
    listModelsJson: (p) => (deps.parseModelsJsonFn ?? parseModelsJson)(expandHome(p)),
    listCatalogProviders: () => (deps.listCatalogProvidersFn ?? listCatalogProviders)(),
    write: (a: WizardAnswers) => {
      let written = false;
      let changes: AnswerDiff[] = [];
      // Atomic temp+rename, PID-suffixed (ConfigView/configCmd pattern) — a
      // crash mid-write must never leave a truncated config.json where a
      // full one used to not exist. If the rename itself throws (e.g. EPERM
      // on the destination) after the temp write already succeeded, don't
      // leave the temp file behind — best-effort unlink, then rethrow so the
      // caller still sees the original failure.
      const renameOrCleanup = (tmp: string, dest: string): void => {
        try {
          renameFn(tmp, dest);
        } catch (e) {
          try {
            unlinkFn(tmp);
          } catch {
            /* best effort */
          }
          throw e;
        }
      };
      if (mode === "fresh") {
        // Validate before touching disk — mirrors rerun mode's ordering
        // below, so a schema-invalid answer set never leaves a half-written
        // file (or none at all) for the caller to trip over.
        validateConfigObject(buildConfigObject(a));
        mkdirFn(dirname(resolved));
        const tmp = join(dirname(resolved), `.config.json.tmp-${process.pid}`);
        writeFileFn(tmp, renderConfigJson(a));
        renameOrCleanup(tmp, resolved);
        written = true;
      } else {
        changes = diffAnswers(raw as Record<string, unknown>, a);
        if (changes.length > 0) {
          const next = applyAnswers(raw as Record<string, unknown>, a);
          validateConfigObject(next);
          const tmp = join(dirname(resolved), `.config.json.tmp-${process.pid}`);
          writeFileFn(tmp, JSON.stringify(next, null, 2) + "\n");
          renameOrCleanup(tmp, resolved);
          written = true;
        }
      }
      const queueRoot = ensureDirs(loadConfigFn(resolved));
      // Skill links ride config-init: consent was just written (or confirmed)
      // by the Skills chapter, so materialize it now rather than at first
      // daemon start. Failures are non-fatal by ensureSkillLinks contract —
      // this call must never throw — but are no longer silently discarded
      // (#294): log them so a failure here is visible somewhere.
      const linkReport = (deps.ensureSkillLinksFn ?? ensureSkillLinks)(loadConfigFn(resolved));
      for (const e of linkReport.entries.filter((e) => isSkillLinkFailure(e.kind))) {
        log.warn("skill link failed", { detail: renderSkillLinkEntry(e) });
      }
      return { written, configPath: resolved, queueRoot, changes };
    },
    flightCheck: () => flightChecks(loadConfigFn(resolved), deps.detectDeps),
    effectiveDataDir,
    dataDirLegacyFallback,
    botGhConfigDir,
    detectedHarnesses: detectInstalledHarnesses(existsFn),
    detectBotLogin: () => (deps.detectBotLoginFn ?? detectBotLogin)(wizGhBin, botGhConfigDir),
    runGhLogin: () => (deps.runGhLoginFn ?? runGhLogin)(wizGhBin, botGhConfigDir),
  };

  return { ok: true, io, mode };
}

export function summary(configPath: string, queueRoot: string, wrote: boolean): string {
  const head = wrote ? `✓ Wrote config:  ${configPath}\n` : `✓ Config untouched: ${configPath}\n`;
  return (
    `\n${head}` +
    `✓ Queue ready:   ${queueRoot}/{inbox,processing,done,failed}\n\n` +
    `Next steps:\n` +
    NEXT_STEPS.map((s) => `  • ${s.cmd} — ${s.blurb}\n`).join("")
  );
}
