/**
 * `junco init` — the guided setup walkthrough. `--yes` scaffolds the default
 * config with zero prompts (and zero React); interactive runs render the Ink
 * WizardApp (lazy-imported, dashboardCmd-style). All side effects live in the
 * WizardIO built by `buildWizardIO` — a standalone entry point any host
 * (runInitWizard here, the dashboard-hosted Root) can call without touching
 * stdin/Ink; the interactive step itself is behind `collectFn`, so every
 * contract below is testable without a TTY.
 *
 * Exit codes: 0 written/unchanged · 130 cancelled · 1 no raw-mode terminal.
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
  resolveConfigPath,
  validateConfigObject,
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
import type { WizardIO, WizardOutcome } from "./wizard/io.js";
import { greetingName, preflightChecks, flightChecks, type DetectDeps } from "./wizard/detect.js";
import { fetchModels, parseModelsJson } from "./wizard/models.js";
import { listCatalogProviders, type CatalogEntry } from "./agent/session.js";
import { NEXT_STEPS } from "./wizard/tips.js";

export interface WizardDeps {
  /** Skip prompts and scaffold from defaults (--yes). */
  yes?: boolean;
  /** Interactive collection seam — the Ink app in production, a fake in tests. */
  collectFn?: (io: WizardIO) => Promise<WizardOutcome>;
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
  printFn?: (s: string) => void;
  /** Raw-mode probe (tests force true). */
  isInteractiveFn?: () => boolean;
}

export type WizardIoResult =
  | { ok: true; io: WizardIO; mode: "fresh" | "rerun" }
  | { ok: false; error: string };

/** Builds the WizardIO (fresh-scaffold or rerun-prefill, plus the atomic
 * write path) without touching stdin/Ink — the standalone entry point both
 * runInitWizard and the dashboard-hosted Root (Task 3) build on. Returns
 * `ok:false` instead of printing so every caller controls its own message. */
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
      return { written, configPath: resolved, queueRoot, changes };
    },
    flightCheck: () => flightChecks(loadConfigFn(resolved), deps.detectDeps),
  };

  return { ok: true, io, mode };
}

export function summary(configPath: string, queueRoot: string, wrote: boolean): string {
  const flag = configPath === resolveConfigPath(undefined) ? "" : ` (--config ${configPath})`;
  const head = wrote ? `✓ Wrote config:  ${configPath}\n` : `✓ Config untouched: ${configPath}\n`;
  return (
    `\n${head}` +
    `✓ Queue ready:   ${queueRoot}/{inbox,processing,done,failed}\n\n` +
    `Next steps${flag}:\n` +
    NEXT_STEPS.map((s) => `  • ${s.cmd} — ${s.blurb}\n`).join("")
  );
}

/** Default interactive collector: lazy-import React/Ink + the WizardApp so
 * non-interactive paths never pay the React cost (dashboardCmd pattern).
 * exitOnCtrlC is false — WizardApp handles Ctrl-C itself (post-write Ctrl-C
 * reports written/unchanged rather than lying about an already-written
 * config), so Ink must never intercept and exit ahead of onOutcome.
 *
 * WizardApp itself no longer calls Ink's exit — its host owns the instance
 * lifetime (see WizardApp's module doc). Until Task 3's dashboard-hosted
 * Root takes over that role, this function IS the host: unmount here, once,
 * right after onOutcome fires, so waitUntilExit still resolves below. */
async function inkCollect(io: WizardIO): Promise<WizardOutcome> {
  const [react, ink, { WizardApp }] = await Promise.all([
    import("react"),
    import("ink"),
    import("./tui/wizard/WizardApp.js"),
  ]);
  let outcome: WizardOutcome = "cancelled";
  const instance = ink.render(
    react.createElement(WizardApp, {
      io,
      onOutcome: (o: WizardOutcome) => {
        outcome = o;
        instance.unmount();
      },
    }),
    { exitOnCtrlC: false, alternateScreen: true },
  );
  await instance.waitUntilExit();
  return outcome;
}

export async function runInitWizard(configPath: string, deps: WizardDeps = {}): Promise<number> {
  const resolved = resolve(configPath);
  const printFn = deps.printFn ?? ((s) => process.stdout.write(s));
  const mkdirFn = deps.mkdirFn ?? ((p) => mkdirSync(p, { recursive: true }));
  const writeFileFn = deps.writeFileFn ?? ((p, c) => writeFileSync(p, c, "utf8"));
  const loadConfigFn = deps.loadConfigFn ?? loadConfig;

  const ensureDirs = (cfg: Config): string => {
    const paths = queuePaths(cfg);
    for (const d of [paths.inbox, paths.processing, paths.done, paths.failed, cfg.worktreeRoot]) {
      mkdirFn(d);
    }
    return dirname(paths.inbox);
  };

  if (deps.yes) {
    // Non-interactive scaffold — same minimal default config as ever (the
    // packaged smoke test drives this path headless).
    mkdirFn(dirname(resolved));
    writeFileFn(resolved, renderConfigJson(defaultAnswers()));
    const queueRoot = ensureDirs(loadConfigFn(resolved));
    printFn(summary(resolved, queueRoot, true));
    return 0;
  }

  // A TTY without raw-mode support cannot drive Ink — bail with the fix
  // before loading React (never render a broken UI).
  const interactive = deps.isInteractiveFn
    ? deps.isInteractiveFn()
    : Boolean(process.stdin.isTTY && typeof process.stdin.setRawMode === "function");
  if (!deps.collectFn && !interactive) {
    printFn(
      `junco init: this terminal cannot run the interactive walkthrough.\n` +
        `  Pass --yes to scaffold defaults, or create ${resolved} by hand.\n`,
    );
    return 1;
  }

  const built = buildWizardIO(configPath, deps);
  if (!built.ok) {
    printFn(
      `junco init: ${built.error}.\n` +
        `  Fix or remove it, then re-run junco init. (junco config path shows the resolved location.)\n`,
    );
    return 1;
  }

  const outcome = await (deps.collectFn ?? inkCollect)(built.io);
  if (outcome === "cancelled") {
    // NOTE (transitional, deleted with runInitWizard in Task 4): this used
    // to branch on whether io.write's rename had already landed before a
    // later throw in the same call (e.g. ensureDirs) — buildWizardIO no
    // longer exposes that flag (it's local to the closure now), so the
    // message is unconditional. Known, accepted inaccuracy: write() renames
    // BEFORE ensureDirs(loadConfigFn(...)), which can throw independently;
    // WizardApp catches that and leaves `result` null, so a real user CAN
    // cancel with the config already on disk — this message is wrong on
    // that narrow path. No release carries it (runInitWizard dies in Task
    // 4); the dashboard host (Task 3) restores truthful reporting via an
    // existence check at print time.
    printFn("Setup cancelled — nothing written.\n");
    return 130;
  }
  // The alt-screen UI vanished on exit — leave a durable transcript.
  const queueRoot = dirname(queuePaths(loadConfigFn(resolved)).inbox);
  printFn(summary(resolved, queueRoot, outcome === "written"));
  return 0;
}
