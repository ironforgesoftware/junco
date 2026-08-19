/**
 * The installed package's root directory (one level above dist/ at runtime,
 * one above src/ under vitest) — the anchor for packaged assets: skills/,
 * templates/, examples/. Hoisted from planPrompt.ts so skillLinks.ts and
 * planPrompt.ts can never disagree about where the package lives.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The packaged skills/ dir — the content source every skill link resolves to. */
export function packageSkillsDir(): string {
  return join(PACKAGE_ROOT, "skills");
}
