#!/usr/bin/env bash
# Package smoke test: pack the npm tarball, install it into a scratch prefix,
# and drive the installed CLI in a sandboxed HOME. This exercises the `files`
# allowlist, bin wiring, and config-init scaffold — the surface unit tests
# never see. Requires a prior `npm run build` (npm pack ships dist/ as-built).
set -euo pipefail

cd "$(dirname "$0")/.." # npm pack packs the cwd — anchor to the repo root
ROOT="$(pwd)"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

npm pack --pack-destination "$TMP" >/dev/null
npm install -g --prefix "$TMP/prefix" "$TMP"/ironforgesoftware-junco-*.tgz >/dev/null
JUNCO="$TMP/prefix/bin/junco"

# Sandbox: config resolution is env-pure — canonical ~/.junco/config.json,
# falling back to the legacy XDG path only while the canonical file doesn't
# exist (never argv/cwd) — point both HOME and XDG_CONFIG_HOME at TMP so the
# smoke run can never touch a real setup.
SB="$TMP/sandbox"
mkdir -p "$SB"
cd "$SB"
export HOME="$SB"
export XDG_CONFIG_HOME="$SB/.config"

"$JUNCO" --help >/dev/null

"$JUNCO" config init
CONFIG="$SB/.junco/config.json"
[ -f "$CONFIG" ] || { echo "FAIL: config init did not write $CONFIG"; exit 1; }

"$JUNCO" schema | node -e "JSON.parse(require('node:fs').readFileSync(0, 'utf8'))" \
  || { echo "FAIL: schema did not print valid JSON"; exit 1; }

INBOX="$("$JUNCO" inbox-path)"
[ -d "$INBOX" ] || { echo "FAIL: inbox dir missing: $INBOX"; exit 1; }

# Single-root containment: nothing may sprawl outside ~/.junco (plan 2026-08-03)
if [ -e "$SB/.local/state/junco" ] || [ -e "$SB/.config/junco" ]; then
  echo "FAIL: junco wrote outside \$HOME/.junco" >&2
  ls -la "$SB/.local/state" "$SB/.config" 2>/dev/null >&2 || true
  exit 1
fi

# Full depth: the INSTALLED binary processes a ticket end to end against the
# scripted model stub — the same pr-happy-path scenario the e2e suite runs
# against dist/. HOME is still the sandbox here; the harness overrides it per
# run anyway. The repo root is the vitest cwd (config, node_modules).
#
# Selected by FILE, not `-t` alone: `vitest run -t <no-match>` exits 0 with
# everything skipped, so a renamed test would turn this into a silent no-op
# under `set -euo pipefail`. A non-existent file argument exits 1 with "No
# test files found" instead — that's the real guard; `-t` stays on as the belt
# so a matching but wrong-file test can't slip through either.
(cd "$ROOT" && JUNCO_E2E_BIN="$JUNCO" "$ROOT/node_modules/.bin/vitest" run -c vitest.e2e.config.ts tests/e2e/prFlow.e2e.ts -t pr-happy-path)

echo "package smoke OK (config: $CONFIG, inbox: $INBOX)"
