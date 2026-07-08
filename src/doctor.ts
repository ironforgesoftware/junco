/**
 * `junco doctor` — preflight every external dependency a ticket will need, so
 * failures surface here instead of after a 30-minute agent run.
 * ✓ pass · ⚠ warning (degraded but workable) · ✗ failure (exit 1).
 */

import { execFile } from "node:child_process";
import { accessSync, constants, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { Config } from "./types.js";
import { loadConfig, queuePaths } from "./config.js";
import { endpointReachable } from "./health.js";
import { fetchModels } from "./wizard/models.js";
import { splitModelId } from "./agent/modelSetup.js";
import { readLockHolder } from "./lock.js";
import { nwoFromRemoteUrl } from "./githubInbox.js";
import { loadDispatchTemplate } from "./planPrompt.js";
import { resolveWatchedRepos, watchlistPath } from "./watchlist.js";
import { outboxDepth, deadCount, outboxPaths } from "./githubOutbox.js";

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

function defaultExec(
  cmd: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 10_000 }, (err, stdout, stderr) => {
      const code = err ? ((err as NodeJS.ErrnoException).code === "ENOENT" ? 127 : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

function defaultAccessOk(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true });
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
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

    // 5. endpoint
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

    // 7. queue + worktree dirs writable
    const paths = queuePaths(cfg);
    for (const [label, dir] of [
      ["queue", dirname(paths.inbox)],
      ["worktree root", cfg.worktreeRoot],
      ["state dir", cfg.stateDir],
    ] as const) {
      report(accessOkFn(dir) ? "ok" : "fail", label, dir);
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

    // 8. daemon (informational)
    const holder = lockHolderFn(join(dirname(configPath), "worker.lock"));
    report("ok", "daemon", holder ? `running (pid ${holder})` : "not running");
  }

  const fails = results.filter((r) => r.v === "fail").length;
  const warns = results.filter((r) => r.v === "warn").length;
  print(`\n${fails === 0 ? "ready" : "NOT ready"} — ${fails} failure(s), ${warns} warning(s)\n`);
  return fails === 0 ? 0 : 1;
}
