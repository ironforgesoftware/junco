import { describe, it, expect } from "vitest";
import {
  makeSubmitTool,
  SUBMIT_TOOL_NAME,
  type SubmitToolDeps,
  type Decision,
} from "../src/chat/submitTool.js";
import type { PendingDraft } from "../src/chat/draftStore.js";
import { DRAFT_NOT_PARKED } from "../src/chat/submitExec.js";

const draft = (over: Partial<PendingDraft> = {}): PendingDraft => ({
  id: "acme__api-1",
  key: "acme/api",
  slug: "acme__api",
  kind: "ticket",
  files: [{ name: "add-readme.md", content: "", lint: [], route: null, droppedKeys: [] }],
  cwd: "/r",
  nwo: "acme/api",
  createdAt: "t",
  lintFailed: false,
  blocked: null,
  routeOverride: "auto",
  commandArgs: null,
  ...over,
});

function harness(o: {
  lookup?: ReturnType<SubmitToolDeps["findDraft"]>;
  decision?: Decision;
  run?: Awaited<ReturnType<SubmitToolDeps["run"]>>;
  /** The executor throws instead of resolving (a store/fs failure). */
  runThrows?: Error;
}) {
  const records: unknown[] = [];
  const calls: string[] = [];
  const deps: SubmitToolDeps = {
    findDraft: (ref) => (
      calls.push(`find:${ref ?? "-"}`),
      o.lookup ?? { ok: true, draft: draft() }
    ),
    confirm: async (p, signal) => {
      calls.push(`confirm:${p.commandId}:${p.route}`);
      if (signal?.aborted) return "aborted";
      return o.decision ?? "run";
    },
    run: async (d, route) => {
      calls.push(`run:${d.id}:${route}`);
      if (o.runThrows) throw o.runThrows;
      return (
        o.run ?? {
          code: 0,
          output: "queued add-readme\n",
          timedOut: false,
          archived: true,
          detail: null,
        }
      );
    },
    record: (r) => records.push(r),
    confirmTimeoutMinutes: 10,
  };
  return { tool: makeSubmitTool(deps), records, calls };
}

const text = (r: { content: { text: string }[] }): string => r.content.map((c) => c.text).join("");

describe("junco_submit (pure)", () => {
  it("has the name the session allowlists and a plain JSON-schema parameter block", () => {
    const { tool } = harness({});
    expect(tool.name).toBe(SUBMIT_TOOL_NAME);
    expect(tool.parameters).toMatchObject({
      type: "object",
      properties: { draft: { type: "string" }, route: { enum: ["inbox", "issue"] } },
      additionalProperties: false,
    });
  });

  it("run: confirms, runs, records ran + the draft note, returns the outcome", async () => {
    const h = harness({});
    const r = await h.tool.execute("call_1", { draft: "add-readme" }, undefined);
    expect(h.calls).toEqual(["find:add-readme", "confirm:call_1:inbox", "run:acme__api-1:inbox"]);
    expect(text(r)).toMatch(/^submitted → inbox · add-readme \(exit 0\)/);
    expect(text(r)).toContain("queued add-readme");
    expect(h.records.map((x) => (x as { type: string; status?: string }).status)).toEqual([
      "submitted",
      "ran",
    ]);
    expect(h.records[0]).toMatchObject({ type: "junco_chat_draft", destination: "inbox" });
    expect(h.records[1]).toMatchObject({
      type: "junco_chat_command",
      commandId: "call_1",
      exitCode: 0,
      output: "queued add-readme\n",
    });
  });

  it("route:issue overrides the draft's route; a failed run records failed and keeps the draft", async () => {
    const h = harness({
      run: { code: 1, output: "boom", timedOut: false, archived: false, detail: null },
    });
    const r = await h.tool.execute("call_2", { route: "issue" }, undefined);
    expect(h.calls[2]).toBe("run:acme__api-1:issue");
    expect(text(r)).toMatch(/^submit failed \(exit 1\)/);
    expect(h.records).toHaveLength(1);
    expect(h.records[0]).toMatchObject({ status: "failed", exitCode: 1, route: "issue" });
  });

  it("exit 0 with a failed archive is a RAN submit that says the card stays parked", async () => {
    // The CLI queued the ticket; only the JSON archive failed. Calling that
    // `failed` made the model relay "submit failed" for a queued ticket, and
    // the operator's follow-up `s` then hit "already queued" (final review
    // #2a). It is `ran` — but with no `junco_chat_draft{submitted}` note,
    // because the draft really is still parked on disk.
    const h = harness({
      run: {
        code: 0,
        output: "queued add-readme\n",
        timedOut: false,
        archived: false,
        detail: "submitted, but the draft did not archive: EACCES",
      },
    });
    const r = await h.tool.execute("call_3", {}, undefined);
    expect(text(r)).toMatch(/^submitted → inbox · add-readme \(exit 0\)/);
    expect(text(r)).toContain(
      "the draft did not archive (EACCES); its card will still show as parked",
    );
    expect(text(r)).toContain("queued add-readme");
    expect(h.records).toHaveLength(1);
    expect(h.records[0]).toMatchObject({
      type: "junco_chat_command",
      status: "ran",
      exitCode: 0,
      output: "queued add-readme\n",
      detail: "submitted, but the draft did not archive: EACCES",
    });
  });

  it("a draft that vanished while the operator decided reports that nothing ran", async () => {
    // The dashboard submitted or discarded it meanwhile: submitExec spawns
    // nothing. "the draft stays parked" contradicted itself (review #2b).
    const h = harness({
      run: {
        code: null,
        output: "",
        timedOut: false,
        archived: false,
        detail: DRAFT_NOT_PARKED,
      },
    });
    const r = await h.tool.execute("call_4", {}, undefined);
    expect(text(r)).toBe(
      "nothing ran — the draft is no longer parked (submitted or discarded from the dashboard meanwhile)",
    );
    expect(h.records).toHaveLength(1);
    expect(h.records[0]).toMatchObject({
      status: "failed",
      exitCode: null,
      detail: DRAFT_NOT_PARKED,
    });
  });

  it("decline / expired / aborted record their status and say the draft stays parked", async () => {
    for (const [decision, status] of [
      ["decline", "declined"],
      ["expired", "expired"],
      ["aborted", "aborted"],
    ] as const) {
      const h = harness({ decision });
      const r = await h.tool.execute("c", {}, undefined);
      expect(h.records[0]).toMatchObject({ type: "junco_chat_command", status });
      expect(h.calls.some((c) => c.startsWith("run:"))).toBe(false);
      expect(text(r)).toContain("stays parked");
    }
    const e = harness({ decision: "expired" });
    await e.tool.execute("c", {}, undefined);
    expect(e.records[0]).toMatchObject({ detail: "no decision in 10m" });
  });

  it("refuses before proposing: unknown, ambiguous, none, lint-failed, blocked", async () => {
    const d2 = draft({
      id: "acme__api-2",
      files: [{ name: "other.md", content: "", lint: [], route: null, droppedKeys: [] }],
    });
    await expect(
      harness({ lookup: { ok: false, reason: "unknown", candidates: [draft(), d2] } }).tool.execute(
        "c",
        { draft: "x" },
        undefined,
      ),
    ).rejects.toThrow(/no parked draft named "x".*add-readme.*other/s);
    await expect(
      harness({
        lookup: { ok: false, reason: "ambiguous", candidates: [draft(), d2] },
      }).tool.execute("c", {}, undefined),
    ).rejects.toThrow(/name one/);
    await expect(
      harness({ lookup: { ok: false, reason: "none", candidates: [] } }).tool.execute(
        "c",
        {},
        undefined,
      ),
    ).rejects.toThrow(/nothing is parked/);
    await expect(
      harness({ lookup: { ok: true, draft: draft({ lintFailed: true }) } }).tool.execute(
        "c",
        {},
        undefined,
      ),
    ).rejects.toThrow(/failed lint/);
    await expect(
      harness({ lookup: { ok: true, draft: draft({ blocked: "no_checkout" }) } }).tool.execute(
        "c",
        {},
        undefined,
      ),
    ).rejects.toThrow(/blocked/);
  });

  it("an executor that THROWS still closes the proposal with one failed record", async () => {
    const h = harness({ runThrows: new Error("EACCES: permission denied, mkdir '/data'") });
    const r = await h.tool.execute("call_3", {}, undefined);
    expect(h.records).toHaveLength(1);
    expect(h.records[0]).toMatchObject({
      type: "junco_chat_command",
      commandId: "call_3",
      status: "failed",
      exitCode: null,
      output: null,
      detail: "EACCES: permission denied, mkdir '/data'",
    });
    expect(text(r)).toContain("EACCES");
    expect(text(r)).toContain("stays parked");
  });

  it("a pre-aborted signal never proposes", async () => {
    const h = harness({});
    const ctl = new AbortController();
    ctl.abort();
    const r = await h.tool.execute("c", {}, ctl.signal);
    expect(h.calls).toEqual(["find:-"]);
    expect(h.records).toEqual([]);
    expect(text(r)).toContain("aborted");
  });
});
