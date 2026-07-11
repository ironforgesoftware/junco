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
6. **`config set` while the daemon runs = warn and proceed** (matches the watchlist writer; the
   daemon reads config only at startup, so a mid-run write is harmless — the warning says
   "restart to apply").

## Non-goals

- **Config hot-reload.** Changes take effect on daemon restart. No SIGHUP/reload path.
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
  description: string;          // the explanation (only hand-authored content)
  enumValues?: string[];        // enum only
  min?: number; max?: number;   // number bounds, mirror zod
}
export const LEVERS: Lever[];   // ~60 entries, in section order
```

Type assignment: `model.apiKey` → `secret`; `tools`, `defaultLabels`, `allowedRepoRoots`,
`model.input`, `github.repos`, `model.compat`, `model.cost` → `structured` (`editable:false`);
everything else → its scalar type (`editable:true`). Consumed by the TUI and `config list`.
`junco config list` becomes the **canonical annotated reference**; `docs/configuration.md` shrinks
to a JSON skeleton + a pointer to `config list` rather than duplicating per-field prose (no
generator script — the registry is the one home for explanations).

### Drift test — `tests/configLevers.test.ts`
Walk the zod schema's leaf paths; assert a **bijection** with `LEVERS`: every schema leaf has
exactly one lever (no missing, no orphan); each lever's `default` deep-equals the schema default;
each lever's `type`/`enumValues`/`min`/`max` matches its schema node. Descriptions are the only
thing hand-maintained; types/defaults can never silently drift.

## CLI — `src/configCmd.ts`, wired in `src/cli.ts`

| Command | Behavior |
|---|---|
| `junco config path` | Print the resolved `config.json` path. |
| `junco config list` | Levers grouped by section: path · current value · default · type/allowed · description. Secrets masked. The annotated reference, now in-tool. |
| `junco config get <path>` | Print the current effective value (raw if set, else default) as JSON. `get model.apiKey` prints the secret (explicit ask). |
| `junco config set <path> <value>` | Coerce per lever `type` (bool / number+bounds / enum-membership / string); reject non-editable structured paths → "edit config.json directly"; validate the whole config; **atomic write** (temp+rename); print `old → new`; warn "restart the daemon to apply" if one is running. |

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
  → failure = error toast + revert the field. "Saved — `junco restart` to apply" toast when a
  daemon is up.
- Reuses `tui/theme` + existing components and the `ghClient.ts` atomic-write pattern; writes
  directly (no `cliRunner` shell-out).

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
  structured read-only; invalid edit → toast + no write; `apiKey` masked. Loop-until-condition
  per the Ink-flake gotcha (never a fixed `setTimeout` tick).
- **Regression:** existing `makeConfig`/`cfg()` fixtures are unaffected (flat `Config` unchanged);
  confirm `npm run typecheck` + full gate stay green.

## Risks & mitigations

- **Live daemon breaks on upgrade** → the leftover-`.toml` guard turns a cryptic failure into an
  actionable message; conversion is an explicit, `.bak`-protected rollout step.
- **Registry/schema drift** → the bijection test fails CI on any mismatch.
- **`set` clobbering a concurrently-edited file** → re-read at write time (watchlist pattern).
- **Breaking external dispatchers** → config is *not* `ticketSchema.ts`; dispatchers generate
  tickets, not config, so the stable-contract rule is not implicated. Still a breaking change for
  humans, documented in CHANGELOG.
