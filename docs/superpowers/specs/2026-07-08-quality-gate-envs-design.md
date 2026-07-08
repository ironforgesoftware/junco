# Quality Gate: per-environment sub-workflows — Design

**Goal:** "Quality Gate" reads as a single CI entry whose per-environment sub-processes
(the full gate for each os × node environment) are grouped under it, instead of today's
seven flat sibling jobs.

**Approach (chosen over a names-only rename and a fold-smoke-into-one-mega-job variant):**
a reusable `workflow_call` sub-workflow called once per environment by a matrix job.
GitHub's run graph then groups each environment's sub-jobs under one expandable node,
and check names become hierarchical (`quality gate (<env>) / checks`). The PR checks
list itself cannot literally nest — the single *required* entry remains the aggregate
`quality-gate` check, unchanged.

## Files

**`.github/workflows/quality-gate.yml`** (rewrite) — thin orchestrator. Keeps the
workflow name, triggers (push main / pull_request / workflow_dispatch), top-level
`permissions: contents: read`, and the per-SHA concurrency strategy. Two jobs:

- `env_gate` — display name `quality gate (${{ matrix.os }}, node ${{ matrix.node }})`,
  `fail-fast: false` matrix over ubuntu-latest/macos-latest × 22.19.0/24,
  `uses: ./.github/workflows/env-gate.yml` with inputs `os`, `node`, and
  `smoke: ${{ matrix.node == '22.19.0' }}` (floor-only smoke, per decision).
  No `timeout-minutes` here — GitHub disallows it on `uses:` caller jobs; the called
  workflow's jobs carry the timeouts.
- `gate` — the unchanged aggregate: display name `quality-gate`, `needs: [env_gate]`,
  `if: always()`, fails when any needed result is failure/cancelled/skipped.

**`.github/workflows/env-gate.yml`** (new) — `on: workflow_call`; inputs `os` (string,
required), `node` (string, required), `smoke` (boolean, default false). Two jobs, both
`runs-on: ${{ inputs.os }}`, both using the SHA-pinned checkout/setup-node with
`persist-credentials: false`:

- `checks` (timeout 15) — today's exact sequence: npm ci → lint → format:check →
  typecheck → git config (temp-repo harness) → build → test.
- `smoke` (timeout 10, `if: inputs.smoke`) — npm ci → build → `bash scripts/package-smoke.sh`.

## Semantics preserved

- A skipped inner `smoke` job (node-24 legs) does not fail the called workflow, so the
  caller leg succeeds; the aggregate's failure/cancelled/skipped guard applies to the
  caller legs (`needs.env_gate.result`) — gate behavior is identical to today.
- Required check context stays `quality-gate`; the main ruleset needs no edit.
- README badge is file-based (`quality-gate.yml`) — unchanged.
- The called workflow is referenced by local path (same-commit), so PR runs exercise the
  PR's own version of both files; no SHA pin applies to it.

## Trade-off accepted

The six old check contexts (`test (…)`, `package smoke (…)`) are replaced by nested
names (`quality gate (…) / checks`, `quality gate (…) / package smoke`). Nothing
references the old names.

## Verification

actionlint (validates workflow_call wiring statically) + zizmor (must stay 0 high /
0 medium beyond the accepted `adhoc-packages` low, which lives in publish.yml) + YAML
parse; the live proof is the PR's own gate run, which the ruleset now requires green
before merge.

## Revision (same day): one check run per OS

After seeing the merge-box checks list (9 quality-gate entries incl. 2 skipped smoke
rows), the maintainer chose the minimal-entries variant: **one job per OS** (3 check
runs total: `quality gate (ubuntu-latest)`, `quality gate (macos-latest)`, and the
required `quality-gate` aggregate). GitHub creates one check run per job — including
skipped and reusable-workflow inner jobs — so this is the floor while covering both
OSes in parallel; a literal single check is impossible cross-OS.

Consequences:
- `env-gate.yml` is deleted — with one inner job per environment the reusable
  workflow added a layer with no grouping benefit.
- Each OS job runs sequentially: full gate on the engines floor (node 22.19.0,
  including the packaged-CLI smoke test), then re-install/build/test on node 24.
  The static checks (lint/format/typecheck) run once per OS — they are
  node-version-independent.
- Job timeout 25 (one job now does both node versions); aggregate unchanged.
