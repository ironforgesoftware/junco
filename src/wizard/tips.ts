/**
 * The wizard's copy registry — every greeting, tip, and trust-copy string in
 * one file so the stack-agnostic packaging gate is a single grep and copy
 * review is a single diff. Voice: "warm guide" — a junco glyph and friendly
 * plain language; never a chatty mascot, never a specific product name.
 */

export const BIRD = "🐦";

export const GREETINGS: readonly string[] = [
  "let's get your worker set up. Enter accepts the safe default at every step.",
  "a few short chapters and your ticket queue is airborne.",
  "five minutes of questions, a lifetime of merged PRs.",
  "let's build the nest. Every answer is editable later.",
];

/** Deterministic pick so tests are stable; callers pass e.g. Date.now(). */
export function pickGreeting(seed: number): string {
  return GREETINGS[Math.abs(seed) % GREETINGS.length];
}

export type TipKey =
  | "welcome"
  | "workspace"
  | "model"
  | "repoSafety"
  | "githubOff"
  | "githubOn"
  | "githubApproval"
  | "account"
  | "extras"
  | "skills"
  | "review"
  | "signoff";

export const TIPS: Record<TipKey, string> = {
  welcome: "Every answer lands in one editable file — config.json. Nothing here is permanent.",
  workspace:
    "This is junco's nest — tickets fly into inbox/, get worked in processing/, and land in done/ or failed/. Parked review items and per-ticket transcripts live right alongside the queue, all under one root.",
  model:
    "junco drives a coding agent through an inference endpoint — any OpenAI-compatible /v1 server, or a hosted provider from the built-in catalog.",
  repoSafety:
    "junco only works in throwaway worktrees and opens pull requests — it never commits to your branches. Folders you list here are the only places a ticket can point it. Leave the list empty to allow any repo path.",
  githubOff:
    "Off means zero gh calls — junco stays fully local. Flip it later with `junco config set github.enabled true`.",
  githubOn:
    "Adding no repos now is fine — `junco doctor` will remind you, and the dashboard's `a` key adds them later.",
  githubApproval:
    "With approval required, a plan-ready ticket waits for you; without it, plans auto-execute on the next sweep.",
  account:
    "A dedicated bot account keeps junco's PRs, comments, and labels attributed to the bot — and since the bot can never approve its own work, your approval labels stay meaningful. Your personal gh login stays untouched for everything you run by hand.",
  extras:
    "The recommended set is pre-checked. Space toggles, Enter continues — each row explains itself below.",
  skills:
    "Skills teach coding agents to write well-formed junco tickets — links live under <dataDir>/skills.",
  review: "more levers keep their safe defaults — `junco config list` shows every one.",
  signoff: "The nest is ready.",
};

export const NEXT_STEPS: readonly { cmd: string; blurb: string }[] = [
  { cmd: "junco start", blurb: "launch the worker daemon" },
  { cmd: "junco submit <ticket>.md", blurb: "drop your first ticket in the inbox" },
  { cmd: "junco dashboard", blurb: "watch the queue live (press , for settings)" },
  { cmd: "junco config list", blurb: "every lever, its default, and what it does" },
  { cmd: "junco doctor", blurb: "re-run the full preflight anytime" },
];
