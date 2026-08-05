/** WizardIO/WizardOutcome/WriteResult contract — type-only; no runtime code.
 * The Ink layer imports these types, never a value, from this module. */

import type { WizardAnswers, AnswerDiff } from "./flow.js";
import type { CheckResult } from "./detect.js";
import type { CatalogEntry } from "../agent/session.js";

export type WizardOutcome = "written" | "unchanged" | "cancelled";

export interface WriteResult {
  written: boolean; // false on a zero-diff re-run (dirs still ensured)
  configPath: string;
  queueRoot: string; // dirname of the inbox
  changes: AnswerDiff[]; // empty in fresh mode
}

/** Everything the Ink app needs from the outside world. Built by
 * buildWizardIO (wizard.ts); faked wholesale in component tests. */
export interface WizardIO {
  mode: "fresh" | "rerun";
  configPath: string;
  initialAnswers: WizardAnswers;
  currentRaw: Record<string, unknown> | null; // rerun: the parsed existing file
  greetName(): Promise<string>;
  preflight(): Promise<CheckResult[]>;
  discoverModels(baseUrl: string, apiKey: string): Promise<string[]>;
  listModelsJson(path: string): string[];
  /** The SDK's complete built-in hosted-model catalog, grouped by provider —
   * backs the "hosted" source's provider/model pickers. Wired to
   * session.ts's `listCatalogProviders` by default (see wizard.ts); can
   * reject (network-free, but the SDK import itself can throw) — callers
   * must treat that as a friendly fallback, never a crash. */
  listCatalogProviders(): Promise<CatalogEntry[]>;
  write(a: WizardAnswers): WriteResult;
  flightCheck(): Promise<CheckResult[]>;
  /** The data root junco will ACTUALLY use while `WizardAnswers.dataDir`
   * stays at its schema-default sentinel ("~/.junco") — i.e. the config
   * carries no explicit `dataDir`/`observability.stateDir` key. Mirrors
   * assembleConfig's own single-root probe (config.ts's `resolveDataRoot`)
   * so the Workspace chapter can show the legacy ~/.local/state/junco root
   * during the migration window instead of the misleading bare "~/.junco"
   * placeholder. Purely informational, same pattern as `botGhConfigDir`
   * below — never fed back into `WizardAnswers`, so it cannot change what a
   * save writes. */
  effectiveDataDir: string;
  /** True when `effectiveDataDir` came from the legacy-root fallback branch
   * (pre-0.10 ~/.local/state/junco), not the canonical ~/.junco. */
  dataDirLegacyFallback: boolean;
  /** Isolated gh config dir the Account chapter logs the bot into. */
  botGhConfigDir: string;
  /** Bot login under botGhConfigDir, or null. Never throws. */
  detectBotLogin(): Promise<string | null>;
  /** Interactive gh device-flow login (caller suspends Ink around it). */
  runGhLogin(): Promise<number>;
}
