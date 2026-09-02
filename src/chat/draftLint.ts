/**
 * The ONE per-file lint+route pass for a chat draft (spec 2026-09-01 §6.2),
 * shared by parking (chat/chatDrafts.ts) and the review surface's re-lint
 * (tui/chatClientMethods.ts). Ruling R26: the two paths run the SAME code, so
 * a draft can never park as failing and re-lint as passing (or the reverse) —
 * which is what made a lint-failed plan set a dead end (`s` refuses, `e`
 * re-lints nothing, only `D` exits).
 *
 * The kinds, per §6.2:
 * - ticket / amend / apply / ticketSet → `lintTicket` + `decideRoute`
 * - planSet → the compiler's own `parsePlanSet` errors, no route
 * - audit / investigate → a CLI verb, not a ticket: neither
 *
 * Parking layers its fence-extraction problems on top of what this returns;
 * it does not fold them in here, because relint has no fence to re-extract.
 */
import type { Config } from "../types.js";
import type { DraftKind } from "../agent/transcriptSchema.js";
import { parseTicket } from "../ticket.js";
import { lintTicket, type LintViolation } from "../planLint.js";
import { decideRoute, type PreflightDeps, type RouteDecision } from "../submitPreflight.js";
import { parsePlanSet } from "../planCompiler.js";
import { extractPlanSetBody } from "../githubInbox.js";

export interface DraftLintDeps {
  lintFn?: typeof lintTicket;
  routeFn?: typeof decideRoute;
  /** decideRoute's own seams (git/fs) — the real one probes the watchlist by
   *  the repo PATH's origin remote when github + bot are on (R17). */
  routeDeps?: PreflightDeps;
}

export interface DraftLintResult {
  lint: LintViolation[];
  route: RouteDecision | null;
}

/**
 * One draft file's verdict. `content` is what is (or is about to be) on disk,
 * byte-identical to what the CLI will read — including a plan set's fence,
 * which is unwrapped here exactly the way `junco submit --plan` unwraps it
 * (`extractPlanSetBody`), so the dashboard's verdict and the CLI's cannot
 * disagree about the same bytes.
 */
export async function lintDraftFile(
  cfg: Config,
  kind: DraftKind,
  file: { name: string; content: string },
  ctx: { cwd: string; nwo: string | null },
  deps: DraftLintDeps = {},
): Promise<DraftLintResult> {
  if (kind === "audit" || kind === "investigate") return { lint: [], route: null };
  if (kind === "planSet") {
    const fence = extractPlanSetBody(file.content);
    if (fence === null) {
      // submitCmd refuses the same file with "no junco-plan fence found";
      // reachable from an edit that deleted (or broke) the fence.
      return {
        lint: [{ rule: "plan_set", severity: "error", message: "no junco-plan fence found" }],
        route: null,
      };
    }
    const parsed = parsePlanSet(fence, { maxTasks: cfg.planSets.maxTasks });
    return {
      lint: parsed.ok
        ? []
        : parsed.errors.map((message) => ({
            rule: "plan_set",
            severity: "error" as const,
            message,
          })),
      route: null,
    };
  }
  const t = parseTicket(file.name, file.content, cfg.defaultTimeoutMinutes);
  const lint = (deps.lintFn ?? lintTicket)(t.body, t.frontmatter, {
    repoPath: ctx.cwd,
    repoNwo: ctx.nwo,
    // No network from a chat turn or the dashboard: the label check shells out to gh.
    checkLabels: false,
  }).violations;
  const route = await (deps.routeFn ?? decideRoute)(cfg, t.frontmatter, deps.routeDeps);
  return { lint, route };
}

/** A draft is submittable only while no file carries an error violation. */
export function draftLintFailed(files: { lint: LintViolation[] }[]): boolean {
  return files.some((f) => f.lint.some((v) => v.severity === "error"));
}
