# Assess review: filed accounting + explicit batch lifecycle

**Date:** 2026-07-19
**Status:** Approved
**Problem:** After `junco assess`, filing a selection from a parked review batch archives the
whole batch (`assessFiling.ts` calls `removePending` when `failed === 0`) and the TUI
optimistically drops the row. A partial filing discards the un-filed remainder from view, and
nothing records which findings were filed or when.

**Decision (user-confirmed):**

- Batches leave the review list on **explicit discard only** — no auto-archive after filing, no
  grace-period sweep.
- Inside an opened batch, filed findings stay **selectable but default-unchecked**; re-filing is
  safe because GitHub marker dedup is authoritative.

## Storage (`assessReview.ts`)

`PendingAssess` gains one optional field (optional like `issue`, so existing parked batches load
unchanged — it is NOT added to the store's required-fields list):

```ts
filed?: Record<string /* fingerprint */, FiledRecord>;

interface FiledRecord {
  at: string; // ISO, stamped at filing time
  how: "created" | "queued" | "deduped";
  url?: string; // present when gh returned the issue URL (how: "created")
}
```

`removePending` is **renamed** `discardPending(cfg, id)` — the explicit end-of-life (archive to
`filed/`, ENOENT-safe double-discard). Its only importers are `assessFiling.ts` (which loses
the call entirely) and `tests/assessReview.test.ts` (import updated), so no alias is kept.

## Filing core (`assessFiling.ts`)

`fileFindings` changes:

1. Every finding that lands as created / queued-offline / deduped gets a `FiledRecord` stamped
   with the pass's timestamp (injectable `nowFn` for tests). Created records carry the URL when
   `gh issue create` printed one. Failed findings stay unstamped.
2. The `result.failed === 0 → removePending` auto-archive is **deleted**. Instead the batch —
   with its merged `filed` map — is rewritten in place via `writePending` (atomic tmp+rename).
   The rewrite happens whenever at least one finding was stamped, including partial-failure
   passes: stamps for the successful subset must survive even when `failed > 0`.
3. `FileResult` gains `batch: PendingAssess` — the updated batch, so callers (TUI) can swap it
   into state without a re-read race. CLI output line is unchanged.

The empty-selection early return keeps its current no-archive behavior (now trivially: nothing
is stamped, nothing rewritten).

## Audit re-run (`assessFlow.ts`)

Phase 7 already excludes GitHub-filed findings from a re-parked batch via `fetchFindingMarkers`
dedup, so after an ONLINE re-run the overwritten batch contains only unfiled findings and the
old accounting is legitimately gone (those rows no longer exist). The merge-forward matters for
the OFFLINE path, where dedup degrades to an empty marker set and previously-filed findings
re-park: before `writePending`, read the existing pending batch (`readPending`) and carry
forward `filed` records for fingerprints present in the new findings list. Corrupt/missing old
batch → no merge (never throw).

## TUI

- **`ghClient.ts`:** `fileReview` returns the enriched `FileResult` (with `batch`). New
  `discardReview(id): Promise<Result<null>>` mirroring `discardCommentDraft`, backed by
  `discardPending` (injectable `discardPendingFn`).
- **`App.tsx` file handler (`f`):** on success, swap the updated batch into `state.batches`
  (row **stays**), keep the checklist open, and recompute
  `checked = old checked ∩ unfiled(updated batch)` — failed findings stay checked for retry,
  filed ones drop out. Toast unchanged.
- **`App.tsx` open handler (enter):** pre-check only **unfiled** findings (today: all).
- **`App.tsx` discard (`x`, opened-batch mode):** `client.discardReview(id)` → optimistic
  removal + cursor clamp (same pattern as draft discard; no confirm, matching that convention).
- **`ReviewView.tsx`:** gains a `now: Date` prop (wired like `IssueList`'s). List rows add
  `createdAt` age (`relTime`) and, when any, a `filed n/m` accent chip. Opened-batch rows:
  unfiled → checkbox as today; filed → dim `✓ created 2h ago` / `✓ queued …` / `✓ dup …` in
  place of the checkbox (still clickable/checkable — a checked filed row shows `[x]` again so
  the selection is visible). Batch header shows `filed n/m` beside the selected count.
- **Hints:** opened-batch footer/help gain `x discard`; `HelpModal.tsx` review section updated.

## CLI (`assessCmd.ts`, `cli.ts`)

- `junco assess review` (list): append `filed n/m` and keep `createdAt`.
- `junco assess review <id>` (detail): filed findings print `[filed <how> <at>]` after the
  title; hint block adds the discard usage.
- New `junco assess discard <id>` → `runAssessDiscardCommand`: discard the batch (exit 0),
  "already gone" → exit 0 with a note (ENOENT-safe), missing arg → usage + exit 2. Wired in
  `cli.ts` beside `review`/`file`, help text updated.

## Error handling

- Filing failures: those findings stay unstamped, batch stays parked (today's retry semantics
  minus the archive), warnings unchanged.
- Discard of an already-archived batch: no-op success (both surfaces).
- Store reads never throw: `filed` absent → treated as `{}` everywhere.

## Consequences

- `pendingCount` (status/doctor/TUI badge) now includes fully-filed batches until discarded —
  accepted consequence of explicit-discard-only.
- `review/assess/filed/` archive naming is unchanged (it now receives batches via discard
  rather than via auto-archive).

## Testing

- `assessFiling`: stamps written per outcome (created/queued/deduped with timestamps; URL on
  created), no auto-archive, rewrite persists on partial failure, empty selection untouched.
- `assessReview`/store: roundtrip with `filed`; legacy batch without `filed` still loads.
- `assessFlow`: offline re-park merges filed records forward; online re-park drops filed rows
  (existing dedup) without error.
- `App.tsx`: file keeps the row + updates accounting, checked-set recompute, enter pre-checks
  unfiled only, `x` discards with optimistic removal. Loop-until-condition assertions, never
  one fixed tick (CLAUDE.md).
- CLI: review list/detail rendering, discard verb (found/already-gone/usage).
- Docs: ARCHITECTURE.md rows for `assessReview.ts`/`assessFiling.ts`/`assessCmd.ts`,
  CHANGELOG Unreleased entry.
- Full gate (`lint`, `format:check`, `typecheck`, `build`, `test`) green before done.

## Out of scope

- Per-finding discard ("won't file") state.
- Parking GitHub-deduped findings at audit time (phase 7 exclusion stays).
- A filed-history browser over `review/assess/filed/`.
- Comment-draft (`junco analyze`) lifecycle — unchanged.
