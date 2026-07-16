import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getSelfPackage, compareVersions } from "../src/updateCheck.js";

describe("getSelfPackage", () => {
  it("reads junco's own package.json (never hardcoded)", () => {
    const self = getSelfPackage();
    const pkg = JSON.parse(readFileSync(join(self.rootDir, "package.json"), "utf8")) as {
      name: string;
      version: string;
    };
    expect(self.name).toBe(pkg.name);
    expect(self.version).toBe(pkg.version);
    expect(self.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("compareVersions", () => {
  it("orders numeric triples", () => {
    expect(compareVersions("0.8.0", "0.7.0")).toBe(1);
    expect(compareVersions("0.7.0", "0.8.0")).toBe(-1);
    expect(compareVersions("0.7.0", "0.7.0")).toBe(0);
    expect(compareVersions("0.7.10", "0.7.9")).toBe(1);
    expect(compareVersions("1.0.0", "0.99.99")).toBe(1);
  });
  it("tolerates a leading v and surrounding whitespace", () => {
    expect(compareVersions("v0.8.0", "0.7.0")).toBe(1);
    expect(compareVersions(" 0.7.0 ", "0.7.0")).toBe(0);
  });
  it("returns null on anything unparseable (prerelease, garbage, empty)", () => {
    expect(compareVersions("0.8.0-beta.1", "0.7.0")).toBeNull();
    expect(compareVersions("0.8", "0.7.0")).toBeNull();
    expect(compareVersions("latest", "0.7.0")).toBeNull();
    expect(compareVersions("", "0.7.0")).toBeNull();
  });
});
