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
