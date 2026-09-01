import { describe, it, expect } from "vitest";
import { fakeChatSession, chatScriptText } from "./helpers/fakeSession.js";

describe("fakeChatSession (the chat seam's scriptable fake)", () => {
  it("emits one script per prompt(), to listeners subscribed at prompt time, and grows messages", async () => {
    const s = await fakeChatSession([chatScriptText("one"), chatScriptText("two", 0.5)])();
    const seen: string[] = [];
    s.subscribe((e) => seen.push((e as { type: string }).type));
    expect(s.isIdle).toBe(true);
    const p = s.prompt("hello");
    expect(s.isStreaming).toBe(true);
    await p;
    expect(s.isStreaming).toBe(false);
    expect(seen).toEqual([
      "message_start",
      "message_update",
      "turn_end",
      "agent_end",
      "agent_settled",
    ]);
    expect(s.messages.length).toBe(2); // user + assistant
    await s.prompt("again");
    expect(s.messages.length).toBe(4);
    expect(s.prompts).toEqual(["hello", "again"]);
  });
  it("steer() records without emitting; a throwing script rejects prompt()", async () => {
    const s = await fakeChatSession([{ events: [], throws: "fetch failed: 429" }])();
    await s.steer("faster");
    expect(s.steers).toEqual(["faster"]);
    await expect(s.prompt("x")).rejects.toThrow("429");
  });
  it("abort() resolves an in-flight prompt early", async () => {
    const s = await fakeChatSession([{ events: [], delayMs: 10_000 }])();
    const p = s.prompt("slow");
    await s.abort();
    await p; // resolves promptly instead of after 10s
    expect(s.aborted).toBe(1);
  });
});
