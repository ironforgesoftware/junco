# Configuration

Junco is configured via a single JSON file: `~/.junco/config.json` (pre-0.10 installs are still read from the legacy `~/.config/junco/config.json`, which respects `XDG_CONFIG_HOME`, until the canonical file exists). Every field is optional; anything you omit falls back to its default. The guided way to produce (or tune) this file is `junco dashboard` (or bare `junco` on a first run) — a walkthrough of the settings that matter, with safe defaults for the rest, re-runnable anytime from the command palette ("setup"). For a headless, non-interactive scaffold (scripting, CI), use `junco config init`.

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
{ "dataDir": "~/.junco" }
```

That's also the default — the very directory `config.json` itself lives in, so a fresh install really is one folder — and most setups never need to set it at all. An install from before 0.10 keeps resolving to its old root, `~/.local/state/junco`, completely untouched, for as long as that root exists and `~/.junco` holds no data tree of its own yet; `junco data migrate` (below) is the only thing that ever relocates it. The shape underneath depends on which of two layouts the root uses — `flat` (every pre-0.10 install, byte-identical forever) or `v2` (below; every fresh `~/.junco` install, and anything `junco data migrate` has restructured):

```
<dataDir>/                                   default: ~/.junco (same directory as config.json)
  .gitignore                                 contains "*" — self-ignoring (cargo target/ trick)
  queue/
    inbox/          processing/          done/          failed/
  review/
    assess/         (+ filed/)                          parked assess findings, one JSON per ticket
    comments/       (+ posted/ discarded/)              parked analyze drafts, one JSON per ticket
  watchlist.json    migrated.json
  migrate.lock                                          held only while `junco data migrate` is actively running
  data/                                                 unrecoverable
    outbox/         (+ dead/)                           GitHub write ops, one JSON per op; created eagerly
    assess-history/                                       per-repo `junco assess` history, one JSON file per repo
    history/                                              per-task finalize ledger, tasks-YYYY-MM.jsonl shards
    transcripts/<ticket-id>.jsonl                         per-run event stream
    spend.json       metrics.json
  cache/                                                rm -rf-safe — rebuilds from GitHub/git on demand
    mirror/
      <owner>__<repo>/
        meta.json                                         fetchedAt stamps per kind
        issues/<n>.json                                   one file per issue, last-known GitHub state
        prs/<n>.json                                      one file per junco PR
    clones/
      watched/<owner>/<repo>/                             dashboard-cloned watched repos
      external/<owner>/<repo>/                             managed clones of unowned repos (fork/assess flow)
    worktrees/                                            ephemeral PR-flow build worktrees
    github-cache/                                         legacy TUI issue/PR cache, unrelated to `mirror/`
    update-check.json                                     npm update-check cache
  logs/
    worker.log
```

Every directory above except `clones/external/`, `worktrees/`, and `github-cache/` is created eagerly at daemon startup, so nothing is invisible-until-first-use. The first two are the exception because a legacy override (see below) can point them outside `dataDir` entirely, so a mkdir here could fabricate a stray empty directory nobody asked for; `github-cache/` is the exception because it's the legacy TUI issue/PR cache (`tui/ghClient.ts` still owns it), created lazily on first fetch and excluded from `junco data`'s report below — it's slated for replacement by `mirror/` in a follow-up release, which is why `mirror/` itself stays empty until then. The root also gets a self-`.gitignore` (contents `*`, written only when no file is already there), so pointing `dataDir` at a path inside a git checkout — including Junco's own — can never dirty a commit.

`config.json`, the single-instance `worker.lock` next to it, and the bot account's isolated gh config dir (`gh/`, default `~/.junco/gh` — see [bot-account.md](bot-account.md)) all resolve independently of `dataDir`, off `config.json`'s own home — but by default that home is this same `~/.junco` directory, so they sit right alongside the tree above. None of the three are part of it, or of `junco data`'s report.

### Legacy per-subtree overrides

Four older, narrower keys still work — each is a **deprecated override for one subtree only**, and setting one always wins for that subtree (over `dataDir`) with a one-line warning logged once at daemon startup and surfaced by `junco doctor` / `junco data`:

| Legacy key                  | Overrides                                                                                     | Default when unset                                                          |
| --------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `vaultRoot` + `juncoSubdir` | the queue root (`<vaultRoot>/<juncoSubdir>`, same flat `inbox/processing/done/failed` layout) | `<dataDir>/queue`                                                           |
| `observability.stateDir`    | `dataDir` itself, for every subtree that doesn't have its own override                        | `~/.junco`                                                                  |
| `git.worktreeRoot`          | the worktrees root                                                                            | `<dataDir>/worktrees` (flat) / `<dataDir>/cache/worktrees` (v2)             |
| `github.externalReposRoot`  | the external (unowned-repo) clones root                                                       | `<dataDir>/clones/external` (flat) / `<dataDir>/cache/clones/external` (v2) |

Resolution order:

```
dataDir      = observability.stateDir ?? dataDir ?? "~/.junco"      # or the legacy ~/.local/state/junco root, untouched, while it exists and ~/.junco holds no tree yet
queueRoot    = vaultRoot ? <vaultRoot>/<juncoSubdir> : <dataDir>/queue
worktreeRoot = git.worktreeRoot ?? <dataDir>/worktrees              # v2: <dataDir>/cache/worktrees
externalRoot = github.externalReposRoot ?? <dataDir>/clones/external # v2: <dataDir>/cache/clones/external
watchedRoot  = <dataDir>/clones/watched              # v2: <dataDir>/cache/clones/watched — no legacy override, always here
```

Setting both `dataDir` and a legacy key is not an error: the legacy key wins for its own subtree, and the deprecation warning says so — every other subtree still resolves under `dataDir` normally. A fresh `junco config init` or wizard-written config never writes any of the four legacy keys, and writes `dataDir` itself only when it differs from the default — a fully-default fresh config carries no path keys at all.

### `junco data` — inspect the tree

`junco data` prints the resolved tree with live counts, legacy-override provenance, and any pending migration — a pure, read-only view that never creates or moves anything:

```
$ junco data
junco data — root: /Users/you/.junco

queue      /Users/you/.junco/queue
  inbox 2 · processing 1 · done 8 · failed 1

review
  assess    1 pending · 6 filed   /Users/you/.junco/review/assess
  comments  0 pending · 4 posted · 1 discarded   /Users/you/.junco/review/comments

outbox     ops 0 · dead 0   /Users/you/.junco/data/outbox

mirror     0 repos · 0 files   /Users/you/.junco/cache/mirror

clones
  watched   1 repos   /Users/you/.junco/cache/clones/watched
  external  1 repos   /Users/you/.junco/cache/clones/external

worktrees  1 dirs   /Users/you/.junco/cache/worktrees

assess-history 3 repos   /Users/you/.junco/data/assess-history

history 2 shards   /Users/you/.junco/data/history

transcripts 5 files · 9.77 KB   /Users/you/.junco/data/transcripts

files
  watchlist.json  13 B   /Users/you/.junco/watchlist.json
  update-check.json41 B   /Users/you/.junco/cache/update-check.json
  spend.json      34 B · $12.41 today   /Users/you/.junco/data/spend.json
  metrics.json    3 B   /Users/you/.junco/data/metrics.json
  worker.log      1.17 KB   /Users/you/.junco/logs/worker.log
  migrated.json   25 B   /Users/you/.junco/migrated.json
```

(`update-check.json`'s label is longer than the fixed-width column every other row pads to, so its size butts up against it with no space — that's the real formatter output, not a typo.)

Every node is listed even when its directory doesn't exist yet (`(absent)` — normal before the first daemon start, or for an override nobody has populated); a legacy-overridden root prints a trailing ` ← legacy override: <key>  [deprecated]`, and any old-name directory still waiting on the automatic migration below prints a trailing `⚠ unmigrated: <from> → <to> (run 'junco data migrate')` line. `junco data --json` emits the same information as `{ root, layout, paths, counts, legacy, pendingMigrations, deprecations }`.

### Automatic migration (in place, at every daemon startup)

Every daemon start renames a fixed set of pre-unification directory names to their new locations, in place, whenever the old name exists and the new one doesn't — no action required:

```
assess-review          → review/assess          github-outbox → outbox
comment-review         → review/comments         repos         → clones/watched
external                → clones/external         github-watchlist.json → watchlist.json
```

(`external → clones/external` is skipped when `github.externalReposRoot` is legacy-set — there's nothing under `dataDir` to move in that case.) Renames are same-directory and atomic; each completed step is journaled to `<dataDir>/migrated.json` so re-running is a no-op. A destination that already exists but contains no files anywhere (only empty directories — e.g. scaffolding an earlier startup materialized) is replaced by the rename; a name collision (the destination holds at least one real file) is left untouched and reported by `junco doctor` / `junco data` instead of being guessed at — file-holding data is never deleted. This step never touches the ticket queue (see below), and it does not touch `github-cache/` (replaced by `mirror/` in a follow-up release, not renamed here). It is also unrelated to the root move / v2 restructure below — this rename is same-directory and automatic; moving to a different root, or from `flat` to `v2`, only ever happens via the explicit, opt-in `junco data migrate`.

### `junco data migrate` — the opt-in full unification

Two things never move on their own: a `vaultRoot` queue, and the root itself while it's still the legacy `~/.local/state/junco` (or an explicit `dataDir` that predates the `v2` shape) — leaving either alone is always safe, and nothing silently relocates live data. `junco data migrate` is the explicit, opt-in command that unifies all of it in one run, in order:

1. Moves the `vaultRoot` queue (if set) into `<targetRoot>/queue` (rename, falling back to copy+verify+fsync+delete across filesystems).
2. Runs the same in-place state-tree name-normalization described above.
3. Restructures the rest of the tree into the `v2` shape (`outbox/` → `data/outbox`, `clones/` → `cache/clones`, `worktrees/` → `cache/worktrees`, `worker.log` → `logs/worker.log`, …), relocating it from the legacy root to `~/.junco` too if that's where it still lives.
4. Moves the bot's gh creds, if they're still at the legacy `~/.config/junco/gh` (see [bot-account.md](bot-account.md)).
5. Removes the legacy root once it's empty (including junco's own scaffolded `.gitignore`, if that's the only thing left — an operator-customized one is left in place and reported).
6. Rewrites `config.json` to drop `vaultRoot` / `juncoSubdir` / `observability.stateDir` (only the ones present) and set a customized `dataDir` (only if the target isn't already the default) — through the same validated read/mutate/write path as `junco config set`.
7. Relocates `config.json` itself from the legacy `~/.config/junco/config.json` (or `$XDG_CONFIG_HOME/junco/config.json`) to the canonical `~/.junco/config.json`, if that's still where this run loaded it from (rename, falling back to copy+verify+fsync+delete across filesystems). Never overwrites an existing canonical file — that's reported as a conflict instead. Once moved, config resolution finds it there on every subsequent run, so this step is a no-op after the first.

It refuses to run while the daemon appears to be up — any `/health` response at all (even non-200) counts as "up", and so does a live-held `worker.lock` next to `config.json` (which catches daemons running with health disabled). Pass `--force` to skip both checks. It holds a `migrate.lock` at every root the run might touch — the target, and, for a cross-root move, the legacy root and (if different) the config's currently-resolved `dataDir` — so two migrations, or a migration racing a starting daemon, can't collide:

```bash
junco data migrate --dry-run   # print the plan; change nothing
junco data migrate             # do it
junco data migrate --force     # skip the daemon-up checks (health probe + pidfile)
```

A machine still on the legacy root, with a legacy `vaultRoot` queue and a legacy bot gh login, plans like this:

```
$ junco data migrate --dry-run
junco data migrate: plan (dry-run — no changes made)
  config: vaultRoot/juncoSubdir are deprecated — the queue lives at <dataDir>/queue; run 'junco data migrate' to unify (docs/configuration.md)
  config: data lives at the legacy ~/.local/state/junco root — run 'junco data migrate' to move it under ~/.junco (docs/configuration.md)
  config: bot gh credentials live at the legacy ~/.config/junco/gh — run 'junco data migrate' to move them to ~/.junco/gh

queue:
  inbox: /Users/you/junco-vault/Junco/inbox -> /Users/you/.junco/queue/inbox
  processing: /Users/you/junco-vault/Junco/processing -> /Users/you/.junco/queue/processing
  done: /Users/you/junco-vault/Junco/done -> /Users/you/.junco/queue/done
  failed: /Users/you/junco-vault/Junco/failed -> /Users/you/.junco/queue/failed

state tree: nothing pending

data root: /Users/you/.local/state/junco -> /Users/you/.junco
  /Users/you/.local/state/junco/queue -> /Users/you/.junco/queue (nothing to move)
  /Users/you/.local/state/junco/review -> /Users/you/.junco/review (nothing to move)
  /Users/you/.local/state/junco/watchlist.json -> /Users/you/.junco/watchlist.json
  /Users/you/.local/state/junco/migrated.json -> /Users/you/.junco/migrated.json (nothing to move)
  /Users/you/.local/state/junco/outbox -> /Users/you/.junco/data/outbox (nothing to move)
  /Users/you/.local/state/junco/assess-history -> /Users/you/.junco/data/assess-history
  /Users/you/.local/state/junco/history -> /Users/you/.junco/data/history
  /Users/you/.local/state/junco/transcripts -> /Users/you/.junco/data/transcripts
  /Users/you/.local/state/junco/spend.json -> /Users/you/.junco/data/spend.json (nothing to move)
  /Users/you/.local/state/junco/metrics.json -> /Users/you/.junco/data/metrics.json (nothing to move)
  /Users/you/.local/state/junco/clones -> /Users/you/.junco/cache/clones
  /Users/you/.local/state/junco/worktrees -> /Users/you/.junco/cache/worktrees
  /Users/you/.local/state/junco/github-cache -> /Users/you/.junco/cache/github-cache
  /Users/you/.local/state/junco/mirror -> /Users/you/.junco/cache/mirror (nothing to move)
  /Users/you/.local/state/junco/update-check.json -> /Users/you/.junco/cache/update-check.json (nothing to move)
  /Users/you/.local/state/junco/worker.log -> /Users/you/.junco/logs/worker.log (nothing to move)
  (legacy root /Users/you/.local/state/junco would be removed once empty)

gh config:
  /Users/you/.config/junco/gh -> /Users/you/.junco/gh

config.json:
  would remove: vaultRoot, juncoSubdir, observability.stateDir (if present)
  dataDir left unset (matches the default)

config: /Users/you/.config/junco/config.json -> /Users/you/.junco/config.json

state tree journal: /Users/you/.junco/migrated.json
```

A real (non-dry-run) run prints a matching receipt in place of the plan — what moved, what the state tree did, what the data-root and gh-config moves did, and what changed in `config.json` — and exits non-zero if any state-tree or data-root pair conflicted (both old and new names existed and the destination held real files; a destination containing only empty directories is repaired automatically and taken). Nothing already moved is ever rolled back, so fixing a conflict by hand and re-running picks up exactly where it left off — the plan is filesystem-driven (it re-probes what still exists under each old name on every run), not "have I run once before", so it converges no matter how many times you run it or where an earlier run was interrupted.

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
