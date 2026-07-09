import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileFindings } from "../src/assessFiling.js";
import { writePending, readPending, type PendingAssess } from "../src/assessReview.js";
import { findingMarker } from "../src/findings.js";
import type { Config } from "../src/types.js";
import type { gh } from "../src/git.js";

function cfg(stateDir: string): Config {
  return { stateDir, github: { triggerLabel: "junco" } } as unknown as Config;
}
function pending(external: boolean): PendingAssess {
  return {
    id: "assess-x-1",
    nwo: "o/r",
    external,
    autoPlan: false,
    repoPath: "/x",
    createdAt: "2026-07-09T00:00:00.000Z",
    findings: [
      {
        fingerprint: "f1",
        kind: "code",
        severity: "high",
        ruleId: "R1",
        title: "One",
        description: "d1",
        references: [],
      },
      {
        fingerprint: "f2",
        kind: "code",
        severity: "low",
        ruleId: "R2",
        title: "Two",
        description: "d2",
        references: [],
      },
    ],
  };
}

/** gh fake: records argv; empty issue-list (no prior markers); issue-create prints a URL. */
function ghFake(calls: string[][]): typeof gh {
  return (async (_c: unknown, args: string[]) => {
    calls.push(args);
    if (args[0] === "issue" && args[1] === "list") return { stdout: "[]", stderr: "", code: 0 };
    if (args[0] === "issue" && args[1] === "create")
      return { stdout: "https://github.com/o/r/issues/9\n", stderr: "", code: 0 };
    return { stdout: "", stderr: "", code: 0 };
  }) as unknown as typeof gh;
}

describe("fileFindings", () => {
  it("files only the selected findings and archives the batch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "afl-"));
    const c = cfg(dir);
    writePending(c, pending(false));
    const calls: string[][] = [];
    const res = await fileFindings(c, pending(false), new Set(["f1"]), { ghFn: ghFake(calls) });

    expect(res.created).toBe(1);
    expect(res.urls).toEqual(["https://github.com/o/r/issues/9"]);
    const creates = calls.filter((a) => a[0] === "issue" && a[1] === "create");
    expect(creates).toHaveLength(1);
    // owned → labelled
    expect(creates[0]).toContain("--label");
    // archived
    expect(readPending(c, "assess-x-1").batch).toBeNull();
  });

  it("external batch files WITHOUT labels and never calls label create", async () => {
    const dir = mkdtempSync(join(tmpdir(), "afl-"));
    const c = cfg(dir);
    writePending(c, pending(true));
    const calls: string[][] = [];
    await fileFindings(c, pending(true), new Set(["f1", "f2"]), { ghFn: ghFake(calls) });

    const creates = calls.filter((a) => a[0] === "issue" && a[1] === "create");
    expect(creates).toHaveLength(2);
    for (const cr of creates) expect(cr).not.toContain("--label");
    expect(calls.some((a) => a[0] === "label")).toBe(false);
  });

  it("skips a finding already filed (marker present in author-scoped list)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "afl-"));
    const c = cfg(dir);
    writePending(c, pending(true));
    const ghFn = (async (_c: unknown, args: string[]) => {
      if (args[1] === "list")
        return { stdout: JSON.stringify([{ body: findingMarker("f1") }]), stderr: "", code: 0 };
      if (args[1] === "create")
        return { stdout: "https://github.com/o/r/issues/9\n", stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 0 };
    }) as unknown as typeof gh;
    const res = await fileFindings(c, pending(true), new Set(["f1", "f2"]), { ghFn });
    expect(res.deduped).toBe(1);
    expect(res.created).toBe(1);
  });
});
