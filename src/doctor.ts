/**
 * `junco doctor` — preflight every external dependency a ticket will need, so
 * failures surface here instead of after a 30-minute agent run.
 * ✓ pass · ⚠ warning (degraded but workable) · ✗ failure (exit 1).
 */

import { existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { Config } from "./types.js";
import {
  loadConfig,
  parseConfigFile,
  queuePaths,
  isLoopbackHost,
  configDeprecations,
} from "./config.js";
import { pendingMigrations } from "./dataMigrate.js";
import { endpointReachable, probePolicy } from "./health.js";
import { fetchModels } from "./wizard/models.js";
import { splitModelId } from "./agent/modelSetup.js";
import { getResolvedModelInfo, type ResolvedModelInfo } from "./agent/session.js";
import { readLockHolder } from "./lock.js";
import { nwoFromRemoteUrl } from "./githubInbox.js";
import { selectBackend, classifyAvailability } from "./agent/sandbox/backend.js";
import { loadDispatchTemplate } from "./planPrompt.js";
import { resolveWatchedRepos, watchlistPath } from "./watchlist.js";
import { outboxDepth, deadCount, outboxPaths } from "./githubOutbox.js";
import { pendingCount } from "./assessReview.js";
import { draftCount } from "./commentReview.js";
import { defaultExec, defaultAccessOk } from "./execProbe.js";
import { SAML_MARKER } from "./botAccess.js";

export interface DoctorDeps {
  loadConfigFn?: (p: string) => Config;
  execFn?: (
    cmd: string,
    args: string[],
    opts?: { env?: Record<string, string> },
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
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
}

type Verdict = "ok" | "warn" | "fail";

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

export async function runDoctor(configPath: string, deps: DoctorDeps = {}): Promise<number> {
  const print = deps.printFn ?? ((s: string) => process.stdout.write(s));
  const execFn = deps.execFn ?? defaultExec;
  const reachableFn = deps.reachableFn ?? ((c: Config) => endpointReachable(c));
  const fetchModelsFn = deps.fetchModelsFn ?? fetchModels;
  const accessOkFn = deps.accessOkFn ?? defaultAccessOk;
  const lockHolderFn = deps.lockHolderFn ?? readLockHolder;
  const resolveInfoFn = deps.resolveInfoFn ?? getResolvedModelInfo;
  const fetchFn = deps.fetchFn ?? fetch;
  const rawApiKeyFn = deps.rawApiKeyFn ?? defaultRawApiKey;
  const env = deps.env ?? process.env;
  const existsFn = deps.existsFn ?? existsSync;
  const readdirFn = deps.readdirFn ?? readdirSync;

  const results: Array<{ v: Verdict; label: string }> = [];
  const report = (v: Verdict, label: string, detail = ""): void => {
    results.push({ v, label });
    const mark = v === "ok" ? "✓" : v === "warn" ? "⚠" : "✗";
    print(`${mark} ${label}${detail ? ` — ${detail}` : ""}\n`);
  };

  // 1. config
  let cfg: Config | null = null;
  try {
    cfg = (deps.loadConfigFn ?? loadConfig)(configPath);
    report("ok", "config", configPath);
  } catch (e) {
    report("fail", "config", `${configPath}: ${e instanceof Error ? e.message : String(e)}`);
  }

  // 2. node version
  const [maj, min] = process.versions.node.split(".").map(Number);
  if (maj > 22 || (maj === 22 && min >= 19)) report("ok", "node", process.versions.node);
  else report("fail", "node", `${process.versions.node} < required 22.19`);

  if (cfg) {
    // 2a. deprecated config keys (Unified Data Root spec §5) — informational
    // only: doctor never fails on a legacy key, it just points at the
    // migration. `junco start` logs this same list once at daemon startup
    // (cli.ts) — this is doctor's mirror of that warning.
    const deprecations = configDeprecations(cfg);
    if (deprecations.length > 0) {
      report("warn", "deprecated config keys", deprecations.join(" | "));
    }

    // 2b. pending state-tree migrations (spec §7) — old-name dirs still
    // present under dataDir; `junco data migrate` renames them in place.
    const pending = pendingMigrations(cfg, existsFn);
    if (pending.length > 0) {
      const list = pending.map((m) => `${m.from} -> ${m.to}`).join(", ");
      report("warn", "unmigrated data dirs", `${list} — run 'junco data migrate' to unify`);
    }

    // 2c. legacy worktree-root leftovers (spec §7): worktrees are disposable
    // and deliberately excluded from the in-place migration above — nothing
    // renames them automatically, so doctor only hints that the old location
    // still holds something.
    if (cfg.legacy.worktreeRoot && existsFn(cfg.worktreeRoot)) {
      let hasEntries = false;
      try {
        hasEntries = readdirFn(cfg.worktreeRoot).length > 0;
      } catch {
        hasEntries = false;
      }
      if (hasEntries) {
        report(
          "ok",
          "legacy worktree root",
          `old worktrees remain at ${cfg.worktreeRoot} (git.worktreeRoot) — disposable, safe to delete; new worktrees use <dataDir>/worktrees`,
        );
      }
    }

    // 3-4. git / gh
    const gitRes = await execFn(cfg.gitBin, ["--version"]);
    report(
      gitRes.code === 0 ? "ok" : "fail",
      "git",
      gitRes.code === 0 ? gitRes.stdout.trim() : "not found — PR-flow tickets need git",
    );
    const ghVer = await execFn(cfg.ghBin, ["--version"]);
    if (ghVer.code !== 0) {
      report("warn", "gh", "not found — PR-flow tickets will fail; Q&A tickets are fine");
    } else {
      const auth = await execFn(cfg.ghBin, ["auth", "status"]);
      report(
        auth.code === 0 ? "ok" : "warn",
        "gh",
        auth.code === 0 ? "authenticated" : "installed but not authenticated (run: gh auth login)",
      );
    }

    // 4b. bot account (only when enabled): identity under the isolated config
    // dir; same-login means the bot identity is doing nothing.
    if (cfg.botAccount.enabled && ghVer.code === 0) {
      // Clear GH_TOKEN/GITHUB_TOKEN (see git.ts ghAuthEnv): gh prefers them over
      // GH_CONFIG_DIR creds, so an ambient token would make the probe report the
      // wrong identity and mask a missing/misconfigured bot login.
      const botEnv = {
        env: { GH_CONFIG_DIR: cfg.botAccount.configDir, GH_TOKEN: "", GITHUB_TOKEN: "" },
      };
      const bot = await execFn(cfg.ghBin, ["api", "user"], botEnv);
      if (bot.code !== 0) {
        report(
          "fail",
          "bot account",
          bot.stderr.includes(SAML_MARKER)
            ? "bot token blocked by SAML enforcement — authorize gh for the org in the bot's browser session"
            : `enabled but not logged in under ${cfg.botAccount.configDir} (run: junco auth login)`,
        );
      } else {
        let botLogin: string | null = null;
        try {
          botLogin = (JSON.parse(bot.stdout) as { login: string }).login;
        } catch {
          /* fall through to inconclusive */
        }
        if (botLogin === null) {
          report("warn", "bot account", "could not parse gh api user output");
        } else {
          const ambient = await execFn(cfg.ghBin, ["api", "user"]);
          let ambientLogin: string | null = null;
          try {
            ambientLogin =
              ambient.code === 0 ? (JSON.parse(ambient.stdout) as { login: string }).login : null;
          } catch {
            /* ambient identity is optional here */
          }
          if (ambientLogin !== null && ambientLogin === botLogin) {
            report(
              "warn",
              "bot account",
              `bot login "${botLogin}" equals your personal gh login — separate identities to get attribution/approval value`,
            );
          } else {
            report("ok", "bot account", `acting as ${botLogin}`);
          }
        }
      }
    }

    // 4a. sandbox backend (only when enabled)
    if (cfg.sandbox?.enabled) {
      const backend = selectBackend(cfg.sandbox.backend, process.platform);
      if (backend.name === "none") {
        report(
          "warn",
          "sandbox",
          "enabled with backend=none — env scrub + fs jail only, no OS isolation",
        );
      } else {
        const ok = await backend.isAvailable((c, a) =>
          execFn(c, a).then((r) => ({ code: r.code })),
        );
        const outcome = classifyAvailability(cfg.sandbox.backend, backend.name, ok);
        // On trouble, tell the operator exactly how to satisfy the system
        // prerequisite (bwrap is a distro package, like git/gh — not an npm dep).
        const installHint =
          backend.name === "bwrap"
            ? "install bubblewrap (apt install bubblewrap / dnf install bubblewrap / apk add bubblewrap)"
            : "install the backend";
        if (outcome === "ok") {
          report("ok", "sandbox", `${backend.name} available`);
        } else if (outcome === "degrade") {
          // backend="auto": won't fail tickets, but silently gives less than
          // full OS isolation — surface it as a warning, not a pass.
          report(
            "warn",
            "sandbox",
            `${backend.name} unavailable — auto-degrading to none (env scrub + fs jail only, ` +
              `bash not OS-confined); ${installHint} for full isolation`,
          );
        } else {
          report(
            "fail",
            "sandbox",
            `${backend.name} unavailable — tickets fail closed. ${installHint}, or set sandbox.enabled=false`,
          );
        }
      }
    }

    // 5. endpoint / model resolution. "catalog-eligible" rather than "hosted
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
    if (!probePolicy(cfg)) {
      if (cfg.endpointProbe === "never") {
        report(
          "ok",
          "inference endpoint",
          `${cfg.model.id} — probe disabled (worker.endpointProbe=never)`,
        );
      } else {
        // Phase 3 hosted-aware preflight: resolution echo, key source, and
        // (for a confirmed catalog hit) a per-API auth check — see checkAuth.
        let info: ResolvedModelInfo | null = null;
        try {
          info = await resolveInfoFn(cfg);
          report(
            "ok",
            "model",
            `${cfg.model.id} resolves via ${pathLabel(info.path)} (${info.baseUrl})`,
          );
        } catch (e) {
          report("fail", "model", e instanceof Error ? e.message : String(e));
        }

        const provider = info?.provider ?? splitModelId(cfg.model.id).provider;
        const envVar = `${provider.toUpperCase()}_API_KEY`;
        const raw = rawApiKeyFn(configPath);
        const envRefMatch = raw !== undefined ? ENV_REF.exec(raw) : null;
        if (envRefMatch) {
          report("ok", "key source", `$${envRefMatch[1]} (resolved from the environment)`);
        } else if (raw !== undefined) {
          report("ok", "key source", "config literal (model.apiKey)");
        } else if (env[envVar]) {
          report("ok", "key source", `${envVar} present in the environment`);
        } else if (provider !== "local") {
          report(
            "warn",
            "key source",
            `no key configured — the SDK will typically look for ${envVar}-style env vars at request time`,
          );
        }

        if (info && info.path === "catalog") {
          if (cfg.model.apiKey === null) {
            report(
              "warn",
              "auth",
              "no key configured — skipping the auth check (see key source above)",
            );
          } else {
            const outcome = await checkAuth(info, cfg.model.apiKey, fetchFn);
            report(outcome.v, "auth", outcome.detail);
          }
        }
      }
    } else {
      const up = await reachableFn(cfg);
      report(
        up ? "ok" : "fail",
        "inference endpoint",
        up ? cfg.model.baseUrl : `${cfg.model.baseUrl} unreachable`,
      );

      // 6. model advertised (warn-only: not every endpoint lists models)
      if (up) {
        const ids = await fetchModelsFn(cfg.model.baseUrl, cfg.model.apiKey);
        const { modelId } = splitModelId(cfg.model.id);
        if (ids.length === 0) {
          report("warn", "model", `endpoint does not list models; cannot verify ${cfg.model.id}`);
        } else if (ids.includes(modelId) || ids.includes(cfg.model.id)) {
          report("ok", "model", cfg.model.id);
        } else {
          report(
            "warn",
            "model",
            `${cfg.model.id} not among the endpoint's ${ids.length} advertised models`,
          );
        }
      }
    }

    // 5a. planner model preflight — plannerModelId overrides cfg.model.id for
    // planning-session tickets only (runOnce.ts:317); a bad override shouldn't
    // fail doctor since ordinary Q&A/PR tickets never use it, hence warn.
    if (cfg.github.plannerModelId) {
      const plannerId = cfg.github.plannerModelId;
      try {
        const plannerInfo = await resolveInfoFn(cfg, plannerId);
        report(
          "ok",
          "planner model",
          `${plannerId} resolves via ${pathLabel(plannerInfo.path)} (${plannerInfo.baseUrl})`,
        );
      } catch (e) {
        report("warn", "planner model", e instanceof Error ? e.message : String(e));
      }
    }

    // 7. queue + worktree dirs writable
    const paths = queuePaths(cfg);
    for (const [label, dir] of [
      ["queue", dirname(paths.inbox)],
      ["worktree root", cfg.worktreeRoot],
      ["data dir", cfg.dataDir],
    ] as const) {
      report(accessOkFn(dir) ? "ok" : "fail", label, dir);
    }

    // 7a. health bind address — a non-loopback health_host exposes the
    // unauthenticated /health metrics (in-flight ticket ids, PID, tokens) to
    // the network. Warn, never fail (the operator may have deliberately opened
    // it behind a firewall/proxy).
    // No truthy `&& cfg.healthHost` guard: an empty host is non-loopback
    // (isLoopbackHost("") → false), so a value that bypassed config
    // normalization still surfaces here rather than evading the warning (#71).
    if (cfg.healthEnabled && !isLoopbackHost(cfg.healthHost)) {
      report(
        "warn",
        "health bind",
        `${cfg.healthHost} is not loopback — /health is unauthenticated and exposes ticket ids + metrics to the network; bind 127.0.0.1 unless firewalled`,
      );
    }

    // 7b. github bridge (only when enabled — disabled setups print nothing)
    if (cfg.github.enabled) {
      try {
        (deps.readTemplateFn ?? loadDispatchTemplate)();
        report("ok", "github planner template", "skills/junco-dispatch/TEMPLATE.md");
      } catch (e) {
        report(
          "fail",
          "github planner template",
          `unreadable — planning tickets will fail (${e instanceof Error ? e.message : String(e)})`,
        );
      }

      const watchedRepos = resolveWatchedRepos(cfg);
      if (watchedRepos.length === 0) {
        report("warn", "github", "enabled but no repos configured — the bridge will idle");
      }
      for (const repo of watchedRepos) {
        const origin = await execFn(cfg.gitBin, ["-C", repo.path, "remote", "get-url", "origin"]);
        const actual = origin.code === 0 ? nwoFromRemoteUrl(origin.stdout.trim()) : null;
        if (actual === null || actual.toLowerCase() !== repo.nwo.toLowerCase()) {
          report(
            "fail",
            `github repo ${repo.nwo}`,
            origin.code !== 0
              ? `${repo.path} is not a git clone (or has no origin)`
              : `origin is ${actual ?? origin.stdout.trim()}, expected ${repo.nwo}`,
          );
          continue;
        }
        const view = await execFn(cfg.ghBin, ["repo", "view", repo.nwo, "--json", "name"]);
        report(
          view.code === 0 ? "ok" : "fail",
          `github repo ${repo.nwo}`,
          view.code === 0 ? repo.path : "not reachable via gh (auth? spelling?)",
        );

        // Bot mode only: the bot account needs enough permission on this
        // watched repo to actually push branches, not just read issues.
        if (cfg.botAccount.enabled) {
          const perm = await execFn(
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
            report("ok", `bot access: ${repo.nwo}`, level.toLowerCase());
          } else if (level === "TRIAGE") {
            report(
              "warn",
              `bot access: ${repo.nwo}`,
              "triage — label edits work, branch pushes will fail — fix: junco auth grant " +
                repo.nwo,
            );
          } else if (perm.code !== 0 && perm.stderr.includes(SAML_MARKER)) {
            report(
              "warn",
              `bot access: ${repo.nwo}`,
              "bot token blocked by SAML enforcement — authorize gh for the org in the bot's browser session",
            );
          } else {
            report(
              "warn",
              `bot access: ${repo.nwo}`,
              `${level ?? "unknown"} — fix: junco auth grant ${repo.nwo}`,
            );
          }
        }
      }
      report("ok", "github watchlist", watchlistPath(cfg));
    }

    // 7c. github outbox backlog / dead-letters — informational warns, never
    // fail doctor (the daemon's throttled sweep or `junco outbox flush`
    // clears them; a stuck backlog just means GitHub side effects are late).
    const backlog = outboxDepth(cfg);
    if (backlog > 0) {
      report("warn", "outbox backlog", `${backlog} queued (junco outbox flush)`);
    }
    const stuck = deadCount(cfg);
    if (stuck > 0) {
      report("warn", "outbox dead-letters", `${stuck} in ${outboxPaths(cfg).dead}`);
    }

    // 7d. assess review backlog — informational only (normal workflow state,
    // not a health problem), independent of the github.enabled bridge gate.
    const reviews = pendingCount(cfg);
    if (reviews > 0) {
      report("ok", "assess review", `${reviews} pending (junco assess review)`);
    }

    // 7e. analyze comment-draft backlog — informational only (normal workflow
    // state, not a health problem), independent of the github.enabled gate.
    const drafts = draftCount(cfg);
    if (drafts > 0) {
      report("ok", "analyze drafts", `${drafts} pending (junco analyze review)`);
    }

    // 8. daemon (informational)
    const holder = lockHolderFn(join(dirname(configPath), "worker.lock"));
    report("ok", "daemon", holder ? `running (pid ${holder})` : "not running");
  }

  const fails = results.filter((r) => r.v === "fail").length;
  const warns = results.filter((r) => r.v === "warn").length;
  print(`\n${fails === 0 ? "ready" : "NOT ready"} — ${fails} failure(s), ${warns} warning(s)\n`);
  return fails === 0 ? 0 : 1;
}
