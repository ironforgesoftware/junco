import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { slugifyId, transcriptPathFor } from "../src/slug.js";

describe("slugifyId", () => {
  it("keeps alphanumerics, dots, underscores, and hyphens", () => {
    expect(slugifyId("my-cool.task_01")).toBe("my-cool.task_01");
  });

  it("collapses path separators and other characters to '-'", () => {
    expect(slugifyId("a/b\\c d")).toBe("a-b-c-d");
  });

  it("neutralizes a path-traversal id into a single filename", () => {
    expect(slugifyId("../../../../Users/x/anything")).toBe("..-..-..-..-Users-x-anything");
  });

  it("strips leading/trailing dashes", () => {
    expect(slugifyId("(hello)")).toBe("hello");
  });

  it("falls back to 'ticket' for empty or symbol-only ids", () => {
    expect(slugifyId("")).toBe("ticket");
    expect(slugifyId("!!!")).toBe("ticket");
  });
});

describe("transcriptPathFor", () => {
  // transcriptPathFor now takes the transcripts DIR itself (a caller passes
  // dataTreePaths(cfg).transcripts — dataTree.ts is the only place that joins
  // "transcripts" onto the data root), not the data root. Call shape only:
  // every asserted path value below is unchanged from before this signature
  // change.
  const transcriptsDir = join("/state", "transcripts");

  it("builds <transcriptsDir>/<id>.jsonl for a clean id", () => {
    expect(transcriptPathFor(transcriptsDir, "gh-owner-repo-12")).toBe(
      join("/state", "transcripts", "gh-owner-repo-12.jsonl"),
    );
  });

  it("slugifies a traversal id so the path stays inside the transcripts dir", () => {
    const p = transcriptPathFor(transcriptsDir, "../../../../tmp/evil/x");
    expect(p).toBe(join("/state", "transcripts", "..-..-..-..-tmp-evil-x.jsonl"));
    // No unresolved parent-dir segment survives to escape the transcripts dir.
    expect(p.startsWith(join("/state", "transcripts") + "/")).toBe(true);
  });
});
