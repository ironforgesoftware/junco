/**
 * Apply tickets (spec 2026-08-31-apply-tickets-design.md): a ticket whose body
 * carries a `junco-patch` fence is executed by applying that `git format-patch`
 * mbox series — no agent session. Detection is body-based on purpose: the
 * GitHub issue route rebuilds frontmatter machine-side, and the marker-
 * delimited body (#329) carries the series byte-exact.
 */
import { extractPatchBody, replaceFencedBlock, PATCH_FENCE } from "./githubInbox.js";
import { wrapInFence } from "./submitAsIssue.js";

/** Refuse a series larger than this (the local route has no other cap; the
 * GitHub route is already bounded by the 64 KB issue-body limit). */
export const MAX_PATCH_BYTES = 512 * 1024;

export interface PatchSeries {
  /** The mbox text, exactly as it will be handed to `git am`. */
  raw: string;
  /** Patches in the series — one commit each. */
  count: number;
  /** Post- and pre-image paths the series touches (deduped, sorted). */
  files: string[];
}

// The real mbox separator, not any line that happens to start with "From
// <hex> ": git format-patch/am's header is `From <sha> <asctime-shaped
// date>` — a fixed, unrealistic date used precisely so it can never collide
// with a real mail Date: header. A commit message BODY line like
// "From deadbeef1234567 …" (no date) used to match the old bare-prefix
// pattern and inflate `count` (a single patch counted as two).
const MBOX_FROM =
  /^From [0-9a-f]{7,40} [A-Za-z]{3} [A-Za-z]{3} {1,2}\d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/gm;
const DIFF_GIT = /^diff --git a\/(.+?) b\/(.+)$/gm;
const SUBJECT_LINE = /^Subject:\s*(.*)$/m;
const PATCH_TAG_PREFIX = /^\[PATCH[^\]]*\]\s*/i;

/** The series carried by `body`, or null when this is not an apply ticket
 * (no fence, or a fence that is not a well-formed series). */
export function parsePatchSeries(body: string): PatchSeries | null {
  const raw = extractPatchBody(body);
  if (raw === null) return null;
  if (raw.length > MAX_PATCH_BYTES) return null;
  const froms = raw.match(MBOX_FROM);
  if (!froms || froms.length === 0) return null;
  if (!/^diff --git /m.test(raw)) return null;
  const files = new Set<string>();
  for (const m of raw.matchAll(DIFF_GIT)) {
    for (const p of [m[1], m[2]]) if (p !== "/dev/null") files.add(p);
  }
  if (files.size === 0) return null;
  return { raw, count: froms.length, files: [...files].sort() };
}

/** Paths a series must never touch: absolute, traversing, or empty. The patch's
 * own file list IS the scope declaration (spec open question 1), so this is a
 * containment check, not a policy allowlist. */
export function unsafePatchPaths(files: string[]): string[] {
  return files.filter(
    (f) => f === "" || f.startsWith("/") || f.split("/").includes("..") || f.includes("\0"),
  );
}

/** True when the series contains a binary hunk — `git am` would apply bytes no
 * reviewer read in the issue. */
export function hasBinaryHunk(raw: string): boolean {
  return /^GIT binary patch$/m.test(raw);
}

/** `body` with the LAST complete `junco-patch` fence (delimiters and content)
 * removed — used wherever an apply ticket's PROSE, not its diff, must be
 * scanned: the PR-title H1 lookup (pr.ts derivePrTitle) and the
 * no_forbidden_phrases lint rule (planLint.ts), both of which would otherwise
 * mis-fire on arbitrary diff/commit-message content. Returns `body` unchanged
 * when there is no complete fence (should not happen once parsePatchSeries
 * has already matched, but this helper makes no such assumption itself). */
export function stripPatchFence(body: string): string {
  return replaceFencedBlock(body, PATCH_FENCE, "");
}

/** One-line stand-in for the fenced mbox when composing a PR body
 * (buildPrBody, prFlow.ts): the PR's own diff already shows the patch, so
 * re-embedding the whole series — up to MAX_PATCH_BYTES — is redundant and
 * can blow GitHub's 65,536-char PR-body cap, failing `gh pr create` AFTER the
 * commits are already pushed. Keeps the ticket's own prose (Why/Verification)
 * untouched; only the fenced block itself is replaced. */
export function summarizePatchFenceForPr(body: string, series: PatchSeries): string {
  const summary = `_${series.count} patch(es) applied — see the diff below; ${series.files.length} file(s) touched._`;
  return replaceFencedBlock(body, PATCH_FENCE, summary);
}

/** The series' PR-title candidate: the FIRST mbox `Subject:` line — the
 * natural title, since it's what `git am` will actually commit — with any
 * leading `[PATCH n/m]` tag stripped. Null when the series carries no
 * Subject line (git format-patch always emits one; a hand-built series might
 * not, so this stays a fallback rather than an assumption). */
export function firstPatchSubject(series: PatchSeries): string | null {
  const m = SUBJECT_LINE.exec(series.raw);
  if (!m) return null;
  const subject = m[1].replace(PATCH_TAG_PREFIX, "").trim();
  return subject || null;
}

/**
 * Compose a full apply ticket (frontmatter + body) from a `git format-patch`
 * series — the `junco submit --patch` door (Stage 3a, spec 2026-08-31-apply-
 * tickets-design.md). Used by the CLI so hand-authoring a `junco-patch`
 * fence is no longer the only way to submit an apply ticket.
 *
 * The series is wrapped with `wrapInFence` (submitAsIssue.ts), never a
 * hand-rolled three-backtick fence: `wrapInFence` picks a fence longer than
 * any backtick run already inside the payload, so a patch that itself adds a
 * fenced markdown file still round-trips through `parsePatchSeries` /
 * `extractPatchBody` instead of truncating at the payload's own inner fence.
 *
 * `pr_title` is emitted only when `opts.title` is given; omitted, the PR flow
 * derives the title from the series' own first `Subject:` line instead (see
 * pr.ts `derivePrTitle`) — the same fallback a hand-authored apply ticket
 * gets. `## Verification` is emitted only when `opts.verify` is given —
 * without it the composed ticket still lints clean: `patch_has_verification`
 * is a WARNING, not an error (planLint.ts `checkPatchSeries`).
 *
 * `opts.why` defaults to a generic one-line placeholder when omitted. This
 * function has no notion of a source filename (only the series bytes), so a
 * more specific default — naming the actual patch file the operator passed
 * to `--patch` — is the CLI's job (src/cli.ts), built before calling here.
 */
export function composePatchTicket(opts: {
  patch: string;
  repo: string;
  id: string;
  title?: string;
  why?: string;
  verify?: string;
}): string {
  const fm: string[] = ["---", `id: ${opts.id}`, `repo: ${JSON.stringify(opts.repo)}`];
  if (opts.title) fm.push(`pr_title: ${JSON.stringify(opts.title)}`);
  fm.push("---");

  const why = opts.why?.trim() || "Apply the attached `git format-patch` series.";
  const sections = [`## Why\n\n${why}`, wrapInFence(PATCH_FENCE, opts.patch)];
  const verify = opts.verify?.trim();
  if (verify) {
    sections.push(`## Verification\n\n\`\`\`bash\n${verify}\n\`\`\``);
  }

  return fm.join("\n") + "\n\n" + sections.join("\n\n") + "\n";
}
