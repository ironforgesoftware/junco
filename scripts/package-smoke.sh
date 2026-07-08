#!/usr/bin/env bash
# Package smoke test: pack the npm tarball, install it into a scratch prefix,
# and drive the installed CLI in a sandboxed HOME. This exercises the `files`
# allowlist, bin wiring, and init scaffold — the surface unit tests never see.
# Requires a prior `npm run build` (npm pack ships dist/ as-built).
set -euo pipefail

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

npm pack --pack-destination "$TMP" >/dev/null
npm install -g --prefix "$TMP/prefix" "$TMP"/ironforgesoftware-junco-*.tgz >/dev/null
JUNCO="$TMP/prefix/bin/junco"

# Sandbox: config resolution prefers ./config.toml then XDG — point both at TMP
# so the smoke run can never touch a real setup.
SB="$TMP/sandbox"
mkdir -p "$SB"
cd "$SB"
export HOME="$SB"
export XDG_CONFIG_HOME="$SB/.config"

"$JUNCO" --help >/dev/null

"$JUNCO" init --yes
CONFIG="$SB/.config/junco/config.toml"
[ -f "$CONFIG" ] || { echo "FAIL: init --yes did not write $CONFIG"; exit 1; }

"$JUNCO" schema | node -e "JSON.parse(require('node:fs').readFileSync(0, 'utf8'))" \
  || { echo "FAIL: schema did not print valid JSON"; exit 1; }

INBOX="$("$JUNCO" inbox-path)"
[ -d "$INBOX" ] || { echo "FAIL: inbox dir missing: $INBOX"; exit 1; }

echo "package smoke OK (config: $CONFIG, inbox: $INBOX)"
