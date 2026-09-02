/**
 * tests/helpers/ghScript.ts — generators for the fake `gh`/`git` shell shims the
 * PR-flow tests drive the orchestrator against.
 *
 * ONLY the envelope generators live here. Each test's CASE TABLE stays at its
 * call site: the `*) … exit 1` fallback is a negative assertion that the code
 * under test invoked exactly the subcommands the test scripted and no others.
 * A single mega-`gh` that answered everything would silently accept a wrong
 * call — so there is deliberately no permissive default (spec 2026-07-21 §1.2).
 *
 * These were invented inside prFlow.test.ts (its `describe` closed over the
 * harness root); hoisting them here with an explicit `dir` parameter shrinks
 * that 2,150-line file and gives future PR-flow suites the same seam. Other
 * suites' fakes (repo/pr's env-driven scripts, git's env dumper, planLint's
 * label printer) are a different, internally-DRY shape and are left alone.
 */
import { writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

/**
 * A fake `gh` that answers `repo view --json nameWithOwner` with `nwo`, then
 * dispatches `$args` against `cases` (a `"glob"* => sh body` map), and fails
 * anything unmatched with exit 1.
 */
export function ghCases(
  dir: string,
  name: string,
  cases: Record<string, string>,
  nwo = "owner/repo",
): string {
  const branches = Object.entries(cases)
    .map(([glob, body]) => `  ${glob})\n    ${body} ;;`)
    .join("\n");
  const p = join(dir, name);
  writeFileSync(
    p,
    `#!/bin/sh
args="$*"
case "$args" in
  "repo view --json nameWithOwner -q .nameWithOwner"*)
    echo "${nwo}"; exit 0 ;;
${branches}
  *)
    echo "fake-gh: unhandled: $args" >&2; exit 1 ;;
esac
`,
    "utf8",
  );
  chmodSync(p, 0o755);
  return p;
}

/** A fake `gh` that answers `repo view` and runs `prCreateBody` for `pr create`. */
export function ghShim(dir: string, name: string, prCreateBody: string): string {
  return ghCases(dir, name, { '"pr create "*': prCreateBody });
}

/**
 * A `git` wrapper that appends every invocation's argv (space-joined, one line
 * per call) to `logFile` and then execs the real git — so a test can assert the
 * exact argv the code under test built while the operation still really runs.
 */
export function gitLogShim(dir: string, name: string, logFile: string): string {
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const p = join(dir, name);
  writeFileSync(
    p,
    `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(logFile)}
exec ${JSON.stringify(realGit)} "$@"
`,
    "utf8",
  );
  chmodSync(p, 0o755);
  return p;
}

/**
 * A `git` wrapper that fails the named subcommand with a scripted stderr line
 * and execs the real git for everything else. `subcommand` is matched as a
 * standalone argv token (none of the flow's other git calls carry it).
 */
export function gitFailShim(
  dir: string,
  name: string,
  subcommand: string,
  stderrLine: string,
): string {
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const p = join(dir, name);
  writeFileSync(
    p,
    `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "${subcommand}" ]; then
    echo ${JSON.stringify(stderrLine)} >&2
    exit 1
  fi
done
exec ${JSON.stringify(realGit)} "$@"
`,
    "utf8",
  );
  chmodSync(p, 0o755);
  return p;
}
