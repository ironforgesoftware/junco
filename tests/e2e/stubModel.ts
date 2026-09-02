/**
 * tests/e2e/stubModel.ts — a scripted OpenAI-compatible model server.
 *
 * Plays the inference endpoint for the REAL Pi SDK running inside the REAL
 * junco process. Protocol verified against
 * pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js
 * (SDK 0.84.2): the adapter drives the official `openai` client with
 * `stream: true` and consumes standard chunk deltas — `choices[0].delta.content`,
 * `choices[0].delta.tool_calls[]` (index / id / function.name /
 * function.arguments), `finish_reason`, then a trailing usage chunk.
 *
 * Fail-fast by design: once the script is exhausted every chat request gets a
 * 500 and `exhausted` flips true. A scenario asserts it stayed false — the
 * loop guards and ticket timeout are a backstop, never what ends a test.
 *
 * Spec: docs/superpowers/specs/2026-09-01-e2e-testing-design.md §5.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type Turn =
  | { kind: "text"; text: string }
  | { kind: "tool"; calls: Array<{ name: string; args: Record<string, unknown> }> }
  /**
   * Answer `status` with an error body. `times` = how many consecutive
   * requests get it (default 1); `Infinity` makes it sticky for the rest of
   * the run — the requeue scenario needs that because the SDK / openai client
   * may retry a 5xx before giving up, and each retry is a fresh request.
   */
  | { kind: "error"; status: number; body?: string; times?: number };

type ContentTurn = Exclude<Turn, { kind: "error" }>;

export interface RecordedRequest {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}

export interface StubModel {
  /** OpenAI-compatible base, e.g. http://127.0.0.1:41234/v1 — use as `model.baseUrl`. */
  url: string;
  /** Every request in arrival order (chat, models, and unknown routes alike). */
  requests: RecordedRequest[];
  /** True once a chat request arrived with no scripted turn left. */
  readonly exhausted: boolean;
  close(): Promise<void>;
}

interface ChunkOpts {
  id: string;
  model: string;
  created: number;
}

const USAGE = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };

/** Encodes one non-error turn as the SSE frames the adapter reads, in order. */
export function encodeTurn(turn: ContentTurn, opts: ChunkOpts): string[] {
  const frame = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;
  const chunk = (
    delta: Record<string, unknown>,
    finish: string | null,
  ): Record<string, unknown> => ({
    id: opts.id,
    object: "chat.completion.chunk",
    created: opts.created,
    model: opts.model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  const frames: string[] = [frame(chunk({ role: "assistant", content: "" }, null))];
  if (turn.kind === "text") {
    // One delta per word so the adapter's accumulation is exercised, not just a single chunk.
    for (const piece of turn.text.match(/\S+\s*|\s+/g) ?? [])
      frames.push(frame(chunk({ content: piece }, null)));
    frames.push(frame(chunk({}, "stop")));
  } else {
    turn.calls.forEach((call, i) => {
      frames.push(
        frame(
          chunk(
            {
              tool_calls: [
                {
                  index: i,
                  id: `call_${opts.id}_${i}`,
                  type: "function",
                  function: { name: call.name, arguments: "" },
                },
              ],
            },
            null,
          ),
        ),
      );
      frames.push(
        frame(
          chunk(
            { tool_calls: [{ index: i, function: { arguments: JSON.stringify(call.args) } }] },
            null,
          ),
        ),
      );
    });
    frames.push(frame(chunk({}, "tool_calls")));
  }
  frames.push(
    frame({
      id: opts.id,
      object: "chat.completion.chunk",
      created: opts.created,
      model: opts.model,
      choices: [],
      usage: USAGE,
    }),
  );
  frames.push("data: [DONE]\n\n");
  return frames;
}

/** The non-streamed equivalent of `encodeTurn`, for a request carrying `stream: false`. */
export function encodeCompletion(turn: ContentTurn, opts: ChunkOpts): Record<string, unknown> {
  const message =
    turn.kind === "text"
      ? { role: "assistant", content: turn.text }
      : {
          role: "assistant",
          content: null,
          tool_calls: turn.calls.map((c, i) => ({
            id: `call_${opts.id}_${i}`,
            type: "function",
            function: { name: c.name, arguments: JSON.stringify(c.args) },
          })),
        };
  return {
    id: opts.id,
    object: "chat.completion",
    created: opts.created,
    model: opts.model,
    choices: [{ index: 0, message, finish_reason: turn.kind === "text" ? "stop" : "tool_calls" }],
    usage: USAGE,
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

export async function startStubModel(script: Turn[]): Promise<StubModel> {
  // Copy each turn: the `times` countdown mutates, and callers reuse scripts.
  const queue: Turn[] = script.map((t) => ({ ...t }));
  const requests: RecordedRequest[] = [];
  const state = { exhausted: false, seq: 0 };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = await readBody(req);
    const path = (req.url ?? "/").split("?")[0];
    let body: Record<string, unknown> | null = null;
    if (raw.length > 0) {
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        body = null;
      }
    }
    const method = req.method ?? "GET";
    requests.push({ method, path, body });

    if (method === "GET" && path.endsWith("/models")) {
      json(res, 200, { object: "list", data: [{ id: "stub", object: "model" }] });
      return;
    }
    if (method !== "POST" || !path.endsWith("/chat/completions")) {
      json(res, 404, {
        error: { message: `stub: no route for ${method} ${path}`, type: "invalid_request_error" },
      });
      return;
    }
    const turn = queue[0];
    if (turn === undefined) {
      state.exhausted = true;
      json(res, 500, { error: { message: "stub script exhausted", type: "server_error" } });
      return;
    }
    if (turn.kind === "error") {
      const left = (turn.times ?? 1) - 1;
      if (left <= 0) queue.shift();
      else turn.times = left;
      json(res, turn.status, {
        error: { message: turn.body ?? `stub: scripted ${turn.status}`, type: "server_error" },
      });
      return;
    }
    queue.shift();
    const opts: ChunkOpts = {
      id: `chatcmpl-stub-${++state.seq}`,
      model: typeof body?.model === "string" ? body.model : "stub",
      created: Math.floor(Date.now() / 1000),
    };
    if (body?.stream === false) {
      json(res, 200, encodeCompletion(turn, opts));
      return;
    }
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    for (const f of encodeTurn(turn, opts)) res.write(f);
    res.end();
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch((e: unknown) => {
      // `handle` can throw after `res.writeHead` (mid-SSE-stream) — at that
      // point the response is committed and a second `json(res, 500, ...)`
      // would throw ERR_HTTP_HEADERS_SENT, turning this catch into an
      // unhandled rejection in the vitest process. Just end the response.
      if (res.headersSent) {
        res.end();
        return;
      }
      json(res, 500, { error: { message: `stub: ${e instanceof Error ? e.message : String(e)}` } });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    get exhausted() {
      return state.exhausted;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections(); // the CLI child may hold keep-alive sockets
        server.close((e) => (e ? reject(e) : resolve()));
      }),
  };
}
