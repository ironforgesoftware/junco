/**
 * tests/e2e/globalSetup.ts — the suite runs a BUILT binary. Fail loudly if it
 * is missing rather than building here: an implicit rebuild would hide a stale
 * dist/ (the same honesty rule scripts/package-smoke.sh follows).
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export default function setup(): void {
  const bin = process.env.JUNCO_E2E_BIN ?? resolve(process.cwd(), "dist/cli.js");
  if (!existsSync(bin)) {
    throw new Error(
      `e2e: binary under test not found at ${bin} — run \`npm run build\` first (or set JUNCO_E2E_BIN)`,
    );
  }
}
