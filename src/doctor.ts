/**
 * `junco doctor` — preflight every external dependency a ticket will need, so
 * failures surface here instead of after a 30-minute agent run.
 * ✓ pass · ⚠ warning (degraded but workable) · ✗ failure (exit 1).
 *
 * The checks live in the `CHECKS` table below, one entry per preflight, and
 * `runDoctor` is the loop that runs them in array order and renders what they
 * return. Ordering is therefore data (array position) and identity is a stable
 * string `id` — the old numbered comment sections had drifted into two `4b`s,
 * a `4a` after a `4b` and a `5a` after a `6` (#355). A check reads its inputs
 * from `DoctorCtx` and returns `Finding[]`; only two values flow between
 * checks (`cfg`, `ghAvailable`), and both are on the ctx.
 */

import { existsSync, readdirSync, lstatSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import type { Config } from "./types.js";
import {
  loadConfig,
  parseConfigFile,
  queuePaths,
  isLoopbackHost,
  configDeprecations,
  dataRootHasTree,
  homeOf,
} from "./config.js";
import {
  pendingMigrations,
  migrationTargetRoot,
  fixedLegacyRoot,
  pendingConfigRelocation,
} from "./dataMigrate.js";
import { dataTreePaths, sandboxDenyPaths } from "./dataTree.js";
import { SKILL_DIR_NAME } from "./skillLinks.js";
import { endpointReachable, probePolicy } from "./health.js";
import { fetchModels } from "./wizard/models.js";
import { splitModelId } from "./agent/modelSetup.js";
import { getResolvedModelInfo, type ResolvedModelInfo } from "./agent/session.js";
import { daemonLockPaths, readLockHolder } from "./lock.js";
import { nwoFromRemoteUrl } from "./githubInbox.js";
import { selectBackend, classifyAvailability } from "./agent/sandbox/backend.js";
import { buildPolicy, SandboxPolicyError } from "./agent/sandbox/policy.js";
import { loadDispatchTemplate } from "./planPrompt.js";
import { resolveWatchedRepos, watchlistPath } from "./watchlist.js";
import { outboxDepth, deadCount, outboxPaths } from "./githubOutbox.js";
import { pendingCount } from "./assessReview.js";
import { draftCount } from "./commentReview.js";
import { listHistory } from "./assessHistory.js";
import { defaultExec, defaultAccessOk } from "./execProbe.js";
import { SAML_MARKER } from "./botAccess.js";
import { checkForUpdate, getSelfPackage, type UpdateInfo } from "./updateCheck.js";
import { detectSplitQueue } from "./splitQueue.js";

export type DoctorExecFn = (
  cmd: string,
  args: string[],
  opts?: { env?: Record<string, string> },
) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface DoctorDeps {
  loadConfigFn?: (p: string) => Config;
  execFn?: DoctorExecFn;
  reachableFn?: (cfg: Config) => Promise<boolean>;
  fetchModelsFn?: typeof fetchModels;
  accessOkFn?: (dir: string) => boolean;
  lockHolderFn?: (lockPath: string) => number | null;
  readTemplateFn?: () => string;
  printFn?: (s: string) => void;
  /** Resolves a model id through the models.json → catalog → inline cascade
   * (see session.ts) — defaults to the real SDK-backed helper. `modelId`
   * overrides `cfg.model.id` for the planner preflight. */
  resolveInfoFn?: (cfg: Config, modelId?: string) => Promise<ResolvedModelInfo>;
  /** Auth-check HTTP calls (free list-models routes only — see checkAuth). */
  fetchFn?: typeof fetch;
  /** The RAW (pre-resolveApiKey) `model.apiKey` field straight off config.json
   * — a literal and a "$VAR" reference both collapse into the same resolved
   * string by the time `cfg.model.apiKey` reaches us, so telling them apart
   * for the key-source echo requires re-reading the file. Defaults to
   * re-parsing the same path loadConfigFn already validated; a failure here
   * degrades to "unknown" (undefined) rather than failing doctor — this is a
   * diagnostic nicety, not the config-load gate. */
  rawApiKeyFn?: (configPath: string) => string | undefined;
  /** Process environment, for the provider-env-var-fallback checks (key
   * source echo). Defaults to `process.env`; injectable so tests never read
   * or mutate the real environment. */
  env?: Record<string, string | undefined>;
  /** Existence probe for `pendingMigrations` (Unified Data Root spec §5, §7)
   * and the legacy-worktree-root leftover hint. Defaults to `fs.existsSync`. */
  existsFn?: (p: string) => boolean;
  /** Directory listing for the legacy-worktree-root leftover hint (spec §7) —
   * emptiness is the only thing that matters, so a listing failure (ENOENT,
   * not a directory) is treated as "nothing to hint about" rather than
   * thrown. Defaults to `fs.readdirSync`. */
  readdirFn?: (d: string) => string[];
  /** lstat (does NOT follow the link) — used only by the skill-links check to
   * tell a broken/absent symlink apart from a real file/dir squatting on the
   * same path (the one state `ensureSkillLinks` in skillLinks.ts refuses to
   * self-heal). Throws ENOENT when absent, same contract as `fs.lstatSync`;
   * defaults to it. */
  lstatFn?: (p: string) => { isSymbolicLink(): boolean };
  /** stat (follows links) — used only by the data-tree-modes check (#343),
   * which reads `mode`. Throws ENOENT when absent (an absent path is skipped,
   * never warned about), same contract as `fs.statSync`; defaults to it. */
  statFn?: (p: string) => { mode: number };
  /** Best-effort npm update check (spec 2026-07-16). Defaults to the real
   * `checkForUpdate`; injectable so tests never hit the network or a real
   * fs cache. */
  checkUpdateFn?: (cfg: Config) => Promise<UpdateInfo | null>;
}

type Verdict = "ok" | "warn" | "fail";

/** One rendered line: `<mark> <label>[ — <detail>]`. A check returns as many
 * as it has to say, or none at all when it has nothing (a disabled feature). */
export interface Finding {
  v: Verdict;
  label: string;
  detail?: string;
}

const ok = (label: string, detail?: string): Finding => ({ v: "ok", label, detail });
const warn = (label: string, detail?: string): Finding => ({ v: "warn", label, detail });
const fail = (label: string, detail?: string): Finding => ({ v: "fail", label, detail });
const verdict = (v: Verdict, label: string, detail?: string): Finding => ({ v, label, detail });

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Everything a check may read: the config path under test, the resolved deps
 * (never the raw optional ones), and the two values earlier checks hand to
 * later ones.
 */
export interface DoctorCtx {
  readonly configPath: string;
  /** Set by the `config` check; `null` when the config failed to load, which
   * is what makes every `needsConfig` check below it contribute nothing. */
  cfg: Config | null;
  /** Set by the `git-gh` check: `gh --version` exited 0. `bot-account` gates
   * on this rather than probing gh a second time. */
  ghAvailable: boolean;
  readonly loadConfigFn: (p: string) => Config;
  readonly execFn: DoctorExecFn;
  readonly reachableFn: (cfg: Config) => Promise<boolean>;
  readonly fetchModelsFn: typeof fetchModels;
  readonly accessOkFn: (dir: string) => boolean;
  readonly lockHolderFn: (lockPath: string) => number | null;
  readonly readTemplateFn: () => string;
  readonly resolveInfoFn: (cfg: Config, modelId?: string) => Promise<ResolvedModelInfo>;
  readonly fetchFn: typeof fetch;
  readonly rawApiKeyFn: (configPath: string) => string | undefined;
  readonly env: Record<string, string | undefined>;
  readonly existsFn: (p: string) => boolean;
  readonly readdirFn: (d: string) => string[];
  readonly lstatFn: (p: string) => { isSymbolicLink(): boolean };
  readonly statFn: (p: string) => { mode: number };
  readonly checkUpdateFn: (cfg: Config) => Promise<UpdateInfo | null>;
}

/** Binds a `DoctorDeps` to its defaults once, so no check re-does `?? real`. */
export function createDoctorCtx(configPath: string, deps: DoctorDeps = {}): DoctorCtx {
  return {
    configPath,
    cfg: null,
    ghAvailable: false,
    loadConfigFn: deps.loadConfigFn ?? loadConfig,
    execFn: deps.execFn ?? defaultExec,
    reachableFn: deps.reachableFn ?? ((c: Config) => endpointReachable(c)),
    fetchModelsFn: deps.fetchModelsFn ?? fetchModels,
    accessOkFn: deps.accessOkFn ?? defaultAccessOk,
    lockHolderFn: deps.lockHolderFn ?? readLockHolder,
    readTemplateFn: deps.readTemplateFn ?? loadDispatchTemplate,
    resolveInfoFn: deps.resolveInfoFn ?? getResolvedModelInfo,
    fetchFn: deps.fetchFn ?? fetch,
    rawApiKeyFn: deps.rawApiKeyFn ?? defaultRawApiKey,
    env: deps.env ?? process.env,
    existsFn: deps.existsFn ?? existsSync,
    readdirFn: deps.readdirFn ?? readdirSync,
    lstatFn: deps.lstatFn ?? lstatSync,
    statFn: deps.statFn ?? statSync,
    checkUpdateFn: deps.checkUpdateFn ?? ((c: Config) => checkForUpdate(c)),
  };
}

export interface DoctorCheck {
  readonly id: string;
  run(ctx: DoctorCtx): Promise<Finding[]>;
}

/** A check that only means anything once the config loaded. Every entry after
 * `config`/`node` is one of these: the null-config skip lives here rather than
 * being restated at the top of twenty bodies. */
function needsConfig(
  id: string,
  body: (ctx: DoctorCtx, cfg: Config) => Finding[] | Promise<Finding[]>,
): DoctorCheck {
  return {
    id,
    run: async (ctx) => (ctx.cfg === null ? [] : body(ctx, ctx.cfg)),
  };
}

/** A bare "$ENV_VAR" reference (uppercase env style only) — mirrors config.ts's
 * private ENV_REF exactly; kept as its own copy here since doctor only needs
 * to detect the shape (config.ts's resolveApiKey already did the resolving). */
const ENV_REF = /^\$([A-Z_][A-Z0-9_]*)$/;

function defaultRawApiKey(configPath: string): string | undefined {
  try {
    return parseConfigFile(configPath).model.apiKey;
  } catch {
    return undefined;
  }
}

/** `ResolvedModelInfo.path` values as shown to the operator — "models_json"
 * reads as "models.json" (the actual file kind); the other two pass through. */
function pathLabel(path: ResolvedModelInfo["path"]): string {
  return path === "models_json" ? "models.json" : path;
}

interface AuthOutcome {
  v: Verdict;
  detail: string;
}

/**
 * Per-API-family auth check against each provider's FREE authenticated
 * list-models route — never a paid completions call:
 *   - openai-*    → GET {baseUrl}/models          Bearer <key>
 *   - anthropic-* → GET {baseUrl}/v1/models        x-api-key + anthropic-version
 *   - google-*    → GET {baseUrl}/v1beta/models?key=<key>
 * Any other/unknown api family is skipped with a note (no request sent) —
 * doctor has no free-route recipe for it. 200 → ok; 401/403 → fail (bad key);
 * any other non-2xx → warn (inconclusive); a network error → warn
 * (unreachable, not necessarily a bad key).
 * An aggregator/proxy sitting behind a non-canonical baseUrl (a route shape
 * doctor doesn't know) can legitimately warn "inconclusive" here for a
 * perfectly good key — an accepted degrade, not a bug to chase.
 */
async function checkAuth(
  info: ResolvedModelInfo,
  apiKey: string,
  fetchFn: typeof fetch,
): Promise<AuthOutcome> {
  const base = info.baseUrl.replace(/\/+$/, "");
  let url: string;
  let headers: Record<string, string>;
  if (info.api.startsWith("openai-")) {
    url = `${base}/models`;
    headers = { Authorization: `Bearer ${apiKey}` };
  } else if (info.api.startsWith("anthropic-")) {
    url = `${base}/v1/models`;
    headers = { "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
  } else if (info.api.startsWith("google-")) {
    // The vendored catalog's baseUrl for google-generative-ai models already
    // ends with /v1beta (pi-ai providers/google.models.js) — suffix-guard so
    // a catalog hit doesn't double it into .../v1beta/v1beta/models (a
    // permanent 404 that reads as "inconclusive" for both good and bad keys).
    const withV1beta = base.endsWith("/v1beta") ? base : `${base}/v1beta`;
    url = `${withV1beta}/models?key=${encodeURIComponent(apiKey)}`;
    headers = {};
  } else {
    return { v: "ok", detail: `unknown api "${info.api}" — auth check skipped` };
  }

  try {
    const resp = await fetchFn(url, { method: "GET", headers });
    if (resp.ok) return { v: "ok", detail: "auth verified" };
    if (resp.status === 401 || resp.status === 403) {
      return { v: "fail", detail: "auth rejected (check the key)" };
    }
    return { v: "warn", detail: `auth check inconclusive (HTTP ${resp.status})` };
  } catch {
    return { v: "warn", detail: "endpoint unreachable" };
  }
}

/**
 * The preflight table. Array order IS report order; `id` is the stable handle
 * (never printed — the label is what the operator sees). Adding a check means
 * appending an entry, not finding a free letter.
 */
export const CHECKS: DoctorCheck[] = [
  {
    id: "config",
    run: async (ctx) => {
      try {
        ctx.cfg = ctx.loadConfigFn(ctx.configPath);
        return [ok("config", ctx.configPath)];
      } catch (e) {
        return [fail("config", `${ctx.configPath}: ${errText(e)}`)];
      }
    },
  },

  {
    id: "node",
    run: async () => {
      const [maj, min] = process.versions.node.split(".").map(Number);
      return maj > 22 || (maj === 22 && min >= 19)
        ? [ok("node", process.versions.node)]
        : [fail("node", `${process.versions.node} < required 22.19`)];
    },
  },

  // Deprecated config keys (Unified Data Root spec §5) — informational only:
  // doctor never fails on a legacy key, it just points at the migration.
  // `junco start` logs this same list once at daemon startup (cli.ts) — this
  // is doctor's mirror of that warning.
  needsConfig("config-deprecations", (_ctx, cfg) => {
    const deprecations = configDeprecations(cfg);
    return deprecations.length > 0
      ? [warn("deprecated config keys", deprecations.join(" | "))]
      : [];
  }),

  // Pending state-tree migrations (spec §7) — old-name dirs still present
  // under dataDir; `junco data migrate` renames them in place. Also folds in
  // the pending single-root layout/root pairs (2026-08-03 plan) when
  // `cfg.legacy.dataRoot` — `env` threads through so the computed target root
  // is hermetically testable, same seam as every other env-driven check in
  // this file.
  needsConfig("data-migrations", (ctx, cfg) => {
    const pending = pendingMigrations(cfg, ctx.existsFn, ctx.env);
    if (pending.length === 0) return [];
    const list = pending.map((m) => `${m.from} -> ${m.to}`).join(", ");
    return [warn("unmigrated data dirs", `${list} — run 'junco data migrate' to unify`)];
  }),

  // Both data roots hold a tree (#280) — NOT diagnostic of a single cause
  // (finding, task review): a pre-0.10 binary run after a completed 'junco
  // data migrate' recreates the legacy root from its hardcoded default, but an
  // INTERRUPTED migrate produces the exact same signal — its move loop
  // iterates pairs with separate, non-atomic rename calls (dataMigrateCmd.ts's
  // module doc), so a crash after the target picks up one pair but before the
  // rest leaves stragglers in the legacy root too. That second case is an
  // ordinary, resumable state (same module doc: resume is filesystem-driven
  // precisely so this recovers) — so this check does NOT gate or suppress
  // `data-migrations` above, and its own advice is written to be safe under
  // either cause rather than guessing between them: re-running 'junco data
  // migrate' is correct either way (it is resumable, refuses to run while the
  // daemon is up, and never overwrites — conflicts are reported, nothing
  // already moved is rolled back), so nothing here tells the operator to
  // delete anything by hand.
  needsConfig("dual-data-roots", (ctx, cfg) => {
    const targetRoot = migrationTargetRoot(cfg, ctx.env);
    const legacyRoot = fixedLegacyRoot(targetRoot, ctx.env);
    const bothRootsHaveTrees =
      legacyRoot !== null &&
      dataRootHasTree(targetRoot, ctx.existsFn) &&
      dataRootHasTree(legacyRoot, ctx.existsFn);
    if (!bothRootsHaveTrees) return [];
    return [
      warn(
        "both data roots hold a tree",
        `${targetRoot} and ${legacyRoot} — either an interrupted 'junco data migrate' left stragglers, ` +
          `or a pre-0.10 binary ran after a completed migrate and recreated the legacy root. Re-run ` +
          `'junco data migrate' — it resumes safely and never overwrites. Inspect both roots before ` +
          `deleting anything by hand.`,
      ),
    ];
  }),

  // The config FILE's own pending relocation (item 11, #281).
  // `data-migrations` above covers pending data DIRS only, so doctor used to
  // print a clean bill of health over a migration that still owed `junco data
  // migrate`'s phase-9 move — reporting parity it did not have. Deliberately
  // its own line rather than another entry in that list: a config.json among
  // "unmigrated data dirs" would misname what it is.
  //
  // Warn, never fail — same posture as the two checks above: a config that
  // still loads from the legacy path is a working install pending an operator
  // decision, not a broken one. `pendingConfigRelocation` is the mover's OWN
  // gate (dataMigrate.ts), so this can never warn about something `junco data
  // migrate` would refuse to do — in particular under a JUNCO_CONFIG override
  // (#307), where the config is deliberately never relocated and a warning
  // here could never be cleared.
  needsConfig("config-relocation", (ctx) => {
    const configMove = pendingConfigRelocation(ctx.configPath, ctx.env);
    if (configMove === null) return [];
    return [
      warn(
        "unrelocated config",
        `${configMove.from} -> ${configMove.to} — the data tree can be unified while the config ` +
          `itself is still at the pre-0.10 path; run 'junco data migrate' to move it`,
      ),
    ];
  }),

  // Legacy worktree-root override (spec §7): while git.worktreeRoot is SET,
  // that dir is the ACTIVE root — the override wins over <dataDir>/worktrees,
  // so its contents may be live tickets' worktrees and are NOT deletable yet.
  // Worktrees are deliberately excluded from the in-place migration above
  // (they're disposable once the override is gone), so doctor only points at
  // the removal path.
  needsConfig("legacy-worktree-root", (ctx, cfg) => {
    if (!cfg.legacy.worktreeRoot || !ctx.existsFn(cfg.worktreeRoot)) return [];
    let hasEntries = false;
    try {
      hasEntries = ctx.readdirFn(cfg.worktreeRoot).length > 0;
    } catch {
      hasEntries = false;
    }
    if (!hasEntries) return [];
    return [
      ok(
        "legacy worktree root",
        `worktrees currently live at ${cfg.worktreeRoot} via the deprecated git.worktreeRoot override — after removing the key (with the daemon idle), any leftovers there are disposable and new worktrees go under <dataDir>/worktrees`,
      ),
    ];
  }),

  // Skill links (spec 2026-08-19): the <dataDir>/skills mount plus each
  // configured harness link must RESOLVE as a live symlink. existsFn alone
  // can't distinguish a healthy symlink from a real file/dir squatting on
  // the same path (both "resolve") — lstatFn (does NOT follow the link) is
  // needed to tell them apart: dead = absent, or a symlink whose target is
  // gone (existsFn false); blocked = present and NOT a symlink — the one
  // state ensureSkillLinks (skillLinks.ts) refuses to self-heal ("occupied
  // by a non-symlink — not touching it"), so it needs a human to move the
  // squatter aside, not just a re-run. Harness dirs whose parent is missing
  // are skipped — a config roams between machines, and an uninstalled
  // harness is not a defect. warn (never fail) either way: dead self-heals
  // at daemon startup or via 'junco skill install'; blocked doesn't, but
  // doctor's job is to surface it, not to fail the run over it.
  needsConfig("skill-links", (ctx, cfg) => {
    const skillLinks = [
      dataTreePaths(cfg).skills,
      ...cfg.skills.harnessDirs
        .filter((d) => ctx.existsFn(dirname(d)))
        .map((d) => join(d, SKILL_DIR_NAME)),
    ];
    const deadLinks: string[] = [];
    const blockedLinks: string[] = [];
    for (const p of skillLinks) {
      let st: { isSymbolicLink(): boolean } | null;
      try {
        st = ctx.lstatFn(p);
      } catch {
        st = null;
      }
      if (st === null) {
        deadLinks.push(p);
      } else if (!st.isSymbolicLink()) {
        blockedLinks.push(p);
      } else if (!ctx.existsFn(p)) {
        deadLinks.push(p);
      }
    }
    if (deadLinks.length === 0 && blockedLinks.length === 0) {
      return [ok("skill links", `${skillLinks.length} link(s) resolve`)];
    }
    const out: Finding[] = [];
    if (deadLinks.length > 0) {
      out.push(
        warn(
          "skill links",
          `${deadLinks.join(", ")} — run 'junco skill install' (or start the daemon) to create/repair`,
        ),
      );
    }
    if (blockedLinks.length > 0) {
      out.push(
        warn(
          "skill links blocked",
          `${blockedLinks.join(", ")} — occupied by a real file/directory (not a symlink); move it ` +
            `aside manually — self-heal and 'junco skill install' will not touch it`,
        ),
      );
    }
    return out;
  }),

  needsConfig("git-gh", async (ctx, cfg) => {
    const out: Finding[] = [];
    const gitRes = await ctx.execFn(cfg.gitBin, ["--version"]);
    out.push(
      verdict(
        gitRes.code === 0 ? "ok" : "fail",
        "git",
        gitRes.code === 0 ? gitRes.stdout.trim() : "not found — PR-flow tickets need git",
      ),
    );
    const ghVer = await ctx.execFn(cfg.ghBin, ["--version"]);
    ctx.ghAvailable = ghVer.code === 0;
    if (ghVer.code !== 0) {
      out.push(warn("gh", "not found — PR-flow tickets will fail; Q&A tickets are fine"));
    } else {
      const auth = await ctx.execFn(cfg.ghBin, ["auth", "status"]);
      out.push(
        verdict(
          auth.code === 0 ? "ok" : "warn",
          "gh",
          auth.code === 0
            ? "authenticated"
            : "installed but not authenticated (run: gh auth login)",
        ),
      );
    }
    return out;
  }),

  // Bot account (only when enabled): identity under the isolated config dir;
  // same-login means the bot identity is doing nothing.
  needsConfig("bot-account", async (ctx, cfg) => {
    if (!cfg.botAccount.enabled || !ctx.ghAvailable) return [];
    // Clear GH_TOKEN/GITHUB_TOKEN (see git.ts ghAuthEnv): gh prefers them over
    // GH_CONFIG_DIR creds, so an ambient token would make the probe report the
    // wrong identity and mask a missing/misconfigured bot login.
    const botEnv = {
      env: { GH_CONFIG_DIR: cfg.botAccount.configDir, GH_TOKEN: "", GITHUB_TOKEN: "" },
    };
    const bot = await ctx.execFn(cfg.ghBin, ["api", "user"], botEnv);
    if (bot.code !== 0) {
      return [
        fail(
          "bot account",
          bot.stderr.includes(SAML_MARKER)
            ? "bot token blocked by SAML enforcement — authorize gh for the org in the bot's browser session"
            : `enabled but not logged in under ${cfg.botAccount.configDir} (run: junco auth login)`,
        ),
      ];
    }
    let botLogin: string | null = null;
    try {
      botLogin = (JSON.parse(bot.stdout) as { login: string }).login;
    } catch {
      /* fall through to inconclusive */
    }
    if (botLogin === null) return [warn("bot account", "could not parse gh api user output")];

    const ambient = await ctx.execFn(cfg.ghBin, ["api", "user"]);
    let ambientLogin: string | null = null;
    try {
      ambientLogin =
        ambient.code === 0 ? (JSON.parse(ambient.stdout) as { login: string }).login : null;
    } catch {
      /* ambient identity is optional here */
    }
    if (ambientLogin !== null && ambientLogin === botLogin) {
      return [
        warn(
          "bot account",
          `bot login "${botLogin}" equals your personal gh login — separate identities to get attribution/approval value`,
        ),
      ];
    }
    return [ok("bot account", `acting as ${botLogin}`)];
  }),

  needsConfig("sandbox-backend", async (ctx, cfg) => {
    if (!cfg.sandbox?.enabled) return [];
    const backend = selectBackend(cfg.sandbox.backend, process.platform);
    if (backend.name === "none") {
      return [
        warn("sandbox", "enabled with backend=none — env scrub + fs jail only, no OS isolation"),
      ];
    }
    const availability = await backend.checkAvailability((c, a) =>
      ctx.execFn(c, a).then((r) => ({ code: r.code, stderr: r.stderr })),
    );
    const outcome = classifyAvailability(
      cfg.sandbox.backend,
      backend.name,
      availability.available,
      cfg.sandbox.requireBackend,
    );
    // On trouble, tell the operator exactly how to satisfy the system
    // prerequisite (bwrap is a distro package, like git/gh — not an npm dep).
    const installHint =
      backend.name === "bwrap"
        ? "install bubblewrap (apt install bubblewrap / dnf install bubblewrap / apk add bubblewrap)"
        : "install the backend";
    // #312: quote the probe's own refusal before the install hint — the hint
    // is wrong advice whenever the binary is present and something else (a
    // kernel policy, a missing userns) is what said no.
    const why = availability.reason === undefined ? "" : ` (${availability.reason})`;
    if (outcome === "ok") return [ok("sandbox", `${backend.name} available`)];
    if (outcome === "degrade") {
      // backend="auto": won't fail tickets, but silently gives less than
      // full OS isolation — surface it as a warning, not a pass.
      return [
        warn(
          "sandbox",
          `${backend.name} unavailable${why} — auto-degrading to none (env scrub + fs jail only, ` +
            `bash not OS-confined); ${installHint} for full isolation`,
        ),
      ];
    }
    // #344: under auto this refusal exists only because
    // sandbox.requireBackend demanded it — name the lever, since the
    // opt-out is that knob, not disabling the sandbox wholesale.
    const demanded = cfg.sandbox.backend === "auto" ? " (sandbox.requireBackend is on)" : "";
    const optOut =
      cfg.sandbox.backend === "auto" ? "sandbox.requireBackend=false" : "sandbox.enabled=false";
    return [
      fail(
        "sandbox",
        `${backend.name} unavailable${why} — tickets fail closed${demanded}. ${installHint}, or set ${optOut}`,
      ),
    ];
  }),

  // Sandbox POLICY (#311/F2). Availability is only half the preflight:
  // `buildPolicy` is fail-closed and refuses a configuration it cannot
  // enforce identically on all three backends (an allow above a by-name
  // deny file). That refusal happens at session-creation time
  // (agent/session.ts's resolveSandbox), i.e. once per TICKET — so without
  // this check a tripping config reports healthy here and then fails 100%
  // of tickets with no config-level signal anywhere. Build the real policy
  // from the real paths and surface the refusal as a doctor failure, with
  // the same actionable message the ticket would have shown.
  //
  // `cwd`/`scratchDir` are the two per-session values doctor cannot know;
  // stand-ins are used. That is sound for what this checks: a ticket's cwd
  // is always a fresh leaf directory under `git.worktreeRoot` (or a clone
  // under `github.externalReposRoot`), and a leaf can never be an ancestor
  // of a deny file. The tier ITSELF is what can trip the guard, and it is
  // checked for real — `sandboxDenyPaths().allowDirs` carries both tiers
  // unconditionally, so a mis-set tier throws here exactly as it would at
  // spawn.
  needsConfig("sandbox-policy", (ctx, cfg) => {
    if (!cfg.sandbox?.enabled) return [];
    try {
      const dataPaths = sandboxDenyPaths(cfg, ctx.env);
      buildPolicy({
        cfg: cfg.sandbox,
        cwd: join(cfg.worktreeRoot, "junco-doctor-preflight"),
        scratchDir: join(tmpdir(), "junco-doctor-preflight"),
        home: homeOf(ctx.env),
        dataDenyPaths: dataPaths,
        dataAllowPaths: dataPaths.allowDirs,
        network: cfg.sandbox.network === "allow",
        botGhConfigDir: cfg.botAccount.configDir,
      });
      return [ok("sandbox policy", "enforceable on every backend")];
    } catch (e) {
      if (e instanceof SandboxPolicyError) return [fail("sandbox policy", e.message)];
      return [fail("sandbox policy", errText(e))];
    }
  }),

  // Endpoint / model resolution. "catalog-eligible" rather than "hosted
  // provider": a provider-prefixed id that ISN'T in the builtin catalog
  // still lands here (shouldProbeEndpoint only checks eligibility, not an
  // actual catalog hit) and the runtime cascade (resolveModelViaRegistries)
  // falls through to inline resolution at first session — "hosted
  // provider" would be actively wrong for that case, hence gating the auth
  // check below on the ACTUAL resolved path, not this branch's entry
  // condition. worker.endpointProbe="never" is a SEPARATE reason to land
  // here: it overrides the catalog-skip heuristic outright (probePolicy in
  // health.ts), so it can fire on a non-catalog (e.g. local) model too — an
  // operator who explicitly disabled probing did not ask for the new
  // auth-check network side effect either, so that sub-branch keeps the
  // old bare message untouched (models.json configs never reach this branch
  // at all: shouldProbeEndpoint always probes them the old way below).
  needsConfig("endpoint-model", async (ctx, cfg) => {
    const out: Finding[] = [];
    if (!probePolicy(cfg)) {
      if (cfg.endpointProbe === "never") {
        out.push(
          ok("inference endpoint", `${cfg.model.id} — probe disabled (worker.endpointProbe=never)`),
        );
        return out;
      }
      // Phase 3 hosted-aware preflight: resolution echo, key source, and
      // (for a confirmed catalog hit) a per-API auth check — see checkAuth.
      let info: ResolvedModelInfo | null = null;
      try {
        info = await ctx.resolveInfoFn(cfg);
        out.push(
          ok("model", `${cfg.model.id} resolves via ${pathLabel(info.path)} (${info.baseUrl})`),
        );
      } catch (e) {
        out.push(fail("model", errText(e)));
      }

      const provider = info?.provider ?? splitModelId(cfg.model.id).provider;
      const envVar = `${provider.toUpperCase()}_API_KEY`;
      const raw = ctx.rawApiKeyFn(ctx.configPath);
      const envRefMatch = raw !== undefined ? ENV_REF.exec(raw) : null;
      if (envRefMatch) {
        out.push(ok("key source", `$${envRefMatch[1]} (resolved from the environment)`));
      } else if (raw !== undefined) {
        out.push(ok("key source", "config literal (model.apiKey)"));
      } else if (ctx.env[envVar]) {
        out.push(ok("key source", `${envVar} present in the environment`));
      } else if (provider !== "local") {
        out.push(
          warn(
            "key source",
            `no key configured — the SDK will typically look for ${envVar}-style env vars at request time`,
          ),
        );
      }

      if (info && info.path === "catalog") {
        if (cfg.model.apiKey === null) {
          out.push(
            warn("auth", "no key configured — skipping the auth check (see key source above)"),
          );
        } else {
          const outcome = await checkAuth(info, cfg.model.apiKey, ctx.fetchFn);
          out.push(verdict(outcome.v, "auth", outcome.detail));
        }
      }
      return out;
    }

    const up = await ctx.reachableFn(cfg);
    out.push(
      verdict(
        up ? "ok" : "fail",
        "inference endpoint",
        up ? cfg.model.baseUrl : `${cfg.model.baseUrl} unreachable`,
      ),
    );

    // Model advertised (warn-only: not every endpoint lists models)
    if (up) {
      const ids = await ctx.fetchModelsFn(cfg.model.baseUrl, cfg.model.apiKey);
      const { modelId } = splitModelId(cfg.model.id);
      if (ids.length === 0) {
        out.push(warn("model", `endpoint does not list models; cannot verify ${cfg.model.id}`));
      } else if (ids.includes(modelId) || ids.includes(cfg.model.id)) {
        out.push(ok("model", cfg.model.id));
      } else {
        out.push(
          warn("model", `${cfg.model.id} not among the endpoint's ${ids.length} advertised models`),
        );
      }
    }
    return out;
  }),

  // Planner model preflight — plannerModelId overrides cfg.model.id for
  // planning-session tickets only (runOnce.ts:317); a bad override shouldn't
  // fail doctor since ordinary Q&A/PR tickets never use it, hence warn.
  needsConfig("planner-model", async (ctx, cfg) => {
    if (!cfg.github.plannerModelId) return [];
    const plannerId = cfg.github.plannerModelId;
    try {
      const plannerInfo = await ctx.resolveInfoFn(cfg, plannerId);
      return [
        ok(
          "planner model",
          `${plannerId} resolves via ${pathLabel(plannerInfo.path)} (${plannerInfo.baseUrl})`,
        ),
      ];
    } catch (e) {
      return [warn("planner model", errText(e))];
    }
  }),

  // Queue + worktree dirs writable
  needsConfig("dirs-writable", (ctx, cfg) => {
    const paths = queuePaths(cfg);
    return (
      [
        ["queue", dirname(paths.inbox)],
        ["worktree root", cfg.worktreeRoot],
        ["data dir", cfg.dataDir],
      ] as const
    ).map(([label, dir]) => verdict(ctx.accessOkFn(dir) ? "ok" : "fail", label, dir));
  }),

  // Data tree modes (#343). Fresh trees are created owner-only
  // (ensureDataTree/configCmd/wizard mkdir 0700, config + transcript writes
  // 0600), but mkdir never re-modes a dir that already exists, so a tree
  // from before #343 — or one an operator loosened — stays readable by every
  // local user on a shared host: the config may hold a literal apiKey and
  // transcripts hold verbatim private-repo file contents. Warn, never fail
  // (a loose mode is not a broken install), and print the exact chmod. An
  // absent path is skipped: a fresh tree has no transcripts dir yet. Unix
  // permission bits are meaningless on win32, so the check is skipped there.
  needsConfig("data-tree-modes", (ctx, cfg) => {
    if (process.platform === "win32") return [];
    const loose: string[] = [];
    for (const [p, want] of [
      [ctx.configPath, "600"],
      [cfg.dataDir, "700"],
      [dataTreePaths(cfg).transcripts, "700"],
    ] as const) {
      let mode: number;
      try {
        mode = ctx.statFn(p).mode;
      } catch {
        continue;
      }
      if ((mode & 0o077) !== 0) loose.push(`chmod ${want} ${p}`);
    }
    if (loose.length === 0) return [ok("data tree modes", "owner-only")];
    return [
      warn(
        "data tree modes",
        `readable by other local users (config may hold model.apiKey; transcripts hold ` +
          `repo file contents) — run: ${loose.join(" && ")}`,
      ),
    ];
  }),

  // Split queue (#274) — the interactive twin of the daemon startup warning
  // (daemon.ts): the resolved queue's inbox is empty while another known root
  // still holds pending tickets. Same detector, same finding, rephrased for a
  // one-shot command. Warn only, never fail: a split queue is an operator
  // decision about which root is "the" queue, not a broken install (see the
  // exit-code tally in runDoctor — warns never move it).
  //
  // listInboxFn reuses existsFn/readdirFn (no new dep) rather than the
  // detector's default `discoverTasks`, which calls fs.readdirSync
  // directly and isn't hermetic; mirrors the existsFn-then-readdirFn
  // pattern the legacy-worktree-root check above already uses, and
  // filters to .md the same way discoverTasks does, so "pending" here
  // means the same thing it means to the worker.
  //
  // Detector-throw handling deliberately differs from the daemon's: the
  // daemon swallows a throw at debug level because it's unattended
  // background observability with no consumer an abort would help, and
  // this same check runs again next start regardless. `doctor` is
  // interactive and its entire job is reporting every check's status to an
  // operator who is looking right now — silently skipping this one would
  // be a blind spot they'd never learn about. So a throw here still
  // surfaces, as a warn naming the error, consistent with "warns never
  // fail doctor."
  needsConfig("split-queue", (ctx, cfg) => {
    try {
      const listInboxFn = (dir: string): string[] => {
        // ENOENT is genuinely "empty" — a root that was never created holds no
        // tickets. Anything else is NOT: swallowing EACCES/ENOTDIR to [] would
        // make doctor print "✓ queue roots — no other known queue root holds
        // pending tickets", an affirmative claim about a directory it could
        // not read, in the one tool an operator reaches for when something
        // feels wrong (an abandoned root on a wrong-permissions mount can hold
        // stranded tickets). Rethrowing with the path attached routes it to
        // the outer catch's warn, which is also what makes the throw→warn
        // asymmetry documented above reachable in production at all: existsFn
        // (fs.existsSync) never throws and knownQueueRoots is pure string
        // joins, so the lister is the only real source of one.
        if (!ctx.existsFn(dir)) return [];
        try {
          return ctx.readdirFn(dir).filter((n) => n.endsWith(".md"));
        } catch (e) {
          throw new Error(`${dir} is unreadable: ${errText(e)}`);
        }
      };
      const split = detectSplitQueue(cfg, ctx.env, { listInbox: listInboxFn });
      if (!split) return [ok("queue roots", "no other known queue root holds pending tickets")];
      const otherRoots = split.others
        .map((o) => `${o.root} (${o.label}, ${o.pending} pending)`)
        .join(", ");
      return [
        warn(
          "queue roots",
          `resolved queue's inbox (${join(split.resolvedRoot, "inbox")}) is empty but ${otherRoots} ` +
            `still holds pending tickets — point whatever files tickets at the resolved root, or run ` +
            `'junco data migrate' for a legacy root, then restart the daemon`,
        ),
      ];
    } catch (e) {
      return [warn("queue roots", `split-queue check failed: ${errText(e)}`)];
    }
  }),

  // Health bind address — a non-loopback health_host exposes the
  // unauthenticated /health metrics (in-flight ticket ids, PID, tokens) to
  // the network. Warn, never fail (the operator may have deliberately opened
  // it behind a firewall/proxy).
  // No truthy `&& cfg.healthHost` guard: an empty host is non-loopback
  // (isLoopbackHost("") → false), so a value that bypassed config
  // normalization still surfaces here rather than evading the warning (#71).
  needsConfig("health-bind", (_ctx, cfg) => {
    if (!cfg.healthEnabled || isLoopbackHost(cfg.healthHost)) return [];
    return [
      warn(
        "health bind",
        `${cfg.healthHost} is not loopback — /health is unauthenticated and exposes ticket ids + metrics to the network; bind 127.0.0.1 unless firewalled`,
      ),
    ];
  }),

  // Github bridge (only when enabled — disabled setups print nothing)
  needsConfig("github-bridge", async (ctx, cfg) => {
    if (!cfg.github.enabled) return [];
    const out: Finding[] = [];
    try {
      ctx.readTemplateFn();
      out.push(ok("github planner template", "skills/junco-dispatch/TEMPLATE.md"));
    } catch (e) {
      out.push(
        fail("github planner template", `unreadable — planning tickets will fail (${errText(e)})`),
      );
    }

    const watchedRepos = resolveWatchedRepos(cfg);
    if (watchedRepos.length === 0) {
      out.push(warn("github", "enabled but no repos configured — the bridge will idle"));
    }
    for (const repo of watchedRepos) {
      const origin = await ctx.execFn(cfg.gitBin, ["-C", repo.path, "remote", "get-url", "origin"]);
      const actual = origin.code === 0 ? nwoFromRemoteUrl(origin.stdout.trim()) : null;
      if (actual === null || actual.toLowerCase() !== repo.nwo.toLowerCase()) {
        out.push(
          fail(
            `github repo ${repo.nwo}`,
            origin.code !== 0
              ? `${repo.path} is not a git clone (or has no origin)`
              : `origin is ${actual ?? origin.stdout.trim()}, expected ${repo.nwo}`,
          ),
        );
        continue;
      }
      const view = await ctx.execFn(cfg.ghBin, ["repo", "view", repo.nwo, "--json", "name"]);
      out.push(
        verdict(
          view.code === 0 ? "ok" : "fail",
          `github repo ${repo.nwo}`,
          view.code === 0 ? repo.path : "not reachable via gh (auth? spelling?)",
        ),
      );

      // Bot mode only: the bot account needs enough permission on this
      // watched repo to actually push branches, not just read issues.
      if (cfg.botAccount.enabled) {
        // #189: the bot credential helper is pinned for https github remotes
        // only. An SSH origin pushes with the operator's ssh key regardless
        // of bot mode (commits stay bot-authored and the PR is bot-opened,
        // but the push/audit trail shows the human) — warn so it can be
        // re-pointed. `origin` reached here with code 0 and a matching nwo.
        if (!/^https:\/\/github\.com\//.test(origin.stdout.trim())) {
          out.push(
            warn(
              `bot remote: ${repo.nwo}`,
              `origin is not an https github remote (${origin.stdout.trim() || "unknown"}) — ` +
                `the bot credential helper only applies to https; pushes authenticate with your ` +
                `ssh key, not the bot. Re-point origin to https for full bot attribution.`,
            ),
          );
        }
        const perm = await ctx.execFn(
          cfg.ghBin,
          ["repo", "view", repo.nwo, "--json", "viewerPermission"],
          // Clear GH_TOKEN/GITHUB_TOKEN so the permission check runs as the bot,
          // not as whatever token the daemon shell happens to export.
          { env: { GH_CONFIG_DIR: cfg.botAccount.configDir, GH_TOKEN: "", GITHUB_TOKEN: "" } },
        );
        let level: string | null = null;
        try {
          level =
            perm.code === 0
              ? (JSON.parse(perm.stdout) as { viewerPermission: string }).viewerPermission
              : null;
        } catch {
          /* inconclusive */
        }
        if (level === "ADMIN" || level === "MAINTAIN" || level === "WRITE") {
          out.push(ok(`bot access: ${repo.nwo}`, level.toLowerCase()));
        } else if (level === "TRIAGE") {
          out.push(
            warn(
              `bot access: ${repo.nwo}`,
              "triage — label edits work, branch pushes will fail — fix: junco auth grant " +
                repo.nwo,
            ),
          );
        } else if (perm.code !== 0 && perm.stderr.includes(SAML_MARKER)) {
          out.push(
            warn(
              `bot access: ${repo.nwo}`,
              "bot token blocked by SAML enforcement — authorize gh for the org in the bot's browser session",
            ),
          );
        } else {
          out.push(
            warn(
              `bot access: ${repo.nwo}`,
              `${level ?? "unknown"} — fix: junco auth grant ${repo.nwo}`,
            ),
          );
        }
      }
    }
    out.push(ok("github watchlist", watchlistPath(cfg)));
    return out;
  }),

  // Github outbox backlog / dead-letters — informational warns, never fail
  // doctor (the daemon's throttled sweep or `junco outbox flush` clears them;
  // a stuck backlog just means GitHub side effects are late).
  needsConfig("outbox", (_ctx, cfg) => {
    const out: Finding[] = [];
    const backlog = outboxDepth(cfg);
    if (backlog > 0) out.push(warn("outbox backlog", `${backlog} queued (junco outbox flush)`));
    const stuck = deadCount(cfg);
    if (stuck > 0) out.push(warn("outbox dead-letters", `${stuck} in ${outboxPaths(cfg).dead}`));
    return out;
  }),

  // Audit review backlog — informational only (normal workflow state, not a
  // health problem), independent of the github.enabled bridge gate.
  needsConfig("audit-review", (_ctx, cfg) => {
    const reviews = pendingCount(cfg);
    return reviews > 0 ? [ok("audit review", `${reviews} pending (junco audit review)`)] : [];
  }),

  // Per-repo audit history — informational only (a never-assessed repo is
  // normal workflow state, not a health problem), mirroring `audit-review`.
  needsConfig("audit-history", (_ctx, cfg) =>
    listHistory(cfg).map((h) => {
      const when = h.lastSuccessAt ? `assessed ${h.lastSuccessAt.slice(0, 10)}` : "never assessed";
      const failed = h.lastFailureAt ? ` (last attempt failed)` : "";
      return ok("audit history", `${h.id}: ${when}${failed}`);
    }),
  ),

  // Analyze comment-draft backlog — informational only (normal workflow
  // state, not a health problem), independent of the github.enabled gate.
  needsConfig("investigate-drafts", (_ctx, cfg) => {
    const drafts = draftCount(cfg);
    return drafts > 0
      ? [ok("investigate drafts", `${drafts} pending (junco investigate review)`)]
      : [];
  }),

  // Daemon (informational) — and, since #310, the two shared-root claims as
  // well (final review F6).
  //
  // `worker.lock` answers only "is a daemon running against THIS config?".
  // That is the wrong question for the operator whose `junco start` was
  // REFUSED because a peer resolved a different config file onto the same
  // data root or queue: their daemon is genuinely not running, so this check
  // printed a clean `ok  daemon  not running` and the actual cause — a live
  // claim held by a pid this config has never heard of — appeared nowhere.
  // The refusal itself is written to stderr before the log sink exists, so
  // under a supervisor it lands only in launchd.err/the journal. Reading the
  // claims here is additive (same `readLockHolder` seam, two more pidfiles)
  // and turns that silence into one line naming the root, the pid and the
  // claim file.
  needsConfig("daemon", (ctx, cfg) => {
    const lockPaths = daemonLockPaths(ctx.configPath, cfg);
    const holder = ctx.lockHolderFn(lockPaths.worker);
    const out: Finding[] = [ok("daemon", holder ? `running (pid ${holder})` : "not running")];
    // A claim held by OUR daemon is the normal case and says nothing new, so
    // only a holder that is not this config's daemon is reported. `holder`
    // being null makes every live claim foreign, which is exactly the refused
    // -start shape.
    for (const [label, claim] of [
      ["data root", lockPaths.dataTree],
      ["queue root", lockPaths.queue],
    ] as const) {
      const claimHolder = ctx.lockHolderFn(claim);
      if (claimHolder === null || claimHolder === holder) continue;
      out.push(
        warn(
          "daemon claim",
          `${label} ${dirname(claim)} is claimed by pid ${claimHolder}, which is not this ` +
            `config's daemon — that daemon resolved a different config file, and \`junco start\` ` +
            `here refuses while it holds ${claim} (#310)`,
        ),
      );
    }
    return out;
  }),

  // npm update check (spec 2026-07-16) — best-effort, never a failure.
  needsConfig("update-check", async (ctx, cfg) => {
    const update = await ctx.checkUpdateFn(cfg);
    if (update === null) {
      return [
        ok(
          "junco version",
          `v${getSelfPackage().version} (update check skipped — offline or disabled)`,
        ),
      ];
    }
    if (update.available) {
      return [
        warn(
          "junco version",
          `v${update.current} — v${update.latest} available (run: junco update)`,
        ),
      ];
    }
    return [ok("junco version", `v${update.current} (latest)`)];
  }),
];

export async function runDoctor(configPath: string, deps: DoctorDeps = {}): Promise<number> {
  const print = deps.printFn ?? ((s: string) => process.stdout.write(s));
  const ctx = createDoctorCtx(configPath, deps);

  const results: Finding[] = [];
  for (const check of CHECKS) {
    for (const f of await check.run(ctx)) {
      results.push(f);
      const mark = f.v === "ok" ? "✓" : f.v === "warn" ? "⚠" : "✗";
      print(`${mark} ${f.label}${f.detail ? ` — ${f.detail}` : ""}\n`);
    }
  }

  const fails = results.filter((r) => r.v === "fail").length;
  const warns = results.filter((r) => r.v === "warn").length;
  print(`\n${fails === 0 ? "ready" : "NOT ready"} — ${fails} failure(s), ${warns} warning(s)\n`);
  return fails === 0 ? 0 : 1;
}
