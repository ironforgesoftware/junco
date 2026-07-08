import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  SEVERITY_RANK,
  AgentFindingSchema,
  fingerprintFinding,
  sanitizeFindingText,
  FINDINGS_FENCE,
  extractLastFencedBlock,
  parseAgentFindings,
  FINDING_MARKER_PREFIX,
  findingMarker,
  extractFindingMarkers,
} from "../src/findings.js";

// Wraps a JSON payload in a fenced ```junco-findings block, mirroring how the
// agent's finalText carries the array (see extractPlanBody tests in
// tests/githubInbox.test.ts for the sibling pattern this mirrors).
const fenced = (json: string, ticks = "```") =>
  "chatter\n\n" + ticks + FINDINGS_FENCE + "\n" + json + "\n" + ticks + "\n\ntrailing";

const depFinding = {
  kind: "dependency",
  severity: "high",
  ruleId: "GHSA-xxxx-yyyy-zzzz",
  title: "Vulnerable lodash",
  description: "lodash < 4.17.21 is vulnerable to prototype pollution.",
  references: ["https://example.com/advisory"],
  package: { name: "lodash", range: "<4.17.21", fixedIn: "4.17.21" },
};

const codeFinding = {
  kind: "code",
  severity: "medium",
  ruleId: "sql-injection",
  title: "Unsanitized query",
  description: "User input flows into a raw SQL string.",
  location: { path: "src/db.ts", line: 42 },
};

describe("SEVERITY_RANK", () => {
  it("ranks critical highest and low lowest", () => {
    expect(SEVERITY_RANK).toEqual({ critical: 3, high: 2, medium: 1, low: 0 });
  });
});

describe("extractLastFencedBlock", () => {
  it("extracts the fenced body", () => {
    expect(extractLastFencedBlock(fenced("[1,2,3]"), FINDINGS_FENCE)).toBe("[1,2,3]");
  });

  it("returns null when there is no fence", () => {
    expect(extractLastFencedBlock("no fence here", FINDINGS_FENCE)).toBeNull();
  });

  it("returns null when the only fence is unclosed", () => {
    expect(extractLastFencedBlock("```junco-findings\n[1]", FINDINGS_FENCE)).toBeNull();
  });

  // Item 4: a 4-backtick fence whose JSON content contains a literal ``` run
  // (e.g. inside a string value) must not be truncated at the inner run.
  it("is fence-length aware — an inner ``` run does not close a 4-backtick fence", () => {
    const inner = '["contains a ```literal``` triple-backtick run"]';
    const text = "chatter\n\n````junco-findings\n" + inner + "\n````\n\ntrailing";
    expect(extractLastFencedBlock(text, FINDINGS_FENCE)).toBe(inner);
  });

  // Item 5: last complete fence wins; a trailing unclosed fence is ignored.
  it("takes the last COMPLETE fence, ignoring a trailing unclosed one", () => {
    const text = fenced("[1]") + "\n\n" + fenced("[2]") + "\n\n```junco-findings\n[3] never closes";
    expect(extractLastFencedBlock(text, FINDINGS_FENCE)).toBe("[2]");
  });

  it("picks the later of two complete fences", () => {
    const text = fenced("[1]") + "\n\n" + fenced("[2]");
    expect(extractLastFencedBlock(text, FINDINGS_FENCE)).toBe("[2]");
  });
});

describe("sanitizeFindingText", () => {
  it("strips a terminated HTML comment", () => {
    expect(sanitizeFindingText("before <!-- hidden --> after", 100)).toBe("before  after");
  });

  it("swallows an unterminated <!-- to end-of-string", () => {
    expect(sanitizeFindingText("keep this <!-- never closes", 100)).toBe("keep this");
  });

  it("strips \\r and other control chars but preserves \\n and \\t", () => {
    const input = "line1\r\nline2\ttabbed\x07bell\x00null";
    expect(sanitizeFindingText(input, 100)).toBe("line1\nline2\ttabbedbellnull");
  });

  it("trims surrounding whitespace", () => {
    expect(sanitizeFindingText("   padded   ", 100)).toBe("padded");
  });

  it("caps at max chars and appends an ellipsis when truncated", () => {
    expect(sanitizeFindingText("abcdefghij", 5)).toBe("abcde…");
  });

  it("does not append an ellipsis when under the cap", () => {
    expect(sanitizeFindingText("short", 100)).toBe("short");
  });
});

describe("fingerprintFinding", () => {
  it("is a 16-char lowercase hex string", () => {
    const fp = fingerprintFinding(codeFinding as never);
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
  });

  // Item 8: line drift must not change the fingerprint.
  it("is stable across differing location.line", () => {
    const a = fingerprintFinding({
      ...codeFinding,
      location: { path: "src/db.ts", line: 1 },
    } as never);
    const b = fingerprintFinding({
      ...codeFinding,
      location: { path: "src/db.ts", line: 999 },
    } as never);
    expect(a).toBe(b);
  });

  it("differs when only kind differs (same ruleId + path)", () => {
    const a = fingerprintFinding({
      kind: "code",
      ruleId: "shared-rule",
      title: "t",
      location: { path: "src/x.ts" },
    } as never);
    const b = fingerprintFinding({
      kind: "dependency",
      ruleId: "shared-rule",
      title: "t",
      location: { path: "src/x.ts" },
    } as never);
    expect(a).not.toBe(b);
  });

  it("uses package.name as the locus for dependency findings, ignoring location", () => {
    const a = fingerprintFinding({
      kind: "dependency",
      ruleId: "GHSA-1",
      title: "t",
      package: { name: "lodash", range: "*", fixedIn: null },
      location: { path: "package.json" },
    } as never);
    const b = fingerprintFinding({
      kind: "dependency",
      ruleId: "GHSA-1",
      title: "t",
      package: { name: "lodash", range: "*", fixedIn: null },
      // No location at all — locus should still be package.name, so this
      // matches `a` even though `a` also carries a location.
    } as never);
    expect(a).toBe(b);
  });

  it("falls back to title when neither package nor location is present", () => {
    const fp = fingerprintFinding({ kind: "code", ruleId: "r", title: "My Title" } as never);
    const expected = createHash("sha256").update("code|r|My Title").digest("hex").slice(0, 16);
    expect(fp).toBe(expected);
  });
});

describe("AgentFindingSchema", () => {
  it("defaults description to '', references to [], package.fixedIn to null", () => {
    const result = AgentFindingSchema.safeParse({
      kind: "code",
      severity: "low",
      ruleId: "r",
      title: "t",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.description).toBe("");
      expect(result.data.references).toEqual([]);
    }
  });

  it("strips unknown keys such as a supplied fingerprint (no .passthrough())", () => {
    const result = AgentFindingSchema.safeParse({
      kind: "code",
      severity: "low",
      ruleId: "r",
      title: "t",
      fingerprint: "attacker00000000",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).fingerprint).toBeUndefined();
    }
  });

  it("rejects a bad severity value", () => {
    expect(
      AgentFindingSchema.safeParse({
        kind: "code",
        severity: "apocalyptic",
        ruleId: "r",
        title: "t",
      }).success,
    ).toBe(false);
  });

  it("rejects an empty ruleId or title", () => {
    expect(
      AgentFindingSchema.safeParse({ kind: "code", severity: "low", ruleId: "", title: "t" })
        .success,
    ).toBe(false);
    expect(
      AgentFindingSchema.safeParse({ kind: "code", severity: "low", ruleId: "r", title: "" })
        .success,
    ).toBe(false);
  });

  it("rejects a non-positive-integer location.line", () => {
    expect(
      AgentFindingSchema.safeParse({
        kind: "code",
        severity: "low",
        ruleId: "r",
        title: "t",
        location: { path: "x.ts", line: -1 },
      }).success,
    ).toBe(false);
    expect(
      AgentFindingSchema.safeParse({
        kind: "code",
        severity: "low",
        ruleId: "r",
        title: "t",
        location: { path: "x.ts", line: 1.5 },
      }).success,
    ).toBe(false);
  });

  it("defaults package.fixedIn to null when absent", () => {
    const result = AgentFindingSchema.safeParse({
      kind: "dependency",
      severity: "low",
      ruleId: "r",
      title: "t",
      package: { name: "n", range: "*" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.package?.fixedIn).toBeNull();
    }
  });
});

describe("parseAgentFindings", () => {
  // Item 1
  it("round-trips a valid 2-element array with computed fingerprints and dropped 0", () => {
    const text = fenced(JSON.stringify([depFinding, codeFinding]));
    const { findings, dropped } = parseAgentFindings(text);
    expect(dropped).toBe(0);
    expect(findings).toHaveLength(2);
    for (const f of findings) {
      expect(f.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    }
    expect(findings[0].fingerprint).toBe(
      fingerprintFinding({
        kind: "dependency",
        ruleId: depFinding.ruleId,
        title: depFinding.title,
        package: depFinding.package,
      }),
    );
  });

  // Item 2
  it("strips an injected finding-marker comment out of description text", () => {
    const malicious = {
      ...codeFinding,
      description: "Legit text <!-- junco:finding:deadbeefdeadbeef --> more text",
    };
    const { findings, dropped } = parseAgentFindings(fenced(JSON.stringify([malicious])));
    expect(dropped).toBe(0);
    expect(findings).toHaveLength(1);
    expect(findings[0].description).not.toContain("junco:finding:deadbeefdeadbeef");
    expect(findings[0].description).toBe("Legit text  more text");
  });

  // Item 3
  it("ignores an attacker-supplied fingerprint and computes its own", () => {
    const spoofed = { ...codeFinding, fingerprint: "attacker00000000" };
    const { findings, dropped } = parseAgentFindings(fenced(JSON.stringify([spoofed])));
    expect(dropped).toBe(0);
    expect(findings).toHaveLength(1);
    expect(findings[0].fingerprint).not.toBe("attacker00000000");
    expect(findings[0].fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  // Item 6
  it("drops an invalid element (bad severity) but keeps the valid ones", () => {
    const bad = { ...codeFinding, severity: "apocalyptic" };
    const { findings, dropped } = parseAgentFindings(fenced(JSON.stringify([depFinding, bad])));
    expect(dropped).toBe(1);
    expect(findings).toHaveLength(1);
    expect(findings[0].ruleId).toBe(depFinding.ruleId);
  });

  // Item 7
  it("returns empty/dropped-0 for non-array JSON, no fence, and malformed JSON", () => {
    expect(parseAgentFindings(fenced("{}"))).toEqual({ findings: [], dropped: 0 });
    expect(parseAgentFindings("no fence anywhere in this text")).toEqual({
      findings: [],
      dropped: 0,
    });
    expect(parseAgentFindings(fenced("{not valid json"))).toEqual({ findings: [], dropped: 0 });
  });

  // Item 9
  it("caps an over-long description at 10_000 chars with a trailing ellipsis", () => {
    const longDescription = "x".repeat(20_000);
    const { findings, dropped } = parseAgentFindings(
      fenced(JSON.stringify([{ ...codeFinding, description: longDescription }])),
    );
    expect(dropped).toBe(0);
    expect(findings).toHaveLength(1);
    expect(findings[0].description).toHaveLength(10_001);
    expect(findings[0].description.endsWith("…")).toBe(true);
  });

  it("caps references to 20 entries, each sanitized to 500 chars", () => {
    const refs = Array.from({ length: 25 }, (_, i) => `https://example.com/${i}`.repeat(1));
    const overLongRef = "r".repeat(600);
    const withRefs = { ...codeFinding, references: [...refs, overLongRef] };
    const { findings } = parseAgentFindings(fenced(JSON.stringify([withRefs])));
    expect(findings[0].references.length).toBeLessThanOrEqual(20);
  });
});

describe("findingMarker", () => {
  it("wraps the fingerprint in the marker prefix and closing comment", () => {
    expect(findingMarker("abc123")).toBe(`${FINDING_MARKER_PREFIX}abc123 -->`);
    expect(findingMarker("abc123")).toBe("<!-- junco:finding:abc123 -->");
  });
});

// Item 11
describe("extractFindingMarkers", () => {
  it("returns an empty set for bodies with no markers", () => {
    expect(extractFindingMarkers(["no markers here", "still none"])).toEqual(new Set());
  });

  it("finds a single marker", () => {
    expect(extractFindingMarkers(["intro\n<!-- junco:finding:deadbeefdeadbeef -->\nbody"])).toEqual(
      new Set(["deadbeefdeadbeef"]),
    );
  });

  it("finds multiple markers across multiple bodies", () => {
    const bodies = [
      "<!-- junco:finding:1111111111111111 -->",
      "chatter <!-- junco:finding:2222222222222222 --> more",
      "no marker here",
    ];
    expect(extractFindingMarkers(bodies)).toEqual(
      new Set(["1111111111111111", "2222222222222222"]),
    );
  });

  it("ignores a malformed prefix-only marker with no closing comment", () => {
    expect(extractFindingMarkers(["<!-- junco:finding:deadbeef no closer here"])).toEqual(
      new Set(),
    );
  });
});
