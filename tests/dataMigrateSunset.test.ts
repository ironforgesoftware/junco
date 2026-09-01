import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";

// The pre-0.10 flat-layout / vaultRoot migration machinery (dataMigrateCmd.ts
// + migratePathRewrite.ts, ~2,400 lines) had no end date (#360). The decision
// — removed in 1.0 — is recorded in docs/configuration.md and the module
// header; these checks keep both statements present and make the 1.0 version
// bump trip over the code instead of carrying it past its sunset.
const root = new URL("../", import.meta.url);
const read = (rel: string): string => readFileSync(new URL(rel, root), "utf8");

/** The `### \`junco data migrate\`` section of docs/configuration.md, up to the next heading. */
function migrateSection(doc: string): string {
  const lines = doc.split("\n");
  const start = lines.findIndex((l) => /^### `junco data migrate`/.test(l));
  if (start < 0) throw new Error("docs/configuration.md has no `junco data migrate` section");
  const end = lines.findIndex((l, i) => i > start && /^#+ /.test(l));
  return lines.slice(start, end < 0 ? lines.length : end).join("\n");
}

describe("pre-0.10 migration sunset (#360)", () => {
  it("docs/configuration.md's `junco data migrate` section records removal in 1.0", () => {
    expect(migrateSection(read("docs/configuration.md"))).toMatch(/removed in 1\.0/);
  });

  it("src/dataMigrateCmd.ts's module header carries the same sunset", () => {
    const src = read("src/dataMigrateCmd.ts");
    const header = src.slice(0, src.indexOf("*/"));
    expect(header).toMatch(/#360/);
    expect(header).toMatch(/removed in 1\.0/);
  });

  it("carries the machinery through 0.x and drops it at the 1.0 bump", () => {
    const { version } = JSON.parse(read("package.json")) as { version: string };
    const major = Number(version.split(".")[0]);
    const present = ["src/dataMigrateCmd.ts", "src/migratePathRewrite.ts"].filter((rel) =>
      existsSync(new URL(rel, root)),
    );
    expect(present.length > 0).toBe(major < 1);
  });
});
