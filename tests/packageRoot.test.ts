import { describe, it, expect } from "vitest";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PACKAGE_ROOT, packageSkillsDir } from "../src/packageRoot.js";

// This test file is tests/packageRoot.test.ts — one level below the package
// root, exactly like src/packageRoot.ts (and like dist/packageRoot.js once
// built). That makes its own location an oracle independent of the module's
// arithmetic: three importers (planPrompt, skillLinks, restartCmd) resolve
// packaged assets off PACKAGE_ROOT, so an off-by-one level breaks all of them
// only at runtime (#369).
const oracleRoot = dirname(dirname(fileURLToPath(import.meta.url)));

describe("PACKAGE_ROOT", () => {
  it("resolves one level above the module's own dir", () => {
    expect(PACKAGE_ROOT).toBe(oracleRoot);
  });

  it("lands on the dir holding this package's package.json", () => {
    const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"));
    expect(pkg.name).toBe("@ironforgesoftware/junco");
  });
});

describe("packageSkillsDir", () => {
  it("points at the real packaged skills dir", () => {
    expect(packageSkillsDir()).toBe(join(PACKAGE_ROOT, "skills"));
    expect(statSync(packageSkillsDir()).isDirectory()).toBe(true);
    expect(statSync(join(packageSkillsDir(), "junco-dispatch", "SKILL.md")).isFile()).toBe(true);
  });

  it("points at a dir the npm package actually ships", () => {
    const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"));
    expect(pkg.files).toContain("skills");
  });
});
