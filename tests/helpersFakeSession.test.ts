// tests/helpersFakeSession.test.ts — direct coverage for tests/helpers/fakeSession.ts.
//
// The shared fakes are consumed indirectly by runOnce/analyzeFlow/assessFlow,
// where a break in them surfaces as a confusing flow-level failure. These tests
// pin the seam itself: what reaches a subscriber, that unsubscribe stops
// delivery, that prompt() resolves (or throws, for the failure fake), and that
// dispose()/abort() are safe no-ops.
import { describe, it, expect } from "vitest";
import {
  fakeSession,
  fakeMultiMessageSession,
  throwingSession,
  type FakeSessionFactory,
} from "./helpers/fakeSession.js";

/** Collect every event a factory-built session delivers to one subscriber. */
async function collect(factory: FakeSessionFactory): Promise<unknown[]> {
  const session = await factory();
  const events: unknown[] = [];
  session.subscribe((e) => events.push(e));
  await session.prompt("go");
  return events;
}

describe("fakeSession", () => {
  it("delivers text_delta, turn_end and agent_end to a subscriber", async () => {
    const events = (await collect(fakeSession("hello"))) as Array<Record<string, any>>;
    expect(events.map((e) => e.type)).toEqual(["message_update", "turn_end", "agent_end"]);
    expect(events[0].assistantMessageEvent).toEqual({ type: "text_delta", delta: "hello" });
    expect(events[1].message.stopReason).toBe("stop");
    expect(events[2].willRetry).toBe(false);
  });

  it("carries the cost on turn_end usage (default 0)", async () => {
    const zero = (await collect(fakeSession("x"))) as Array<Record<string, any>>;
    expect(zero[1].message.usage.cost.total).toBe(0);

    const priced = (await collect(fakeSession("x", 0.0042))) as Array<Record<string, any>>;
    expect(priced[1].message.usage.cost.total).toBe(0.0042);
  });

  it("stops delivering once the subscription is disposed", async () => {
    const session = await fakeSession("hello")();
    const events: unknown[] = [];
    const unsubscribe = session.subscribe((e) => events.push(e));
    unsubscribe();
    await session.prompt("go");
    expect(events).toEqual([]);
  });

  it("resolves prompt() and tolerates dispose()/abort()", async () => {
    const session = await fakeSession("hello")();
    await expect(session.prompt("go")).resolves.toBeUndefined();
    expect(() => session.dispose()).not.toThrow();
    await expect(session.abort()).resolves.toBeUndefined();
  });
});

describe("fakeMultiMessageSession", () => {
  it("emits one message_start + text_delta pair per scripted message", async () => {
    const events = (await collect(fakeMultiMessageSession(["one", "two"]))) as Array<
      Record<string, any>
    >;
    expect(events.map((e) => e.type)).toEqual([
      "message_start",
      "message_update",
      "message_start",
      "message_update",
      "turn_end",
      "agent_end",
    ]);
    expect(events[1].assistantMessageEvent.delta).toBe("one");
    expect(events[3].assistantMessageEvent.delta).toBe("two");
    expect(events[0].message.role).toBe("assistant");
  });

  it("stops delivering once the subscription is disposed", async () => {
    const session = await fakeMultiMessageSession(["one"])();
    const events: unknown[] = [];
    const unsubscribe = session.subscribe((e) => events.push(e));
    unsubscribe();
    await session.prompt("go");
    expect(events).toEqual([]);
  });
});

describe("throwingSession", () => {
  it("throws the transient-failure signature from prompt() and emits nothing", async () => {
    const session = await throwingSession()();
    const events: unknown[] = [];
    session.subscribe((e) => events.push(e));
    await expect(session.prompt("go")).rejects.toThrow(/fetch failed: ECONNREFUSED/);
    expect(events).toEqual([]);
  });

  it("tolerates dispose()/abort()", async () => {
    const session = await throwingSession()();
    expect(() => session.dispose()).not.toThrow();
    await expect(session.abort()).resolves.toBeUndefined();
  });
});
