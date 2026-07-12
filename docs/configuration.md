# Configuration

Junco is configured via a JSON file — `./config.json` if present, else `~/.config/junco/config.json` (the wizard writes the latter unless you pass `--config`; respects `XDG_CONFIG_HOME`). Every field is optional except `vaultRoot`; anything you omit falls back to its default.

[← back to the README](../README.md)

## Minimal example

```json
{
  "vaultRoot": "~/junco-vault",
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

`vaultRoot` is required — the queue lives at `<vaultRoot>/<juncoSubdir>/{inbox,processing,done,failed}`. `tools` sets the coding agent's tool allowlist. `model` describes the inference endpoint (point `model.modelsJson` at a Pi-style `models.json` instead of the inline fields if you'd rather load the provider+model from there). Everything else — `worker`, `supervisor`, `git`, `pr`, `verify`, `sandbox`, `critic`, `planLint`, `observability`, `github`, `assess` — is a sectioned object with sensible defaults; set only the keys you want to override.

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

## The full reference

The full, always-current annotated reference is `junco config list` — every lever with its default, type, and one-line explanation:

```bash
junco config list                       # every lever
junco config get worker.maxConcurrent   # one value
junco config set model.id myprovider/my-model
```

Edit interactively in the dashboard config view (press `,`), or with `junco config path` to print the resolved file location. Structural fields (`editable: false` in `junco config list`, e.g. `tools`) require a direct edit of `config.json`.

## Hot-reload

The daemon re-reads `config.json` on change. Live-safe levers (e.g. most `worker`/`supervisor`/`model` knobs) apply at the next poll with no restart. Structural levers (e.g. `vaultRoot`, `juncoSubdir`, `worker.maxConcurrent`) need `junco restart` to take effect — until then they show up in `pendingRestartFields` in `junco status` and the `/health` endpoint, so a pending change is never silently ignored.

## TOML is no longer supported

Earlier versions used `config.toml`. TOML support (and the `smol-toml` dependency) has been removed — `config.json` is the only format Junco reads. If `parseConfigFile` can't find `config.json` at the resolved path but finds a `config.toml` sitting right next to it, it fails with a guard error pointing at this doc instead of a generic "file not found" — your `config.toml` is left untouched, so nothing is lost. Convert it by hand: the old `[pi]` model-id key and `[oMLX]` section map to `model.id` / `model.baseUrl` / `model.apiKey`, the `--tools` CSV maps to top-level `tools`, the old top-level commit-leftovers key maps to `worker.commitLeftovers`, and every other key is the same name camelCased under its section.
