/**
 * One chat turn (spec 2026-09-01 §3): runAgent's subscribe → prompt → settle
 * shape (src/agent/session.ts:183-370) with NO GuardManager — the human is the
 * supervisor and steer() is the nudge — and with the session left alive
 * afterwards (a chat session is prompted many times). What stays from the
 * ticket world is the per-turn timeout, the operator abort, and the wedge
 * grace after an abort (#51).
 */
import type { AgentEvent, ChatSessionLike } from "../agent/session.js";
import { RunAccumulator } from "../agent/runResult.js";
import type { Usage } from "../types.js";
import { log } from "../logging.js";

export interface ChatTurnOpts {
  text: string;
  timeoutMs: number;
  /** Every SDK event, in order. Best-effort: a throw is logged and ignored. */
  emit: (event: unknown) => void;
  /** Operator abort. */
  abortSignal?: AbortSignal;
  /** Wedge grace after an abort (default 60s); tests short-circuit it. */
  abortGraceMs?: number;
  now?: () => number;
}

export interface ChatTurnResult {
  mode: "prompt" | "steer";
  status: "ok" | "error" | "aborted";
  abortReason: "timeout" | "operator" | null;
  errorMessage: string | null;
  usage: Usage;
  durationMs: number;
  finalText: string;
  allText: string;
}

const ABORT_GRACE_MS = 60_000;
const ZERO_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, total: 0, costUsd: 0 };

export async function runChatTurn(
  session: ChatSessionLike,
  opts: ChatTurnOpts,
): Promise<ChatTurnResult> {
  const now = opts.now ?? (() => Date.now());
  const start = now();

  // Streaming → steer: the SDK queues it and delivers it at the next tool
  // boundary of the RUNNING turn, whose own completion covers this text.
  if (session.isStreaming) {
    await session.steer(opts.text);
    return {
      mode: "steer",
      status: "ok",
      abortReason: null,
      errorMessage: null,
      usage: ZERO_USAGE,
      durationMs: now() - start,
      finalText: "",
      allText: "",
    };
  }

  const acc = new RunAccumulator();
  let abortReason: "timeout" | "operator" | null = null;
  let wedged = false;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveWedge: (() => void) | undefined;
  const wedgePromise = new Promise<void>((resolve) => {
    resolveWedge = resolve;
  });
  const armAbortGrace = (): void => {
    if (graceTimer !== undefined) return;
    graceTimer = setTimeout(() => {
      wedged = true;
      resolveWedge?.();
    }, opts.abortGraceMs ?? ABORT_GRACE_MS);
  };
  const softAbort = (reason: "timeout" | "operator"): void => {
    if (abortReason === null) abortReason = reason;
    void session.abort().catch(() => {});
    armAbortGrace();
  };
  const timer = setTimeout(() => softAbort("timeout"), opts.timeoutMs);
  const onExternalAbort = (): void => softAbort("operator");
  if (opts.abortSignal?.aborted) onExternalAbort();
  else opts.abortSignal?.addEventListener("abort", onExternalAbort, { once: true });

  let unsubscribe: (() => void) | undefined;
  let thrown: string | null = null;
  try {
    unsubscribe = session.subscribe((e: AgentEvent) => {
      acc.observe(e);
      try {
        opts.emit(e);
      } catch (err) {
        log.warn("chat emit threw; ignoring", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
    const runPromise = session.prompt(opts.text);
    runPromise.catch(() => {});
    await Promise.race([runPromise, wedgePromise]);
    if (wedged)
      log.warn("chat turn wedged after abort — returning salvaged result", { abortReason });
  } catch (e) {
    thrown = e instanceof Error ? e.message : String(e);
  } finally {
    clearTimeout(timer);
    if (graceTimer !== undefined) clearTimeout(graceTimer);
    opts.abortSignal?.removeEventListener("abort", onExternalAbort);
    unsubscribe?.();
  }

  const durationMs = now() - start;
  const r = acc.result(durationMs, abortReason === "timeout", false);
  const errorMessage = thrown ?? r.errorMessage;
  return {
    mode: "prompt",
    status: abortReason !== null ? "aborted" : errorMessage !== null ? "error" : "ok",
    abortReason,
    errorMessage,
    usage: r.usage,
    durationMs,
    finalText: r.finalText,
    allText: r.allText ?? r.finalText,
  };
}
