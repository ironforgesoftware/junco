/**
 * The one read → mutate → validate → atomic-write path for config.json (#349).
 *
 * config.json is live daemon runtime state (configWatcher.ts reloads it on
 * change), so every writer has to (a) refuse to persist an object
 * `ConfigSchema` would reject — the daemon's next reload would otherwise fail
 * on a file a CLI verb just wrote — and (b) never truncate the file in place:
 * write a PID-suffixed temp file beside it, then rename over the target
 * (POSIX rename is atomic and always overwrites; the PID suffix keeps a
 * concurrent `junco config set` and the dashboard from sharing one temp
 * file). Before this module the seven writers — `junco config set`, the
 * wizard's fresh and rerun writes, `junco auth login`, `junco data migrate`,
 * `junco skill install`, the dashboard's ConfigView — each composed that
 * sequence by hand, and one of them skipped the validation.
 *
 * 0600 (#343): config.json may hold a literal model.apiKey. The default
 * `writeFileFn` creates the temp file owner-only and the mode rides through
 * the rename, so any rewrite tightens a loose file too.
 */
import { readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { ZodError } from "zod";
import { validateConfigObject } from "./config.js";

export interface ConfigWriteDeps {
  readFileFn?: (p: string) => string;
  writeFileFn?: (p: string, s: string) => void;
  renameFn?: (from: string, to: string) => void;
  /** Best-effort cleanup of the temp file when the write or the rename throws. */
  unlinkFn?: (p: string) => void;
}

/** Parse config.json as written — sparse, no schema defaults applied (that is
 * `loadConfig`'s job). Throws on a missing/unparseable file, and on a JSON
 * document that is not an object (a mutation could not be applied to it). */
export function readConfigFile(
  configPath: string,
  deps: ConfigWriteDeps = {},
): Record<string, unknown> {
  const readFile = deps.readFileFn ?? ((p: string) => readFileSync(p, "utf8"));
  const parsed: unknown = JSON.parse(readFile(configPath));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    const kind = parsed === null ? "null" : Array.isArray(parsed) ? "an array" : typeof parsed;
    throw new Error(`${configPath}: expected a JSON object, got ${kind}`);
  }
  return parsed as Record<string, unknown>;
}

/** Validate `raw` against `ConfigSchema` (throws the ZodError, file untouched),
 * then atomic temp+rename. A write or rename failure unlinks the temp file
 * best-effort and rethrows the original error. */
export function writeConfigFile(
  configPath: string,
  raw: Record<string, unknown>,
  deps: ConfigWriteDeps = {},
): void {
  validateConfigObject(raw);
  const writeFile =
    deps.writeFileFn ??
    ((p: string, s: string) => writeFileSync(p, s, { encoding: "utf8", mode: 0o600 }));
  const renameFn = deps.renameFn ?? renameSync;
  const unlinkFn = deps.unlinkFn ?? unlinkSync;
  const tmp = join(dirname(configPath), `.config.json.tmp-${process.pid}`);
  try {
    writeFile(tmp, JSON.stringify(raw, null, 2) + "\n");
    renameFn(tmp, configPath);
  } catch (e) {
    try {
      unlinkFn(tmp);
    } catch {
      /* best effort */
    }
    throw e;
  }
}

/** Read → `mutate` in place → validate → atomic write. Returns the object
 * written. The read happens here, at write time, so a caller's earlier
 * snapshot can never clobber an edit made in between. A missing file is a
 * read error, not a fresh `{}` — the one caller that scaffolds (`junco config
 * set` on a fresh install) says so through its `readFileFn`. */
export function updateConfigFile(
  configPath: string,
  mutate: (raw: Record<string, unknown>) => void,
  deps: ConfigWriteDeps = {},
): Record<string, unknown> {
  const raw = readConfigFile(configPath, deps);
  mutate(raw);
  writeConfigFile(configPath, raw, deps);
  return raw;
}

/** True for the error `writeConfigFile`/`updateConfigFile` throw when the
 * object fails `ConfigSchema` (nothing was written), as opposed to an fs error
 * from the write itself — callers that word the two differently ("config
 * invalid" vs "config write failed") branch on this, without importing zod. */
export function isConfigValidationError(e: unknown): boolean {
  return e instanceof ZodError;
}
