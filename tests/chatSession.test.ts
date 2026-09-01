import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatSession, chatCfgFor } from "../src/chat/chatSession.js";
import type { SessionManagerMode } from "../src/agent/session.js";
import { makeConfig, READ_ONLY_TOOLS } from "./helpers/config.js";
import { fakeChatSession, chatScriptText, type FakeChatSession } from "./helpers/fakeSession.js";
import { parseTranscriptLine } from "../src/agent/transcriptSchema.js";

const cfg = makeConfig({
  dataDir: "/sbxroot/data",
  queueRoot: "/sbxroot/data/queue",
  worktreeRoot: "/sbxroot/wt",
  tools: ["bash", "read", "write", "grep", "find"],
  criticEnabled: false,
  planLintEnabled: false,
  verifyEnabled: false,
  supervisorEnabled: false,
  healthEnabled: false,
  removeWorktreeOnSuccess: true,
});

/** A fake SessionManager seam mirroring SDK 0.84.2 (Ruling R5): "create"
 * mints a file under dir; "open" never throws — a missing path simply yields
 * a session at that path. */
const fakeSm = async (mode: SessionManagerMode): Promise<{ manager: unknown; file: string }> => {
  if ("create" in mode) {
    const file = join(
      mode.create.dir,
      `sdk-session-${Date.now()}-${Math.random().toString(16).slice(2, 6)}.jsonl`,
    );
    writeFileSync(file, "");
    return { manager: { tag: "sm" }, file };
  }
  return { manager: { tag: "sm" }, file: mode.open.file };
};

function makeSession(dir: string, scripts = [chatScriptText("hi", 0.1)]) {
  const factory = fakeChatSession(scripts);
  let last: FakeChatSession | null = null;
  const session = new ChatSession(
    {
      cfg,
      key: "acme/api",
      kind: "watched",
      cwd: dir,
      nwo: "acme/api",
      dir: join(dir, "acme__api"),
    },
    {
      makeSessionManager: fakeSm,
      sessionFactoryFor: () => async () => (last = await factory()),
    },
  );
  return { session, sdk: () => last };
}

const records = (path: string) =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => parseTranscriptLine(l))
    .map((p) =>
      p.kind === "junco" ? p.record.type : p.kind === "sdk" ? String(p.event.type) : "invalid",
    );

describe("chatCfgFor (spec 2026-09-01 §2.3)", () => {
  it("narrows tools to the read-only subset and resolves the model id chain", () => {
    const c = chatCfgFor(cfg);
    expect(c.tools).toEqual(["read", "grep", "find"]);
    expect(c.model.id).toBe(cfg.model.id);
    const planner = chatCfgFor({ ...cfg, github: { ...cfg.github, plannerModelId: "x/planner" } });
    expect(planner.model.id).toBe("x/planner");
    const explicit = chatCfgFor({
      ...cfg,
      chat: { ...cfg.chat, modelId: "x/chat" },
      github: { ...cfg.github, plannerModelId: "x/planner" },
    });
    expect(explicit.model.id).toBe("x/chat");
    expect(READ_ONLY_TOOLS).toEqual(["read", "grep", "find", "ls"]); // the contract this narrows to
  });
});

describe("ChatSession (spec 2026-09-01 §2.3, §5.2, §11)", () => {
  it("ensureMeta creates the dir, meta.json and the junco_meta header once", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-chat-"));
    const { session } = makeSession(root);
    await session.ensureMeta();
    await session.ensureMeta();
    expect(existsSync(session.metaPath)).toBe(true);
    expect(records(session.transcriptPath)).toEqual(["junco_meta"]);
    const meta = JSON.parse(readFileSync(session.metaPath, "utf8"));
    expect(meta.key).toBe("acme/api");
    expect(meta.sdkSessionFile.startsWith(session.dir)).toBe(true);
  });

  it("prompt writes prompt/turn_start/SDK events/turn_end — never message_update — and fans out everything", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-chat-"));
    const { session } = makeSession(root);
    const bus: Array<{ type: string; offset: number | null }> = [];
    session.subscribe({
      onLine: (line, offset) => bus.push({ type: JSON.parse(line).type, offset }),
      onEnd: () => {},
    });
    const r = await session.prompt("hello", { source: "operator", timeoutMs: 5_000 });
    expect(r.status).toBe("ok");
    expect(records(session.transcriptPath)).toEqual([
      "junco_meta",
      "junco_chat_prompt",
      "junco_chat_turn_start",
      "message_start",
      "turn_end",
      "agent_end",
      "agent_settled",
      "junco_chat_turn_end",
    ]);
    const busTypes = bus.map((b) => b.type);
    expect(busTypes).toContain("message_update");
    expect(bus.find((b) => b.type === "message_update")!.offset).toBeNull();
    expect(bus.find((b) => b.type === "turn_end")!.offset).toBeGreaterThan(0);
    expect(session.turns).toBe(1);
    expect(session.streaming).toBe(false);
  });

  it("readLines(since) returns complete lines with end-of-line offsets, and resumes exactly after an echoed offset", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-chat-"));
    const { session } = makeSession(root);
    await session.prompt("hello", { source: "operator", timeoutMs: 5_000 });
    const all = session.readLines(0);
    expect(all.length).toBeGreaterThan(3);
    const size = readFileSync(session.transcriptPath).length;
    expect(all[all.length - 1]!.offset).toBe(size);
    const rest = session.readLines(all[1]!.offset);
    expect(rest.map((r) => r.line)).toEqual(all.slice(2).map((r) => r.line));
    // a torn tail is held back
    writeFileSync(session.transcriptPath, '{"type":"turn_en', { flag: "a" });
    expect(session.readLines(size)).toEqual([]);
  });

  it("stamps a crash-aborted turn on open when the transcript ends in turn_start", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-chat-"));
    const { session } = makeSession(root);
    await session.ensureMeta();
    writeFileSync(
      session.transcriptPath,
      JSON.stringify({
        type: "junco_chat_turn_start",
        modelId: "m",
        tools: [],
        timeoutMs: 1,
        ts: "t",
      }) + "\n",
      { flag: "a" },
    );
    const again = makeSession(root).session;
    await again.ensureMeta();
    const types = records(again.transcriptPath);
    expect(types[types.length - 1]).toBe("junco_chat_turn_aborted");
    const last = readFileSync(again.transcriptPath, "utf8").trim().split("\n").pop()!;
    expect(JSON.parse(last).reason).toBe("crash");
  });

  it("a missing SDK session file is a reset only when a turn was already completed (Ruling R5)", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-chat-"));
    // No turn yet: the SDK never flushed, so a missing file loses nothing — no reset record.
    const { session } = makeSession(root);
    await session.ensureSession();
    const meta = JSON.parse(readFileSync(session.metaPath, "utf8"));
    const { rmSync } = await import("node:fs");
    rmSync(meta.sdkSessionFile);
    const again = makeSession(root).session;
    await again.ensureSession();
    expect(records(again.transcriptPath)).not.toContain("junco_chat_session_reset");
    expect(JSON.parse(readFileSync(again.metaPath, "utf8")).sdkSessionFile).toBe(
      meta.sdkSessionFile,
    );
    // A completed turn, then the file goes missing: that is a reset the operator must see.
    await again.prompt("hello", { source: "operator", timeoutMs: 5_000 });
    rmSync(meta.sdkSessionFile, { force: true });
    const third = makeSession(root).session;
    await third.ensureSession();
    const types = records(third.transcriptPath);
    expect(types[types.length - 1]).toBe("junco_chat_session_reset");
    const last = JSON.parse(readFileSync(third.transcriptPath, "utf8").trim().split("\n").pop()!);
    expect(last.reason).toBe("missing");
  });

  it("a corrupt SDK session file (open or build throws) is archived under corrupt-* and replaced", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-chat-"));
    const { session } = makeSession(root);
    await session.ensureSession();
    const meta = JSON.parse(readFileSync(session.metaPath, "utf8"));
    writeFileSync(meta.sdkSessionFile, "{not json");
    let calls = 0;
    const throwingOnce = async (mode: SessionManagerMode) => {
      if ("open" in mode && calls++ === 0) throw new Error("bad header");
      return fakeSm(mode);
    };
    const again = new ChatSession(
      {
        cfg,
        key: "acme/api",
        kind: "watched",
        cwd: root,
        nwo: "acme/api",
        dir: join(root, "acme__api"),
      },
      {
        makeSessionManager: throwingOnce,
        sessionFactoryFor: () => fakeChatSession([chatScriptText("hi")]),
      },
    );
    await again.ensureSession();
    const types = records(again.transcriptPath);
    expect(types).toContain("junco_chat_session_reset");
    const last = JSON.parse(readFileSync(again.transcriptPath, "utf8").trim().split("\n").pop()!);
    expect(last.reason).toBe("corrupt");
    const meta2 = JSON.parse(readFileSync(again.metaPath, "utf8"));
    expect(meta2.sdkSessionFile).not.toBe(meta.sdkSessionFile);
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(join(root, "acme__api")).some((n) => n.startsWith("corrupt-"))).toBe(true);
  });

  it("abort() soft-aborts an in-flight turn; drain() writes daemon_stopped and ends subscribers", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-chat-"));
    const { session, sdk } = makeSession(root, [{ events: [], delayMs: 10_000 }]);
    const ends: string[] = [];
    session.subscribe({ onLine: () => {}, onEnd: (r) => ends.push(r) });
    const p = session.prompt("slow", { source: "operator", timeoutMs: 60_000, abortGraceMs: 50 });
    await new Promise((r) => setTimeout(r, 5));
    expect(session.streaming).toBe(true);
    await session.drain();
    const r = await p;
    expect(r.status).toBe("aborted");
    expect(sdk()!.disposed).toBe(true);
    expect(ends).toEqual(["daemon_stopped"]);
    const types = records(session.transcriptPath);
    expect(types).toContain("junco_chat_turn_aborted");
    const aborted = readFileSync(session.transcriptPath, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .filter((r) => r.type === "junco_chat_turn_aborted");
    expect(aborted.map((a) => a.reason)).toContain("daemon_stopped");
  });

  it("reset('operator_new') archives the whole dir and ends subscribers with session_reset", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-chat-"));
    const { session } = makeSession(root);
    await session.prompt("hello", { source: "operator", timeoutMs: 5_000 });
    const ends: string[] = [];
    session.subscribe({ onLine: () => {}, onEnd: (r) => ends.push(r) });
    await session.reset("operator_new");
    expect(existsSync(session.transcriptPath)).toBe(false);
    const archive = join(root, "_archive");
    expect(existsSync(archive)).toBe(true);
    expect(ends).toEqual(["session_reset"]);
  });

  it("a dead sink degrades: live delivery continues, one degraded record is published, offsets are null", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-chat-"));
    const { session } = makeSession(root);
    // make the transcript path unwritable by putting a DIRECTORY there
    mkdirSync(session.dir, { recursive: true });
    mkdirSync(session.transcriptPath);
    const bus: Array<{ type: string; offset: number | null }> = [];
    session.subscribe({
      onLine: (l, o) => bus.push({ type: JSON.parse(l).type, offset: o }),
      onEnd: () => {},
    });
    const r = await session.prompt("hello", { source: "operator", timeoutMs: 5_000 });
    expect(r.status).toBe("ok");
    expect(session.degraded).toBe(true);
    expect(bus.filter((b) => b.type === "junco_chat_transcript_degraded")).toHaveLength(1);
    expect(bus.every((b) => b.offset === null)).toBe(true);
  });
});
