/**
 * `junco auth login` — the headless/re-auth vehicle for the bot account
 * (spec 2026-07-15): run gh's interactive device-flow login into the isolated
 * GH_CONFIG_DIR, verify the identity, flip botAccount.enabled in config.json
 * (validated atomic write via updateConfigFile, configWrite.ts). The wizard's
 * Account chapter shares the same runGhLogin/detectBotLogin routines
 * (src/ghAuth.ts).
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig, resolveBotGhConfigDir } from "./config.js";
import { getAtPath, setAtPath } from "./configLevers.js";
import { readConfigFile, updateConfigFile, isConfigValidationError } from "./configWrite.js";
import { detectBotLogin, runGhLogin } from "./ghAuth.js";
import { grantBotAccess } from "./botAccess.js";
import type { Config } from "./types.js";

export interface AuthCmdDeps {
  runGhLoginFn?: typeof runGhLogin;
  detectBotLoginFn?: typeof detectBotLogin;
  grantFn?: typeof grantBotAccess;
  loadConfigFn?: (p: string) => Config;
  printFn?: (s: string) => void;
  printErrFn?: (s: string) => void;
  existsFn?: (p: string) => boolean;
  readFileFn?: (p: string) => string;
  writeFileFn?: (p: string, c: string) => void;
  renameFn?: (from: string, to: string) => void;
  unlinkFn?: (p: string) => void;
  /** Injected for the botGhConfigDir legacy-liveness probe (resolveBotGhConfigDir);
   * defaults to process.env. */
  env?: Record<string, string | undefined>;
}

const USAGE =
  "Usage: junco auth login | junco auth grant <owner/repo>   (see docs/bot-account.md)\n";

export async function runAuthCommand(
  args: string[],
  configPath: string,
  deps: AuthCmdDeps = {},
): Promise<number> {
  const print = deps.printFn ?? ((s: string) => process.stdout.write(s));
  const printErr = deps.printErrFn ?? ((s: string) => process.stderr.write(s));
  if (args[0] !== "login" && args[0] !== "grant") {
    printErr(USAGE);
    return 2;
  }
  const resolved = resolve(configPath);
  const existsFn = deps.existsFn ?? existsSync;

  if (args[0] === "grant") {
    const nwo = args[1];
    if (!nwo || !/^[\w.-]+\/[\w.-]+$/.test(nwo)) {
      printErr(USAGE);
      return 2;
    }
    if (!existsFn(resolved)) {
      printErr(
        `no config at ${resolved} — run \`junco dashboard\` or \`junco config init\` first\n`,
      );
      return 1;
    }
    // grant needs the assembled Config (botAccount defaults, ghBin, expandHome).
    let cfg: Config;
    try {
      cfg = (deps.loadConfigFn ?? loadConfig)(resolved);
    } catch (e) {
      printErr(`config unreadable: ${e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    }
    try {
      const { login } = await (deps.grantFn ?? grantBotAccess)(cfg, nwo);
      print(`✓ ${login} has write on ${nwo}\n`);
      return 0;
    } catch (e) {
      printErr(`${e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    }
  }

  if (!existsFn(resolved)) {
    printErr(
      `no config at ${resolved} — run \`junco dashboard\` (guided setup) or \`junco config init\` first\n`,
    );
    return 1;
  }
  let raw: Record<string, unknown>;
  try {
    raw = readConfigFile(resolved, deps);
  } catch (e) {
    printErr(`config unreadable: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
  // Same resolution assembleConfig uses (never re-derive the default here) —
  // an upgrader with a live legacy login must see `junco auth login` target
  // the SAME dir the daemon reads, or this plants a second hosts.yml.
  const { dir: configDir } = resolveBotGhConfigDir(
    getAtPath(raw, "botAccount.configDir") as string | undefined,
    deps.env,
    existsFn,
  );
  const ghBin = (getAtPath(raw, "git.ghBin") as string | undefined) ?? "gh";

  print(`Logging the bot account in (isolated gh config dir: ${configDir})…\n`);
  const code = await (deps.runGhLoginFn ?? runGhLogin)(ghBin, configDir);
  if (code !== 0) {
    printErr(`gh auth login exited ${code} — config untouched\n`);
    return 1;
  }
  const login = await (deps.detectBotLoginFn ?? detectBotLogin)(ghBin, configDir);
  if (login === null) {
    printErr("login finished but the identity could not be resolved — config untouched\n");
    return 1;
  }

  // #188: validation runs BEFORE the write (inside updateConfigFile) and is
  // caught here so a config that was ALREADY schema-invalid in some unrelated
  // field surfaces a one-line message and a clean exit 1 — parity with
  // configCmd's `set` — instead of letting the raw ZodError propagate to
  // cli.ts's top-level catch and print a stack trace. The file is re-read at
  // write time: the login above can take minutes, and an edit made meanwhile
  // must not be clobbered by the snapshot taken before it.
  try {
    updateConfigFile(resolved, (fresh) => setAtPath(fresh, "botAccount.enabled", true), deps);
  } catch (e) {
    const what = isConfigValidationError(e) ? "config invalid" : "config write failed";
    printErr(
      `${what} — not modified: ${(e instanceof Error ? e.message : String(e)).split("\n")[0]}\n`,
    );
    return 1;
  }

  print(`✓ junco now acts as ${login} for daemon GitHub traffic (botAccount.enabled=true)\n`);
  print(`  Restart the daemon to apply: junco restart\n`);
  return 0;
}
