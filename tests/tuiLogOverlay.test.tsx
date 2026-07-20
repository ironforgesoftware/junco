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

  it("/ shows the search prompt; typed term + Enter sets the chip; esc in search clears it", async () => {
    const deps = fakeFs(
      logLine({ ts: "2026-07-20T05:00:00.000Z", level: "info", msg: "daemon booted" }),
    );
    const r = await openToLogs(deps, "daemon booted");
    await fireUntil(r.stdin, ENTER, () => frame(r).includes("following"));
    // `/` enters search-entry mode — now observable via the live prompt chip
    // (`/<term>▏`), present even before a char is typed. Polling that prompt
    // replaces the old fixed settle: `until` yields ticks for React to commit
    // and ink to re-bind before the following keystroke lands.
    r.stdin.write("/");
    await until(() => frame(r).includes("/▏")); // empty-term prompt
    r.stdin.write("boot"); // printable chars extend the term — prompt tracks live
    await until(() => frame(r).includes("/boot▏"));
    r.stdin.write(ENTER); // commit: keep the term, leave search-entry mode
    await until(() => frame(r).includes('"boot"')); // the committed quoted chip
    expect(frame(r)).not.toContain("/boot▏"); // the live prompt is gone once committed
    // Re-enter search (prompt shows the retained term) then esc → discards it.
    r.stdin.write("/");
    await until(() => frame(r).includes("/boot▏"));
    r.stdin.write(ESC);
    await until(() => !frame(r).includes('"boot"') && !frame(r).includes("/boot▏"));
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
    // Tail-anchor invariant: pausing lands at the BOTTOM (toEnd) then steps up
    // one row — the oldest line must still be off screen. This fails loudly
    // under a hypothetical jump-to-top-on-pause regression (which the scroll-up
    // loop below would otherwise mask, since fireUntil stops the moment the
    // condition first holds).
    expect(frame(r)).not.toContain("line-000");
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

  it("the overlay owns input: `m` and `,` typed in search are chars, not mode/config toggles", async () => {
    const deps = fakeFs(
      logLine({ ts: "2026-07-20T05:00:00.000Z", level: "info", msg: "daemon, booted" }),
    );
    const r = await openToLogs(deps, "daemon, booted");
    await fireUntil(r.stdin, ENTER, () => frame(r).includes("following"));
    // Enter search-entry mode, then build the term "daemon" char-group by
    // char-group. The `m` MUST land as a discrete keystroke: under the open
    // overlay canToggleMode() is false, so `m` extends the term instead of
    // flipping to GITHUB (which would unmount the overlay and time out below).
    r.stdin.write("/");
    await until(() => frame(r).includes("/▏"));
    r.stdin.write("dae"); // plain chars, appended wholesale
    await until(() => frame(r).includes("/dae▏"));
    r.stdin.write("m"); // the critical discrete `m` — a search char, NOT a toggle
    await until(() => frame(r).includes("/daem▏"));
    r.stdin.write("on");
    await until(() => frame(r).includes("/daemon▏"));
    // `,` is the worst case: layer-3b used to open ConfigView even mid-search.
    // Under the overlay it is just another search char.
    r.stdin.write(",");
    await until(() => frame(r).includes("/daemon,▏"));
    // Still LOCAL, still the overlay open — neither `m` nor `,` leaked.
    expect(frame(r)).toContain("[LOCAL]"); // `m` did not flip to GITHUB
    expect(frame(r)).toContain("following"); // ConfigView did not replace the overlay
  });

  it("the footer under the overlay shows esc/close, not the stale LOCAL rail chips", async () => {
    const deps = fakeFs(
      logLine({ ts: "2026-07-20T05:00:00.000Z", level: "info", msg: "seed-foot" }),
    );
    const r = await openToLogs(deps, "seed-foot");
    await fireUntil(r.stdin, ENTER, () => frame(r).includes("following"));
    const f = frame(r);
    expect(f).toContain("esc"); // the overlay's only actionable chip (close)
    expect(f).toContain("close");
    // The LOCAL rail chips (whose keys the overlay swallows) must be gone — the
    // `q` chip must not quit while the `q` key closes, `→ open` label is wrong.
    expect(f).not.toContain("q quit");
    expect(f).not.toContain("→ open");
  });

  it("a second click on the already-selected logs rail row opens the overlay", async () => {
    const deps = fakeFs(
      logLine({ ts: "2026-07-20T05:00:00.000Z", level: "info", msg: "seed-rail" }),
    );
    // openToLogs leaves `logs` selected (rail focus) with the overlay closed —
    // so a click on that rail row is the click-again case (parity with Enter).
    const r = await openToLogs(deps, "seed-rail");
    // Locate the `logs` rail row: the "logs" text inside the left rail column
    // (x < RAIL_WIDTH), NOT the compact pane header to its right.
    const railLogs = (): { x: number; y: number } | null => {
      const lines = frame(r).split("\n");
      for (let y = 0; y < lines.length; y++) {
        const x = (lines[y] ?? "").indexOf("logs");
        if (x >= 0 && x < 26) return { x, y };
      }
      return null;
    };
    const pos = railLogs();
    expect(pos).not.toBeNull();
    const { x, y } = pos!;
    // ESC-prefixed SGR press (the reliable form the LOCAL rail suites use — a
    // bare `[<…M` lands only intermittently on the nested section regions).
    const press = `[<0;${x + 1};${y + 1}M`;
    // Idempotent (a click that unmounts its own target — the rail — once the
    // overlay opens), so fireUntil's re-send is safe.
    await fireUntil(r.stdin, press, () => frame(r).includes("following"));
  });
});
