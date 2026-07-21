// Covers tests/helpers/gitHarness.ts — the shared real-git harness.
//
// The second test is the load-bearing one: cloneHarness() exists only because
// building the tree costs ~142ms (10 git subprocesses) while cpSync-ing a
// prebuilt one costs ~7ms. That is worthless if a COPIED bare remote no longer
// accepts a push, so this pins it.
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, setupGitHarness, cloneHarness } from "./helpers/gitHarness.js";

const dirs: string[] = [];
const tmp = (p: string): string => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("gitHarness", () => {
  it("setupGitHarness seeds a clone whose origin is on main", () => {
    const h = setupGitHarness(tmp("gh-setup-"));
    expect(run(["git", "-C", h.work, "rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe("main");
    expect(run(["git", "-C", h.remote, "rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe("main");
  });

  it("a cloned harness accepts a push to its copied remote", () => {
    const h = cloneHarness(tmp("gh-clone-"));
    writeFileSync(join(h.work, "new.txt"), "x\n");
    run(["git", "-C", h.work, "add", "new.txt"]);
    run(["git", "-C", h.work, "commit", "-m", "add"]);
    run(["git", "-C", h.work, "push", "origin", "main"]);
    expect(run(["git", "-C", h.remote, "rev-parse", "main"]).trim()).toBe(
      run(["git", "-C", h.work, "rev-parse", "main"]).trim(),
    );
  });

  it("two clones are independent", () => {
    const a = cloneHarness(tmp("gh-a-"));
    const b = cloneHarness(tmp("gh-b-"));
    writeFileSync(join(a.work, "only-a.txt"), "a\n");
    run(["git", "-C", a.work, "add", "only-a.txt"]);
    run(["git", "-C", a.work, "commit", "-m", "a"]);
    run(["git", "-C", a.work, "push", "origin", "main"]);
    expect(run(["git", "-C", a.remote, "rev-parse", "main"]).trim()).not.toBe(
      run(["git", "-C", b.remote, "rev-parse", "main"]).trim(),
    );
  });
});
