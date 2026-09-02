import { describe, it, expect, afterEach } from "vitest";
import { encodeTurn, encodeCompletion, startStubModel, type StubModel } from "./e2e/stubModel.js";

const OPTS = { id: "chatcmpl-1", model: "stub", created: 1_700_000_000 };

/** Parse the `data: {...}` frames back into objects, keeping the [DONE] sentinel as a string. */
function decode(frames: string[]): Array<Record<string, unknown> | "[DONE]"> {
  return frames.map((f) => {
    expect(f.startsWith("data: ")).toBe(true);
    expect(f.endsWith("\n\n")).toBe(true);
    const payload = f.slice("data: ".length, -2);
    return payload === "[DONE]" ? "[DONE]" : (JSON.parse(payload) as Record<string, unknown>);
  });
}

type Chunk = {
  choices: Array<{ delta: Record<string, unknown>; finish_reason: string | null }>;
  usage?: unknown;
};

describe("encodeTurn", () => {
  it("streams a text turn as role → content deltas → stop → usage → [DONE]", () => {
    const frames = decode(encodeTurn({ kind: "text", text: "Done. Really done." }, OPTS));
    expect(frames.at(-1)).toBe("[DONE]");
    const chunks = frames.slice(0, -1) as Chunk[];
    expect(chunks[0].choices[0].delta).toEqual({ role: "assistant", content: "" });
    const content = chunks
      .map((c) => c.choices[0]?.delta.content)
      .filter((s): s is string => typeof s === "string")
      .join("");
    expect(content).toBe("Done. Really done.");
    const finish = chunks.find((c) => c.choices[0]?.finish_reason !== null && c.choices.length > 0);
    expect(finish?.choices[0].finish_reason).toBe("stop");
    const usage = chunks.at(-1);
    expect(usage?.choices).toEqual([]);
    expect(usage?.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  });

  it("streams a tool turn with per-call index bookkeeping and finish_reason tool_calls", () => {
    const frames = decode(
      encodeTurn(
        {
          kind: "tool",
          calls: [
            { name: "write", args: { path: "a.txt", content: "A" } },
            { name: "bash", args: { command: "true" } },
          ],
        },
        OPTS,
      ),
    );
    const chunks = frames.slice(0, -1) as Chunk[];
    type TC = { index: number; id?: string; function: { name?: string; arguments: string } };
    const byIndex = new Map<number, { id?: string; name?: string; args: string }>();
    for (const c of chunks) {
      const tcs = c.choices[0]?.delta.tool_calls as TC[] | undefined;
      for (const tc of tcs ?? []) {
        const cur = byIndex.get(tc.index) ?? { args: "" };
        if (tc.id) cur.id = tc.id;
        if (tc.function.name) cur.name = tc.function.name;
        cur.args += tc.function.arguments;
        byIndex.set(tc.index, cur);
      }
    }
    expect([...byIndex.keys()]).toEqual([0, 1]);
    expect(byIndex.get(0)?.name).toBe("write");
    expect(JSON.parse(byIndex.get(0)?.args ?? "")).toEqual({ path: "a.txt", content: "A" });
    expect(byIndex.get(1)?.name).toBe("bash");
    expect(byIndex.get(0)?.id).not.toBe(byIndex.get(1)?.id);
    const finish = chunks.find((c) => c.choices.length > 0 && c.choices[0].finish_reason !== null);
    expect(finish?.choices[0].finish_reason).toBe("tool_calls");
  });

  it("encodeCompletion renders the non-streamed equivalent", () => {
    const text = encodeCompletion({ kind: "text", text: "hi" }, OPTS) as {
      choices: Array<{ message: { content: string | null }; finish_reason: string }>;
    };
    expect(text.choices[0].message.content).toBe("hi");
    expect(text.choices[0].finish_reason).toBe("stop");
    const tool = encodeCompletion({ kind: "tool", calls: [{ name: "ls", args: {} }] }, OPTS) as {
      choices: Array<{
        message: { content: null; tool_calls: Array<{ function: { name: string } }> };
        finish_reason: string;
      }>;
    };
    expect(tool.choices[0].message.tool_calls[0].function.name).toBe("ls");
    expect(tool.choices[0].finish_reason).toBe("tool_calls");
  });
});

describe("startStubModel", () => {
  let stub: StubModel | null = null;
  afterEach(async () => {
    await stub?.close();
    stub = null;
  });

  const chat = (url: string, body: Record<string, unknown>) =>
    fetch(`${url}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("serves scripted turns in order, repeats an error `times` times, then fails fast when exhausted", async () => {
    stub = await startStubModel([
      { kind: "text", text: "Done." },
      { kind: "error", status: 503, times: 2 },
    ]);
    const r1 = await chat(stub.url, {
      model: "stub",
      messages: [{ role: "user", content: "go" }],
      stream: true,
    });
    expect(r1.status).toBe(200);
    expect(r1.headers.get("content-type")).toBe("text/event-stream");
    const sse = await r1.text();
    expect(sse).toContain('"content":"Done."');
    expect(sse.trimEnd().endsWith("data: [DONE]")).toBe(true);

    expect((await chat(stub.url, { model: "stub", messages: [] })).status).toBe(503);
    expect((await chat(stub.url, { model: "stub", messages: [] })).status).toBe(503);
    expect(stub.exhausted).toBe(false);

    const r4 = await chat(stub.url, { model: "stub", messages: [] });
    expect(r4.status).toBe(500);
    expect(await r4.text()).toContain("stub script exhausted");
    expect(stub.exhausted).toBe(true);

    expect(stub.requests.map((q) => q.path)).toEqual(Array(4).fill("/v1/chat/completions"));
    expect(stub.requests[0].body).toEqual({
      model: "stub",
      messages: [{ role: "user", content: "go" }],
      stream: true,
    });
  });

  it("answers stream:false with a JSON completion, GET /models with a list, and anything else with 404", async () => {
    stub = await startStubModel([{ kind: "text", text: "plain" }]);
    const r = await chat(stub.url, { model: "stub", messages: [], stream: false });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { choices: Array<{ message: { content: string } }> };
    expect(body.choices[0].message.content).toBe("plain");

    const models = await fetch(`${stub.url}/models`);
    expect(models.status).toBe(200);
    expect(((await models.json()) as { data: Array<{ id: string }> }).data[0].id).toBe("stub");

    const nope = await fetch(`${stub.url}/embeddings`, { method: "POST", body: "{}" });
    expect(nope.status).toBe(404);
    expect(stub.requests.at(-1)?.path).toBe("/v1/embeddings");
  });

  it("an error turn with times: Infinity is sticky and never marks the script exhausted", async () => {
    stub = await startStubModel([{ kind: "error", status: 503, times: Infinity }]);
    for (let i = 0; i < 5; i++)
      expect((await chat(stub.url, { model: "stub", messages: [] })).status).toBe(503);
    expect(stub.exhausted).toBe(false);
  });
});
