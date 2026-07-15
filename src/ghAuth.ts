/**
 * Bot-account auth resolution (spec 2026-07-15-gh-bot-account-design.md).
 * The bot's credential is a normal `gh auth login` living in an ISOLATED
 * GH_CONFIG_DIR (default ~/.config/junco/gh) — gh owns token refresh; junco
 * only ever handles the dir path, never the token. Entrypoints call
 * withBotAuth() to attach the resolved GhAuthContext to Config; git.ts injects
 * it into child env (see ghAuthEnv).
 */

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { execFile } from "node:child_process";
import type { Config, GhAuthContext } from "./types.js";

export const DEFAULT_GH_CONFIG_DIR = "~/.config/junco/gh";

/** Same shape as execProbe's defaultExec, plus env (bot probes need it). */
function defaultExecWithEnv(
  cmd: string,
  args: string[],
  opts?: { env?: Record<string, string> },
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout: 10_000, env: opts?.env ? { ...process.env, ...opts.env } : undefined },
      (err, stdout, stderr) => {
        const code = err ? ((err as NodeJS.ErrnoException).code === "ENOENT" ? 127 : 1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

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
  const execFn = deps.execFn ?? defaultExecWithEnv;
  const r = await execFn(cfg.ghBin, ["api", "user"], {
    env: { GH_CONFIG_DIR: cfg.botAccount.configDir },
  });
  if (r.code !== 0) {
    throw new Error(
      `botAccount.enabled is true but no working gh login exists under ` +
        `${cfg.botAccount.configDir} — run: junco auth login (or set botAccount.enabled=false)`,
    );
  }
  let login: string;
  let id: number;
  try {
    const u = JSON.parse(r.stdout) as { login: string; id: number };
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
    credentialHelper: `!${cfg.ghBin} auth git-credential`,
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

/** Wizard/doctor probe: bot login under configDir, or null. Never throws. */
export async function detectBotLogin(
  ghBin: string,
  configDir: string,
  deps: GhAuthDeps = {},
): Promise<string | null> {
  const execFn = deps.execFn ?? defaultExecWithEnv;
  try {
    const r = await execFn(ghBin, ["api", "user"], { env: { GH_CONFIG_DIR: configDir } });
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
