/**
 * Wizard probe layer — the Welcome preflight and the Finale flight check.
 * Same seam shapes as doctor.ts (execFn / reachableFn / fetchModelsFn /
 * accessOkFn) and the same ✓/⚠/✗ verdict vocabulary, but scoped to what the
 * walkthrough shows; `junco doctor` remains the exhaustive standalone check.
 */

import { dirname } from "node:path";
import type { Config } from "../types.js";
import { queuePaths } from "../config.js";
import { endpointReachable } from "../health.js";
import { fetchModels } from "./models.js";
import { splitModelId } from "../agent/modelSetup.js";
import { selectBackend, classifyAvailability } from "../agent/sandbox/backend.js";
import { defaultExec, defaultAccessOk } from "../execProbe.js";

export interface CheckResult {
  verdict: "ok" | "warn" | "fail";
  label: string;
  detail: string;
}

export interface DetectDeps {
  execFn?: (
    cmd: string,
    args: string[],
    opts?: { env?: Record<string, string> },
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
  fetchModelsFn?: typeof fetchModels;
  reachableFn?: (cfg: Config) => Promise<boolean>;
  accessOkFn?: (dir: string) => boolean;
  nodeVersion?: string;
  platform?: NodeJS.Platform;
}

/** First name from `git config user.name`, "friend" when unset/unavailable. */
export async function greetingName(deps: DetectDeps = {}): Promise<string> {
  const execFn = deps.execFn ?? defaultExec;
  const r = await execFn("git", ["config", "user.name"]);
  const first = r.code === 0 ? r.stdout.trim().split(/\s+/)[0] : "";
  return first || "friend";
}

/** Welcome-chapter receipts: node ≥ 22.19, git present, gh present+authed. */
export async function preflightChecks(deps: DetectDeps = {}): Promise<CheckResult[]> {
  const execFn = deps.execFn ?? defaultExec;
  const out: CheckResult[] = [];

  const v = deps.nodeVersion ?? process.versions.node;
  const [maj, min] = v.split(".").map(Number);
  out.push(
    maj > 22 || (maj === 22 && min >= 19)
      ? { verdict: "ok", label: "node", detail: v }
      : { verdict: "fail", label: "node", detail: `${v} < required 22.19` },
  );

  const git = await execFn("git", ["--version"]);
  out.push(
    git.code === 0
      ? { verdict: "ok", label: "git", detail: git.stdout.trim() }
      : { verdict: "fail", label: "git", detail: "not found — PR tickets need git" },
  );

  const gh = await execFn("gh", ["--version"]);
  if (gh.code !== 0) {
    out.push({ verdict: "warn", label: "gh", detail: "not found — PRs need it, Q&A is fine" });
  } else {
    const auth = await execFn("gh", ["auth", "status"]);
    out.push(
      auth.code === 0
        ? { verdict: "ok", label: "gh", detail: "authenticated" }
        : { verdict: "warn", label: "gh", detail: "installed, not authenticated (gh auth login)" },
    );
  }
  return out;
}

/** Account-chapter probe: is a bot login present under the isolated config
 * dir? warn (not fail) when absent — the chapter offers the login step next. */
export async function botLoginCheck(
  ghBin: string,
  configDir: string,
  deps: DetectDeps = {},
): Promise<{ check: CheckResult; login: string | null }> {
  const execFn = deps.execFn ?? defaultExec;
  const r = await execFn(ghBin, ["api", "user"], { env: { GH_CONFIG_DIR: configDir } });
  if (r.code !== 0) {
    return {
      check: { verdict: "warn", label: "bot account", detail: "not logged in yet" },
      login: null,
    };
  }
  try {
    const login = (JSON.parse(r.stdout) as { login: string }).login;
    return { check: { verdict: "ok", label: "bot account", detail: `acting as ${login}` }, login };
  } catch {
    return {
      check: { verdict: "warn", label: "bot account", detail: "could not parse identity" },
      login: null,
    };
  }
}

/** Finale receipts against the freshly-written config. Mirrors the doctor
 * checks the wizard can affect; failures never block — config is on disk and
 * `junco doctor` is the standalone re-check. */
export async function flightChecks(cfg: Config, deps: DetectDeps = {}): Promise<CheckResult[]> {
  const execFn = deps.execFn ?? defaultExec;
  const reachableFn = deps.reachableFn ?? ((c: Config) => endpointReachable(c));
  const fetchModelsFn = deps.fetchModelsFn ?? fetchModels;
  const accessOkFn = deps.accessOkFn ?? defaultAccessOk;
  const out: CheckResult[] = [];

  const up = await reachableFn(cfg);
  out.push(
    up
      ? { verdict: "ok", label: "inference endpoint", detail: cfg.model.baseUrl }
      : {
          verdict: "fail",
          label: "inference endpoint",
          detail: `${cfg.model.baseUrl} unreachable — junco doctor re-checks anytime`,
        },
  );
  if (up) {
    const ids = await fetchModelsFn(cfg.model.baseUrl, cfg.model.apiKey);
    const { modelId } = splitModelId(cfg.model.id);
    if (ids.length === 0) {
      out.push({
        verdict: "warn",
        label: "model",
        detail: `endpoint lists no models; cannot verify ${cfg.model.id}`,
      });
    } else if (ids.includes(modelId) || ids.includes(cfg.model.id)) {
      out.push({ verdict: "ok", label: "model", detail: cfg.model.id });
    } else {
      out.push({
        verdict: "warn",
        label: "model",
        detail: `${cfg.model.id} not among ${ids.length} advertised`,
      });
    }
  }

  const paths = queuePaths(cfg);
  for (const [label, dir] of [
    ["queue dir", dirname(paths.inbox)],
    ["worktree dir", cfg.worktreeRoot],
    ["state dir", cfg.dataDir],
  ] as const) {
    out.push(
      accessOkFn(dir)
        ? { verdict: "ok", label, detail: dir }
        : { verdict: "fail", label, detail: `${dir} not writable` },
    );
  }

  if (cfg.sandbox.enabled) {
    const backend = selectBackend(cfg.sandbox.backend, deps.platform ?? process.platform);
    if (backend.name === "none") {
      out.push({
        verdict: "warn",
        label: "sandbox",
        detail: "backend=none — env scrub + fs jail only",
      });
    } else {
      const ok = await backend.isAvailable((c, a) => execFn(c, a).then((r) => ({ code: r.code })));
      const outcome = classifyAvailability(cfg.sandbox.backend, backend.name, ok);
      out.push(
        outcome === "ok"
          ? { verdict: "ok", label: "sandbox", detail: `${backend.name} available` }
          : outcome === "degrade"
            ? {
                verdict: "warn",
                label: "sandbox",
                detail: `${backend.name} unavailable — degrading to none`,
              }
            : {
                verdict: "fail",
                label: "sandbox",
                detail: `${backend.name} unavailable — tickets fail closed (junco doctor for the fix)`,
              },
      );
    }
  }

  // Bot mode: one receipt per watched repo — can the DAEMON's identity push?
  // Read-only (the wizard never mutates GitHub); the fix is the CLI command.
  if (cfg.botAccount.enabled) {
    for (const repo of cfg.github.repos) {
      const r = await execFn(cfg.ghBin, ["repo", "view", repo.nwo, "--json", "viewerPermission"], {
        env: { GH_CONFIG_DIR: cfg.botAccount.configDir, GH_TOKEN: "", GITHUB_TOKEN: "" },
      });
      let level: string | null = null;
      try {
        level =
          r.code === 0
            ? (JSON.parse(r.stdout) as { viewerPermission: string | null }).viewerPermission
            : null;
      } catch {
        /* inconclusive → warn below */
      }
      out.push(
        level === "ADMIN" || level === "MAINTAIN" || level === "WRITE"
          ? { verdict: "ok", label: `bot access: ${repo.nwo}`, detail: level.toLowerCase() }
          : {
              verdict: "warn",
              label: `bot access: ${repo.nwo}`,
              detail: `no push — run: junco auth grant ${repo.nwo}`,
            },
      );
    }
  }
  return out;
}
