import { describe, it, expect, beforeEach } from "vitest";
import { ProviderGate, type GateStateKind } from "../src/providerGate.js";

describe("ProviderGate", () => {
  let t: number;
  let transitions: Array<[GateStateKind, GateStateKind]>;
  let gate: ProviderGate;

  beforeEach(() => {
    t = 0;
    transitions = [];
    gate = new ProviderGate({
      retryBackoffSeconds: 60,
      now: () => t,
      onTransition: (from, to) => transitions.push([from, to]),
    });
  });

  it("starts ok with a fully-null status and open claiming", () => {
    expect(gate.status()).toEqual({ state: "ok", reason: null, since: null, until: null });
    expect(gate.claimBlockReason()).toBeNull();
  });

  describe("latched failures", () => {
    it("auth → auth_error, latched (no until), blocks claiming", () => {
      gate.reportFailure("auth", "401 unauthorized");
      expect(gate.status()).toEqual({
        state: "auth_error",
        reason: "401 unauthorized",
        since: new Date(0).toISOString(),
        until: null,
      });
      expect(gate.claimBlockReason()).toBe("401 unauthorized");
    });

    it("quota → quota_exhausted, latched", () => {
      gate.reportFailure("quota", "insufficient_quota");
      expect(gate.status().state).toBe("quota_exhausted");
      expect(gate.claimBlockReason()).toBe("insufficient_quota");
    });

    it("model_not_found → misconfig, latched", () => {
      gate.reportFailure("model_not_found", "model not found: gpt-x");
      expect(gate.status().state).toBe("misconfig");
      expect(gate.claimBlockReason()).toBe("model not found: gpt-x");
    });

    it("stays blocked until reportSuccess()", () => {
      gate.reportFailure("auth", "401");
      gate.reportSuccess();
      expect(gate.claimBlockReason()).toBeNull();
      expect(gate.status().state).toBe("ok");
    });

    it("stays blocked until clearLatched()", () => {
      gate.reportFailure("quota", "insufficient_quota");
      gate.clearLatched();
      expect(gate.claimBlockReason()).toBeNull();
      expect(gate.status().state).toBe("ok");
    });

    it("repeated same-class reports do not fire onTransition, and `since` stays pinned to first entry", () => {
      gate.reportFailure("auth", "401 first");
      expect(transitions).toEqual([["ok", "auth_error"]]);
      t = 5_000;
      gate.reportFailure("auth", "401 second");
      // still just the one ok -> auth_error transition
      expect(transitions).toEqual([["ok", "auth_error"]]);
      const s = gate.status();
      expect(s.since).toBe(new Date(0).toISOString());
      expect(s.reason).toBe("401 second");
    });
  });

  describe("rate_limit backoff + doubling", () => {
    it("doubles the delay per consecutive report, capped at 900s, for base 60s", () => {
      const expectedDelaysSeconds = [60, 120, 240, 480, 900, 900];
      for (const seconds of expectedDelaysSeconds) {
        gate.reportFailure("rate_limit", "429 too many requests");
        const s = gate.status();
        expect(s.state).toBe("rate_limited");
        expect(s.until).toBe(new Date(t + seconds * 1000).toISOString());
      }
      // one real transition (ok -> rate_limited); the rest just extend `until`
      expect(transitions).toEqual([["ok", "rate_limited"]]);
    });

    it("reportSuccess resets the streak — the next rate_limit report starts back at the base delay", () => {
      gate.reportFailure("rate_limit", "429"); // streak 1 -> 60s
      gate.reportFailure("rate_limit", "429"); // streak 2 -> 120s
      gate.reportSuccess();
      gate.reportFailure("rate_limit", "429"); // streak reset -> back to 60s
      expect(gate.status().until).toBe(new Date(t + 60 * 1000).toISOString());
    });

    it("clearLatched resets the streak too", () => {
      gate.reportFailure("rate_limit", "429"); // streak 1 -> 60s
      gate.reportFailure("rate_limit", "429"); // streak 2 -> 120s
      gate.clearLatched();
      gate.reportFailure("rate_limit", "429"); // streak reset -> back to 60s
      expect(gate.status().until).toBe(new Date(t + 60 * 1000).toISOString());
    });

    it("extending `until` while already rate_limited does not fire onTransition (state kind unchanged)", () => {
      gate.reportFailure("rate_limit", "429 first");
      gate.reportFailure("rate_limit", "429 second");
      expect(transitions).toEqual([["ok", "rate_limited"]]);
    });

    it("blocks claiming while active, and auto-expires to ok once `until` has passed (firing onTransition)", () => {
      gate.reportFailure("rate_limit", "429");
      expect(gate.claimBlockReason()).toBe("429");
      t = 60_000; // == until: expired
      const s = gate.status();
      expect(s.state).toBe("ok");
      expect(s.until).toBeNull();
      expect(transitions).toEqual([
        ["ok", "rate_limited"],
        ["rate_limited", "ok"],
      ]);
    });

    it("claimBlockReason() goes through the same expiry logic as status()", () => {
      gate.reportFailure("rate_limit", "429");
      t = 60_000;
      expect(gate.claimBlockReason()).toBeNull();
      expect(transitions).toEqual([
        ["ok", "rate_limited"],
        ["rate_limited", "ok"],
      ]);
    });

    it("reportFailure itself routes through expiry — a report after `until` with NO intervening read starts a fresh episode", () => {
      gate.reportFailure("rate_limit", "429 first"); // until = 60_000
      t = 100_000; // well past until — and crucially, no status()/claimBlockReason() read here
      gate.reportFailure("rate_limit", "429 second");
      // The stale rate_limited must expire inside reportFailure, so the pair fires...
      expect(transitions).toEqual([
        ["ok", "rate_limited"],
        ["rate_limited", "ok"],
        ["ok", "rate_limited"],
      ]);
      // ...and `since` reflects the second report's time, not the first episode's.
      expect(gate.status().since).toBe(new Date(100_000).toISOString());
    });

    it("streak survives auto-expiry — doubling continues across an expired episode (only success/clear reset it)", () => {
      gate.reportFailure("rate_limit", "429"); // streak 1 -> until = 60_000
      t = 100_000;
      expect(gate.status().state).toBe("ok"); // auto-expired on read
      gate.reportFailure("rate_limit", "429 again"); // streak 2 -> 120s, NOT back to 60s
      expect(gate.status().until).toBe(new Date(100_000 + 120 * 1000).toISOString());
    });

    it("does not re-fire onTransition on a second read after expiry", () => {
      gate.reportFailure("rate_limit", "429");
      t = 60_000;
      gate.status();
      gate.status();
      expect(transitions).toEqual([
        ["ok", "rate_limited"],
        ["rate_limited", "ok"],
      ]);
    });
  });

  describe("outage backoff", () => {
    it("outage → outage_backoff with until = now + retryBackoffSeconds", () => {
      gate.reportFailure("outage", "503 service unavailable");
      const s = gate.status();
      expect(s.state).toBe("outage_backoff");
      expect(s.reason).toBe("503 service unavailable");
      expect(s.until).toBe(new Date(60_000).toISOString());
    });

    it("does not double on repeated reports — always exactly retryBackoffSeconds from the latest report", () => {
      gate.reportFailure("outage", "503");
      expect(gate.status().until).toBe(new Date(60_000).toISOString());
      t = 10_000;
      gate.reportFailure("outage", "503");
      expect(gate.status().until).toBe(new Date(70_000).toISOString());
    });

    it("does not overwrite an existing latched state (latch wins)", () => {
      gate.reportFailure("auth", "401");
      gate.reportFailure("outage", "503");
      const s = gate.status();
      expect(s.state).toBe("auth_error");
      expect(s.reason).toBe("401");
      expect(transitions).toEqual([["ok", "auth_error"]]);
    });

    it("blocks claiming while active, and clears once `until` has passed", () => {
      gate.reportFailure("outage", "503");
      expect(gate.claimBlockReason()).toBe("503");
      t = 60_000;
      expect(gate.claimBlockReason()).toBeNull();
    });
  });

  describe("rate_limit vs. latches", () => {
    it("does not overwrite an existing latched state (latch wins)", () => {
      gate.reportFailure("quota", "insufficient_quota");
      gate.reportFailure("rate_limit", "429");
      const s = gate.status();
      expect(s.state).toBe("quota_exhausted");
      expect(s.reason).toBe("insufficient_quota");
      expect(transitions).toEqual([["ok", "quota_exhausted"]]);
    });
  });

  describe("unknown classification", () => {
    it("is a no-op from ok", () => {
      gate.reportFailure("unknown", "some unrelated text");
      expect(gate.status()).toEqual({ state: "ok", reason: null, since: null, until: null });
      expect(transitions).toEqual([]);
    });

    it("is a no-op from a non-ok state — does not alter or extend an existing backoff", () => {
      gate.reportFailure("rate_limit", "429");
      const before = gate.status();
      gate.reportFailure("unknown", "some unrelated text");
      expect(gate.status()).toEqual(before);
      expect(transitions).toEqual([["ok", "rate_limited"]]);
    });
  });

  describe("reportSuccess", () => {
    it("clears a latch and fires onTransition", () => {
      gate.reportFailure("auth", "401");
      gate.reportSuccess();
      expect(gate.status()).toEqual({ state: "ok", reason: null, since: null, until: null });
      expect(transitions).toEqual([
        ["ok", "auth_error"],
        ["auth_error", "ok"],
      ]);
    });

    it("clears an until-based backoff and fires onTransition", () => {
      gate.reportFailure("rate_limit", "429");
      gate.reportSuccess();
      expect(gate.status().state).toBe("ok");
      expect(transitions).toEqual([
        ["ok", "rate_limited"],
        ["rate_limited", "ok"],
      ]);
    });

    it("is a no-op (no onTransition) when already ok", () => {
      gate.reportSuccess();
      expect(transitions).toEqual([]);
      expect(gate.status().state).toBe("ok");
    });
  });

  describe("clearLatched", () => {
    it("clears a latched state and fires onTransition", () => {
      gate.reportFailure("quota", "insufficient_quota");
      gate.clearLatched();
      expect(gate.status().state).toBe("ok");
      expect(transitions).toEqual([
        ["ok", "quota_exhausted"],
        ["quota_exhausted", "ok"],
      ]);
    });

    it("also clears until-based states (config change = full reset)", () => {
      gate.reportFailure("outage", "503");
      gate.clearLatched();
      expect(gate.status().state).toBe("ok");
      expect(transitions).toEqual([
        ["ok", "outage_backoff"],
        ["outage_backoff", "ok"],
      ]);
    });

    it("is a no-op (no onTransition) when already ok", () => {
      gate.clearLatched();
      expect(transitions).toEqual([]);
    });
  });

  describe("notBeforeIso", () => {
    it("returns `now` when ok", () => {
      expect(gate.notBeforeIso()).toBe(new Date(0).toISOString());
      t = 12_345;
      expect(gate.notBeforeIso()).toBe(new Date(12_345).toISOString());
    });

    it("returns the `until` instant for an until-based state", () => {
      gate.reportFailure("rate_limit", "429"); // until = 60_000
      expect(gate.notBeforeIso()).toBe(new Date(60_000).toISOString());
    });

    it("returns now + retryBackoffSeconds for a latched state", () => {
      gate.reportFailure("auth", "401");
      t = 5_000;
      expect(gate.notBeforeIso()).toBe(new Date(5_000 + 60_000).toISOString());
    });

    it("goes through the same auto-expiry logic — an expired until-based state reads as `now`", () => {
      gate.reportFailure("rate_limit", "429"); // until = 60_000
      t = 60_000;
      expect(gate.notBeforeIso()).toBe(new Date(60_000).toISOString());
    });
  });
});
