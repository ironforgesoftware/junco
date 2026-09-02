import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PACKAGE_ROOT, packageSkillsDir } from "../src/packageRoot.js";

// Toolchain smoke: a NodeNext `.js` specifier resolves to the TS source under
// vitest, and that module's `import.meta.url`-anchored root really is the
// package (the anchor every packaged asset — skills/, templates/, examples/ —
// resolves from). A self-comparing literal proved neither.
describe("toolchain", () => {
  it("resolves a NodeNext `.js` import to src/ and anchors PACKAGE_ROOT on the package", () => {
    const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as {
      name: string;
    };
    expect(pkg.name).toBe("@ironforgesoftware/junco");
    expect(existsSync(packageSkillsDir())).toBe(true);
  });
});
