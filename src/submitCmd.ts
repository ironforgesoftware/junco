/**
 * `junco submit` — place a ticket into the inbox, or route it to one of the
 * three alternative destinations the flags select: a composed apply ticket
 * (`--patch`), a parked GitHub issue (`--as-issue`), a compiled plan set
 * (`--plan`), or nothing at all (`--dry-run`, which only reports).
 *
 * Extracted verbatim from cli.ts's `submit` branch (#351). The config is loaded
 * through `deps.loadCfg` rather than passed in (the replayCmd/transcriptCmd
 * shape) because every usage error above must be reported BEFORE the config is
 * read — `junco submit` with no file argument says "usage" even when
 * config.json is unparseable, and that ordering is behaviour, not an accident.
 */

import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { Config } from "./types.js";
import { queuePaths, expandHome } from "./config.js";
import { parseTicket } from "./ticket.js";
import { ticketState } from "./ticketDeps.js";
import { submitTicket } from "./dispatch.js";
import { extractPlanSetBody } from "./githubInbox.js";
import { submitAsIssue } from "./submitAsIssue.js";
import { composePatchTicket, parsePatchSeries } from "./patchTicket.js";
import { parsePlanSet, compilePlan, hashPlan } from "./planCompiler.js";
import {
  materializePlanSet,
  submitPlanSet,
  readPlanSetRecord,
  supersedeUnclaimed,
  resolveSetState,
  type PlanSetRecord,
} from "./planSets.js";
import { slugifyId } from "./slug.js";

/** The `submit` flags, already parsed by cli.ts's option table. */
export interface SubmitOptions {
  /** `--patch <file>`: compose an apply ticket from a git format-patch file. */
  patch?: string;
  /** `--plan`: compile a junco-plan fence into its child tickets. */
  plan?: boolean;
  /** `--repo <path>`: repo path stamped into the compiled/composed ticket(s). */
  repo?: string;
  /** `--title` / `--why` / `--verify`: `--patch` composition knobs. */
  title?: string;
  why?: string;
  verify?: string;
  /** `--dry-run`: report the destination and lint, write nothing. */
  dryRun?: boolean;
  /** `--as-issue`: park an unlabeled GitHub issue instead of queueing locally. */
  asIssue?: boolean;
}

export interface SubmitCmdDeps {
  /** Deferred config load — see the module docstring for why it is a thunk. */
  loadCfg: () => Config;
  /** Output function. Default: process.stdout.write. */
  printFn?: (s: string) => void;
  /** Read stdin as a UTF-8 string. Injected so tests can supply content
   * without a real stdin. */
  readStdinFn?: () => Promise<string>;
  /** `--dry-run` implementation (submitPreflight.ts). Injected so cli tests
   * never exercise the lazy import's real git/gh calls. Default: the real
   * runSubmitDryRun via lazy import. */
  runSubmitDryRunFn?: (cfg: Config, fileArg: string, content: string) => Promise<number>;
  /** submitTicket injection for `--plan`'s fan-out only (tests only —
   * production callers omit this; default the real submitTicket via
   * submitPlanSet's own default). Scoped to the plan-set door; the
   * single-ticket path is unaffected. */
  submitPlanFn?: typeof submitTicket;
}

/** Run `junco submit`. `args` is the positional slice AFTER the subcommand.
 *  Returns an exit code; never calls process.exit. */
export async function runSubmitCommand(
  args: string[],
  opts: SubmitOptions,
  deps: SubmitCmdDeps,
): Promise<number> {
  const printFn = deps.printFn ?? ((s: string) => process.stdout.write(s));

  let fileArg = args[0];
  let content: string;

  // submit --patch <file> --repo <path> [--title T] [--why W] [--verify CMD]:
  // compose an apply ticket from a `git format-patch` file (composePatchTicket,
  // patchTicket.ts) and fall through into the SAME dry-run / --as-issue / local
  // -submit branches below as an ordinary file ticket — no behavior forks. This
  // branch only ever sets `content` (+ a synthetic `fileArg` for display/idHint
  // parity with the file-sourced path); everything after it is unchanged.
  if (typeof opts.patch === "string") {
    // final-review item 13: reject usage errors up front, at exit 2, rather
    // than silently discarding a positional (fileArg was clobbered by
    // `fileArg = patchArg` below with no warning) or failing late with a
    // confusing "no junco-plan fence found in '<patchfile>'" once --plan's
    // own branch runs against a composed patch ticket that never had one.
    if (fileArg) {
      process.stderr.write(
        "junco submit: --patch and a positional file argument are mutually exclusive\n",
      );
      return 2;
    }
    if (opts.plan === true) {
      process.stderr.write("junco submit: --patch and --plan are mutually exclusive\n");
      return 2;
    }
    const patchArg = opts.patch;
    const repoFlag = opts.repo;
    if (!repoFlag) {
      process.stderr.write("Usage: junco submit --patch <file> --repo <path>\n");
      return 2;
    }
    let patchRaw: string;
    try {
      patchRaw = readFileSync(patchArg, "utf8");
    } catch (e) {
      process.stderr.write(
        `junco submit --patch: cannot read '${patchArg}': ${e instanceof Error ? e.message : String(e)}\n`,
      );
      return 1;
    }
    const titleFlag = opts.title;
    const stem = basename(patchArg).replace(/\.[^./]+$/, "");
    const today = new Date().toISOString().slice(0, 10);
    const id = `${slugifyId(titleFlag ?? stem)}-${today}`;
    const whyFlag = opts.why ?? `Apply the patch series from \`${basename(patchArg)}\`.`;
    const composed = composePatchTicket({
      patch: patchRaw,
      repo: repoFlag,
      id,
      title: titleFlag,
      why: whyFlag,
      verify: opts.verify,
    });
    if (parsePatchSeries(composed) === null) {
      process.stderr.write(
        `junco submit --patch: '${patchArg}' is not a well-formed \`git format-patch\` series ` +
          "(needs an mbox `From <sha> …` header and at least one `diff --git` hunk)\n",
      );
      return 1;
    }
    content = composed;
    fileArg = patchArg;
  } else {
    if (!fileArg) {
      process.stderr.write(`Usage: junco submit <file|->\n`);
      return 2;
    }

    try {
      if (fileArg === "-") {
        const readStdinFn =
          deps.readStdinFn ??
          (() =>
            new Promise<string>((res, reject) => {
              let buf = "";
              process.stdin.setEncoding("utf8");
              process.stdin.on("data", (chunk) => {
                buf += chunk;
              });
              process.stdin.on("end", () => res(buf));
              process.stdin.on("error", reject);
            }));
        content = await readStdinFn();
      } else {
        content = readFileSync(fileArg, "utf8");
      }
    } catch (e) {
      process.stderr.write(
        `junco submit: cannot read '${fileArg}': ${e instanceof Error ? e.message : String(e)}\n`,
      );
      return 1;
    }
  }

  const cfg = deps.loadCfg();
  const idHint = fileArg !== "-" ? basename(fileArg).replace(/\.md$/, "") : undefined;

  // submit --dry-run: routing verdict + lint, nothing written. The verdict
  // is the CLI's regardless of --as-issue; --plan is unsupported (the
  // compiler has its own validation).
  if (opts.dryRun === true) {
    if (opts.plan === true) {
      process.stderr.write("junco submit: --dry-run does not support --plan\n");
      return 2;
    }
    if (fileArg === "-") {
      process.stderr.write("Usage: junco submit --dry-run <file> (stdin not supported)\n");
      return 2;
    }
    const runDry =
      deps.runSubmitDryRunFn ??
      (async (c: Config, f: string, s: string) => {
        const { runSubmitDryRun } = await import("./submitPreflight.js");
        return runSubmitDryRun(c, f, s, { printFn: deps.printFn });
      });
    return await runDry(cfg, fileArg, content);
  }

  // submit --as-issue <file> [--plan --repo <path>]: file as a parked,
  // unlabeled GitHub issue via the bot account (src/submitAsIssue.ts)
  // instead of the local inbox/compiler — a human applying the trigger
  // label is what launches it. Both forms route here, BEFORE the local
  // --plan branch below, so `--as-issue --plan` never reaches the local
  // compiler: a bare `--as-issue` parks a single ticket, and `--as-issue
  // --plan` parks a plan-set fence (submitAsIssue.ts's opts.plan path
  // mirrors this file's own extractPlanSetBody → parsePlanSet validation).
  if (opts.asIssue === true) {
    if (fileArg === "-") {
      process.stderr.write("Usage: junco submit --as-issue <file> (stdin not supported)\n");
      return 2;
    }
    return await submitAsIssue(cfg, fileArg, content, {
      plan: opts.plan === true,
      repoFlag: opts.repo,
    });
  }

  // submit --plan <file> --repo <path>: compile an approved junco-plan
  // fence into its child tickets and fan them out. Local trust model — no
  // approval machinery here; the dispatcher is trusted exactly like every
  // locally-authored ticket today (the junco-dispatch preview gate is the
  // approval). Kept as its own branch (rather than folding into the
  // single-ticket path below) because a plan set has no single `dst` to
  // report — it prints one line per child plus a set-level summary line.
  if (opts.plan === true) {
    if (fileArg === "-") {
      process.stderr.write(
        "Usage: junco submit --plan <file> --repo <path> (stdin not supported)\n",
      );
      return 2;
    }
    if (!cfg.planSets.enabled) {
      process.stderr.write(
        "junco submit: plan sets are disabled — set planSets.enabled in config.json\n",
      );
      return 1;
    }
    const repoFlag = opts.repo;
    if (!repoFlag) {
      process.stderr.write("Usage: junco submit --plan <file> --repo <path>\n");
      return 2;
    }
    const fence = extractPlanSetBody(content);
    if (fence === null) {
      process.stderr.write(`junco submit: no junco-plan fence found in '${fileArg}'\n`);
      return 1;
    }
    const parsed = parsePlanSet(fence, { maxTasks: cfg.planSets.maxTasks });
    if (!parsed.ok) {
      for (const e of parsed.errors) process.stderr.write(`junco submit: plan error: ${e}\n`);
      return 1;
    }
    const planId = "plan-" + slugifyId(basename(fileArg).replace(/\.md$/, ""));
    const hash = hashPlan(fence);
    const repoPath = resolve(expandHome(repoFlag));
    const children = compilePlan(parsed.plan, { planId, repoPath, hash, github: null });
    // A re-run with an edited plan reuses the SAME planId (it is derived
    // from the filename), so without this the old children stay queued
    // under identical ids and submitPlanSet skips every one — the record's
    // rev would advertise a revision the queue does not contain (#298).
    // Mirrors the bridge's supersede: dispose only the UNCLAIMED ones, then
    // fan out with the SAME loose (absent | failed) policy trySupersede
    // uses — a sibling that genuinely failed on the PRIOR revision must
    // resubmit too, not just the ids this call happened to dispose (#298
    // review round 1).
    const prior = readPlanSetRecord(cfg, planId);
    let supersede = false;
    if (prior !== null && prior.hash !== hash) {
      supersede = true;
      const { disposed } = supersedeUnclaimed(cfg, prior, hash);
      if (disposed.length > 0) {
        printFn(`plan set ${planId}: superseded ${disposed.length} unclaimed ticket(s)\n`);
      }
    }
    // Fan out BEFORE materializing the fresh record — mirrors the bridge's
    // #293-critical-4 crash-idempotence ordering: a crash in this window
    // leaves the OLD record on disk, so a later run re-derives from queue
    // reality instead of wedging on a record that advertises a revision
    // the queue never actually received.
    const r = submitPlanSet(cfg, children, {
      resubmitFailed: supersede,
      submitFn: deps.submitPlanFn,
    });
    const record: PlanSetRecord = {
      v: 1,
      planId,
      hash,
      repoPath,
      github: null,
      tasks: children.map((c) => ({
        id: c.taskId,
        ticketId: c.ticketId,
        dependsOn: c.dependsOn,
      })),
      createdAt: new Date().toISOString(),
      statusCommentId: null,
      degradedPosted: false,
      lastLabel: null,
      closed: false,
    };
    materializePlanSet(cfg, record, fence);
    printFn(`plan set ${planId} (${children.length} tasks, rev ${hash})\n`);
    if (r.submitted.length === 0 && r.stranded.length === 0) {
      // Fix wave C, item 2: `submitted`/`stranded` both empty does not by
      // itself mean every child is healthy. Under the STRICT policy (this
      // run made no edit, so `supersede` is false), a child a PRIOR run's
      // supersede disposed into `failed/` (a `superseded:` marker) and then
      // failed to resubmit (see the `r.stranded.length > 0` branch below)
      // stays stuck there forever: strict-policy `submitPlanSet` only ever
      // submits an `absent` child (see its `resubmitFailed` doc comment),
      // and `junco retry --all` deliberately skips a superseded-marked
      // file too. Detect it with the SAME state resolution the
      // dashboard/reporter use — `resolveSetState`'s `superseded` task
      // state already disambiguates a disposed-and-never-resubmitted copy
      // from a genuine execution failure (see `pickFailedTicketFile`) — and
      // surface it here rather than reporting a clean no-op. Deliberately
      // NOT switching this unchanged re-run to the loose policy instead:
      // that would also resurrect any sibling that failed on its own
      // merits, which is exactly what the strict policy exists to prevent.
      const state = resolveSetState(cfg, record);
      const stranded = state.tasks.filter((t) => t.state === "superseded");
      if (stranded.length > 0) {
        for (const t of stranded) {
          process.stderr.write(
            `junco submit: plan set ${planId}: ${t.ticketId} is stranded (disposed by a prior supersede, never resubmitted) — edit '${fileArg}' and re-run to recover it\n`,
          );
        }
        return 1;
      }
      printFn(`plan set ${planId}: all ${children.length} tickets already in the queue\n`);
      return 0;
    }
    for (const s of r.submitted) printFn(`submitted: ${s.dst}\n`);
    // I3 (#298 review round 2): a per-child submit throw is CONTAINED
    // inside submitPlanSet, not propagated — before this branch it threw
    // and this command exited 1 with a fatal message. Surface the same
    // signal here instead of silently returning 0, or the operator has no
    // way to notice a stranded child short of re-reading the daemon log.
    // The record above was still materialized. Fix wave C, item 2: that
    // does NOT by itself mean a later unchanged re-run retries this child —
    // only true when nothing was disposed this run (no prior record, or
    // `supersede` false: the child really does stay `absent`, and a
    // strict-policy re-run resubmits it fine). When THIS stranding happened
    // during a supersede (`supersede` true — `supersedeUnclaimed` already
    // disposed the prior copy into `failed/` with a `superseded:` marker
    // before the fresh copy's submit threw here), the child sits in
    // `failed/`, not `absent`, and an unchanged re-run's STRICT policy will
    // never pick a `failed` child back up on its own — see the
    // `superseded`-state check above (the "already in the queue" branch)
    // for how that case is actually surfaced on a later re-run.
    if (r.stranded.length > 0) {
      for (const id of r.stranded) {
        process.stderr.write(`junco submit: plan set ${planId}: failed to submit ${id}\n`);
      }
      return 1;
    }
    return 0;
  }

  let dst: string;
  try {
    dst = submitTicket(cfg, content, { idHint });
  } catch (e) {
    process.stderr.write(`junco submit: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }

  printFn(`submitted: ${dst}\n`);

  // Dangling-edge warning (spec 2026-08-20): submit never refuses — sets may
  // arrive out of order — but a dep that exists nowhere is probably a typo.
  // Best-effort only: this must never fail an already-successful submit, so
  // any error (e.g. an unreadable queue dir) is swallowed silently — it will
  // surface loudly elsewhere (list/status/the sweep itself).
  try {
    const submitted = parseTicket(basename(dst), content);
    const missing = submitted.dependsOn.filter(
      (d) => !submitted.depsSatisfied.includes(d) && ticketState(queuePaths(cfg), d) === "absent",
    );
    if (missing.length > 0) {
      process.stderr.write(
        `junco submit: warning — depends_on references no queued or finished ticket: ${missing.join(", ")} (the ticket will wait until they exist)\n`,
      );
    }
  } catch {
    /* best-effort warning; the submit already succeeded */
  }

  return 0;
}
