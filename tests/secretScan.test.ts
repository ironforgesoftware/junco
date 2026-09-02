/**
 * Tests for src/secretScan.ts — the pre-push secret scan (#337).
 *
 * FIXTURE RULE: every sample secret is ASSEMBLED AT RUNTIME from fragments so
 * this file's own bytes never carry a shape the scanner matches. Junco works on
 * this repo — a verbatim token here would make the scan block junco's own PRs.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  scanDiffForSecrets,
  scanPendingPush,
  formatSecretFindings,
  type SecretFinding,
} from "../src/secretScan.js";

const SAMPLE: Record<string, { text: string; rule: string }> = {
  pem: { text: "-----BEGIN RSA PRIVATE" + " KEY-----", rule: "pem-private-key" },
  githubClassic: { text: "ghp_" + "A".repeat(36), rule: "github-token" },
  githubFineGrained: { text: "github_pat_" + "B".repeat(30), rule: "github-token" },
  githubOauth: { text: "gho_" + "C".repeat(36), rule: "github-token" },
  aws: { text: "AKIA" + "IOSFODNN7EXAMPLE", rule: "aws-access-key-id" },
  anthropic: { text: "sk-ant-" + "api03-" + "x".repeat(24), rule: "anthropic-api-key" },
  stripe: { text: "sk_live_" + "4eC39HqLyjWDarjtT1zdp7dc", rule: "stripe-live-key" },
  slack: { text: "xoxb-" + "123456789012-abcdefghijkl", rule: "slack-token" },
  npm: { text: "npm_" + "c".repeat(36), rule: "npm-token" },
  url: {
    text: "https://" + "deploy:" + "hunter2" + "@example.com/repo.git",
    rule: "url-credentials",
  },
};

/** A minimal single-hunk unified diff whose added lines start at `startLine`. */
function addedDiff(path: string, startLine: number, added: string[]): string {
  return (
    [
      `diff --git a/${path} b/${path}`,
      `--- a/${path}`,
      `+++ b/${path}`,
      `@@ -${startLine},0 +${startLine},${added.length} @@`,
      ...added.map((l) => `+${l}`),
    ].join("\n") + "\n"
  );
}

describe("scanDiffForSecrets", () => {
  it("flags every high-confidence shape on an added line", () => {
    for (const [name, { text, rule }] of Object.entries(SAMPLE)) {
      const findings = scanDiffForSecrets(addedDiff("src/leak.ts", 1, [`const x = "${text}";`]));
      expect(findings, name).toEqual([{ path: "src/leak.ts", line: 1, rule }]);
    }
  });

  it("returns nothing for a diff with no secret shapes", () => {
    const diff = addedDiff("src/ok.ts", 4, [
      "const greeting = 'hello';",
      "export default greeting;",
    ]);
    expect(scanDiffForSecrets(diff)).toEqual([]);
  });

  it("reports path + line only — never the matched content", () => {
    const secret = SAMPLE.githubClassic.text;
    const findings = scanDiffForSecrets(addedDiff(".env", 2, [`GH_TOKEN=${secret}`]));
    expect(findings).toHaveLength(1);
    expect(JSON.stringify(findings)).not.toContain(secret);
    expect(JSON.stringify(findings)).not.toContain("GH_TOKEN");
  });

  it("counts context lines so the reported line is the post-image line", () => {
    const diff =
      [
        "diff --git a/src/a.ts b/src/a.ts",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -10,3 +10,5 @@ function f() {",
        " const before = 1;",
        `+const key = "${SAMPLE.aws.text}";`,
        " const between = 2;",
        `+const other = "${SAMPLE.npm.text}";`,
        " const after = 3;",
      ].join("\n") + "\n";
    expect(scanDiffForSecrets(diff)).toEqual([
      { path: "src/a.ts", line: 11, rule: "aws-access-key-id" },
      { path: "src/a.ts", line: 13, rule: "npm-token" },
    ]);
  });

  it("ignores removed lines — only what the push ADDS is scanned", () => {
    const diff =
      [
        "diff --git a/src/a.ts b/src/a.ts",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -1,2 +1,1 @@",
        `-const key = "${SAMPLE.aws.text}";`,
        "+const key = process.env.AWS_KEY;",
      ].join("\n") + "\n";
    expect(scanDiffForSecrets(diff)).toEqual([]);
  });

  it("attributes each finding to the file its hunk belongs to", () => {
    const diff =
      addedDiff("a/first.txt", 1, [SAMPLE.pem.text]) +
      addedDiff("b/second.txt", 7, ["clean line", SAMPLE.slack.text]);
    expect(scanDiffForSecrets(diff)).toEqual([
      { path: "a/first.txt", line: 1, rule: "pem-private-key" },
      { path: "b/second.txt", line: 8, rule: "slack-token" },
    ]);
  });

  it("skips a deletion hunk (+++ /dev/null) — there is no post-image to leak", () => {
    const diff =
      [
        "diff --git a/secrets.pem b/secrets.pem",
        "--- a/secrets.pem",
        "+++ /dev/null",
        "@@ -1,1 +0,0 @@",
        `-${SAMPLE.pem.text}`,
      ].join("\n") + "\n";
    expect(scanDiffForSecrets(diff)).toEqual([]);
  });

  it("never scans the diff's own +++ header as an added line", () => {
    const diff = addedDiff(`fixtures/${SAMPLE.aws.text}.txt`, 1, ["clean"]);
    expect(scanDiffForSecrets(diff)).toEqual([]);
  });

  it("reports one finding per line even when several shapes match it", () => {
    const diff = addedDiff("src/a.ts", 1, [`${SAMPLE.aws.text} ${SAMPLE.npm.text}`]);
    expect(scanDiffForSecrets(diff)).toHaveLength(1);
  });

  it("returns nothing for an empty diff", () => {
    expect(scanDiffForSecrets("")).toEqual([]);
  });

  // Junco pushes this repo. A rule whose own source text matches it — or a
  // fixture written verbatim rather than assembled — would make the gate block
  // every PR that touches these two files.
  it("finds nothing in its own source or in this test file", () => {
    for (const rel of ["src/secretScan.ts", "tests/secretScan.test.ts"]) {
      const lines = readFileSync(join(import.meta.dirname, "..", rel), "utf8").split("\n");
      expect(scanDiffForSecrets(addedDiff(rel, 1, lines)), rel).toEqual([]);
    }
  });
});

describe("scanPendingPush", () => {
  const cfg = { gitBin: "git" };

  it("scans the diff the injected provider returns", async () => {
    const seen: Array<{ wtPath: string; sinceRef: string }> = [];
    const findings = await scanPendingPush(cfg, "/wt", "origin/main", {
      diffProvider: async (_cfg, wtPath, sinceRef) => {
        seen.push({ wtPath, sinceRef });
        return addedDiff("src/x.ts", 3, [SAMPLE.anthropic.text]);
      },
    });
    expect(seen).toEqual([{ wtPath: "/wt", sinceRef: "origin/main" }]);
    expect(findings).toEqual([{ path: "src/x.ts", line: 3, rule: "anthropic-api-key" }]);
  });

  it("passes cfg through to the provider", async () => {
    let received: { gitBin: string } | null = null;
    await scanPendingPush(cfg, "/wt", "origin/main", {
      diffProvider: async (c) => {
        received = c;
        return "";
      },
    });
    expect(received).toBe(cfg);
  });
});

describe("formatSecretFindings", () => {
  it("names every finding as path:line (rule)", () => {
    const findings: SecretFinding[] = [
      { path: "src/a.ts", line: 11, rule: "aws-access-key-id" },
      { path: ".env", line: 2, rule: "github-token" },
    ];
    expect(formatSecretFindings(findings)).toBe(
      "2 matches — src/a.ts:11 (aws-access-key-id), .env:2 (github-token)",
    );
  });

  it("uses the singular for one match", () => {
    expect(formatSecretFindings([{ path: "a", line: 1, rule: "npm-token" }])).toBe(
      "1 match — a:1 (npm-token)",
    );
  });

  it("caps the listed findings and counts the rest", () => {
    const findings: SecretFinding[] = Array.from({ length: 12 }, (_, i) => ({
      path: `f${i}.ts`,
      line: i + 1,
      rule: "npm-token",
    }));
    const text = formatSecretFindings(findings);
    expect(text).toContain("12 matches");
    expect(text).toContain("f0.ts:1 (npm-token)");
    expect(text).toContain("+2 more");
    expect(text).not.toContain("f10.ts");
  });
});
