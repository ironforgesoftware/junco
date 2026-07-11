import type { ProviderFailureClass } from "./providerFailure.js";

export type GateStateKind =
  | "ok"
  | "auth_error"
  | "quota_exhausted"
  | "misconfig"
  | "rate_limited"
  | "outage_backoff";

export interface GateStatus {
  state: GateStateKind;
  reason: string | null; // human-readable cause, e.g. the classified error text
  since: string | null; // ISO — when the non-ok state was entered
  until: string | null; // ISO — rate_limited/outage_backoff expiry; null for latches
}

export interface ProviderGateOpts {
  retryBackoffSeconds: number; // base for rate-limit doubling and outage block
  now?: () => number; // injectable clock (tests)
  onTransition?: (from: GateStateKind, to: GateStateKind) => void; // daemon wires metrics
}

interface InternalState {
  kind: GateStateKind;
  reason: string | null;
  since: number | null; // epoch ms; null only while ok
  until: number | null; // epoch ms; set only for rate_limited/outage_backoff
}

const LATCHED_KINDS: ReadonlySet<GateStateKind> = new Set([
  "auth_error",
  "quota_exhausted",
  "misconfig",
]);

const OK_STATE: InternalState = { kind: "ok", reason: null, since: null, until: null };

/**
 * Latching provider-failure state machine.
 *
 * Dependency-free by design: no metrics/log imports and no timers anywhere —
 * the daemon wires `onTransition` to its own metrics emitter, and every
 * `until`-based deadline is checked lazily, at read time, via the private
 * `currentState()` (shared by status()/claimBlockReason()/notBeforeIso() so
 * they can never disagree about whether a deadline has passed).
 *
 * Two families of non-ok state:
 *  - Latches (auth_error/quota_exhausted/misconfig): operator-fixable
 *    misconfiguration, not transient load. They stick until an explicit
 *    reportSuccess()/clearLatched() — auto-retrying them would just spin
 *    against a provider that will keep saying no. A latch is never
 *    downgraded by a later rate_limit/outage report ("latch wins").
 *  - Until-based backoffs (rate_limited/outage_backoff): expire on their own
 *    once read past their deadline.
 */
export class ProviderGate {
  private readonly retryBackoffSeconds: number;
  private readonly now: () => number;
  private readonly onTransitionCb: ((from: GateStateKind, to: GateStateKind) => void) | undefined;

  private state: InternalState = OK_STATE;
  private streak = 0;

  constructor(opts: ProviderGateOpts) {
    this.retryBackoffSeconds = opts.retryBackoffSeconds;
    this.now = opts.now ?? (() => Date.now());
    this.onTransitionCb = opts.onTransition;
  }

  reportFailure(cls: ProviderFailureClass, reason: string): void {
    switch (cls) {
      case "auth":
        this.transitionTo("auth_error", reason, null);
        return;
      case "quota":
        this.transitionTo("quota_exhausted", reason, null);
        return;
      case "model_not_found":
        this.transitionTo("misconfig", reason, null);
        return;
      case "rate_limit": {
        if (LATCHED_KINDS.has(this.state.kind)) return; // latch wins
        this.streak += 1;
        const delaySeconds = Math.min(this.retryBackoffSeconds * 2 ** (this.streak - 1), 900);
        this.transitionTo("rate_limited", reason, this.now() + delaySeconds * 1000);
        return;
      }
      case "outage": {
        if (LATCHED_KINDS.has(this.state.kind)) return; // latch wins
        // Single interval, never doubles — recomputed fresh from "now" on
        // every report, so repeated outage reports don't accumulate delay.
        this.transitionTo("outage_backoff", reason, this.now() + this.retryBackoffSeconds * 1000);
        return;
      }
      case "unknown":
        return; // no signal strong enough to act on
    }
  }

  /** Any successful session clears everything: latches, backoffs, and streak. */
  reportSuccess(): void {
    this.streak = 0;
    this.transitionTo("ok", null, null);
  }

  /**
   * Config hot-reload apply / operator action: clears latched states AND
   * until-based states alike — a full reset, same effect as reportSuccess().
   * Kept as a separate method because the call site differs (an external
   * "try again" signal vs. an actual successful session).
   */
  clearLatched(): void {
    this.streak = 0;
    this.transitionTo("ok", null, null);
  }

  status(): GateStatus {
    const s = this.currentState();
    return {
      state: s.kind,
      reason: s.reason,
      since: s.since !== null ? new Date(s.since).toISOString() : null,
      until: s.until !== null ? new Date(s.until).toISOString() : null,
    };
  }

  claimBlockReason(): string | null {
    const s = this.currentState();
    return s.kind === "ok" ? null : s.reason;
  }

  notBeforeIso(): string {
    const s = this.currentState();
    if (s.until !== null) return new Date(s.until).toISOString();
    if (LATCHED_KINDS.has(s.kind)) {
      return new Date(this.now() + this.retryBackoffSeconds * 1000).toISOString();
    }
    return new Date(this.now()).toISOString();
  }

  /**
   * Single expiry check shared by status()/claimBlockReason()/notBeforeIso().
   * `until`-based states auto-expire to `ok` the moment they're read past
   * their deadline (>=) — there is no timer driving this anywhere.
   */
  private currentState(): InternalState {
    if (this.state.until !== null && this.now() >= this.state.until) {
      this.transitionTo("ok", null, null);
    }
    return this.state;
  }

  private transitionTo(kind: GateStateKind, reason: string | null, until: number | null): void {
    const from = this.state.kind;
    if (from === kind) {
      // Same state kind: not a "transition" — e.g. a rate_limit report that
      // just pushes `until` further out, or a repeated latch report with a
      // fresh reason string. `since` (when the state was entered) is left
      // untouched, and onTransition does not fire.
      this.state = { ...this.state, reason: kind === "ok" ? null : reason, until };
      return;
    }
    this.state = {
      kind,
      reason: kind === "ok" ? null : reason,
      since: kind === "ok" ? null : this.now(),
      until,
    };
    this.onTransitionCb?.(from, kind);
  }
}
