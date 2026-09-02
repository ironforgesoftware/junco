import { describe, it, expect } from "vitest";
import { MASKED_TMP, SANDBOX_FALLBACK_BASE, sandboxBaseDir } from "./e2e/harness.js";

/**
 * The e2e sandbox must not live under a path the OS sandbox backend masks.
 *
 * bwrap starts every sandboxed bash call with `--tmpfs /tmp`
 * (src/agent/sandbox/backend.ts:274), so on Linux — where os.tmpdir() IS
 * /tmp — the agent saw an EMPTY /tmp: only the paths the policy binds
 * explicitly (the linked worktree's gitdir, objects, refs, logs) were
 * re-exposed, while the repo's own `.git/config` — readable in production
 * only through bwrap's `--ro-bind / /` — was hidden. `git commit` therefore
 * made no commit, junco reported "no commits but wt dirty", and both PR-flow
 * scenarios failed on ubuntu while macOS (os.tmpdir() = /var/folders/...)
 * passed. PR #435, quality gate (ubuntu-latest) run 33592022083.
 *
 * These cases are the regression guard: they run on every platform because
 * `sandboxBaseDir` takes its inputs, so macOS CI pins the Linux behavior.
 */
describe("sandboxBaseDir (e2e harness)", () => {
  it("redirects a masked /tmp to the fallback base", () => {
    expect(sandboxBaseDir("/tmp", () => true)).toBe(SANDBOX_FALLBACK_BASE);
  });

  it("redirects any subdirectory of the masked root too", () => {
    expect(sandboxBaseDir("/tmp/nested", () => true)).toBe(SANDBOX_FALLBACK_BASE);
  });

  it("leaves an unmasked temp root alone", () => {
    const macos = "/var/folders/q5/5nwbq2/T";
    expect(sandboxBaseDir(macos, () => true)).toBe(macos);
    expect(sandboxBaseDir("/var/tmp", () => true)).toBe("/var/tmp");
  });

  it("never returns the fallback when it does not exist — the caller's temp root stands", () => {
    expect(sandboxBaseDir("/tmp", () => false)).toBe("/tmp");
  });

  it("does not mistake a sibling whose name merely starts with the masked root", () => {
    expect(sandboxBaseDir("/tmpfoo", () => true)).toBe("/tmpfoo");
  });

  it("exports the masked root the product actually masks", () => {
    expect(MASKED_TMP).toBe("/tmp");
    expect(SANDBOX_FALLBACK_BASE).toBe("/var/tmp");
  });
});
