/**
 * Bot-account auth resolution (spec 2026-07-15-gh-bot-account-design.md).
 * The bot's credential is a normal `gh auth login` living in an ISOLATED
 * GH_CONFIG_DIR (default ~/.junco/gh, resolved by config.ts's
 * resolveBotGhConfigDir — the single source of truth every entrypoint calls,
 * so none of them can drift and plant a second hosts.yml) — gh owns token
 * refresh; junco only ever handles the dir path, never the token.
 * Entrypoints call withBotAuth() to attach the resolved GhAuthContext to
 * Config; git.ts injects it into child env (see ghAuthEnv).
 */

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { defaultExec } from "./execProbe.js";
import type { Config, GhAuthContext } from "./types.js";

export interface GhAuthDeps {
  execFn?: (
    cmd: string,
    args: string[],
    opts?: { env?: Record<string, string> },
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
  spawnFn?: typeof spawn;
  mkdirFn?: (p: string) => void;
}

/** Resolve the bot identity under botAccount.configDir. `null` when disabled;
 * throws (actionable) when enabled but the login is missing or expired —
 * silent fallback to the operator's personal identity would be an attribution
 * and self-approval hazard, so callers fail loud. */
export async function resolveBotAuth(
  cfg: Pick<Config, "botAccount" | "ghBin">,
  deps: GhAuthDeps = {},
): Promise<GhAuthContext | null> {
  if (!cfg.botAccount.enabled) return null;
  const execFn = deps.execFn ?? defaultExec;
  const r = await execFn(cfg.ghBin, ["api", "user"], {
    // Clear GH_TOKEN/GITHUB_TOKEN (see git.ts ghAuthEnv): gh gives them
    // precedence over GH_CONFIG_DIR creds, so an ambient token would make this
    // very verification resolve to the wrong identity and defeat refuse-to-start.
    env: { GH_CONFIG_DIR: cfg.botAccount.configDir, GH_TOKEN: "", GITHUB_TOKEN: "" },
  });
  // #187.2: a missing/unreadable gh binary maps to 127 in the exec seam — a
  // distinct failure from a genuinely absent login (below), so name it
  // precisely rather than sending the operator to `junco auth login`.
  if (r.code === 127) {
    throw new Error(
      `botAccount.enabled is true but the gh binary was not found (ghBin="${cfg.ghBin}") — ` +
        `install gh or fix git.ghBin`,
    );
  }
  if (r.code !== 0) {
    throw new Error(
      `botAccount.enabled is true but no working gh login exists under ` +
        `${cfg.botAccount.configDir} — run: junco auth login (or set botAccount.enabled=false)`,
    );
  }
  let login: string;
  let id: number;
  try {
    // #187.1: validate the shape inside the try so shapeless-but-valid JSON
    // ({} → login:undefined, id:undefined) is caught by the same "could not
    // parse" error instead of producing "undefined+undefined@…" downstream.
    const u = JSON.parse(r.stdout) as { login?: unknown; id?: unknown };
    if (typeof u.login !== "string" || typeof u.id !== "number") {
      throw new Error("unexpected 'gh api user' shape");
    }
    login = u.login;
    id = u.id;
  } catch {
    throw new Error(`bot account: could not parse 'gh api user' output (${r.stdout.slice(0, 80)})`);
  }
  return {
    configDir: cfg.botAccount.configDir,
    login,
    email: `${id}+${login}@users.noreply.github.com`,
    // The helper subprocess is spawned by git and inherits the child's
    // GH_CONFIG_DIR (ghAuthEnv), so the bare gh binary reference suffices.
    // #187.4: quote ghBin — git runs `!`-helpers through the shell, which
    // word-splits, so an unquoted path with spaces would break mid-path.
    credentialHelper: `!"${cfg.ghBin}" auth git-credential`,
  };
}

/** Attach the resolved context to cfg (spread copy). Disabled → cfg unchanged. */
export async function withBotAuth<C extends Pick<Config, "botAccount" | "ghBin">>(
  cfg: C,
  deps: GhAuthDeps = {},
): Promise<C & { ghAuth?: GhAuthContext }> {
  const ctx = await resolveBotAuth(cfg, deps);
  if (ctx === null) return cfg;
  return { ...cfg, ghAuth: ctx };
}

/** assess.fileAs resolution for the interactive filing path: "me" keeps the
 * ambient identity untouched; "bot" attaches the bot context and fails LOUD
 * when the bot is disabled or its login is broken — a filing that was asked to
 * post as the bot must never silently fall back to the personal login. */
export async function withFileAsAuth<
  C extends Pick<Config, "botAccount" | "ghBin"> & { assess: { fileAs: "me" | "bot" } },
>(cfg: C, deps: GhAuthDeps = {}): Promise<C & { ghAuth?: GhAuthContext }> {
  if (cfg.assess.fileAs !== "bot") return cfg;
  if (!cfg.botAccount.enabled) {
    throw new Error(
      'assess.fileAs is "bot" but botAccount.enabled is false — ' +
        'run: junco auth login (or set assess.fileAs back to "me")',
    );
  }
  const ctx = await resolveBotAuth(cfg, deps); // throws the actionable auth-login message
  return { ...cfg, ghAuth: ctx ?? undefined };
}

/** Wizard/doctor probe: bot login under configDir, or null. Never throws. */
export async function detectBotLogin(
  ghBin: string,
  configDir: string,
  deps: GhAuthDeps = {},
): Promise<string | null> {
  const execFn = deps.execFn ?? defaultExec;
  try {
    const r = await execFn(ghBin, ["api", "user"], {
      // Clear GH_TOKEN/GITHUB_TOKEN so an ambient token can't spoof the probe.
      env: { GH_CONFIG_DIR: configDir, GH_TOKEN: "", GITHUB_TOKEN: "" },
    });
    if (r.code !== 0) return null;
    return (JSON.parse(r.stdout) as { login: string }).login ?? null;
  } catch {
    return null;
  }
}

/** The ONE interactive login routine (shared by `junco auth login` and the
 * wizard Account chapter): gh's own device-flow UX with inherited stdio,
 * pointed at the isolated config dir. Resolves with gh's exit code. */
export function runGhLogin(
  ghBin: string,
  configDir: string,
  deps: GhAuthDeps = {},
): Promise<number> {
  const spawnFn = deps.spawnFn ?? spawn;
  const mkdirFn = deps.mkdirFn ?? ((p: string) => mkdirSync(p, { recursive: true, mode: 0o700 }));
  return new Promise((resolve) => {
    // mkdir inside the executor so a failure (EACCES, ENOTDIR) resolves with a
    // non-zero code instead of throwing synchronously — the "resolves with exit
    // code, never rejects" contract must hold for every failure mode.
    try {
      mkdirFn(configDir);
    } catch {
      resolve(1);
      return;
    }
    const child = spawnFn(
      ghBin,
      ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web"],
      { stdio: "inherit", env: { ...process.env, GH_CONFIG_DIR: configDir } },
    );
    child.on("error", () => resolve(127));
    child.on("close", (code) => resolve(code ?? 1));
  });
}
