/**
 * Bot-account identity probe for the dashboard: which login opens junco's
 * issues/PRs when `botAccount.enabled`? Mirrors the doctor's probe (gh api
 * user under the isolated GH_CONFIG_DIR, ambient tokens cleared — GH_TOKEN
 * outranks config dirs, the #186 gotcha). Null = disabled or unresolvable;
 * callers treat null as "feature inert".
 */
import { execFile } from "node:child_process";
import type { Config } from "./types.js";

export interface BotIdentityDeps {
  execFn?: (
    cmd: string,
    args: string[],
    env: NodeJS.ProcessEnv,
  ) => Promise<{ code: number; stdout: string }>;
}

function defaultExec(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string }> {
  return new Promise((res) => {
    execFile(cmd, args, { env, timeout: 10_000 }, (err, stdout) => {
      res({ code: err ? 1 : 0, stdout: String(stdout) });
    });
  });
}

export async function resolveBotLogin(
  cfg: Pick<Config, "botAccount">,
  deps: BotIdentityDeps = {},
): Promise<string | null> {
  if (!cfg.botAccount.enabled) return null;
  const execFn = deps.execFn ?? defaultExec;
  const r = await execFn("gh", ["api", "user", "--jq", ".login"], {
    ...process.env,
    GH_CONFIG_DIR: cfg.botAccount.configDir,
    GH_TOKEN: "",
    GITHUB_TOKEN: "",
  });
  if (r.code !== 0) return null;
  const login = r.stdout.trim();
  return login === "" ? null : login;
}
