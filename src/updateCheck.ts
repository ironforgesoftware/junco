/**
 * Best-effort npm update check (spec 2026-07-16). CLI/TUI-side only — the
 * daemon never checks and never restarts itself. Never throws: no network
 * (or a garbage registry response) degrades to "no badge".
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface SelfPackage {
  name: string;
  version: string;
  /** Dir containing our own package.json: repo root in dev, package root installed. */
  rootDir: string;
}

/** `../package.json` relative to this module — resolves from both src/ (vitest) and dist/ (installed CLI). */
export function getSelfPackage(): SelfPackage {
  const rootDir = fileURLToPath(new URL("..", import.meta.url));
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    name: string;
    version: string;
  };
  return { name: pkg.name, version: pkg.version, rootDir };
}

/**
 * Strict X.Y.Z compare (leading `v` tolerated). Junco publishes plain semver
 * to the `latest` dist-tag; anything else → null, which every caller treats
 * as "no update available" — never a badge on garbage.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | null {
  const parse = (v: string): number[] | null => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const pa = parse(a);
  const pb = parse(b);
  if (pa === null || pb === null) return null;
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}
