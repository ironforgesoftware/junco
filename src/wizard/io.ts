/** WizardIO/WizardOutcome/WriteResult contract — type-only; no runtime code.
 * The Ink layer imports these types, never a value, from this module. */

import type { WizardAnswers, AnswerDiff } from "./flow.js";
import type { CheckResult } from "./detect.js";

export type WizardOutcome = "written" | "unchanged" | "cancelled";

export interface WriteResult {
  written: boolean; // false on a zero-diff re-run (dirs still ensured)
  configPath: string;
  queueRoot: string; // dirname of the inbox
  changes: AnswerDiff[]; // empty in fresh mode
}

/** Everything the Ink app needs from the outside world. Built by
 * runInitWizard; faked wholesale in component tests. */
export interface WizardIO {
  mode: "fresh" | "rerun";
  configPath: string;
  initialAnswers: WizardAnswers;
  currentRaw: Record<string, unknown> | null; // rerun: the parsed existing file
  greetName(): Promise<string>;
  preflight(): Promise<CheckResult[]>;
  discoverModels(baseUrl: string, apiKey: string): Promise<string[]>;
  listModelsJson(path: string): string[];
  write(a: WizardAnswers): WriteResult;
  flightCheck(): Promise<CheckResult[]>;
}
