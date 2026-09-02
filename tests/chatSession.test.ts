import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatSession, chatCfgFor } from "../src/chat/chatSession.js";
import type { ChatSessionLike, SessionManagerMode } from "../src/agent/session.js";
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

/** A fake SessionManager seam mirroring SDK 0.84.4 (Ruling R5): "create"
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

/**
 * A ChatSessionLike whose `isStreaming` flips only AFTER prompt()'s first
 * await — the real SDK's shape (the run loop sets it), and the window in which
 * two same-tick prompts both observe an idle session. prompt() then blocks
 * until abort().
 */
function laggingChatSession(): ChatSessionLike & { prompts: string[]; steers: string[] } {
  const prompts: string[] = [];
  const steers: string[] = [];
  let streaming = false;
  let running = false;
  let release: (() => void) | null = null;
  return {
    prompts,
    steers,
    messages: [],
    get isStreaming() {
      return streaming;
    },
    get isIdle() {
      return !streaming;
    },
    subscribe: () => () => {},
    async prompt(text: string) {
      // The SDK rejects a second concurrent prompt() (no streamingBehavior) —
      // which is the failure this guard exists to prevent.
      if (running) throw new Error("prompt() called while a run is active");
      running = true;
      prompts.push(text);
      try {
        await Promise.resolve(); // the SDK's own first await …
        streaming = true; // … only now does the run loop report streaming
        await new Promise<void>((r) => (release = r));
      } finally {
        streaming = false;
        running = false;
      }
    },
    async steer(text: string) {
      steers.push(text);
    },
    async abort() {
      release?.();
      release = null;
    },
    dispose() {},
  };
}

/**
 * A ChatSession whose SDK-session build is parked on a gate, so
 * `ensureSession()` is provably still pending when reset()/drain()/abort()
 * land — the window in which `inFlight` is not yet set.
 */
function makeDeferredSession(root: string) {
  const inner = fakeChatSession([chatScriptText("hi")]);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let built: FakeChatSession | null = null;
  const session = new ChatSession(
    {
      cfg,
      key: "acme/api",
      kind: "watched",
      cwd: root,
      nwo: "acme/api",
      dir: join(root, "acme__api"),
    },
    {
      makeSessionManager: fakeSm,
      sessionFactoryFor: () => async () => {
        await gate;
        built = await inner();
        return built;
      },
    },
  );
  return { session, release, built: () => built };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

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
    // every bit of state derived from the archived transcript resets with it
    expect(session.turns).toBe(0);
    expect(session.lastActivityAt).toBeNull();
    expect(session.degraded).toBe(false);
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
    // reset archives the dead sink away, so the latch must not survive it
    await session.reset("operator_new");
    expect(session.degraded).toBe(false);
  });

  it("offsets are BYTE lengths, not string lengths", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-chat-"));
    const multibyte = "héllo — ünïcode ✓";
    const { session } = makeSession(root, [chatScriptText(multibyte)]);
    const busOffsets: Array<number | null> = [];
    session.subscribe({ onLine: (_l, o) => busOffsets.push(o), onEnd: () => {} });
    await session.prompt(multibyte, { source: "operator", timeoutMs: 5_000 });
    const bytes = readFileSync(session.transcriptPath).length;
    const chars = readFileSync(session.transcriptPath, "utf8").length;
    expect(bytes).toBeGreaterThan(chars); // the multibyte text really is in there
    const lines = session.readLines(0);
    let acc = 0;
    for (const l of lines) {
      acc += Buffer.byteLength(l.line, "utf8") + 1; // + the newline the offset sits after
      expect(l.offset).toBe(acc);
    }
    expect(lines[lines.length - 1]!.offset).toBe(bytes);
    // the live (persist-side) counter must agree with the file, byte for byte
    expect(busOffsets.filter((o) => o !== null)).toEqual(lines.map((l) => l.offset));
  });

  it("a second prompt in the same tick steers the running turn instead of racing it", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-chat-"));
    // NOT tests/helpers/fakeSession's fakeChatSession: that one flips
    // isStreaming SYNCHRONOUSLY inside prompt(), which closes the very window
    // under test (a `sdk.isStreaming`-only guard passes against it). The real
    // SDK reports streaming only once its run loop starts — after prompt()'s
    // first await — so two same-tick POSTs both observe an idle session, and
    // only `inFlight` tells the second one that a turn is already running.
    const sdk = laggingChatSession();
    const session = new ChatSession(
      {
        cfg,
        key: "acme/api",
        kind: "watched",
        cwd: root,
        nwo: "acme/api",
        dir: join(root, "acme__api"),
      },
      { makeSessionManager: fakeSm, sessionFactoryFor: () => async () => sdk },
    );
    const one = session.prompt("one", { source: "operator", timeoutMs: 60_000, abortGraceMs: 50 });
    const two = session.prompt("two", { source: "operator", timeoutMs: 60_000 });
    expect(await two).toMatchObject({ mode: "steer", status: "ok", finalText: "" });
    expect(sdk.prompts).toEqual(["one"]);
    expect(sdk.steers).toEqual(["two"]);
    expect(await session.abort()).toBe(true);
    expect(await one).toMatchObject({ mode: "prompt", status: "aborted" });
    const modes = readFileSync(session.transcriptPath, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .filter((r) => r.type === "junco_chat_prompt")
      .map((r) => r.mode);
    expect(modes).toEqual(["prompt", "steer"]);
  });

  it("a subscriber whose onLine throws is dropped; the others keep receiving", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-chat-"));
    const { session } = makeSession(root);
    let bad = 0;
    session.subscribe({
      onLine: () => {
        bad++;
        throw new Error("boom");
      },
      onEnd: () => {
        throw new Error("boom-end");
      },
    });
    const good: string[] = [];
    session.subscribe({ onLine: (l) => good.push(l), onEnd: () => {} });
    const r = await session.prompt("hello", { source: "operator", timeoutMs: 5_000 });
    expect(r.status).toBe("ok");
    expect(bad).toBe(1); // dropped after its first throw, never called again
    expect(good.length).toBeGreaterThan(3);
    await expect(session.drain()).resolves.toBeUndefined(); // an onEnd throw is swallowed too
  });

  it("drain() then reset() ends each subscriber exactly once and clears the drain latch", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-chat-"));
    const { session } = makeSession(root, [{ events: [], delayMs: 10_000 }]);
    const first: string[] = [];
    session.subscribe({ onLine: () => {}, onEnd: (r) => first.push(r) });
    const slow = session.prompt("one", { source: "operator", timeoutMs: 60_000, abortGraceMs: 50 });
    await new Promise((r) => setTimeout(r, 5));
    await session.drain();
    await slow;
    await session.drain(); // idempotent: no second end for the first subscriber
    const second: string[] = [];
    session.subscribe({ onLine: () => {}, onEnd: (r) => second.push(r) });
    await session.reset("operator_new");
    expect(first).toEqual(["daemon_stopped"]);
    expect(second).toEqual(["session_reset"]);
    // the daemon_stopped latch cleared with the reset: the next abort is the operator's
    const again = session.prompt("two", {
      source: "operator",
      timeoutMs: 60_000,
      abortGraceMs: 50,
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(await session.abort()).toBe(true);
    await again;
    const reasons = readFileSync(session.transcriptPath, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .filter((r) => r.type === "junco_chat_turn_aborted")
      .map((r) => r.reason);
    expect(reasons).toEqual(["operator"]);
  });

  it("reset() during a pending session build disposes it and writes nothing after the archive", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-chat-"));
    const { session, release, built } = makeDeferredSession(root);
    const p = session.prompt("hello", { source: "operator", timeoutMs: 5_000 });
    await tick(); // the build is parked; `inFlight` is still null
    const resetting = session.reset("operator_new");
    await tick();
    release();
    await resetting;
    expect(await p).toMatchObject({ status: "aborted" });
    expect(built()!.disposed).toBe(true); // never published on this.sdk, never leaked
    expect(session.degraded).toBe(false); // no write into the archived dir
    expect(existsSync(session.transcriptPath)).toBe(false);
    expect(existsSync(join(root, "_archive"))).toBe(true);
  });

  it("drain() during a pending session build disposes it and stamps daemon_stopped", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-chat-"));
    const { session, release, built } = makeDeferredSession(root);
    const p = session.prompt("hello", { source: "operator", timeoutMs: 5_000 });
    await tick();
    const draining = session.drain();
    await tick();
    release();
    await draining;
    expect(await p).toMatchObject({ status: "aborted" });
    expect(built()!.disposed).toBe(true);
    const types = records(session.transcriptPath);
    expect(types[types.length - 1]).toBe("junco_chat_turn_aborted");
    const last = JSON.parse(readFileSync(session.transcriptPath, "utf8").trim().split("\n").pop()!);
    expect(last.reason).toBe("daemon_stopped");
  });

  it("abort() during a pending session build returns true and the SDK is never prompted", async () => {
    const root = mkdtempSync(join(tmpdir(), "junco-chat-"));
    const { session, release, built } = makeDeferredSession(root);
    const p = session.prompt("hello", { source: "operator", timeoutMs: 5_000 });
    await tick();
    expect(await session.abort()).toBe(true); // a STARTING turn counts
    release();
    expect(await p).toMatchObject({ status: "aborted", abortReason: "operator" });
    expect(built()!.prompts).toEqual([]); // runChatTurn's pre-aborted short-circuit
  });
});
