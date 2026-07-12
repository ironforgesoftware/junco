/**
 * `junco doctor` — preflight every external dependency a ticket will need, so
 * failures surface here instead of after a 30-minute agent run.
 * ✓ pass · ⚠ warning (degraded but workable) · ✗ failure (exit 1).
 */

import { join, dirname } from "node:path";
import type { Config } from "./types.js";
import { loadConfig, queuePaths, isLoopbackHost } from "./config.js";
import { endpointReachable } from "./health.js";
import { fetchModels } from "./wizard/models.js";
import { splitModelId, shouldProbeEndpoint } from "./agent/modelSetup.js";
import { readLockHolder } from "./lock.js";
import { nwoFromRemoteUrl } from "./githubInbox.js";
import { selectBackend, classifyAvailability } from "./agent/sandbox/backend.js";
import { loadDispatchTemplate } from "./planPrompt.js";
import { resolveWatchedRepos, watchlistPath } from "./watchlist.js";
import { outboxDepth, deadCount, outboxPaths } from "./githubOutbox.js";
import { pendingCount } from "./assessReview.js";
import { draftCount } from "./commentReview.js";
import { defaultExec, defaultAccessOk } from "./execProbe.js";

export interface DoctorDeps {
  loadConfigFn?: (p: string) => Config;
  execFn?: (
    cmd: string,
    args: string[],
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
  reachableFn?: (cfg: Config) => Promise<boolean>;
  fetchModelsFn?: typeof fetchModels;
  accessOkFn?: (dir: string) => boolean;
  lockHolderFn?: (lockPath: string) => number | null;
  readTemplateFn?: () => string;
  printFn?: (s: string) => void;
}

type Verdict = "ok" | "warn" | "fail";

export async function runDoctor(configPath: string, deps: DoctorDeps = {}): Promise<number> {
  const print = deps.printFn ?? ((s: string) => process.stdout.write(s));
  const execFn = deps.execFn ?? defaultExec;
  const reachableFn = deps.reachableFn ?? ((c: Config) => endpointReachable(c));
  const fetchModelsFn = deps.fetchModelsFn ?? fetchModels;
  const accessOkFn = deps.accessOkFn ?? defaultAccessOk;
  const lockHolderFn = deps.lockHolderFn ?? readLockHolder;

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

    // 5. endpoint (hosted catalog models are not probed — Phase 2 adds the
    // provider gate; Phase 3 adds per-API auth checks). "catalog-eligible"
    // rather than "hosted provider": a provider-prefixed id that ISN'T in the
    // builtin catalog still lands here (shouldProbeEndpoint only checks
    // eligibility, not an actual catalog hit) and the runtime cascade
    // (resolveModelViaRegistries) falls through to inline resolution at first
    // session — "hosted provider" would be actively wrong for that case.
    if (!shouldProbeEndpoint(cfg.model)) {
      report(
        "ok",
        "inference endpoint",
        `${cfg.model.id} — catalog-eligible; probe skipped (resolution confirmed at first session)`,
      );
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

    // 7. queue + worktree dirs writable
    const paths = queuePaths(cfg);
    for (const [label, dir] of [
      ["queue", dirname(paths.inbox)],
      ["worktree root", cfg.worktreeRoot],
      ["state dir", cfg.stateDir],
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
