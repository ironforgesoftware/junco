/**
 * `junco init` — the guided setup walkthrough. `--yes` scaffolds the default
 * config with zero prompts (and zero React); interactive runs render the Ink
 * WizardApp (lazy-imported, dashboardCmd-style). All side effects live in the
 * WizardIO built here; the interactive step itself is behind `collectFn`, so
 * every contract below is testable without a TTY.
 *
 * Exit codes: 0 written/unchanged · 130 cancelled · 1 no raw-mode terminal.
 */

import { writeFileSync, readFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
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
import { NEXT_STEPS } from "./wizard/tips.js";

export interface WizardDeps {
  /** Skip prompts and scaffold from defaults (--yes). */
  yes?: boolean;
  /** Interactive collection seam — the Ink app in production, a fake in tests. */
  collectFn?: (io: WizardIO) => Promise<WizardOutcome>;
  detectDeps?: DetectDeps;
  fetchModelsFn?: typeof fetchModels;
  parseModelsJsonFn?: typeof parseModelsJson;
  writeFileFn?: (path: string, content: string) => void;
  renameFn?: (from: string, to: string) => void;
  readFileFn?: (path: string) => string;
  existsFn?: (path: string) => boolean;
  loadConfigFn?: (path: string) => Config;
  mkdirFn?: (path: string) => void;
  printFn?: (s: string) => void;
  /** Raw-mode probe (tests force true). */
  isInteractiveFn?: () => boolean;
}

function summary(configPath: string, queueRoot: string, wrote: boolean): string {
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
 * config), so Ink must never intercept and exit ahead of onOutcome. */
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
      },
    }),
    { exitOnCtrlC: false, alternateScreen: true },
  );
  await instance.waitUntilExit();
  return outcome;
}

export async function runInitWizard(configPath: string, deps: WizardDeps = {}): Promise<number> {
  const resolved = resolve(configPath);
  const existsFn = deps.existsFn ?? existsSync;
  const printFn = deps.printFn ?? ((s) => process.stdout.write(s));
  const mkdirFn = deps.mkdirFn ?? ((p) => mkdirSync(p, { recursive: true }));
  const writeFileFn = deps.writeFileFn ?? ((p, c) => writeFileSync(p, c, "utf8"));
  const readFileFn = deps.readFileFn ?? ((p) => readFileSync(p, "utf8"));
  const renameFn = deps.renameFn ?? renameSync;
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

  const mode: "fresh" | "rerun" = existsFn(resolved) ? "rerun" : "fresh";
  const invalidConfig = (reason: string): number => {
    printFn(
      `junco init: ${resolved} is not a valid config (${reason}).\n` +
        `  Fix or remove it, then re-run junco init. (junco config path shows the resolved location.)\n`,
    );
    return 1;
  };
  let raw: Record<string, unknown> | null = null;
  if (mode === "rerun") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileFn(resolved));
    } catch (e) {
      return invalidConfig(e instanceof Error ? e.message : String(e));
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      const kind = parsed === null ? "null" : Array.isArray(parsed) ? "an array" : typeof parsed;
      return invalidConfig(`expected a JSON object, got ${kind}`);
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
    write: (a: WizardAnswers) => {
      let written = false;
      let changes: AnswerDiff[] = [];
      if (mode === "fresh") {
        // Validate before touching disk — mirrors rerun mode's ordering
        // below, so a schema-invalid answer set never leaves a half-written
        // file (or none at all) for the caller to trip over.
        validateConfigObject(buildConfigObject(a));
        mkdirFn(dirname(resolved));
        // Atomic temp+rename, PID-suffixed (same ConfigView/configCmd pattern
        // as the rerun branch below) — a crash mid-write must never leave a
        // truncated config.json where a full one used to not exist.
        const tmp = join(dirname(resolved), `.config.json.tmp-${process.pid}`);
        writeFileFn(tmp, renderConfigJson(a));
        renameFn(tmp, resolved);
        written = true;
      } else {
        changes = diffAnswers(raw as Record<string, unknown>, a);
        if (changes.length > 0) {
          const next = applyAnswers(raw as Record<string, unknown>, a);
          validateConfigObject(next);
          // Atomic temp+rename, PID-suffixed (ConfigView/configCmd pattern).
          const tmp = join(dirname(resolved), `.config.json.tmp-${process.pid}`);
          writeFileFn(tmp, JSON.stringify(next, null, 2) + "\n");
          renameFn(tmp, resolved);
          written = true;
        }
      }
      const queueRoot = ensureDirs(loadConfigFn(resolved));
      return { written, configPath: resolved, queueRoot, changes };
    },
    flightCheck: () => flightChecks(loadConfigFn(resolved), deps.detectDeps),
  };

  const outcome = await (deps.collectFn ?? inkCollect)(io);
  if (outcome === "cancelled") {
    printFn("Setup cancelled — nothing written.\n");
    return 130;
  }
  // The alt-screen UI vanished on exit — leave a durable transcript.
  const queueRoot = dirname(queuePaths(loadConfigFn(resolved)).inbox);
  printFn(summary(resolved, queueRoot, outcome === "written"));
  return 0;
}
