# Quality Gate Per-Environment Sub-Workflows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure CI so "Quality Gate" is one orchestrator whose per-environment sub-processes (full gate per os × node) are grouped under matrix caller jobs via a reusable `workflow_call` sub-workflow.

**Architecture:** `quality-gate.yml` keeps its triggers/permissions/concurrency and shrinks to two jobs: `env_gate` (matrix caller, `uses: ./.github/workflows/env-gate.yml`, floor-only smoke via a boolean input) and the unchanged `gate` aggregate. New `env-gate.yml` hosts the per-environment jobs `checks` and `smoke`. Spec: `docs/superpowers/specs/2026-07-08-quality-gate-envs-design.md`.

**Tech Stack:** GitHub Actions reusable workflows (`workflow_call`), actionlint, zizmor.

## Global Constraints

- Branch: `feat/quality-gate-envs` off `origin/main`, in this worktree (`/Users/alxedelweiss/junco/.claude/worktrees/ci_cd`).
- Conventional commits; **no AI attribution** (verify `git log --format='%B' -1` after each commit; amend if a trailer appears).
- Actions SHA-pinned with comments: `actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6.0.3`, `actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6.4.0`.
- The aggregate check context must remain exactly `quality-gate` (the main ruleset requires it; no ruleset edit).
- No `timeout-minutes` on the `uses:` caller job (GitHub rejects it there); timeouts live in the called workflow's jobs (checks 15, smoke 10).
- `main` requires PRs + green `quality-gate` — the change lands via PR only.

---

### Task 1: Create `env-gate.yml`, rewrite `quality-gate.yml`, validate, commit

**Files:**
- Create: `.github/workflows/env-gate.yml`
- Rewrite: `.github/workflows/quality-gate.yml`

**Interfaces:**
- Produces: reusable workflow `env-gate.yml` with `workflow_call` inputs `os: string (required)`, `node: string (required)`, `smoke: boolean (default false)`; caller job id `env_gate`; aggregate job display name `quality-gate` (consumed by the existing ruleset).

- [ ] **Step 1: Create `.github/workflows/env-gate.yml`** with exactly:

```yaml
name: Environment Gate

# Reusable per-environment quality gate — called once per (os, node) leg by
# quality-gate.yml via a local-path reference, so a PR run exercises the PR's
# own version of this file. Not directly triggerable.

on:
  workflow_call:
    inputs:
      os:
        description: Runner image for this environment
        required: true
        type: string
      node:
        description: Node version for this environment
        required: true
        type: string
      smoke:
        description: Also run the packaged-CLI smoke test (node-floor legs)
        required: false
        default: false
        type: boolean

permissions:
  contents: read

jobs:
  checks:
    name: checks
    runs-on: ${{ inputs.os }}
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6.0.3
        with:
          persist-credentials: false # no job here pushes; don't leave a token in .git/config
      - uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6.4.0
        with:
          node-version: ${{ inputs.node }}
          cache: npm
      - run: npm ci
      - run: npm run lint
      - run: npm run format:check
      - run: npm run typecheck
      # repo/pr/worktree tests create real commits in temp repos
      - run: |
          git config --global user.email "ci@example.invalid"
          git config --global user.name "junco-ci"
      - run: npm run build
      - run: npm test

  smoke:
    name: package smoke
    if: inputs.smoke
    runs-on: ${{ inputs.os }}
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6.0.3
        with:
          persist-credentials: false # no job here pushes; don't leave a token in .git/config
      - uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6.4.0
        with:
          node-version: ${{ inputs.node }}
          cache: npm
      - run: npm ci
      - run: npm run build
      - run: bash scripts/package-smoke.sh
```

- [ ] **Step 2: Replace the entire content of `.github/workflows/quality-gate.yml`** with exactly:

```yaml
name: Quality Gate

on:
  push:
    branches: [main]
  pull_request:
  workflow_dispatch:

permissions:
  contents: read

# PRs group per ref so a force-push cancels the superseded run. Pushes group
# per SHA: a concurrency group also cancels PENDING runs when a newer one
# queues, so grouping main by ref would let rapid merges leave commits with a
# cancelled gate — per-SHA keeps main's result history unbroken.
concurrency:
  group: ${{ github.workflow }}-${{ github.event_name == 'pull_request' && github.ref || github.sha }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}

jobs:
  # One full quality gate per supported environment, grouped in the run graph
  # under each caller node. Timeouts live inside env-gate.yml (GitHub rejects
  # timeout-minutes on `uses:` caller jobs).
  env_gate:
    name: quality gate (${{ matrix.os }}, node ${{ matrix.node }})
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest]
        node: ["22.19.0", "24"] # engines floor (exact) + current LTS
    uses: ./.github/workflows/env-gate.yml
    with:
      os: ${{ matrix.os }}
      node: ${{ matrix.node }}
      # the shipped tarball must install and run on the minimum supported
      # node; node-24 legs skip the smoke to avoid redundant coverage
      smoke: ${{ matrix.node == '22.19.0' }}

  # The single status check that ties every environment leg together. Branch
  # protection requires exactly this context: "quality-gate".
  gate:
    name: quality-gate
    needs: [env_gate]
    if: always()
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - name: Fail unless every environment gate succeeded
        if: contains(needs.*.result, 'failure') || contains(needs.*.result, 'cancelled') || contains(needs.*.result, 'skipped')
        run: |
          echo "::error::An environment quality gate did not succeed — env_gate=${{ needs.env_gate.result }}"
          exit 1
      - name: All environments green
        run: echo "quality gate passed — env_gate=${{ needs.env_gate.result }}"
```

- [ ] **Step 3: Validate**

Run:
```bash
node -e "const {readFileSync}=require('fs'); const y=require('/Users/alxedelweiss/junco/.claude/worktrees/ci_cd/node_modules/yaml'); y.parse(readFileSync('.github/workflows/quality-gate.yml','utf8')); y.parse(readFileSync('.github/workflows/env-gate.yml','utf8')); console.log('yaml ok')"
actionlint
zizmor .github/workflows/ 2>&1 | tail -1
```
Expected: `yaml ok`; actionlint silent (exit 0 — it validates `workflow_call` input wiring and the local `uses:` reference); zizmor summary `0 medium, 0 high` (the 1 low is the accepted publish.yml `adhoc-packages`).

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/
git commit -m "refactor(ci): group per-environment gates under reusable env-gate workflow"
git log --format='%B' -1   # verify: no attribution trailer
```

---

### Task 2: PR, live verification, merge

- [ ] **Step 1: Push and open the PR**

```bash
git push -u origin feat/quality-gate-envs
gh pr create --title "refactor(ci): quality gate as one entry with per-environment sub-gates" --body "$(cat <<'EOF'
Restructures the Quality Gate workflow into a thin orchestrator: a matrix caller job per environment invokes the new reusable env-gate.yml (workflow_call), so the Actions run graph groups each environment's sub-jobs (checks + package smoke) under one expandable node and check names read "quality gate (<env>) / checks". Floor-only smoke preserved via a boolean input; the aggregate `quality-gate` required check and ruleset are unchanged.

Design: docs/superpowers/specs/2026-07-08-quality-gate-envs-design.md
EOF
)"
```

- [ ] **Step 2: Watch checks**

Run: `gh pr checks <PR#> --watch --interval 30`
Expected 7 green check runs: `quality gate (<os>, node <v>) / checks` ×4, `quality gate (<os>, node 22.19.0) / package smoke` ×2, `quality-gate` ×1. Confirm in the run graph (Actions tab) that each environment is an expandable group.

- [ ] **Step 3: Merge**

```bash
gh pr merge <PR#> --merge --delete-branch
```
(The ruleset enforces the green gate; `--delete-branch` may warn locally because `main` is checked out in the primary worktree — the remote merge still completes; verify with `gh pr view <PR#> --json state`.)

- [ ] **Step 4: Confirm main's run**

Run: `gh run list --branch main --workflow "Quality Gate" --limit 1` and watch it to success (`gh run watch <id> --exit-status`).

---

## Self-review notes

- Spec coverage: orchestrator rewrite (T1 S2), reusable workflow with the three inputs (T1 S1), floor-only smoke (`smoke: ${{ matrix.node == '22.19.0' }}`), aggregate unchanged (`quality-gate`, needs `[env_gate]`), validation trio (T1 S3), live PR proof + merge (T2). No ruleset/badge/docs edits needed per spec.
- Consistency: job id `env_gate` matches `needs: [env_gate]` and the gate's `needs.env_gate.result` references; input names `os`/`node`/`smoke` match between caller `with:` and `workflow_call` inputs.
