/**
 * The repo-target preamble shared by the two read-only orchestrators
 * (assessFlow.ts, analyzeFlow.ts): resolve the ticket's `repo:` path, apply
 * the [git].allowed_repo_roots containment rail, read the origin's
 * owner/name, decide whether the checkout is a junco-managed external clone,
 * and run the read-only agent session against it. The containment
 * primitives are also what runOnce's Q&A `workdir:` resolution and repo.ts's
 * PR-flow rail use, so "is this path under one of these roots" has exactly
 * one spelling.
 */

import { statSync } from "node:fs";
import { resolve, sep } from "node:path";

import type { Config, Ticket, RunResult } from "./types.js";
import type { SpendLedger } from "./spendLedger.js";
import { expandHome } from "./config.js";
import { git, describeError } from "./git.js";
import {
  runAgent,
  makePiSessionFactory,
  type AgentSessionLike,
  type SessionOverrides,
} from "./agent/session.js";
import { runEnveloped } from "./agent/runEnvelope.js";
import { READ_ONLY_TOOLS } from "./readOnlyTools.js";
import { nwoFromRemoteUrl } from "./githubInbox.js";
import { syncExternalClone } from "./externalRepo.js";

/** True when `path` (already resolved) equals one of `roots` or lives below
 * it. `~` in a root is expanded; an empty `roots` list is NOT "anywhere" —
 * callers apply the "empty allowedRepoRoots ⇒ anywhere" rule themselves so
 * the intent stays visible at each call site. */
export function isUnderAnyRoot(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => {
    const r = resolve(expandHome(root));
    return path === r || path.startsWith(r + sep);
  });
}

/** statSync-backed directory probe that never throws (missing ⇒ false). */
export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Seams every read-only repo agent run threads through, shared verbatim by
 * AnalyzeDeps and AssessDeps. */
export interface RepoAgentDeps {
  sessionFactoryFor?: (
    cfg: Config,
    cwd: string,
    overrides?: SessionOverrides,
  ) => () => Promise<AgentSessionLike>;
  abortSignal?: AbortSignal;
  onProgress?: Parameters<typeof runAgent>[0]["onProgress"] extends infer T ? T : never;
  /** Guard-decision hook (nudge/kill) for the /health guard counters (#37). */
  onGuardDecision?: Parameters<typeof runAgent>[0]["onGuardDecision"];
  /** Per-day spend ledger (Phase-3 Task 4), peer of prFlow/runOnce's
   * RunDeps.spend: the agent run's resolved `usage.costUsd` is recorded here
   * immediately after it completes, mirroring the Q&A/PR-flow pattern.
   * Optional: absent (CLI one-shot, tests) is a no-op. */
  spend?: Pick<SpendLedger, "recordUsd">;
}

export interface RepoTarget {
  /** Absolute, `~`-expanded checkout path. */
  repoPath: string;
  /** owner/name parsed from the origin remote. */
  nwo: string;
  /** Lives under cfg.github.externalReposRoot — a junco-managed clone, never
   * the operator's own checkout. Gates the freshness sync and the parked
   * record's `external` flag. */
  external: boolean;
}

/**
 * Phases 1–2b of the read-only flows. `label` prefixes every error
 * ("assess: …" / "analyze: …"); the returned error is the phase message the
 * caller finalizes the ticket to failed/ with. Containment mirrors
 * resolveQaCwd's semantics (runOnce.ts) EXACTLY — including the "empty
 * allowedRepoRoots ⇒ anywhere" rule — but a violation is a phase error here
 * rather than a fall-back to the default cwd.
 */
export async function resolveRepoTarget(
  cfg: Config,
  repoRaw: unknown,
  label: string,
  gitFn: typeof git,
): Promise<{ ok: true; target: RepoTarget } | { ok: false; error: string }> {
  if (typeof repoRaw !== "string") return { ok: false, error: `${label}: ticket has no repo path` };
  const repoPath = resolve(expandHome(repoRaw));
  if (!isDirectory(repoPath)) {
    return { ok: false, error: `${label}: repo path is not a directory: ${repoPath}` };
  }
  if (cfg.allowedRepoRoots.length > 0 && !isUnderAnyRoot(repoPath, cfg.allowedRepoRoots)) {
    return { ok: false, error: `${label}: repo path not permitted: ${repoPath}` };
  }

  // Without a parseable GitHub origin there is nothing to file or draft
  // against, so this is fatal.
  let nwo: string;
  try {
    const remote = await gitFn(cfg, ["remote", "get-url", "origin"], { cwd: repoPath });
    const parsed = nwoFromRemoteUrl(remote.stdout.trim());
    if (!parsed) {
      return { ok: false, error: `${label}: origin remote is not a parseable GitHub repo` };
    }
    nwo = parsed;
  } catch (e) {
    return { ok: false, error: `${label}: could not read origin remote — ${describeError(e)}` };
  }

  // External detection is path-based: a managed clone lives under
  // cfg.github.externalReposRoot; the operator's OWNED checkouts never do.
  const external = isUnderAnyRoot(repoPath, [cfg.github.externalReposRoot]);
  return { ok: true, target: { repoPath, nwo, external } };
}

/**
 * Phase 2c: freshness sync — EXTERNAL clones ONLY. Junco owns these clones,
 * so a fetch + hard-reset to upstream's default branch is safe and makes the
 * run reflect live upstream, not the provisioned snapshot. NEVER run on an
 * owned checkout (it would blow away the operator's tree). A failure is a
 * recorded warning, not fatal — the run proceeds on the current tree.
 */
export async function syncIfExternal(
  cfg: Config,
  target: RepoTarget,
  gitFn: typeof git,
  warnings: string[],
): Promise<void> {
  if (!target.external) return;
  try {
    await syncExternalClone(cfg, target.repoPath, { gitFn });
  } catch (e) {
    warnings.push(`could not sync external clone to upstream default: ${describeError(e)}`);
  }
}

/**
 * The read-only agent run, mirroring the Q&A agent block in runOnce.ts's
 * `executeClaimed`: read-only tool default (a ticket's own `tools:` wins),
 * cwd = repoPath, supervisor and transcript wired by the envelope, timeout
 * from the ticket, abortSignal/onProgress threaded. `readOnly` (#346):
 * repoPath is the operator's live checkout, so the sandbox keeps scratch as
 * the only writable root whatever `tools:` the ticket names. Spend is
 * recorded immediately by the envelope, BEFORE any requeue/finalize branching
 * in the caller — the dollars were spent regardless of what the ticket does
 * next. No-op when deps.spend is absent or costUsd is 0/non-finite.
 */
export async function runReadOnlyRepoAgent(
  cfg: Config,
  ticket: Ticket,
  flow: "assess" | "analyze",
  repoPath: string,
  deps: RepoAgentDeps,
): Promise<RunResult> {
  const tools = ticket.tools ?? cfg.tools.filter((t) => READ_ONLY_TOOLS.has(t));
  const flowCfg: Config = { ...cfg, tools };
  const factory = (deps.sessionFactoryFor ?? makePiSessionFactory)(flowCfg, repoPath, {
    readOnly: true,
  });
  return runEnveloped(
    flowCfg,
    {
      ticketId: ticket.id,
      flow,
      body: ticket.body,
      cwd: repoPath,
      timeoutMs: ticket.timeoutSeconds * 1000,
    },
    {
      createSession: factory,
      abortSignal: deps.abortSignal,
      onProgress: deps.onProgress,
      onGuardDecision: deps.onGuardDecision,
      spend: deps.spend,
    },
  );
}
