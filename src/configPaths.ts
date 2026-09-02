import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, isAbsolute } from "node:path";
import type { Config, Paths } from "./types.js";

export function expandHome(p: string): string {
  if (p === "~" || p.startsWith("~/")) return join(homedir(), p.slice(1));
  return p;
}

/** env.HOME (tests/sandboxes) wins over os.homedir(). */
export function homeOf(env: Record<string, string | undefined> = process.env): string {
  return env.HOME && env.HOME.trim() !== "" ? env.HOME : homedir();
}

/** Junco's single home directory: ~/.junco. env.HOME wins over os.homedir()
 * so tests and sandboxes can relocate it. Config lives here today; the data
 * tree follows suit by default in the single-root consolidation (probe-based
 * fallback keeps a pre-existing legacy root working — see assembleConfig). */
export function juncoHome(env: Record<string, string | undefined> = process.env): string {
  return join(homeOf(env), ".junco");
}

/** Schema default for `botAccount.configDir` — the one spelling every other
 * reference (the zod default in configSchema.ts, `resolveBotGhConfigDir`'s own
 * default) derives from, so they can't drift apart. */
export const DEFAULT_BOT_GH_CONFIG_DIR = "~/.junco/gh";

/**
 * Resolve the bot account's isolated gh config dir from the raw (possibly
 * unset) `botAccount.configDir` config value. The SINGLE source of truth for
 * this resolution — `assembleConfig`, `junco auth login` (authCmd.ts), and
 * the setup wizard (wizard.ts) all call this instead of re-deriving the
 * default themselves, so the three entrypoints can never disagree about
 * where a live legacy login lives and plant a second `hosts.yml` at
 * `~/.junco/gh` while the daemon keeps reading `~/.config/junco/gh` (or vice
 * versa) — the split-brain this resolution exists to prevent.
 *
 * An explicit non-default `raw` passes through (tilde-expanded) verbatim —
 * NEVER probed. A defaulted/unset value resolves to `~/.junco/gh`, EXCEPT
 * when `~/.junco/gh/hosts.yml` is absent and the legacy
 * `~/.config/junco/gh/hosts.yml` exists — then the legacy dir is used and
 * `legacy: true` is returned (an upgrade must never orphan a working bot
 * login until `junco data migrate` moves it).
 */
export function resolveBotGhConfigDir(
  raw: string | undefined,
  env: Record<string, string | undefined> = process.env,
  existsFn: (p: string) => boolean = existsSync,
): { dir: string; legacy: boolean } {
  const ghDefault = join(juncoHome(env), "gh");
  const ghLegacy = join(homeOf(env), ".config", "junco", "gh");
  const ghConfigured = expandHome(raw ?? DEFAULT_BOT_GH_CONFIG_DIR);
  // NOTE: expandHome is homedir()-based while ghDefault is env-based
  // (homeOf(env)). Under an injected test env (env.HOME !== os.homedir())
  // these can disagree, making an explicitly-set "~/.junco/gh" indistinguishable
  // from the default here — acceptable, they resolve to the same place in
  // real use (see Task 3 brief).
  let dir = ghConfigured === expandHome(DEFAULT_BOT_GH_CONFIG_DIR) ? ghDefault : ghConfigured;
  let legacy = false;
  if (
    dir === ghDefault &&
    !existsFn(join(ghDefault, "hosts.yml")) &&
    existsFn(join(ghLegacy, "hosts.yml"))
  ) {
    dir = ghLegacy;
    legacy = true;
  }
  return { dir, legacy };
}

/** True when `root` holds a junco data tree (either layout). config.json/gh
 * alone do NOT count — the config plan puts those at ~/.junco before any
 * data lives there. */
export function dataRootHasTree(
  root: string,
  existsFn: (p: string) => boolean = existsSync,
): boolean {
  return ["queue", "data", "cache", "transcripts", "history"].some((m) => existsFn(join(root, m)));
}

/** Which internal shape an existing tree uses. Fresh (marker-less) roots get
 * the final shape. queue/review/watchlist sit at the root in BOTH layouts and
 * are deliberately not markers. */
export function layoutOf(
  root: string,
  existsFn: (p: string) => boolean = existsSync,
): "flat" | "v2" {
  if (existsFn(join(root, "data")) || existsFn(join(root, "cache"))) return "v2";
  const flatMarkers = [
    "transcripts",
    "history",
    "clones",
    "worktrees",
    "assess-history",
    "github-cache",
  ];
  if (flatMarkers.some((m) => existsFn(join(root, m)))) return "flat";
  return "v2";
}

/** The canonical config location: ~/.junco/config.json. */
export function defaultUserConfigPath(
  env: Record<string, string | undefined> = process.env,
): string {
  return join(juncoHome(env), "config.json");
}

/** Pre-0.10 config location (XDG_CONFIG_HOME or ~/.config). Read-only
 * fallback: an existing install keeps loading its config instead of being
 * routed to the setup walkthrough — which would write a competing config,
 * the exact failure mode this module was rewritten to prevent. */
export function legacyConfigPath(env: Record<string, string | undefined> = process.env): string {
  const base =
    env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.trim() !== ""
      ? env.XDG_CONFIG_HOME
      : join(env.HOME && env.HOME.trim() !== "" ? env.HOME : homedir(), ".config");
  return join(base, "junco", "config.json");
}

export interface ResolveConfigDeps {
  existsFn?: (p: string) => boolean;
  env?: Record<string, string | undefined>;
}

/**
 * The explicitly-named config path from `JUNCO_CONFIG` (#275) — tilde-expanded
 * and required to be absolute, then `resolve()`d to a normalized absolute
 * path — or `undefined` when the variable is unset, empty, or whitespace-only
 * (same "empty is unset" rule as `homeOf`/`legacyConfigPath`). A relative
 * value throws (see below) rather than being silently accepted.
 *
 * THE single spelling of "how the override resolves". `resolveConfigPath`
 * (which path do we load) and `sandboxDenyPaths` (which path must the agent
 * not read) both call this rather than re-deriving it — two independent
 * spellings would drift, and a drift here means the ACTIVE config, with its
 * possible `model.apiKey`, is silently readable inside the agent sandbox
 * (dataTree.ts's I-3 gap, reopened at a third location).
 *
 * A RELATIVE value (`JUNCO_CONFIG=junco.json`, easily exported from a shell
 * profile) is REJECTED, not resolved: `resolve()` cannot remove a relative
 * value's launch-directory dependence, it can only freeze it to whichever cwd
 * happens to be current when this function runs. A launchd daemon (cwd `/`)
 * and an operator shell would still land on two different absolute paths —
 * and two different `worker.lock`s — from the same `JUNCO_CONFIG=junco.json`,
 * so `status`/`doctor` could silently report "not running" against a live
 * daemon. cwd-dependence is exactly what this module was rewritten to
 * eliminate (split-queue incident, 2026-08-01), and `JUNCO_CONFIG` is new
 * enough on this branch that nothing depends on the old resolve-anyway
 * behaviour — so a relative value is a hard, actionable error instead.
 *
 * An ABSOLUTE value is still `resolve()`d, purely to normalize `..` segments
 * (`/w/sub/../cfg.json` → `/w/cfg.json`) into one canonical spelling — that's
 * what lets `resolveConfigPath`, `sandboxDenyPaths`, and the migrate guard's
 * equality check agree without each re-deriving it.
 */
export function configPathOverride(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const override = env.JUNCO_CONFIG;
  if (!(override && override.trim() !== "")) return undefined;
  const trimmed = override.trim();
  const expanded = expandHome(trimmed);
  if (!isAbsolute(expanded)) {
    throw new Error(
      `JUNCO_CONFIG must be an absolute path (a leading "~" is fine) — got ${JSON.stringify(trimmed)}`,
    );
  }
  return resolve(expanded);
}

/**
 * Where the config lives — a pure function of the environment, never of the
 * working directory or argv (split-queue incident, 2026-08-01): the canonical
 * ~/.junco/config.json, falling back to the legacy XDG path only while the
 * canonical file does not exist. The returned path may not exist — first-run
 * detection checks that separately.
 *
 * JUNCO_CONFIG (#275), when set to a non-empty value, wins outright — checked
 * before the canonical path, and normalized to an absolute path by
 * `configPathOverride`, which rejects a relative value outright rather than
 * resolving it (see there for why). `junco start` derives the daemon-singleton
 * worker.lock as `dirname(resolve(configPath))/worker.lock`, and every other
 * reader of it (ensureDaemon, cli, restartCmd, dataMigrateCmd, updateCmd,
 * doctor) gets it from the ONE helper that spells it — `workerLockPath`
 * (lock.ts, #310); they used to re-derive it by hand and had already drifted
 * (doctor's copy omitted the `resolve()`, so it went cwd-relative whenever
 * the config path was). So an override relocates the lock
 * right along with the config everywhere. Two named configs are therefore two
 * daemon instances — genuinely independent only when they also resolve to
 * DIFFERENT `dataDir`s and queue roots. Two configs over ONE data root are no
 * longer allowed to run as two daemons: `worker.lock` alone still cannot see
 * the collision (it sits beside each config), but `junco start` also claims
 * `<dataDir>/daemon-tree.lock` and `<queueRoot>/daemon-queue.lock`, and the
 * second daemon refuses to start rather than doubling up on one queue (#310 —
 * docs/configuration.md).
 */
export function resolveConfigPath(deps: ResolveConfigDeps = {}): string {
  const existsFn = deps.existsFn ?? existsSync;
  const env = deps.env ?? process.env;
  // An explicit JUNCO_CONFIG wins outright — above the canonical path, not
  // below it. Below, the variable would be useless on exactly the machines it
  // exists for (any machine with a real ~/.junco/config.json would ignore
  // it). A non-existent value still wins: the contract already allows the
  // returned path not to exist, and an explicit instruction should not be
  // silently overridden — this also lets a script name the config it is about
  // to create. Empty/whitespace is treated as unset, matching homeOf and
  // legacyConfigPath. configPathOverride rejects a relative value outright
  // (throws) rather than resolving it, so a launch-directory dependence can't
  // sneak back in here (#275, and the split-queue incident this module was
  // rewritten for).
  const override = configPathOverride(env);
  if (override !== undefined) return override;
  const canonical = defaultUserConfigPath(env);
  if (existsFn(canonical)) return canonical;
  const legacy = legacyConfigPath(env);
  if (existsFn(legacy)) return legacy;
  return canonical;
}

/** Result of the single-root ~/.junco probe (see `resolveDataRoot`). */
export interface DataRootResolution {
  dataDir: string;
  dataLayout: "flat" | "v2";
  legacyDataRoot: boolean;
}

/**
 * The single-root ~/.junco probe (spec 2026-07-16 / 2026-08-03): given an
 * already-normalized explicit override (or `undefined` when the config sets
 * neither `dataDir` nor `observability.stateDir`), resolve the EFFECTIVE data
 * root exactly as `assembleConfig` does. Extracted so callers that need to
 * PREVIEW the resolution without a full `ConfigParsed` — the setup wizard
 * must display the root the daemon will actually use even before it has
 * written a config — reuse this probe instead of re-deriving it (the trap
 * that would otherwise repeat resolveBotGhConfigDir's own split-brain
 * warning: two entry points quietly disagreeing about where something
 * lives).
 *
 * `explicitRoot === undefined`: a defaulted root prefers the canonical
 * `~/.junco`, but while `~/.junco` holds no data tree and the pre-0.10
 * `~/.local/state/junco` root exists, keep resolving to the legacy root
 * UNTOUCHED — `junco data migrate` is the only thing that relocates live
 * data. A root adopted via that fallback is BY DEFINITION a pre-0.10 tree
 * (the fallback only fires while `~/.junco` holds no tree AND the legacy
 * root exists — a v2 tree can't live at the legacy path before `junco data
 * migrate` ships in P2.T5), so its layout is forced "flat" rather than
 * trusting `layoutOf`'s marker probe: a legacy root that predates #194
 * (transcripts disabled, TUI never run, no worktrees/clones under dataDir)
 * or that exists but was never populated can hold none of `layoutOf`'s six
 * markers, and `layoutOf`'s marker-less default is "v2" — which would then
 * have startup's migrateStateTree (daemon.ts) relocate this root's
 * pre-unification dirs into data/-shaped destinations before any operator
 * ever ran `junco data migrate`, violating this branch's safety property
 * that nothing else relocates live data. Explicit-dataDir and canonical
 * (~/.junco) resolutions are unaffected — they still probe.
 */
export function resolveDataRoot(
  explicitRoot: string | undefined,
  env: Record<string, string | undefined> = process.env,
  existsFn: (p: string) => boolean = existsSync,
): DataRootResolution {
  let dataDir: string;
  let legacyDataRoot = false;
  if (explicitRoot !== undefined) {
    dataDir = expandHome(explicitRoot);
  } else {
    const canonical = juncoHome(env);
    const legacyRoot = join(homeOf(env), ".local", "state", "junco");
    if (!dataRootHasTree(canonical, existsFn) && existsFn(legacyRoot)) {
      dataDir = legacyRoot;
      legacyDataRoot = true;
    } else {
      dataDir = canonical;
    }
  }
  const dataLayout = legacyDataRoot ? "flat" : layoutOf(dataDir, existsFn);
  return { dataDir, dataLayout, legacyDataRoot };
}

export interface KnownQueueRoot {
  /** Absolute path to the queue root (the dir holding inbox/processing/...). */
  root: string;
  /** Operator-facing label, e.g. "canonical", "legacy data root", "vault". */
  label: string;
  /** True for the root the running config actually resolves to. */
  resolved: boolean;
}

/**
 * Every queue root this installation could plausibly own, deduped by
 * resolved path, with the one the running config actually resolves to
 * flagged `resolved: true`. Pure: no I/O, no cwd, no argv — the split-queue
 * incident (2026-08-01) that motivates this function came from a resolution
 * path that quietly depended on more than the environment, so this one
 * deliberately doesn't.
 *
 * Reuses `juncoHome`/`homeOf` — the exact helpers `resolveDataRoot` (this
 * file) uses to derive the canonical and legacy-data-root shapes — rather
 * than re-deriving those path shapes here. A second spelling of "where the
 * legacy root is" is exactly the drift this codebase keeps getting bitten by
 * (see `resolveBotGhConfigDir`'s doc comment above for the prior incident of
 * that same shape).
 *
 * Only two of the four conceptual roots the split-queue plan names —
 * canonical `~/.junco/queue` and legacy data root
 * `~/.local/state/junco/queue` — are independently derivable from `env`
 * alone. The other two (a legacy `vaultRoot`/`juncoSubdir` queue and an
 * explicit `dataDir`/`stateDir` override) are arbitrary, operator-chosen
 * strings that `assembleConfig` folds into `queueRoot` and does not retain
 * separately on `Config` — and this function is intentionally given only
 * `cfg.queueRoot`, not the raw schema, so it can't re-derive them from a
 * second copy of that logic either. When `cfg.queueRoot` doesn't match
 * either derivable shape, it is still always included (labeled
 * "configured") rather than guessed at — the resolved root is authoritative
 * for whatever it is on THIS run; only unresolved history is unrecoverable.
 */
export function knownQueueRoots(
  cfg: Pick<Config, "queueRoot">,
  env: Record<string, string | undefined> = process.env,
): KnownQueueRoot[] {
  const knownShapes: Array<{ root: string; label: string }> = [
    { root: join(juncoHome(env), "queue"), label: "canonical" },
    { root: join(homeOf(env), ".local", "state", "junco", "queue"), label: "legacy data root" },
  ];
  const byRoot = new Map<string, KnownQueueRoot>();
  for (const shape of knownShapes) {
    byRoot.set(shape.root, { root: shape.root, label: shape.label, resolved: false });
  }
  const resolvedMatch = byRoot.get(cfg.queueRoot);
  if (resolvedMatch) {
    resolvedMatch.resolved = true;
  } else {
    byRoot.set(cfg.queueRoot, { root: cfg.queueRoot, label: "configured", resolved: true });
  }
  return [...byRoot.values()];
}

export function queuePaths(cfg: Config): Paths {
  const root = cfg.queueRoot;
  return {
    inbox: join(root, "inbox"),
    processing: join(root, "processing"),
    done: join(root, "done"),
    failed: join(root, "failed"),
  };
}
