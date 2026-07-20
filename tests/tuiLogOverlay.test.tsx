// App-level suite for the full-screen log overlay (Task 7): opened from the
// LOCAL `logs` section (Enter or a click on the compact pane), it owns input
// while open — filters cycle via keys (l/t//), follow toggles via f/G, and
// scrollback pauses follow. The log source is injected as an in-memory fake fs
// via `logReaderDeps` + a small `logsPollMs` (same seam as tuiLogSection), so
// no test touches a real worker.log.
import { describe, it, expect, afterEach } from "vitest";
import { cleanup } from "ink-testing-library";
import type { LogReaderDeps } from "../src/logReader.js";
import { renderApp, ESC } from "./helpers/localFixtures.js";
import { until, fireUntil } from "./helpers/until.js";

afterEach(cleanup);

const ENTER = "\r";
const logLine = (o: Record<string, unknown>): string => JSON.stringify(o) + "\n";
const lineOf = (frame: string, needle: string): number =>
  frame.split("\n").findIndex((l) => l.includes(needle));

// In-memory file backing the reader deps (no spies needed here).
function fakeFs(initial = "") {
  const content = Buffer.from(initial, "utf8");
  const deps: LogReaderDeps = {
    existsFn: () => true,
    statFn: () => ({ size: content.length }),
    openFn: () => 1,
    closeFn: () => undefined,
    readFn: (_fd: number, buf: Buffer, _off: number, len: number, pos: number) => {
      const slice = content.subarray(pos, pos + len);
      slice.copy(buf, 0);
      return slice.length;
    },
  };
  return deps;
}

const frame = (r: { lastFrame: () => string | undefined }): string => r.lastFrame() ?? "";

// Yield a couple of macrotasks so React commits and ink re-binds its input
// handler after a mode-entry keystroke (`/`) that has no observable of its own.
// Used ONLY to sequence a following keystroke — every assertion still polls via
// `until`, never a fixed tick.
const settle = (): Promise<void> => new Promise((res) => setTimeout(res, 40));

/** Mount in LOCAL mode, jump to the `logs` section, and wait for a seeded line
 * to tail into the compact pane (proves the section mounted + polled). */
async function openToLogs(deps: LogReaderDeps, waitFor: string) {
  const r = renderApp({ initialUiMode: "local", logReaderDeps: deps, logsPollMs: 15 });
  await until(() => frame(r).includes("[LOCAL]"));
  // G jumps to the last rail section (`logs`); resend is idempotent.
  await fireUntil(r.stdin, "G", () => frame(r).includes(waitFor));
  return r;
}

describe("LOCAL full-screen log overlay", () => {
  it("Enter opens the overlay from the logs section; esc closes it back", async () => {
    const deps = fakeFs(logLine({ ts: "2026-07-20T05:00:00.000Z", level: "info", msg: "seed-a" }));
    const r = await openToLogs(deps, "seed-a");
    // Enter opens the full overlay (its follow chip is overlay-only wording);
    // Enter is unbound inside the overlay, so re-sending it is idempotent.
    await fireUntil(r.stdin, ENTER, () => frame(r).includes("following"));
    expect(frame(r)).toContain("esc close"); // the overlay footer hint
    // esc closes it — the follow chip disappears, back on the compact section.
    r.stdin.write(ESC);
    await until(() => !frame(r).includes("following"));
    expect(frame(r)).toContain("logs");
  });

  it("a click on the compact log pane opens the overlay", async () => {
    const deps = fakeFs(logLine({ ts: "2026-07-20T05:00:00.000Z", level: "info", msg: "seed-c" }));
    const r = await openToLogs(deps, "seed-c");
    const y = lineOf(frame(r), "seed-c");
    const x = (frame(r).split("\n")[y] ?? "").indexOf("seed-c");
    // SGR press at the compact pane's own row; the pane's ClickableBox is the
    // deepest region there, so onPress → onLogExpand. Idempotent (re-open).
    const press = `[<0;${x + 1};${y + 1}M`;
    await fireUntil(r.stdin, press, () => frame(r).includes("following"));
  });

  it("l cycles the level threshold chip (info → warn)", async () => {
    const deps = fakeFs(logLine({ ts: "2026-07-20T05:00:00.000Z", level: "info", msg: "seed-l" }));
    const r = await openToLogs(deps, "seed-l");
    await fireUntil(r.stdin, ENTER, () => frame(r).includes("following"));
    expect(frame(r)).toContain("level ≥ info"); // default threshold chip
    r.stdin.write("l");
    await until(() => frame(r).includes("level ≥ warn"));
  });

  it("t cycles the ticket chip through the buffer's tickets and back to all", async () => {
    const deps = fakeFs(
      logLine({ ts: "2026-07-20T05:00:00.000Z", level: "info", ticket: "alpha", msg: "m-a" }) +
        logLine({ ts: "2026-07-20T05:00:01.000Z", level: "info", ticket: "beta", msg: "m-b" }),
    );
    const r = await openToLogs(deps, "m-b");
    await fireUntil(r.stdin, ENTER, () => frame(r).includes("following"));
    expect(frame(r)).not.toContain("#alpha"); // ticket=null on open, no chip
    r.stdin.write("t");
    await until(() => frame(r).includes("#alpha"));
    r.stdin.write("t");
    await until(() => frame(r).includes("#beta"));
    r.stdin.write("t"); // wraps back to null (all tickets) — no ticket chip
    await until(() => !frame(r).includes("#alpha") && !frame(r).includes("#beta"));
  });

  it("/ + typed term + Enter sets the search chip; esc in search clears it", async () => {
    const deps = fakeFs(
      logLine({ ts: "2026-07-20T05:00:00.000Z", level: "info", msg: "daemon booted" }),
    );
    const r = await openToLogs(deps, "daemon booted");
    await fireUntil(r.stdin, ENTER, () => frame(r).includes("following"));
    // `/` toggles search-entry mode — a state change with NO observable of its
    // own, so yield a tick (sequencing only; the real assertions stay on until)
    // before the next keystroke reads the freshly-committed handler.
    r.stdin.write("/");
    await settle();
    r.stdin.write("boot"); // printable chars extend the term — chip tracks live
    await until(() => frame(r).includes('"boot"')); // the quoted search chip
    r.stdin.write(ENTER); // commit: keep the term, leave search-entry mode
    await until(() => frame(r).includes('"boot"')); // still shown after commit
    // Re-enter search then esc → discards the term and exits search-entry mode.
    r.stdin.write("/");
    await settle();
    r.stdin.write(ESC);
    await until(() => !frame(r).includes('"boot"'));
  });

  it("f toggles follow (following → paused → following)", async () => {
    const deps = fakeFs(logLine({ ts: "2026-07-20T05:00:00.000Z", level: "info", msg: "seed-f" }));
    const r = await openToLogs(deps, "seed-f");
    await fireUntil(r.stdin, ENTER, () => frame(r).includes("following"));
    r.stdin.write("f");
    await until(() => frame(r).includes("paused"));
    r.stdin.write("f");
    await until(() => frame(r).includes("following"));
  });

  it("[ / up pauses follow and scrolls up to a higher row; G resumes follow", async () => {
    // 40 info lines > the 23-row overlay viewport, so following shows only the
    // tail and the earliest line is off screen until we scroll up.
    let buf = "";
    for (let i = 0; i < 40; i++) {
      buf += logLine({
        ts: `2026-07-20T05:00:${String(i).padStart(2, "0")}.000Z`,
        level: "info",
        msg: `line-${String(i).padStart(3, "0")}`,
      });
    }
    const deps = fakeFs(buf);
    const r = await openToLogs(deps, "line-039"); // the tail is on screen
    await fireUntil(r.stdin, ENTER, () => frame(r).includes("following"));
    // Following: the last line is visible, the first is not.
    await until(() => frame(r).includes("line-039"));
    expect(frame(r)).not.toContain("line-000");
    // First [ pauses (chip flips to paused) and steps the window up by one.
    r.stdin.write("[");
    await until(() => frame(r).includes("paused"));
    // Keep stepping up until the earliest line comes into view — proof the
    // paused window scrolls back through scrollback.
    await fireUntil(r.stdin, "[", () => frame(r).includes("line-000"), 80);
    // G snaps back to the live tail and resumes follow.
    r.stdin.write("G");
    await until(() => frame(r).includes("following") && frame(r).includes("line-039"));
  });

  it("the overlay owns input: t does NOT open the GitHub queue view", async () => {
    const deps = fakeFs(
      logLine({ ts: "2026-07-20T05:00:00.000Z", level: "info", ticket: "alpha", msg: "m-own" }),
    );
    const r = await openToLogs(deps, "m-own");
    await fireUntil(r.stdin, ENTER, () => frame(r).includes("following"));
    r.stdin.write("t"); // inside the overlay: cycles the ticket filter
    await until(() => frame(r).includes("#alpha"));
    // Still the overlay (not the github `t` queue view, which renders RUNNING).
    expect(frame(r)).toContain("following");
    expect(frame(r)).not.toContain("RUNNING");
  });
});
