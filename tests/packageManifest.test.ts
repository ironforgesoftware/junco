import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// The npm tarball is the `files` allowlist as-built (#379). tsc emits a
// `.js.map` beside every `dist/**/*.js` whose `sources` point at `../src/...`
// — not in the allowlist — so an installed copy would carry 200+ maps that
// resolve to nothing, a third of the package. npm-packlist turns `files` into
// ordered ignore rules (`*`, then one `!entry` per item, last match wins), so
// the negation only bites if it is listed AFTER the `dist` entry it carves from.
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  bin: Record<string, string>;
  files: string[];
  exports?: unknown;
  main?: unknown;
};

describe("package.json publish surface", () => {
  it("excludes tsc source maps from the tarball, after the dist entry they carve from", () => {
    const dist = pkg.files.indexOf("dist");
    const noMaps = pkg.files.indexOf("!dist/**/*.js.map");
    expect(dist).toBeGreaterThanOrEqual(0);
    expect(noMaps).toBeGreaterThan(dist);
  });

  it("is bin-only: an empty exports map states there is no import surface", () => {
    // Dispatchers consume `junco schema` JSON, never `import`s of dist/ —
    // `exports: {}` makes that a stated contract (deep imports of dist/ paths
    // fail with ERR_PACKAGE_PATH_NOT_EXPORTED) without touching the bin, which
    // npm links straight from `bin` and never resolves through `exports`.
    expect(pkg.bin).toEqual({ junco: "dist/cli.js" });
    expect(pkg.exports).toEqual({});
    expect(pkg.main).toBeUndefined();
  });
});
