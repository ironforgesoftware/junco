/**
 * tests/e2e/chatStream.e2e.ts — what `/chat/events` carries DURING a turn,
 * against the REAL Pi SDK (spec 2026-09-06 §7's last bullet; plan Task 17).
 *
 * Every other streaming test fakes the SDK (`tests/liveTurn.test.ts`,
 * `tests/chatRoutes.test.ts`). This is the one that proves the real event
 * pipeline end to end: the stub streams a turn that first calls `read`, then
 * answers with `<think>…</think>` text (the tag-in-content shape a local
 * server emits when its reasoning parser is off), and the daemon turns that
 * into the three bus-only records the dashboard renders — `junco_chat_tool`
 * start/end, a `junco_chat_delta` of kind `thinking`, `junco_chat_delta`
 * text — while the raw SDK `message_update` never reaches the wire and the
 * persisted `junco_chat_turn_end` still arrives with an SSE `id`.
 *
 * The answer is streamed with a per-chunk delay (`delayMs`, the stub's
 * opt-in) so a SECOND subscriber can attach while the turn is in flight and
 * prove the snapshot-first contract: its first frame is `junco_chat_partial`
 * carrying every block streamed so far, before anything live.
 *
 * Two scripted turns, exactly: (1) the `read` call; (2) the text. A third
 * request would mean the SDK asked for a turn nobody scripted — the
 * fail-fast stub reports that as `exhausted`, which is asserted.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  chatRequests,
  chatTranscript,
  createSandbox,
  ghLog,
  spawnDaemon,
  stub,
  waitFor,
  type DaemonHandle,
  type Sandbox,
} from "./harness.js";
import type {
  ChatDeltaRecord,
  ChatPartialRecord,
  ChatToolRecord,
} from "../../src/chat/liveBlocks.js";

const THINKING = "consider";
const MARKDOWN = "# Done\n\n```sh\nls\n```";
const ANSWER = `<think>${THINKING}</think>\n${MARKDOWN}`;
/** What the text deltas add up to: everything outside the tags. The splitter
 * trims whitespace only INSIDE a thinking block (thinkSplitter.ts), so the
 * newline after `</think>` is ordinary text — rendering strips it, the wire
 * does not. */
const TEXT = `\n${MARKDOWN}`;

/** One parsed SSE frame: `id:` is present only on persisted lines. */
interface Frame {
  id: string | null;
  event: string | null;
  data: Record<string, unknown>;
}

interface Subscriber {
  frames: Frame[];
  close(): void;
}

/** Open `/chat/events` and parse frames as they arrive; comment lines (pings) are dropped. */
async function subscribe(base: string, key: string, since?: string): Promise<Subscriber> {
  const ac = new AbortController();
  const url = new URL(`${base}/chat/events`);
  url.searchParams.set("key", key);
  if (since !== undefined) url.searchParams.set("since", since);
  const res = await fetch(url, { signal: ac.signal });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  const frames: Frame[] = [];
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buf = "";
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let cut: number;
        while ((cut = buf.indexOf("\n\n")) !== -1) {
          const raw = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          let id: string | null = null;
          let event: string | null = null;
          let data = "";
          for (const line of raw.split("\n")) {
            if (line.startsWith("id: ")) id = line.slice(4);
            else if (line.startsWith("event: ")) event = line.slice(7);
            else if (line.startsWith("data: ")) data += line.slice(6);
          }
          if (data === "") continue; // a `: ping` comment
          frames.push({ id, event, data: JSON.parse(data) as Record<string, unknown> });
        }
      }
    } catch {
      // aborted by close(): the reader rejects, nothing to report
    }
  })();
  return { frames, close: () => ac.abort() };
}

const isDelta = (f: Frame): f is Frame & { data: ChatDeltaRecord } =>
  f.data.type === "junco_chat_delta";
const isTool = (f: Frame): f is Frame & { data: ChatToolRecord } =>
  f.data.type === "junco_chat_tool";
const isPartial = (f: Frame): f is Frame & { data: ChatPartialRecord } =>
  f.data.type === "junco_chat_partial";

describe("e2e: chat streaming", () => {
  let sb: Sandbox | null = null;
  let daemon: DaemonHandle | null = null;
  const subs: Subscriber[] = [];
  afterEach(async () => {
    for (const s of subs.splice(0)) s.close();
    if (daemon && daemon.child.exitCode === null) daemon.child.kill("SIGKILL");
    daemon = null;
    await sb?.close();
    sb = null;
  });

  it("chat-stream: /chat/events carries tool, thinking, and text records in order; a late subscriber gets the partial first", async () => {
    const sandbox = await createSandbox({
      script: [
        { kind: "tool", calls: [{ name: "read", args: { path: "README.md" } }] },
        // ~6 word-chunks × 150 ms: long enough to attach the second subscriber
        // mid-turn, short enough not to matter for the suite's wall clock.
        { kind: "text", text: ANSWER, delayMs: 150 },
      ],
      config: { worker: { pollIntervalSeconds: 3600 } },
    });
    sb = sandbox;
    const base = `http://127.0.0.1:${sandbox.healthPort}`;
    daemon = spawnDaemon(sandbox);
    await waitFor(
      async () => {
        try {
          return (await fetch(`${base}/health`)).ok;
        } catch {
          return false;
        }
      },
      { timeoutMs: 20_000, label: "/health responds" },
    );

    // A local checkout path IS a chat key (chatCwd.ts's local branch).
    const key = sandbox.git.work;
    const first = await subscribe(base, key);
    subs.push(first);

    const res = await fetch(`${base}/chat/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key, text: "read the readme, then answer" }),
    });
    expect(res.status).toBe(202);

    // ---- mid-turn: a second subscriber attaches while text is streaming ---
    // Wait for the thinking delta (the tool has finished by then, and the
    // text is still trickling in behind the stub's delay).
    await waitFor(() => first.frames.some((f) => isDelta(f) && f.data.kind === "thinking"), {
      timeoutMs: 60_000,
      label: "a thinking delta reached the first subscriber",
    });
    const seenAtAttach = first.frames.filter(isDelta);
    const lastPersisted = [...first.frames].reverse().find((f) => f.id !== null)?.id ?? "";
    expect(lastPersisted).not.toBe("");
    // `since` = the last persisted offset the first client saw, exactly what
    // a reconnecting dashboard sends — so the replay is empty and the FIRST
    // frame must be the snapshot.
    const second = await subscribe(base, key, lastPersisted);
    subs.push(second);
    await waitFor(() => second.frames.length > 0, {
      timeoutMs: 10_000,
      label: "the second subscriber got a frame",
    });

    // ---- turn end -------------------------------------------------------
    await waitFor(() => first.frames.some((f) => f.data.type === "junco_chat_turn_end"), {
      timeoutMs: 60_000,
      label: "junco_chat_turn_end reached the first subscriber",
    });
    first.close();
    second.close();

    // ---- the first subscriber's stream, in order --------------------------
    const frames = first.frames;
    const idx = (pred: (f: Frame) => boolean, from = 0): number => {
      const i = frames.slice(from).findIndex(pred);
      expect(i).toBeGreaterThanOrEqual(0);
      return from + i;
    };
    const toolStart = idx((f) => isTool(f) && f.data.phase === "start");
    const startRec = frames[toolStart]!.data as unknown as ChatToolRecord;
    expect(startRec).toMatchObject({ name: "read", args: { path: "README.md" } });
    const toolEnd = idx((f) => isTool(f) && f.data.phase === "end", toolStart);
    const endRec = frames[toolEnd]!.data as unknown as ChatToolRecord;
    expect(endRec.id).toBe(startRec.id);
    expect(endRec.isError).toBe(false);
    expect(endRec.result).toContain("seed");
    const firstThinking = idx((f) => isDelta(f) && f.data.kind === "thinking", toolEnd);
    const firstText = idx((f) => isDelta(f) && f.data.kind === "text", firstThinking);
    const turnEnd = idx((f) => f.data.type === "junco_chat_turn_end", firstText);
    expect(toolStart).toBeLessThan(toolEnd);
    expect(toolEnd).toBeLessThan(firstThinking);
    expect(firstThinking).toBeLessThan(firstText);
    expect(firstText).toBeLessThan(turnEnd);

    // The deltas reassemble the scripted text, split at the think tags.
    const deltas = frames.filter(isDelta).map((f) => f.data);
    const joined = (kind: ChatDeltaRecord["kind"]): string =>
      deltas
        .filter((d) => d.kind === kind)
        .map((d) => d.delta)
        .join("");
    expect(joined("thinking")).toBe(THINKING);
    expect(joined("text")).toBe(TEXT);
    // No thinking delta arrives after the first text delta (the tag closed).
    expect(frames.findLastIndex((f) => isDelta(f) && f.data.kind === "thinking")).toBeLessThan(
      firstText,
    );
    // Every delta has the same turn id and a strictly increasing seq.
    const turnIds = new Set(deltas.map((d) => d.turn));
    expect(turnIds.size).toBe(1);
    for (let i = 1; i < deltas.length; i++)
      expect(deltas[i]!.seq).toBeGreaterThan(deltas[i - 1]!.seq);

    // The persisted turn_end carries an SSE id; the bus-only records never do.
    expect(frames[turnEnd]!.id).not.toBeNull();
    expect(Number.parseInt(frames[turnEnd]!.id ?? "", 10)).toBeGreaterThan(0);
    for (const f of frames) if (isDelta(f) || isTool(f) || isPartial(f)) expect(f.id).toBeNull();
    // The raw SDK delta never reaches the wire (spec §1.2).
    expect(frames.some((f) => f.data.type === "message_update")).toBe(false);
    // Nor the file: the transcript holds no bus-only record.
    const persisted = chatTranscript(sandbox, key).flatMap((l) =>
      l.kind === "junco" ? [l.record.type] : [],
    );
    expect(persisted).toContain("junco_chat_turn_end");
    for (const t of ["junco_chat_delta", "junco_chat_tool", "junco_chat_partial"])
      expect(persisted).not.toContain(t);

    // ---- the second subscriber: snapshot first, then live ------------------
    const partialFrame = second.frames[0]!;
    expect(partialFrame.id).toBeNull();
    expect(isPartial(partialFrame)).toBe(true);
    const partial = partialFrame.data as unknown as ChatPartialRecord;
    expect(partial.turn).toBe([...turnIds][0]);
    const tools = partial.blocks.filter((b) => b.kind === "tool");
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ id: startRec.id, name: "read", done: true, isError: false });
    const thinking = partial.blocks.filter((b) => b.kind === "thinking");
    expect(thinking).toHaveLength(1);
    expect(thinking[0]).toMatchObject({ text: THINKING });
    // The snapshot's text is at least what the first client had seen when
    // the second attached (more may have streamed in between), and never
    // more than the whole answer.
    const seenText = seenAtAttach
      .filter((f) => f.data.kind === "text")
      .map((f) => f.data.delta)
      .join("");
    const partialText = partial.blocks
      .filter((b) => b.kind === "text")
      .map((b) => b.text)
      .join("");
    expect(partialText.startsWith(seenText)).toBe(true);
    expect(TEXT.startsWith(partialText)).toBe(true);
    expect(partial.seq).toBeGreaterThanOrEqual(seenAtAttach.at(-1)!.data.seq);
    // What follows the snapshot is live: only records after its seq, then
    // the persisted turn_end — and the second client's text completes the
    // answer too.
    const liveDeltas = second.frames.slice(1).filter(isDelta);
    for (const f of liveDeltas) expect(f.data.seq).toBeGreaterThan(partial.seq);
    expect(
      partialText +
        liveDeltas
          .filter((f) => f.data.kind === "text")
          .map((f) => f.data.delta)
          .join(""),
    ).toBe(TEXT);
    expect(second.frames.some((f) => f.data.type === "junco_chat_turn_end")).toBe(true);
    expect(second.frames.filter(isPartial)).toHaveLength(1);

    // ---- the wire: exactly the two scripted turns, no gh ----------------
    expect(stub(sandbox).exhausted).toBe(false);
    expect(chatRequests(sandbox)).toHaveLength(2);
    expect(ghLog(sandbox)).toEqual([]);

    daemon.child.kill("SIGTERM");
    expect((await daemon.exited).code).toBe(0);
  });
});
