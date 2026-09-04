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
  /** Session-owned so the submit tool can pause it; absent → a private one. */
  deadline?: TurnDeadline;
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

/**
 * The per-turn timeout as a PAUSABLE deadline (spec 2026-09-03 §3.3): while a
 * `junco_submit` call waits for the operator's y/n the clock stops, so a slow
 * human never trips the turn's 30-minute budget — the confirmation has its own.
 * Arithmetic, not wall-clock: `remaining` shrinks only by armed spans.
 */
export class TurnDeadline {
  private remaining: number;
  private armedAt: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private onFire: (() => void) | null = null;
  private isPaused = false;
  /** One-shot: set by a fire and by clear(). `remaining` is 0 (or a leftover
   *  budget) at that point, so re-arming would fire immediately or run on a
   *  stale clock. No caller reuses an instance — a fresh TurnDeadline is minted
   *  per turn in chatSession.admit — and this makes a reuse inert rather than
   *  a surprise (#481). */
  private spent = false;

  constructor(
    ms: number,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.remaining = ms;
  }

  get paused(): boolean {
    return this.isPaused;
  }

  get remainingMs(): number {
    return this.armedAt === null
      ? this.remaining
      : Math.max(0, this.remaining - (this.now() - this.armedAt));
  }

  arm(onFire: () => void): void {
    if (this.spent) return;
    this.onFire = onFire;
    if (!this.isPaused) this.start();
  }

  pause(): void {
    if (this.isPaused) return;
    this.isPaused = true;
    this.stop();
  }

  resume(): void {
    if (!this.isPaused) return;
    this.isPaused = false;
    if (this.onFire !== null && !this.spent) this.start();
  }

  clear(): void {
    this.spent = true;
    this.stop();
    this.onFire = null;
  }

  private start(): void {
    this.armedAt = this.now();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.armedAt = null;
      this.remaining = 0;
      this.spent = true;
      this.onFire?.();
    }, this.remaining);
  }

  private stop(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.armedAt !== null) {
      this.remaining = Math.max(0, this.remaining - (this.now() - this.armedAt));
      this.armedAt = null;
    }
  }
}

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

  // Pre-aborted signal means "do not run": the SDK does not latch aborts —
  // session.abort() with no active run is a no-op (see runAgent's identical
  // preAbortedResult short-circuit at src/agent/session.ts:214-229) — so
  // without this check the turn would run to completion (or its own timeout)
  // regardless of the operator's already-signalled abort.
  if (opts.abortSignal?.aborted) {
    return {
      mode: "prompt",
      status: "aborted",
      abortReason: "operator",
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
  const deadline = opts.deadline ?? new TurnDeadline(opts.timeoutMs, now);
  deadline.arm(() => softAbort("timeout"));
  const onExternalAbort = (): void => softAbort("operator");
  opts.abortSignal?.addEventListener("abort", onExternalAbort, { once: true });

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
    deadline.clear();
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
