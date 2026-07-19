/**
 * Least-privilege filing core for `junco assess`. Files a human-confirmed
 * SELECTION from a parked review batch (assessReview.ts) as GitHub issues,
 * through the outbox seam (githubOutbox.ts) so offline runs converge. Labels are
 * owned-only best-effort DATA (external batches file label-free); dedup is
 * author-scoped + marker-based, identical for owned and unowned. This module is
 * the seam SP-2 (comment) / SP-3 (issue-context) build on.
 */
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Config } from "./types.js";
import { gh, GitOpError, isNetworkError } from "./git.js";
import {
  tryOrEnqueue,
  fetchFindingMarkers,
  ensureFindingLabels,
  isOffline,
  type OutboxOp,
} from "./githubOutbox.js";
import { buildIssueTitle, buildIssueBody, findingLabels, type Finding } from "./findings.js";
import { discardPending, type PendingAssess } from "./assessReview.js";
import { log } from "./logging.js";

const GH_TIMEOUT = 60_000;

export interface FileFindingsDeps {
  ghFn?: typeof gh;
}
export interface FileResult {
  created: number;
  queuedOffline: number;
  deduped: number;
  failed: number;
  urls: string[];
  warnings: string[];
}

function describeError(e: unknown): string {
  if (e instanceof GitOpError) return e.stderr || e.message;
  return e instanceof Error ? e.message : String(e);
}

/** Create ONE issue live; return the URL gh prints, or null. Moved verbatim from
 * assessFlow.ts — the body goes to a temp file, labels flatten into --label flags. */
export async function createIssueLive(
  cfg: Config,
  nwo: string,
  title: string,
  bodyText: string,
  labels: string[],
  ghFn: typeof gh,
): Promise<string | null> {
  const dir = mkdtempSync(join(tmpdir(), "junco-assess-"));
  const file = join(dir, "issue.md");
  writeFileSync(file, bodyText, "utf8");
  try {
    const out = await ghFn(
      cfg,
      [
        "issue",
        "create",
        "--repo",
        nwo,
        "--title",
        title,
        "--body-file",
        file,
        ...labels.flatMap((l) => ["--label", l]),
      ],
      { timeoutMs: GH_TIMEOUT },
    );
    return (
      out.stdout
        .trim()
        .split("\n")
        .reverse()
        .find((l) => l.startsWith("https://")) ?? null
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** File the SELECTED findings from a parked batch, then archive the batch.
 * Owned → labelled (best-effort ensure; on failure, file label-free rather than
 * fail the issue). External → label-free by construction. Author-scoped dedup
 * skips anything already filed. Offline → durable outbox op. */
export async function fileFindings(
  cfg: Config,
  batch: PendingAssess,
  selected: Set<string>,
  deps: FileFindingsDeps = {},
): Promise<FileResult> {
  const ghFn = deps.ghFn ?? gh;
  const result: FileResult = {
    created: 0,
    queuedOffline: 0,
    deduped: 0,
    failed: 0,
    urls: [],
    warnings: [],
  };
  const toFile = batch.findings.filter((f) => selected.has(f.fingerprint));
  if (toFile.length === 0) {
    // Nothing selected → nothing to file. Do NOT archive here: archiving only
    // happens after an actual (non-empty) filing pass, so an empty selection
    // (e.g. an unknown --only fingerprint that slipped past the CLI guard) can
    // never silently discard the parked batch.
    return result;
  }

  // Authoritative dedup: network failure degrades to empty (converges via the
  // outbox flush re-check); any other error is fatal for this file attempt.
  let filed: Set<string>;
  try {
    filed = await fetchFindingMarkers(cfg, batch.nwo, ghFn);
  } catch (e) {
    if (e instanceof GitOpError && isNetworkError(e.stderr)) {
      result.warnings.push(`GitHub dedup unavailable (offline): ${describeError(e)}`);
      filed = new Set();
    } else {
      throw e instanceof GitOpError ? new GitOpError(describeError(e), e.stderr, e.returncode) : e;
    }
  }

  // Best-effort labels (owned only). If ensure fails, drop to label-free so the
  // issues still land — the marker+title carry the same information.
  let labelFree = batch.external;
  if (!batch.external) {
    const union = new Set<string>();
    for (const f of toFile) {
      for (const l of findingLabels(f, {
        autoPlan: batch.autoPlan,
        triggerLabel: cfg.github.triggerLabel,
      })) {
        union.add(l);
      }
    }
    if (union.size > 0) {
      try {
        await ensureFindingLabels(cfg, batch.nwo, [...union], ghFn);
      } catch (e) {
        // Offline: KEEP the labels (do not drop to label-free, do not warn) so
        // the enqueued issue-create op carries them — the flush's executor will
        // create the labels when the network returns. Only a real
        // permission/other error means the labels can't be created at all, so
        // that path files label-free and warns.
        if (!isOffline(e)) {
          labelFree = true;
          result.warnings.push(`could not ensure labels — filing label-free: ${describeError(e)}`);
        }
      }
    }
  }
  const labelsFor = (f: Finding): string[] =>
    labelFree
      ? []
      : findingLabels(f, { autoPlan: batch.autoPlan, triggerLabel: cfg.github.triggerLabel });

  for (const f of toFile) {
    if (filed.has(f.fingerprint)) {
      result.deduped++;
      continue;
    }
    const title = buildIssueTitle(f);
    const bodyText = buildIssueBody(
      f,
      batch.issue !== undefined ? { nwo: batch.nwo, issue: batch.issue } : undefined,
    );
    const labels = labelsFor(f);
    const op: OutboxOp = {
      kind: "issue-create",
      nwo: batch.nwo,
      title,
      bodyText,
      labels,
      fingerprint: f.fingerprint,
    };
    let url: string | null = null;
    try {
      const outcome = await tryOrEnqueue(cfg, "assess", op, async () => {
        url = await createIssueLive(cfg, batch.nwo, title, bodyText, labels, ghFn);
      });
      if (outcome === "sent") {
        result.created++;
        if (url) result.urls.push(url);
      } else {
        result.queuedOffline++;
      }
    } catch (e) {
      result.failed++;
      result.warnings.push(`could not file "${title}": ${describeError(e)}`);
    }
  }
  log.info("assess findings filed", {
    id: batch.id,
    nwo: batch.nwo,
    created: result.created,
    queued: result.queuedOffline,
    deduped: result.deduped,
    failed: result.failed,
  });
  // Archive only when nothing failed. A non-offline filing error (issues
  // disabled, 403/422 — tryOrEnqueue rethrows it, the loop swallows it into
  // result.failed) would otherwise sail past this unconditional archive and
  // drop the findings out of `junco assess review` with no un-archive path. On
  // any failure the batch stays parked for retry; the author-scoped dedup skips
  // the already-filed/deduped subset on the next pass. Offline enqueues count as
  // queuedOffline (success), so a fully-queued batch still archives. (#137)
  if (result.failed === 0) {
    discardPending(cfg, batch.id);
  }
  return result;
}
