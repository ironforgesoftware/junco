/**
 * `junco assess` audit prompt — the ticket BODY for an assessment run: a
 * READ-ONLY security/vulnerability audit of the working directory, closing
 * with a precise output contract so `parseAgentFindings` (src/findings.ts)
 * can extract the result. Mirrors planPrompt.ts's directness — a checklist
 * and a contract, not an essay.
 */

import { FINDINGS_FENCE } from "./findings.js";

export function buildAssessPrompt(opts: { nwo: string | null; repoPath: string }): string {
  const target = opts.nwo
    ? `repository ${opts.nwo}, checked out at ${opts.repoPath}`
    : `the repository checked out at ${opts.repoPath}`;

  return (
    [
      `You are performing a READ-ONLY security and vulnerability assessment of ${target}. Make no writes, run no mutating commands, and create no commits or branches — this session only looks.`,
      `Check, at minimum:
- Dependency manifests (package.json, requirements.txt, go.mod, Cargo.toml, etc.) for known-vulnerable or carelessly unpinned versions.
- Code handling external input: request handlers, file/webhook payload parsing, CLI argument parsing.
- Authentication and authorization: missing checks, broken access control, privilege escalation.
- Secrets handling: hardcoded credentials/tokens/keys, secrets logged or written to disk.
- Injection surfaces: SQL, command, template, path, and log injection.
- Unsafe deserialization of untrusted data.
- Path traversal built from user-controlled input.`,
      `Report your findings as exactly ONE fenced block tagged \`${FINDINGS_FENCE}\` containing a JSON array; nothing outside that single fence is parsed. An empty array is the correct result when you find nothing.`,
      `Each array element is an object with these fields:
- \`kind\` (string, required): always "code" for this audit.
- \`severity\` (string, required): one of "critical", "high", "medium", "low".
- \`ruleId\` (string, required): a short, stable rule id (e.g. a CWE id).
- \`title\` (string, required): a one-line summary.
- \`description\` (string, optional): what the issue is and why it matters.
- \`evidence\` (string, optional): the relevant snippet or reasoning.
- \`remediation\` (string, optional): how to fix it.
- \`references\` (string[], optional): supporting links.
- \`location\` (object, optional): \`{ path, line? }\` — \`path\` is a file path relative to the repository root and MUST exist on disk (\`line\` is an optional line number). Findings citing a path that does not exist are discarded.`,
    ].join("\n\n") + "\n"
  );
}
