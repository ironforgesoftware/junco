/**
 * `junco config` — path/list/get/set over the lever registry (src/configLevers.ts).
 *
 * The CLI is generic: every subcommand operates off `LEVERS`/`leverAtPath`, so
 * adding a config knob only means adding a `ConfigSchema` leaf + a matching
 * `Lever` entry (enforced in bijection by tests/configLevers.test.ts) — no
 * per-field code lives here.
 */
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  LEVERS,
  getAtPath,
  setAtPath,
  leverAtPath,
  coerceLever,
  type Lever,
} from "./configLevers.js";
import { validateConfigObject } from "./config.js";

export interface ConfigCmdDeps {
  readFileFn?: (p: string) => string;
  writeFileFn?: (p: string, s: string) => void;
  existsFn?: (p: string) => boolean;
  printFn?: (s: string) => void;
  errFn?: (s: string) => void;
  /** True when the daemon is currently running — gates the "restart to apply"
   * hint on `set` for `reload: "restart"` levers. */
  daemonRunningFn?: () => boolean;
}

/** Secrets never print their raw value outside of an explicit `get` on that
 * exact path — `list` (and any other bulk view) masks them. */
function maskFor(lever: Lever, value: unknown): unknown {
  return lever.type === "secret" && typeof value === "string" && value.length > 0 ? "••••" : value;
}

/** Effective value at a lever's path: the raw file value if present, else the
 * lever's default (mirrors how `parseConfigFile`/zod would default it, without
 * requiring the whole file to be schema-valid just to inspect one path). */
function getEffective(
  readFile: (p: string) => string,
  exists: (p: string) => boolean,
  configPath: string,
  lever: Lever,
): unknown {
  if (!exists(configPath)) return lever.default;
  const raw = JSON.parse(readFile(configPath)) as Record<string, unknown>;
  const v = getAtPath(raw, lever.path);
  return v === undefined ? lever.default : v;
}

export function runConfigCommand(
  argv: string[],
  configPath: string,
  deps: ConfigCmdDeps = {},
): number {
  const print = deps.printFn ?? ((s: string) => process.stdout.write(s));
  const err = deps.errFn ?? ((s: string) => process.stderr.write(s));
  const readFile = deps.readFileFn ?? ((p: string) => readFileSync(p, "utf8"));
  const writeFile = deps.writeFileFn ?? ((p: string, s: string) => writeFileSync(p, s, "utf8"));
  const exists = deps.existsFn ?? existsSync;
  const [sub, ...rest] = argv;

  if (sub === "path") {
    print(configPath + "\n");
    return 0;
  }

  if (sub === "list") {
    for (const l of LEVERS) {
      const cur = getEffective(readFile, exists, configPath, l);
      const val = maskFor(l, cur);
      const meta = l.type === "enum" ? l.enumValues?.join("|") : l.type;
      print(
        `${l.path}\t= ${JSON.stringify(val)} (default ${JSON.stringify(l.default)}) [${meta}${
          l.editable ? "" : ", read-only"
        }]  ${l.description}\n`,
      );
    }
    return 0;
  }

  if (sub === "get") {
    const l = leverAtPath(rest[0]);
    if (!l) {
      err(`config: unknown path '${rest[0]}'\n`);
      return 1;
    }
    print(JSON.stringify(getEffective(readFile, exists, configPath, l)) + "\n");
    return 0;
  }

  if (sub === "set") {
    const [path, ...valueParts] = rest;
    const l = leverAtPath(path);
    if (!l) {
      err(`config: unknown path '${path}'\n`);
      return 1;
    }
    if (!l.editable) {
      err(`config: '${path}' is structured — edit config.json directly\n`);
      return 1;
    }
    const c = coerceLever(l, valueParts.join(" "));
    if ("error" in c) {
      err(`config: ${path}: ${c.error}\n`);
      return 1;
    }
    // Mutate raw (sparse), validate a defaulted copy via the schema, then atomic write.
    const raw = exists(configPath)
      ? (JSON.parse(readFile(configPath)) as Record<string, unknown>)
      : {};
    const old = getEffective(readFile, exists, configPath, l);
    setAtPath(raw, path, c.value);
    try {
      validateConfigObject(raw);
    } catch (e) {
      err(`config: ${e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    }
    const tmp = join(dirname(configPath), `.config.json.tmp-${process.pid}`);
    writeFile(tmp, JSON.stringify(raw, null, 2) + "\n");
    renameSync(tmp, configPath);
    print(`${path}: ${JSON.stringify(old)} → ${JSON.stringify(c.value)}\n`);
    if (l.reload === "restart" && deps.daemonRunningFn?.()) {
      print(`(restart the daemon to apply: junco restart)\n`);
    }
    return 0;
  }

  err(`config: unknown subcommand '${sub ?? ""}' (path|list|get|set)\n`);
  return 1;
}
