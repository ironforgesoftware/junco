// Covers tests/helpers/ghScript.ts — the fake gh/git shim generators.
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ghCases, ghShim, gitFailShim } from "./helpers/ghScript.js";

const d = mkdtempSync(join(tmpdir(), "ghs-"));
afterAll(() => rmSync(d, { recursive: true, force: true }));

const sh = (bin: string, args: string[]): { code: number; out: string } => {
  try {
    return { code: 0, out: execFileSync(bin, args, { encoding: "utf8" }) };
  } catch (e) {
    const err = e as { status?: number; stdout?: string };
    return { code: err.status ?? 1, out: err.stdout ?? "" };
  }
};

describe("ghCases", () => {
  it("answers repo view with the default nwo", () => {
    const bin = ghCases(d, "gh-nwo.sh", {});
    expect(
      sh(bin, ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]).out.trim(),
    ).toBe("owner/repo");
  });

  it("dispatches a scripted subcommand", () => {
    const bin = ghCases(d, "gh-list.sh", { '"pr list "*': 'echo "[]"; exit 0' });
    expect(sh(bin, ["pr", "list", "--state", "open"]).out.trim()).toBe("[]");
  });

  it("takes a custom nwo (may be a shell expression)", () => {
    const bin = ghCases(d, "gh-env.sh", {}, "${FAKE_NWO:-fallback/repo}");
    expect(
      sh(bin, ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]).out.trim(),
    ).toBe("fallback/repo");
  });

  // The strict fallback is a negative assertion: an unscripted call must fail.
  it("exits non-zero on an unmatched subcommand", () => {
    const bin = ghCases(d, "gh-strict.sh", { '"pr create "*': "exit 0" });
    expect(sh(bin, ["repo", "delete"]).code).not.toBe(0);
  });
});

describe("ghShim", () => {
  it("answers repo view and runs the pr-create body", () => {
    const bin = ghShim(d, "gh-shim.sh", 'echo "https://x/pull/1"; exit 0');
    expect(sh(bin, ["pr", "create", "--title", "t"]).out.trim()).toBe("https://x/pull/1");
  });
});

describe("gitFailShim", () => {
  it("fails the named subcommand but delegates others to real git", () => {
    const bin = gitFailShim(d, "git-nopush.sh", "push", "boom");
    expect(sh(bin, ["push", "origin", "main"]).code).not.toBe(0);
    // A non-push git call still works (real git prints its version).
    expect(sh(bin, ["--version"]).out).toMatch(/git version/);
  });
});
