# Config: migrate TOML → JSON, add a lever registry, CLI + TUI editor

**Date:** 2026-07-10
**Status:** draft

## Problem

Junco is configured via a TOML file parsed by the exact-pinned `smol-toml` dependency.
TOML earns its keep today as a *human-authored, comment-annotated* file — but the maintainer
wants (a) an in-TUI config editor, (b) matching CLI support, and (c) `smol-toml` gone. A TUI
that round-trips TOML would either drop the `#`-comment annotations (the whole reason TOML was
chosen) or require comment-preserving edits `smol-toml` doesn't offer. Moving to JSON removes
the dependency and the comment tension at once — the field explanations move *out* of the file
and *into* a registry that powers the TUI screen, the CLI, and the docs from one source.

This is a **breaking config-format change**. It also touches the maintainer's **live runtime**:
the main checkout runs a launchd daemon off a real `config.toml`. Once `smol-toml` is deleted,
junco physically cannot read that file, so migration is a hard requirement of shipping, handled
as a deliberate maintainer-confirmed rollout step (never by the shipped code).

## Goal

- `config.json` (camelCase, sectioned, sparse) replaces `config.toml`; `smol-toml` removed.
- A single **lever registry** (`src/configLevers.ts`) is the sole source of field explanations,
  editability, and display types — consumed by the TUI editor, the CLI, and the docs, guarded
  against schema drift by a bijection test.
- `junco config {path,list,get,set}` CLI family.
- A dashboard **Config view** that edits every scalar lever inline (bool/number/enum/string +
  masked secret), with structured fields shown read-only.
- **Daemon hot-reload**: a running daemon file-watches `config.json` and applies live-safe
  levers at the next poll boundary (never mid-ticket); structural levers warn "restart to apply".
- No residual TOML: dependency, format, docs, and (post-merge, maintainer-confirmed) the live
  file itself.

## Locked decisions (from brainstorming)

1. **Hard cut, manual conversion.** No TOML-parsing code ships. `loadConfig`/`doctor` error
   clearly on a leftover `.toml`. The maintainer's live file is hand-converted at rollout.
2. **camelCase keys** mirroring the internal `Config` type (file stays *sectioned*; `Config`
   stays *flat*; `loadConfig` flattens).
3. **Drop legacy shims.** Remove `pi` / `oMLX` / `omlx` entirely. Promote the tool allowlist to
   a first-class top-level `tools: string[]` (no more `--tools` inside `extra_args`) and
   `commitLeftovers` to `worker.commitLeftovers`.
4. **TUI editable scope = all scalars.** bool/number/enum/string editable with explanations;
   structured fields (`tools`, `defaultLabels`, `allowedRepoRoots`, `model.input`,
   `github.repos`, `model.compat`, `model.cost`) render read-only with an "edit config.json"
   pointer; `model.apiKey` is a masked-but-editable secret.
5. **Explanation source = explicit lever registry + drift test** (not Zod introspection, not
   hardcoded-in-TUI).
6. **`config set` while the daemon runs = warn and proceed** (matches the watchlist writer). With
   hot-reload (decision 7) a running daemon picks up live levers on its own; `set`/TUI only warn
   "restart to apply" for `restart`-kind levers.
7. **Daemon hot-reload = file-watched live subset + restart-warn** (chosen over rebind-everything
   and TUI-only IPC). The daemon `fs.watch`es `config.json`; a valid edit applies the live-safe
   levers at the next poll boundary; structural levers warn instead of rebinding. File-watch, so
   TUI edits, `config set`, and hand-edits all reload uniformly.

## Non-goals

- **Live rebind/rewire.** Hot-reload never rebinds the health socket, moves the queue/state dir,
  or re-wires the GitHub bridge on the fly — those levers are `restart`-kind (warn, keep running
  value). No mid-ticket application either: an in-flight ticket keeps the config snapshot it
  started with.
- **`config edit` ($EDITOR).** `set` + the TUI cover it; $EDITOR plumbing isn't worth the surface.
- **Structured-field editors in the TUI** (string-array add/remove, repos editor). Read-only in v1.
- **Any change to the flat `Config` type** or to `ticketSchema.ts`. Out of scope.
- **Release.** On absolute HOLD; a version bump + CHANGELOG entry ship in the PR, the tag/publish
  is a separate maintainer-approved step.

## The `config.json` format

Sectioned (mirrors today's TOML tables — groups the TUI screen and reads well for humans),
camelCase, **sparse** (only what the user sets; `loadConfig` fills defaults). Illustrative:

```json
{
  "vaultRoot": "~/Junco",
  "juncoSubdir": "",
  "tools": ["read", "bash", "edit", "write", "grep", "find", "ls"],
  "model": {
    "id": "local/my-model",
    "baseUrl": "http://127.0.0.1:1234/v1",
    "apiKey": "1234",
    "contextWindow": 131072,
    "maxTokens": 49152,
    "thinkingLevel": "medium",
    "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
    "compat": {}
  },
  "worker": { "maxConcurrent": 1, "pollIntervalSeconds": 15, "commitLeftovers": false },
  "supervisor": {}, "git": {}, "pr": {}, "verify": {}, "critic": {},
  "planLint": {}, "observability": {}, "github": {}, "assess": {}
}
```

Changes vs. the TOML schema:

- `tools` — **top-level array** (was `pi.extra_args = ["--tools", "..."]`).
- `commitLeftovers` — **`worker.commitLeftovers`** (was `pi.commit_leftovers`).
- `pi` / `oMLX` / `omlx` and every `?? d.pi.*` / `?? d.oMLX.*` fallback — **gone**.
- Section field names → camelCase (`max_concurrent` → `maxConcurrent`, `health_port` →
  `healthPort`, `cache_read` → `cacheRead`, …).

## `src/config.ts`

### Schema
Rewrite `TomlSchema` as a camelCase `ConfigSchema` (zod). Every field that today falls back to
a legacy key becomes a plain `.default(...)` (e.g. `model.api` defaults to `"openai-completions"`,
`model.baseUrl` to `"http://127.0.0.1:1234/v1"`, `model.apiKey` to `"1234"`). Numeric bounds
(`.min`/`.max`) and enums (`logLevel`, `assess.minSeverity`) carry over unchanged.

### `loadConfig`
`read file → JSON.parse (try/catch → "config.json is not valid JSON: <msg>") → ConfigSchema.parse
→ expandHome on the path fields → compute cross-field defaults → flat Config`.

- **Path fields** (`expandHome`): `vaultRoot`, `model.modelsJson`, `git.worktreeRoot`,
  `git.allowedRepoRoots[]`, `observability.stateDir`, `github.externalReposRoot`,
  `github.repos[].path`.
- **Cross-field defaults** (stay in code — zod can't express them cleanly): `github.askLabel`
  default `${triggerLabel}:ask`; `github.externalReposRoot` default `join(stateDir, "external")`;
  `github.plannerModelId ?? null`.
- **Deletions:** the `omlx`-casing accept and `camelizeKeys` both disappear — `model.compat`
  keys are camelCase now, so they merge straight onto `DEFAULT_COMPAT`.

### Path resolution + leftover-TOML guard
- `resolveConfigPath`: `--config` → `./config.json` if present → `~/.config/junco/config.json`
  (still respects `XDG_CONFIG_HOME`); `defaultUserConfigPath` swaps the basename to `config.json`.
- **Guard:** when `config.json` is absent *but* a `config.toml` sits at the resolved location,
  `loadConfig` (and `doctor`) throw an actionable error — *"TOML config was removed in vX.Y;
  convert to config.json (see docs/configuration.md). Your config.toml is untouched."* — never a
  raw ENOENT. This is what catches the live daemon and any npm user on upgrade.

## `src/configLevers.ts` — lever registry

```ts
export interface Lever {
  path: string;                 // dotted path into config.json, e.g. "worker.maxConcurrent"
  type: "boolean" | "number" | "enum" | "string" | "secret" | "structured";
  default: unknown;             // deep-equals the schema default (drift test)
  editable: boolean;            // false for structured
  reload: "live" | "restart";   // live = applied at next poll boundary; restart = needs a restart
  description: string;          // the explanation (only hand-authored content)
  enumValues?: string[];        // enum only
  min?: number; max?: number;   // number bounds, mirror zod
}
export const LEVERS: Lever[];   // ~60 entries, in section order
```

Type assignment: `model.apiKey` → `secret`; `tools`, `defaultLabels`, `allowedRepoRoots`,
`model.input`, `github.repos`, `model.compat`, `model.cost` → `structured` (`editable:false`);
everything else → its scalar type (`editable:true`).

`reload` assignment (the hot-reload partition — see the Daemon hot-reload section): `restart` for
levers baked into a bound resource or setup-captured wiring — `vaultRoot`, `juncoSubdir`, the whole
`observability` section (health socket + `stateDir` + log sinks), and `github.enabled`; `live` for
everything else (per-ticket/per-poll knobs). Consumed by the TUI and `config list`.
`junco config list` becomes the **canonical annotated reference**; `docs/configuration.md` shrinks
to a JSON skeleton + a pointer to `config list` rather than duplicating per-field prose (no
generator script — the registry is the one home for explanations).

### Drift test — `tests/configLevers.test.ts`
Walk the zod schema's leaf paths; assert a **bijection** with `LEVERS`: every schema leaf has
exactly one lever (no missing, no orphan); each lever's `default` deep-equals the schema default;
each lever's `type`/`enumValues`/`min`/`max` matches its schema node; and every lever carries a
`reload` value. Descriptions + the `reload` partition are the only hand-maintained fields;
types/defaults can never silently drift.

## CLI — `src/configCmd.ts`, wired in `src/cli.ts`

| Command | Behavior |
|---|---|
| `junco config path` | Print the resolved `config.json` path. |
| `junco config list` | Levers grouped by section: path · current value · default · type/allowed · description. Secrets masked. The annotated reference, now in-tool. |
| `junco config get <path>` | Print the current effective value (raw if set, else default) as JSON. `get model.apiKey` prints the secret (explicit ask). |
| `junco config set <path> <value>` | Coerce per lever `type` (bool / number+bounds / enum-membership / string); reject non-editable structured paths → "edit config.json directly"; validate the whole config; **atomic write** (temp+rename); print `old → new`; if the lever is `restart`-kind, warn "restart the daemon to apply" (live levers reload on their own via the watcher). |

- **Edits mutate the raw parsed JSON**, not the defaulted object → the file stays sparse (`set`
  only ever adds the touched key). Validation runs on a defaulted *copy*; the raw+edit is written.
- `set` on an unknown path, a bad enum value, an out-of-range number, or a structured path errors
  and writes nothing.
- Atomic write reuses the `src/tui/ghClient.ts` temp+rename pattern; re-read at write time so a
  file that changed since load is never clobbered.

## TUI — `src/tui/components/ConfigView.tsx`

- **Entry:** a new dashboard view opened by a free key (chosen at implementation from
  `g`/`o`/`,`, avoiding collisions with existing bindings); `Esc` returns.
- **Layout:** two panes. Left = section list (`vaultRoot`/`juncoSubdir`/`tools` top-level, then
  `model`, `worker`, `git`, `pr`, `verify`, `critic`, `planLint`, `observability`, `github`,
  `assess`). Right = the focused section's fields (label · current value); a detail footer shows
  the focused lever's `description` — where the explanations surface.
- **Editing per type:** bool → toggle; enum → cycle `enumValues`; number → inline input validated
  against `min`/`max`; string → inline input; `apiKey` → masked `••••` + masked input;
  **structured → dim, non-editable, "edit config.json" hint.**
- **Save:** commit → mutate raw JSON → validate whole config → success = atomic write (temp+rename)
  → failure = error toast + revert the field. Success toast is per the edited lever's `reload`:
  "Saved — applies live" vs "Saved — `junco restart` to apply" (see Surfacing).
- Reuses `tui/theme` + existing components and the `ghClient.ts` atomic-write pattern; writes
  directly (no `cliRunner` shell-out).

## Daemon hot-reload

The daemon and the editor (TUI or `config set`) are **separate processes**, so reload is
file-driven: the daemon watches `config.json` and re-loads on change. The architecture makes the
live subset cheap — `runOnce`/`runScheduler`/`execute`/`bridgeSweep` already take `cfg` **by
parameter**, so re-reading at the loop top applies new values to the *next* unit of work while an
in-flight ticket keeps the snapshot it was called with.

### `ConfigHolder` (`src/config.ts` or `src/configHolder.ts`)
A tiny mutable box — `{ current: Config }` with a guarded `set`. Created in the `start` handler,
initialized from `loadConfig`. `mainLoop` reads `holder.current` at the top of each iteration and
passes *that* to the worker entry points. **"live" means read from the holder at use-time** —
so the per-sweep GitHub/outbox throttle closures and the scheduler must consult `holder.current`
rather than a setup-captured `cfg` (the plan threads the holder into those closures; any consumer
that can't is reclassified `restart`).

### Config watcher (`src/configWatcher.ts`, behind a `watchFn` deps seam)
- **Watches the config's *directory*, filtered to the basename** — not the file. The atomic
  temp+rename write (used by TUI + CLI) swaps the inode, which staleifies a direct file-watch;
  a directory watch survives it. Events are **debounced** (~200ms) to collapse rename churn.
- On event: re-run `loadConfig` in try/catch.
  - **Success** → diff old vs new; `holder.set(new)`; if `logLevel` changed, call `setLogLevel`
    immediately (cheap global, safe live); classify every changed leaf via its lever's `reload`;
    record the set of changed `restart`-kind paths into `metrics.pendingRestartFields` and
    `log.warn("config changed; restart to apply", { fields })`.
  - **Failure** (bad JSON / schema) → `log.error`, keep the old config, keep running. A broken
    save never takes down the daemon.
- Started in the `start` handler alongside the loop; torn down in its `finally`.

### Restart-kind levers (not hot-applied)
The `observability` section (health server is bound to `healthHost`/`healthPort`; `stateDir` +
log sinks are opened once), `vaultRoot`/`juncoSubdir` (queue dirs are `mkdir`'d once and an
in-flight worktree references them), and `github.enabled` (reporter/bridge/outbox wiring is
captured at `mainLoop` setup). Changing these updates the on-disk file and the holder but does
**not** reconfigure the running daemon — `junco status` + `/health` list `pendingRestartFields`
so the operator knows a restart is owed.

### Surfacing
- `/health` JSON + `junco status` gain `pendingRestartFields: string[]`.
- TUI `ConfigView` renders a `↻ restart to apply` marker on `restart`-kind levers; on save it
  toasts "applies live" vs "restart to apply" per the edited lever's `reload`.
- `junco config set` warns "restart to apply" **only** when the target lever is `restart`-kind.

## Migration & rollout

1. `npm uninstall smol-toml` (drops it from `package.json` + lockfile).
2. `config.ts`: camelCase schema + JSON `loadConfig` + leftover-`.toml` guard.
3. `wizard.ts`: `renderConfigToml` → `renderConfigJson` (`JSON.stringify(obj, null, 2)`, no
   comments — explanations live in `config list`). Wizard writes `config.json`; its round-trip
   test now asserts `renderConfigJson` parses back through `loadConfig`.
4. Sweep the **41** `config.toml` references → `config.json` (docs, README, `service.ts` comments
   + emitted unit text, error strings, doctor). `docs/configuration.md`'s annotated TOML reference
   shrinks to a JSON skeleton that points at `junco config list` for per-field prose.
5. **Maintainer-confirmed live conversion** (main checkout, post-merge, *not* the shipped code):
   convert the live `config.toml` → `config.json`, rename the old file to `config.toml.bak`,
   `junco restart`, verify via `doctor` + `/health`.
6. Version bump + CHANGELOG (Keep a Changelog; breaking: config format). **Release on HOLD.**
7. **Residual-TOML sweep (final):** once the live daemon is confirmed healthy on `config.json`,
   grep the whole tree for any lingering `toml` / `smol-toml` / `config.toml` reference (code,
   docs, templates, examples, comments citing the old schema) and remove it; delete the
   `config.toml.bak` safety copy after a confidence window. End state: zero TOML anywhere.

## Testing

- **Drift test:** registry ↔ schema bijection (defaults, types, enums, bounds).
- **`loadConfig`:** valid JSON → Config; malformed JSON → friendly error; leftover `.toml` → guard
  error; defaults applied; `expandHome` on path fields; cross-field defaults (`askLabel`,
  `externalReposRoot`, `plannerModelId`).
- **`configCmd`:** `get`/`set`/`list`/`path`; per-type coercion; reject structured + bad enum +
  out-of-range; atomic write; masked secret in `list`; **sparse-file preservation** (`set` adds
  only the touched key).
- **wizard:** `renderConfigJson` round-trips through `loadConfig`.
- **ConfigView (Ink):** renders sections/fields/descriptions; edits of each scalar type write;
  structured read-only; invalid edit → toast + no write; `apiKey` masked; `↻ restart to apply`
  marker on `restart`-kind levers. Loop-until-condition per the Ink-flake gotcha (never a fixed
  `setTimeout` tick).
- **Config watcher (`watchFn` seam):** valid edit → holder updated + `logLevel` re-applied +
  `restart`-kind changes recorded to `pendingRestartFields`; malformed edit → holder unchanged, no
  crash; debounce collapses a rename burst to one reload; a directory-watch survives an atomic
  temp+rename (inode swap). Fake timers/injected `watchFn` — no real fs events.
- **Poll-boundary application:** `mainLoop` reads `holder.current` each iteration → a live edit
  reaches the next `runOnce`; an in-flight ticket keeps its param snapshot. Use the daemon-test
  real-tick yield (`await new Promise((r) => setTimeout(r, 1))`) so the instant fake `sleep`
  doesn't starve the macrotask queue.
- **status/health:** `pendingRestartFields` surfaces after a `restart`-kind change.
- **Regression:** existing `makeConfig`/`cfg()` fixtures are unaffected (flat `Config` unchanged);
  confirm `npm run typecheck` + full gate stay green.

## Risks & mitigations

- **Live daemon breaks on upgrade** → the leftover-`.toml` guard turns a cryptic failure into an
  actionable message; conversion is an explicit, `.bak`-protected rollout step.
- **Registry/schema drift** → the bijection test fails CI on any mismatch.
- **`set` clobbering a concurrently-edited file** → re-read at write time (watchlist pattern).
- **`fs.watch` unreliability** (macOS FSEvents vs Linux inotify; inode swap on atomic rename) →
  watch the *directory* not the file, debounce, and re-`loadConfig`+diff on every event so a
  spurious or coalesced event is a harmless no-op. `watchFn` is injectable for deterministic tests.
- **Reload applied mid-ticket** → prevented by construction: in-flight work holds its `cfg`
  parameter snapshot; the holder is only re-read at the loop top / next dispatch.
- **Malformed save crashes the daemon** → the watcher keeps the last-good config on any
  parse/validate failure; only a successful `loadConfig` swaps the holder.
- **Breaking external dispatchers** → config is *not* `ticketSchema.ts`; dispatchers generate
  tickets, not config, so the stable-contract rule is not implicated. Still a breaking change for
  humans, documented in CHANGELOG.
