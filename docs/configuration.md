# Configuration

Junco is configured via a JSON file — `./config.json` if present, else `~/.config/junco/config.json` (the wizard writes the latter unless you pass `--config`; respects `XDG_CONFIG_HOME`). Every field is optional; anything you omit falls back to its default. The guided way to produce (or tune) this file is `junco dashboard` (or bare `junco` on a first run) — a walkthrough of the settings that matter, with safe defaults for the rest, re-runnable anytime from the command palette ("setup"). For a headless, non-interactive scaffold (scripting, CI), use `junco config init`.

[← back to the README](../README.md)

## Minimal example

```json
{
  "tools": ["bash", "read", "write", "edit", "grep", "find"],
  "model": {
    "id": "myprovider/my-model",
    "baseUrl": "http://127.0.0.1:1234/v1",
    "apiKey": "your-api-key"
  },
  "worker": {
    "commitLeftovers": false
  },
  "git": {
    "allowedRepoRoots": ["~/code"]
  }
}
```

`tools` sets the coding agent's tool allowlist. `model` describes the inference endpoint (point `model.modelsJson` at a Pi-style `models.json` instead of the inline fields if you'd rather load the provider+model from there). Everything else — `worker`, `supervisor`, `git`, `pr`, `verify`, `sandbox`, `critic`, `planLint`, `observability`, `github`, `assess` — is a sectioned object with sensible defaults; set only the keys you want to override. The queue and every other on-disk directory Junco keeps default to a location under `dataDir` (below) — nothing here needs to be set to get a working queue.

## Unified data root

Every path Junco reads or writes — the ticket queue, parked `assess`/`analyze` review items, the GitHub write-outbox, cloned repos, PR-flow worktrees, transcripts, and a handful of top-level state files — resolves under one root, `dataDir`:

```json
{ "dataDir": "~/.local/state/junco" }
```

That's also the default, so most setups never need to set it at all. The shape underneath is fixed:

```
<dataDir>/                                   default: ~/.local/state/junco
  .gitignore                                 contains "*" — self-ignoring (cargo target/ trick)
  queue/
    inbox/          processing/          done/          failed/
  review/
    assess/         (+ filed/)                          parked assess findings, one JSON per ticket
    comments/       (+ posted/ discarded/)              parked analyze drafts, one JSON per ticket
  outbox/           (+ dead/)                           GitHub write ops, one JSON per op; created eagerly
  mirror/
    <owner>__<repo>/
      meta.json                                         fetchedAt stamps per kind
      issues/<n>.json                                   one file per issue, last-known GitHub state
      prs/<n>.json                                      one file per junco PR
  clones/
    watched/<owner>/<repo>/                             dashboard-cloned watched repos
    external/<owner>/<repo>/                             managed clones of unowned repos (fork/assess flow)
  worktrees/                                            ephemeral PR-flow build worktrees
  assess-history/                                       per-repo `junco assess` history, one JSON file per repo
  history/                                              per-task finalize ledger, tasks-YYYY-MM.jsonl shards
  transcripts/<ticket-id>.jsonl                         per-run event stream
  watchlist.json    spend.json    metrics.json    worker.log    migrated.json
```

Every directory above except `clones/external/` and `worktrees/` is created eagerly at daemon startup, so nothing is invisible-until-first-use; those two are the exception because a legacy override (see below) can point them outside `dataDir` entirely, so a mkdir here could fabricate a stray empty directory nobody asked for. `mirror/` is reserved for a follow-up release (a read-only local mirror of GitHub issues/PRs behind the dashboard) and stays empty until then. The root also gets a self-`.gitignore` (contents `*`, written only when no file is already there), so pointing `dataDir` at a path inside a git checkout — including Junco's own — can never dirty a commit.

The dashboard's issue/PR cache (`github-cache/`) still lives directly under `dataDir/` today; it isn't part of this tree because it's slated for replacement by `mirror/` in that same follow-up release.

### Legacy per-subtree overrides

Four older, narrower keys still work — each is a **deprecated override for one subtree only**, and setting one always wins for that subtree (over `dataDir`) with a one-line warning logged once at daemon startup and surfaced by `junco doctor` / `junco data`:

| Legacy key                  | Overrides                                                                                     | Default when unset          |
| --------------------------- | --------------------------------------------------------------------------------------------- | --------------------------- |
| `vaultRoot` + `juncoSubdir` | the queue root (`<vaultRoot>/<juncoSubdir>`, same flat `inbox/processing/done/failed` layout) | `<dataDir>/queue`           |
| `observability.stateDir`    | `dataDir` itself, for every subtree that doesn't have its own override                        | `~/.local/state/junco`      |
| `git.worktreeRoot`          | the worktrees root                                                                            | `<dataDir>/worktrees`       |
| `github.externalReposRoot`  | the external (unowned-repo) clones root                                                       | `<dataDir>/clones/external` |

Resolution order:

```
dataDir      = observability.stateDir ?? dataDir ?? "~/.local/state/junco"
queueRoot    = vaultRoot ? <vaultRoot>/<juncoSubdir> : <dataDir>/queue
worktreeRoot = git.worktreeRoot ?? <dataDir>/worktrees
externalRoot = github.externalReposRoot ?? <dataDir>/clones/external
watchedRoot  = <dataDir>/clones/watched              # no legacy override — always here
```

Setting both `dataDir` and a legacy key is not an error: the legacy key wins for its own subtree, and the deprecation warning says so — every other subtree still resolves under `dataDir` normally. A fresh `junco config init` or wizard-written config never writes any of the four legacy keys, and writes `dataDir` itself only when it differs from the default — a fully-default fresh config carries no path keys at all.

### `junco data` — inspect the tree

`junco data` prints the resolved tree with live counts, legacy-override provenance, and any pending migration — a pure, read-only view that never creates or moves anything:

```
$ junco data
junco data — root: /Users/you/.local/state/junco

queue      /Users/you/.local/state/junco/queue
  inbox 2 · processing 1 · done 148 · failed 9

review
  assess    1 pending · 6 filed   /Users/you/.local/state/junco/review/assess
  comments  0 pending · 4 posted · 1 discarded   /Users/you/.local/state/junco/review/comments

outbox     ops 0 · dead 0   /Users/you/.local/state/junco/outbox

mirror     0 repos · 0 files   /Users/you/.local/state/junco/mirror

clones
  watched   1 repos   /Users/you/.local/state/junco/clones/watched
  external  1 repos   /Users/you/.local/state/junco/clones/external

worktrees  1 dirs   /Users/you/.local/state/junco/worktrees

assess-history 3 repos   /Users/you/.local/state/junco/assess-history

history 2 shards   /Users/you/.local/state/junco/history

transcripts 158 files · 3.20 MB   /Users/you/.local/state/junco/transcripts

files
  watchlist.json  1.20 KB   /Users/you/.local/state/junco/watchlist.json
  spend.json      340 B · $12.41 today   /Users/you/.local/state/junco/spend.json
  metrics.json    (absent)   /Users/you/.local/state/junco/metrics.json
  worker.log      3.20 MB   /Users/you/.local/state/junco/worker.log
  migrated.json   180 B   /Users/you/.local/state/junco/migrated.json
```

Every node is listed even when its directory doesn't exist yet (`(absent)` — normal before the first daemon start, or for an override nobody has populated); a legacy-overridden root prints a trailing ` ← legacy override: <key>  [deprecated]`, and any old-name directory still waiting on the automatic migration below prints a trailing `⚠ unmigrated: <from> → <to> (run 'junco data migrate')` line. `junco data --json` emits the same information as `{ root, paths, counts, legacy, pendingMigrations, deprecations }`.

### Automatic migration (in place, at every daemon startup)

Every daemon start renames a fixed set of pre-unification directory names to their new locations, in place, whenever the old name exists and the new one doesn't — no action required:

```
assess-review          → review/assess          github-outbox → outbox
comment-review         → review/comments         repos         → clones/watched
external                → clones/external         github-watchlist.json → watchlist.json
```

(`external → clones/external` is skipped when `github.externalReposRoot` is legacy-set — there's nothing under `dataDir` to move in that case.) Renames are same-directory and atomic; each completed step is journaled to `<dataDir>/migrated.json` so re-running is a no-op. A destination that already exists but contains no files anywhere (only empty directories — e.g. scaffolding an earlier startup materialized) is replaced by the rename; a name collision (the destination holds at least one real file) is left untouched and reported by `junco doctor` / `junco data` instead of being guessed at — file-holding data is never deleted. This step never touches the ticket queue (see below), and it does not touch `github-cache/` (replaced by `mirror/` in a follow-up release, not renamed here).

### `junco data migrate` — the opt-in full unification

The ticket queue itself never moves automatically: `vaultRoot` is required by every config that predates this release, so leaving it set is always safe, and nothing silently relocates a live queue. `junco data migrate` is the explicit, opt-in command that finishes the job for a config still carrying legacy keys — it moves the queue directories into `<dataDir>/queue` (rename, falling back to copy+verify+delete across filesystems), runs the same in-place state-tree normalization described above, then rewrites `config.json` to drop `vaultRoot` / `juncoSubdir` / `observability.stateDir` (only the ones present) and set a customized `dataDir` (only if it isn't already the default) — through the same validated read/mutate/write path as `junco config set`.

It refuses to run while the daemon appears to be up — any `/health` response at all (even non-200) counts as "up", and so does a live-held `worker.lock` next to `config.json` (which catches daemons running with health disabled). Pass `--force` to skip both checks. It also holds a `<dataDir>/migrate.lock` for the whole run so two migrations can't race:

```bash
junco data migrate --dry-run   # print the plan; change nothing
junco data migrate             # do it
junco data migrate --force     # skip the daemon-up checks (health probe + pidfile)
```

```
$ junco data migrate --dry-run
junco data migrate: plan (dry-run — no changes made)
  config: vaultRoot/juncoSubdir are deprecated — the queue lives at <dataDir>/queue; run 'junco data migrate' to unify (docs/configuration.md)

queue:
  inbox: /Users/you/junco-vault/Junco/inbox -> /Users/you/.local/state/junco/queue/inbox
  processing: /Users/you/junco-vault/Junco/processing -> /Users/you/.local/state/junco/queue/processing
  done: /Users/you/junco-vault/Junco/done -> /Users/you/.local/state/junco/queue/done
  failed: /Users/you/junco-vault/Junco/failed -> /Users/you/.local/state/junco/queue/failed

state tree: nothing pending

config.json:
  would remove: vaultRoot, juncoSubdir, observability.stateDir (if present)
  dataDir left unset (matches the default)

state tree journal: /Users/you/.local/state/junco/migrated.json
```

A real (non-dry-run) run prints a matching receipt in place of the plan — what moved, what the state tree did, and what changed in `config.json` — and exits non-zero if any state-tree pair conflicted (both old and new names existed and the destination held real files; a destination containing only empty directories is repaired automatically). Nothing already moved is ever rolled back, so fixing a conflict by hand and re-running picks up exactly where it left off.

## Model resolution

| Field                     | Default            | Description                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model.id`                | `"local/my-model"` | Provider-prefixed model id, e.g. `anthropic/claude-sonnet-4-5`. The text before the first `/` is the provider; a bare id with no `/` is provider `local`.                                                                                                                                                                                                                  |
| `model.source`            | `"auto"`           | `"auto"`: a non-`local` provider prefix with no explicit `model.baseUrl` resolves from the embedded SDK's builtin hosted-provider catalog (real endpoint, cost, and context-window metadata); otherwise the inline fields below apply. `"catalog"` / `"inline"` pin the behavior explicitly.                                                                               |
| `model.baseUrl`           | unset              | OpenAI-compatible `/v1` endpoint for inline resolution. Unset defaults to the local endpoint (`http://127.0.0.1:1234/v1`); setting it explicitly forces inline resolution even for a provider-prefixed id — an explicit endpoint means a deliberate proxy/override.                                                                                                        |
| `model.apiKey`            | unset              | A literal key, an `"$ENV_VAR"` reference (read from the daemon's own environment), or unset. Unset on a catalog-resolved model defers to the provider's environment variable at request time (e.g. `ANTHROPIC_API_KEY`); unset on an inline model falls back to a placeholder. `"!command"` values are rejected — junco does not shell out for secrets from `config.json`. |
| `model.retry.maxRetries`  | unset              | SDK auto-retry attempts on transient provider errors; unset uses the SDK default (3).                                                                                                                                                                                                                                                                                      |
| `model.retry.baseDelayMs` | unset              | Base delay (ms) for the SDK's auto-retry backoff; unset uses the SDK default (2000).                                                                                                                                                                                                                                                                                       |

Endpoint probing — the daemon's startup readiness wait, `/health` and dashboard reachability checks, and `junco doctor`'s endpoint check — is skipped for a catalog-resolved model (no local server to wait for, and probing a metered API on every poll/dashboard tick is billed traffic). A configured `model.modelsJson` still probes, since the provider `baseUrl` it declares may be local.

`worker.endpointProbe` overrides that skip heuristic directly: `"never"` always skips probing (even for a local/inline model), `"always"` always probes (even a catalog-resolved hosted model), and `"auto"` (default) defers to the skip-for-catalog rule above. Probe results are cached for ~10 seconds so a poll loop or dashboard tick can't multiply upstream probe traffic; the cache is shared by the claim gate, `/health`, and `/ready` inside the daemon process, and the dashboard (a separate process) keeps its own cache on the same terms.

A provider-prefixed id that is catalog-eligible but NOT actually present in the embedded SDK's builtin catalog (e.g. a typo'd or not-yet-added provider) falls through to inline resolution — an explicit `model.baseUrl` and `model.apiKey` are then required, and the session build fails with an actionable error if the key is missing; endpoint probing is still skipped for any catalog-eligible config, including this fall-through case.

```json
{
  "model": { "id": "anthropic/claude-sonnet-4-5" }
}
```

With no `baseUrl` and no `apiKey`, the model resolves from the embedded catalog and the key comes from `ANTHROPIC_API_KEY` in the daemon environment.

## Daily spend cap

`worker.dailyBudgetUsd` (default `0`, disabled) caps total USD spend per local calendar day, tallied from every completed session's actual resolved cost (main run, critic pass, and any corrective re-dispatch). Once today's spend reaches the cap, the provider gate enters `budget_exhausted` and pauses new ticket claims until local midnight, or until an operator raises the cap via a config hot-reload — see [Operations § Provider gate](operations.md#provider-gate) for the full gate-state table and the `/health` spend field.

```json
{
  "worker": {
    "dailyBudgetUsd": 5
  }
}
```

## Update check

`updateCheck` (default `true`) enables a best-effort daily check against the npm registry for a
newer Junco release, surfaced in the dashboard header, `junco status`, and `junco doctor`. It's
CLI/TUI-side only — the daemon never phones home. Set it to `false` to opt out:

```json
{ "updateCheck": false }
```

## The full reference

The full, always-current annotated reference is `junco config list` — every lever with its default, type, and one-line explanation:

```bash
junco config list                       # every lever
junco config get worker.maxConcurrent   # one value
junco config set model.id myprovider/my-model
```

Edit interactively in the dashboard config view (press `,`), or with `junco config path` to print the resolved file location. Structural fields (`editable: false` in `junco config list`, e.g. `tools`) require a direct edit of `config.json`.

## Hot-reload

The daemon re-reads `config.json` on change. Live-safe levers (e.g. most `worker`/`supervisor`/`model` knobs) apply at the next poll with no restart. Structural levers (e.g. `dataDir`, `vaultRoot`, `juncoSubdir`, `worker.maxConcurrent`) need `junco restart` to take effect — until then they show up in `pendingRestartFields` in `junco status` and the `/health` endpoint, so a pending change is never silently ignored.

## TOML is no longer supported

Earlier versions used `config.toml`. TOML support (and the `smol-toml` dependency) has been removed — `config.json` is the only format Junco reads. If `parseConfigFile` can't find `config.json` at the resolved path but finds a `config.toml` sitting right next to it, it fails with a guard error pointing at this doc instead of a generic "file not found" — your `config.toml` is left untouched, so nothing is lost. Convert it by hand: the old `[pi]` model-id key and `[oMLX]` section map to `model.id` / `model.baseUrl` / `model.apiKey`, the `--tools` CSV maps to top-level `tools`, the old top-level commit-leftovers key maps to `worker.commitLeftovers`, and every other key is the same name camelCased under its section.
