import { describe, it, expect, afterEach } from "vitest";
import React from "react";
import { render, cleanup } from "ink-testing-library";
import { until } from "./helpers/until.js";
import { MouseProvider } from "../src/tui/MouseProvider.js";
import { WizardApp } from "../src/tui/wizard/WizardApp.js";
import { defaultAnswers, answersFromConfig } from "../src/wizard/flow.js";
import type { WizardIO } from "../src/wizard/io.js";
import type { WizardAnswers } from "../src/wizard/flow.js";

afterEach(cleanup);
const ENTER = "\r";
const ESC = "\x1b";
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 30));
async function press(stdin: { write: (s: string) => void }, ...keys: string[]): Promise<void> {
  for (const k of keys) {
    stdin.write(k);
    await tick();
  }
}

// SGR mouse press at 0-based cell (x, y) — a JS `\u001b` escape (not a raw
// ESC byte) so file edits never drop it. Named mousePress (not `press`) to
// avoid colliding with this file's keyboard press(stdin, ...keys) helper
// above; mirrors tests/tuiClickable.test.tsx / tests/tuiMouseApp.test.tsx.
const mousePress = (x: number, y: number): string => `\u001b[<0;${x + 1};${y + 1}M`;
const lineOf = (frame: string, needle: string): number =>
  frame.split("\n").findIndex((l) => l.includes(needle));

/**
 * Press `key` repeatedly — but only while `fromMarker` is still showing —
 * until `toMarker` appears. Plain `press()` + `until()` is unsafe for one
 * specific transition in the walkthrough below: the Model chapter's "pick"
 * step (see src/tui/wizard/chapters/Model.tsx) is the only step in the whole
 * flow mounted from a bare Promise `.then()` (the `probe` effect's
 * `io.discoverModels().then(...)`) rather than from a keystroke handler,
 * which Ink wraps in `reconciler.discreteUpdates` (src/hooks/use-input.js in
 * ink) and flushes synchronously. A step mounted off-cycle like this can
 * still be rendering (its marker text visible via lastFrame()) a tick before
 * its own `useInput` effect has subscribed to Ink's internal input emitter —
 * and that emitter is fire-and-forget: a keystroke arriving in that gap is
 * dropped for good, no replay, so a plain `until()` afterward would spin
 * until it exhausts its whole budget no matter how generous. Confirmed by
 * capturing the exact pre/post frames on a reproduced stall: they were
 * byte-for-byte identical, i.e. the Enter never reached the Select at all.
 * Resending is safe specifically because every resend is gated on still
 * seeing `fromMarker`: a first press that landed but just hasn't rendered
 * yet is never double-submitted, since we stop the instant `toMarker` shows.
 */
async function pressUntilAdvanced(
  stdin: { write: (s: string) => void },
  key: string,
  lastFrame: () => string | undefined,
  fromMarker: string,
  toMarker: string,
  tries: number,
): Promise<void> {
  for (let i = 0; i < tries; i++) {
    const frame = lastFrame() ?? "";
    if (frame.includes(toMarker)) return;
    if (frame.includes(fromMarker)) stdin.write(key);
    await tick();
  }
  await until(() => (lastFrame() ?? "").includes(toMarker), 1); // final real-failure assert
}

const SIZE = { columns: 100, rows: 32 };
// Generous ceiling for the long Enter-through walkthrough: exits as soon as
// the condition holds, so this is only ever paid under real CPU
// oversubscription (full-suite default concurrency), not on a healthy run.
const LONG_TRIES = 500; // 500 * 20ms = 10s ceiling per until()

/**
 * Enter-through choreography from the Welcome greeting up to (and including)
 * the Review chapter's config preview, stopping just short of pressing Enter
 * on "Write config" — the one keystroke every caller below wants to control
 * itself (either to reach the finale, or to exercise a write failure without
 * ever leaving Review). Shared so neither caller has to re-derive the
 * chapter sequence.
 */
async function driveToReview(
  stdin: { write: (s: string) => void },
  lastFrame: () => string | undefined,
): Promise<void> {
  await until(() => (lastFrame() ?? "").includes("Ada"), LONG_TRIES);
  await press(stdin, ENTER); // begin
  await until(() => (lastFrame() ?? "").includes("Where should junco"), LONG_TRIES);
  await press(stdin, ENTER); // dataDir default
  await until(() => (lastFrame() ?? "").includes("How is the model configured?"), LONG_TRIES);
  await press(stdin, ENTER); // inline
  await until(() => (lastFrame() ?? "").includes("Inference endpoint base URL"), LONG_TRIES);
  await press(stdin, ENTER); // url default
  await until(() => (lastFrame() ?? "").includes("API key for the endpoint?"), LONG_TRIES);
  await press(stdin, ENTER); // key default
  await until(() => (lastFrame() ?? "").includes("1 model"), LONG_TRIES);
  // See pressUntilAdvanced's doc comment: the "pick" step mounts from an
  // async Promise callback, not a keystroke, so a plain press() can drop
  // the Enter under CPU starvation.
  await pressUntilAdvanced(stdin, ENTER, lastFrame, "1 model", "Which folders", LONG_TRIES);
  await press(stdin, ENTER); // empty roots → continue
  await until(
    () =>
      (lastFrame() ?? "").includes("GitHub bridge") ||
      (lastFrame() ?? "").includes("Enable the GitHub"),
    LONG_TRIES,
  );
  await press(stdin, ENTER); // Off
  await until(() => (lastFrame() ?? "").includes("Who should junco act as"), LONG_TRIES);
  await press(stdin, ENTER); // ambient gh login (default)
  await until(() => (lastFrame() ?? "").includes("Which extras"), LONG_TRIES);
  await press(stdin, ENTER); // keep recommended set
  await until(() => (lastFrame() ?? "").includes("No known agent harnesses detected"), LONG_TRIES);
  await press(stdin, ENTER); // no harnesses detected (fake io) → continue
  await until(() => (lastFrame() ?? "").includes("This is the exact config.json"), LONG_TRIES);
}

/**
 * Same Enter-through choreography as the walkthrough test below, stopping the
 * instant the finale's "The nest is ready" marker shows (config already
 * written to the fake io by that point). Shared so the Ctrl-C-after-write
 * regression test doesn't have to re-derive the chapter sequence.
 */
async function driveToFinale(
  stdin: { write: (s: string) => void },
  lastFrame: () => string | undefined,
): Promise<void> {
  await driveToReview(stdin, lastFrame);
  await press(stdin, ENTER); // Write config
  await until(() => (lastFrame() ?? "").includes("The nest is ready"), LONG_TRIES);
}

function fakeIo(over: Partial<WizardIO> = {}): WizardIO {
  const written: WizardAnswers[] = [];
  return {
    mode: "fresh",
    configPath: "/tmp/config.json",
    initialAnswers: defaultAnswers(),
    currentRaw: null,
    greetName: async () => "Ada",
    preflight: async () => [{ verdict: "ok", label: "git", detail: "2.44" }],
    discoverModels: async () => ["m-fast"],
    listModelsJson: () => [],
    listCatalogProviders: async () => [{ provider: "acme", ids: ["m-fast"] }],
    write: (a) => {
      written.push(a);
      return { written: true, configPath: "/tmp/config.json", queueRoot: "/tmp/q", changes: [] };
    },
    flightCheck: async () => [{ verdict: "ok", label: "inference endpoint", detail: "up" }],
    effectiveDataDir: "/sbx/home/.junco",
    dataDirLegacyFallback: false,
    botGhConfigDir: "/sbx/junco-gh",
    detectedHarnesses: [],
    detectBotLogin: async () => null,
    runGhLogin: async () => 0,
    ...over,
  };
}

describe("WizardApp", () => {
  it("walks the whole flow Enter-through to a written outcome", async () => {
    // Generous per-test timeout: each until() below carries an explicit
    // LONG_TRIES (10s) ceiling for commit-lag headroom under CPU
    // oversubscription (see tests/helpers/until.ts), so the test itself
    // must outlive vitest's 5000ms default or a genuinely-slow-but-
    // converging run gets killed early.
    let outcome = "";
    const io = fakeIo();
    const writes: WizardAnswers[] = [];
    io.write = (a) => {
      writes.push(a);
      return { written: true, configPath: "/tmp/config.json", queueRoot: "/tmp/q", changes: [] };
    };
    const { lastFrame, stdin } = render(
      <WizardApp io={io} onOutcome={(o) => (outcome = o)} sizeOverride={SIZE} revealMs={0} />,
    );
    await until(() => (lastFrame() ?? "").includes("Ada"), LONG_TRIES);
    expect(lastFrame()).toContain("▶ Welcome");
    await press(stdin, ENTER); // begin
    await until(() => (lastFrame() ?? "").includes("Where should junco"), LONG_TRIES);
    expect(lastFrame()).toContain("✓ Welcome");
    await press(stdin, ENTER); // dataDir default
    await until(() => (lastFrame() ?? "").includes("How is the model configured?"), LONG_TRIES);
    await press(stdin, ENTER); // inline
    await until(() => (lastFrame() ?? "").includes("Inference endpoint base URL"), LONG_TRIES);
    await press(stdin, ENTER); // url default
    await until(() => (lastFrame() ?? "").includes("API key for the endpoint?"), LONG_TRIES);
    await press(stdin, ENTER); // key default
    await until(() => (lastFrame() ?? "").includes("1 model"), LONG_TRIES);
    // The "pick" step mounts from an async Promise callback, not a
    // keystroke — see pressUntilAdvanced's doc comment for why a plain
    // press() here can silently drop the Enter under CPU starvation.
    await pressUntilAdvanced(stdin, ENTER, lastFrame, "1 model", "Which folders", LONG_TRIES);
    await press(stdin, ENTER); // empty roots → continue
    await until(
      () =>
        (lastFrame() ?? "").includes("GitHub bridge") ||
        (lastFrame() ?? "").includes("Enable the GitHub"),
      LONG_TRIES,
    );
    await press(stdin, ENTER); // Off
    await until(() => (lastFrame() ?? "").includes("Who should junco act as"), LONG_TRIES);
    await press(stdin, ENTER); // ambient gh login (default)
    await until(() => (lastFrame() ?? "").includes("Which extras"), LONG_TRIES);
    await press(stdin, ENTER); // keep recommended set
    await until(
      () => (lastFrame() ?? "").includes("No known agent harnesses detected"),
      LONG_TRIES,
    );
    await press(stdin, ENTER); // no harnesses detected (fake io) → continue
    await until(() => (lastFrame() ?? "").includes("This is the exact config.json"), LONG_TRIES);
    await press(stdin, ENTER); // Write config
    await until(() => (lastFrame() ?? "").includes("The nest is ready"), LONG_TRIES);
    expect(lastFrame()).toContain("✓ Review");
    expect(lastFrame()).toContain("✓ Welcome");
    expect(lastFrame()).not.toContain("▶");
    await press(stdin, ENTER); // finish
    await until(() => outcome === "written", LONG_TRIES);
    expect(writes.length).toBe(1);
    expect(writes[0].modelId).toBe("local/m-fast");
  }, 60000);

  it("q cancels from a non-text chapter; Esc on Welcome cancels", async () => {
    let outcome = "";
    const { lastFrame, stdin } = render(
      <WizardApp io={fakeIo()} onOutcome={(o) => (outcome = o)} sizeOverride={SIZE} />,
    );
    await until(() => (lastFrame() ?? "").includes("Ada"));
    await press(stdin, ESC);
    await until(() => outcome === "cancelled");
  });

  it("onOutcome fires exactly once on repeated finish attempts; WizardApp never exits Ink itself", async () => {
    // Regression for the Plan B Task 2 refactor: finishWith used to call
    // useApp().exit() right after onOutcome, which both reports the outcome
    // AND tears the Ink instance down. Now the HOST owns that lifetime, so
    // WizardApp must (a) still guard onOutcome to exactly one call even if
    // finish is triggered again, and (b) stay mounted and responsive
    // afterward — no self-inflicted unmount to verify that against.
    let calls = 0;
    let outcome = "";
    const { lastFrame, stdin } = render(
      <WizardApp
        io={fakeIo()}
        onOutcome={(o) => {
          calls++;
          outcome = o;
        }}
        sizeOverride={SIZE}
      />,
    );
    await until(() => (lastFrame() ?? "").includes("Ada"));
    await press(stdin, ESC); // cancel
    await until(() => outcome === "cancelled");
    expect(calls).toBe(1);
    // Would-be second and third finish attempts — guarded by the `reported`
    // ref. If WizardApp had exited Ink here (old behavior), stdin.write below
    // would be writing into a torn-down instance instead of exercising the
    // guard.
    await press(stdin, ESC);
    await press(stdin, "\x03");
    expect(calls).toBe(1);
    expect(outcome).toBe("cancelled");
    // Still mounted and rendering — proof WizardApp itself never exited.
    expect(lastFrame()).toContain("Ada");
  });

  it("q typed into a text field does NOT cancel", async () => {
    let outcome = "none";
    const { lastFrame, stdin } = render(
      <WizardApp io={fakeIo()} onOutcome={(o) => (outcome = o)} sizeOverride={SIZE} />,
    );
    await until(() => (lastFrame() ?? "").includes("Ada"));
    await press(stdin, ENTER); // → Workspace (text field focused)
    await until(() => (lastFrame() ?? "").includes("Where should junco"));
    await press(stdin, "q");
    expect(outcome).toBe("none");
    await until(() => (lastFrame() ?? "").includes("~/.juncoq"));
  });

  it("clicking the q quit legend chip immediately on a text-editing chapter does NOT cancel", async () => {
    // Regression: textEditing is a ref, flipped inside a chapter's mount
    // effect (Workspace.tsx's `setTextEditing(true)`), which commits WITHOUT
    // itself triggering a WizardApp re-render. A "q quit" onPress computed as
    // a plain ternary (`textEditing.current ? undefined : cancel`) bakes in
    // whatever textEditing.current read as at WizardApp's LAST render — which
    // is still `false` (pre-effect) the instant Workspace first mounts. A
    // click landing in that window, before any keystroke forces a re-render
    // (e.g. via patch → setAnswers), would fire the stale `cancel`. The fix
    // wraps the handler in a closure that dereferences the ref at call time.
    let outcome = "none";
    const r = render(
      <MouseProvider>
        <WizardApp io={fakeIo()} onOutcome={(o) => (outcome = o)} sizeOverride={SIZE} />
      </MouseProvider>,
    );
    await until(() => (r.lastFrame() ?? "").includes("Ada"));
    r.stdin.write(ENTER); // → Workspace (text field focused), no tick yielded
    await until(() => (r.lastFrame() ?? "").includes("Where should junco"));
    const y = lineOf(r.lastFrame() ?? "", "q quit");
    const x = (r.lastFrame() ?? "").split("\n")[y].indexOf("q quit") + 1;
    r.stdin.write(mousePress(x, y));
    await tick();
    await tick();
    expect(outcome).toBe("none");
  });

  it("← goes back a chapter", async () => {
    const { lastFrame, stdin } = render(
      <WizardApp io={fakeIo()} onOutcome={() => {}} sizeOverride={SIZE} />,
    );
    await until(() => (lastFrame() ?? "").includes("Ada"));
    await press(stdin, ENTER);
    await until(() => (lastFrame() ?? "").includes("Where should junco"));
    await press(stdin, "\x1b[D"); // left arrow
    await until(() => (lastFrame() ?? "").includes("press enter to begin"));
  });

  it("narrow terminals swap the rail for a breadcrumb", async () => {
    const { lastFrame } = render(
      <WizardApp io={fakeIo()} onOutcome={() => {}} sizeOverride={{ columns: 60, rows: 32 }} />,
    );
    await until(() => (lastFrame() ?? "").includes("1/9"));
    expect(lastFrame()).not.toContain("▶ Welcome");
  });

  it("Ctrl-C before the write cancels", async () => {
    // ink-testing-library's render always passes exitOnCtrlC: false to Ink
    // (see node_modules/ink-testing-library/build/index.js), so Ctrl-C is
    // never intercepted before reaching WizardApp's own useInput handler —
    // no special render option needed here, plain stdin.write("\x03") is
    // enough to exercise the real ctrl-c branch.
    let outcome = "";
    const { lastFrame, stdin } = render(
      <WizardApp io={fakeIo()} onOutcome={(o) => (outcome = o)} sizeOverride={SIZE} />,
    );
    await until(() => (lastFrame() ?? "").includes("Ada"));
    await press(stdin, "\x03");
    await until(() => outcome === "cancelled");
  });

  it("Ctrl-C after the write reports written, not cancelled", async () => {
    // Regression test: before the fix, WizardApp's global useInput treated
    // Ctrl-C as an unconditional cancel — including from the finale, after
    // io.write() already succeeded. The caller maps "cancelled" to exit 130
    // plus a "nothing written" message, which would be false here: the
    // config is already on disk by the time we reach "The nest is ready".
    let outcome = "";
    const io = fakeIo();
    const { lastFrame, stdin } = render(
      <WizardApp io={io} onOutcome={(o) => (outcome = o)} sizeOverride={SIZE} revealMs={0} />,
    );
    await driveToFinale(stdin, lastFrame);
    await press(stdin, "\x03"); // Ctrl-C from the finale — config already written
    await until(() => outcome === "written", LONG_TRIES);
  }, 60000);

  it("a throwing io.write surfaces an error banner instead of crashing", async () => {
    // Regression test: io.write can throw (schema-invalid config on a
    // zero-diff rerun, EACCES, etc.) inside the live Ink alt-screen session.
    // Before the fix, WizardApp.write() called setResult(io.write(answers))
    // with no try/catch — the exception would escape Select's useInput
    // handler with no handler above it, leaving a raw stack trace and the
    // terminal stuck in raw mode. The fix must keep the Review chapter alive
    // (result stays null) so the user can retry, go back, or quit.
    let outcome = "";
    const io = fakeIo({
      write: () => {
        throw new Error("EACCES: permission denied");
      },
    });
    const { lastFrame, stdin } = render(
      <WizardApp io={io} onOutcome={(o) => (outcome = o)} sizeOverride={SIZE} revealMs={0} />,
    );
    await driveToReview(stdin, lastFrame);
    await press(stdin, ENTER); // Write config → io.write throws
    await until(() => (lastFrame() ?? "").includes("Write failed"), LONG_TRIES);
    expect(lastFrame()).toContain("EACCES: permission denied");
    // Still alive on Review, not crashed: the Select options are still there.
    expect(lastFrame()).toContain("Write config");
    expect(lastFrame()).toContain("Quit without writing");
    await press(stdin, "q");
    await until(() => outcome === "cancelled", LONG_TRIES);
  }, 60000);

  it("write error banner shows only the first line of a multi-line message", async () => {
    // Regression for #174: validateConfigObject throws a raw ZodError whose
    // .message is a multi-line JSON blob (src/config.ts). The banner is a
    // one-line summary — the rest must not leak into the frame.
    let outcome = "";
    const io = fakeIo({
      write: () => {
        throw new Error("first line\nsecond line");
      },
    });
    const { lastFrame, stdin } = render(
      <WizardApp io={io} onOutcome={(o) => (outcome = o)} sizeOverride={SIZE} revealMs={0} />,
    );
    await driveToReview(stdin, lastFrame);
    await press(stdin, ENTER); // Write config → io.write throws
    await until(() => (lastFrame() ?? "").includes("Write failed"), LONG_TRIES);
    expect(lastFrame()).toContain("first line");
    expect(lastFrame()).not.toContain("second line");
    await press(stdin, "q");
    await until(() => outcome === "cancelled", LONG_TRIES);
  }, 60000);

  it("write error banner truncates a long single-line message with an ellipsis", async () => {
    // Ink's fake test stdout is a fixed 100 columns (ink-testing-library
    // hardcodes it — sizeOverride only drives WizardApp's own narrow/rail
    // layout, not the real wrap width), so a 120-char banner always wraps
    // across several rendered rows interleaved with the rail column text.
    // Asserting a single contiguous substring is therefore not reliable;
    // instead count the filler character (one not used anywhere else in the
    // chrome — rail marks, box-drawing, JSON preview) to confirm exactly the
    // capped length made it to the frame, not the full message.
    let outcome = "";
    const longMsg = "*".repeat(200);
    const io = fakeIo({
      write: () => {
        throw new Error(longMsg);
      },
    });
    const { lastFrame, stdin } = render(
      <WizardApp io={io} onOutcome={(o) => (outcome = o)} sizeOverride={SIZE} revealMs={0} />,
    );
    await driveToReview(stdin, lastFrame);
    await press(stdin, ENTER); // Write config → io.write throws
    await until(() => (lastFrame() ?? "").includes("Write failed"), LONG_TRIES);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("…");
    expect((frame.match(/\*/g) ?? []).length).toBe(120);
    await press(stdin, "q");
    await until(() => outcome === "cancelled", LONG_TRIES);
  }, 60000);

  it("re-run mode: Enter-through every chapter is a no-op (Selects honor the prefilled config)", async () => {
    // Regression test: before Select's `initial` prop was wired up, every
    // Select in a re-run always rendered pre-selected on option 0 regardless
    // of the current config — so an operator who just wanted to glance at
    // `junco init`'s recap and hit Enter through it would silently flip
    // github.enabled back off (option 0 is "Off") and requireApproval to
    // whatever option 0 happened to be, even though nothing in the on-disk
    // config actually needed to change. A pure tune-up run must be a true
    // no-op: Enter through every chapter, land on "Nothing changed."
    const raw = {
      vaultRoot: "/v",
      model: { id: "local/m-fast", baseUrl: "http://127.0.0.1:1234/v1", apiKey: "k" },
      github: {
        enabled: true,
        repos: [{ nwo: "acme/api", path: "/tmp/acme" }],
        requireApproval: true,
      },
    };
    let writeCalls = 0;
    let outcome = "";
    const io = fakeIo({
      mode: "rerun",
      currentRaw: raw,
      initialAnswers: answersFromConfig(raw),
      // Configured model deliberately NOT at index 0: the pick-step
      // preselection (findIndex, not the fallback) must be what keeps this
      // run a no-op — a broken findIndex would select m-big and fail below.
      discoverModels: async () => ["m-big", "m-fast"],
      write: () => {
        writeCalls++;
        return { written: false, configPath: "/tmp/config.json", queueRoot: "/tmp/q", changes: [] };
      },
    });
    const { lastFrame, stdin } = render(
      <WizardApp io={io} onOutcome={(o) => (outcome = o)} sizeOverride={SIZE} revealMs={0} />,
    );
    await until(() => (lastFrame() ?? "").includes("Ada"), LONG_TRIES);
    await press(stdin, ENTER); // begin
    await until(() => (lastFrame() ?? "").includes("Where should junco"), LONG_TRIES);
    await press(stdin, ENTER); // dataDir unchanged (legacy vaultRoot untouched)
    await until(() => (lastFrame() ?? "").includes("How is the model configured?"), LONG_TRIES);
    await press(stdin, ENTER); // source: inline, preselected from mode
    await until(() => (lastFrame() ?? "").includes("Inference endpoint base URL"), LONG_TRIES);
    await press(stdin, ENTER); // url unchanged
    await until(() => (lastFrame() ?? "").includes("API key for the endpoint?"), LONG_TRIES);
    await press(stdin, ENTER); // key unchanged
    await until(() => (lastFrame() ?? "").includes("models found"), LONG_TRIES);
    // See pressUntilAdvanced's doc comment: the "pick" step mounts from an
    // async Promise callback, not a keystroke.
    await pressUntilAdvanced(stdin, ENTER, lastFrame, "models found", "Which folders", LONG_TRIES);
    await press(stdin, ENTER); // empty roots → continue
    await until(
      () =>
        (lastFrame() ?? "").includes("GitHub bridge") ||
        (lastFrame() ?? "").includes("Enable the GitHub"),
      LONG_TRIES,
    );
    await press(stdin, ENTER); // toggle preselected On (github.enabled: true)
    await until(() => (lastFrame() ?? "").includes("owner/repo"), LONG_TRIES);
    expect(lastFrame()).toContain("acme/api"); // existing repo already listed
    await press(stdin, ENTER); // empty nwo field → skip straight to approval
    await until(() => (lastFrame() ?? "").includes("approval"), LONG_TRIES);
    await press(stdin, ENTER); // approval preselected Yes (requireApproval: true)
    await until(() => (lastFrame() ?? "").includes("Who should junco act as"), LONG_TRIES);
    await press(stdin, ENTER); // ambient gh login preselected (botAccount: false, unchanged)
    await until(() => (lastFrame() ?? "").includes("Which extras"), LONG_TRIES);
    await press(stdin, ENTER); // recommended set unchanged
    await until(
      () => (lastFrame() ?? "").includes("No known agent harnesses detected"),
      LONG_TRIES,
    );
    await press(stdin, ENTER); // no harnesses detected (fake io) → continue, harnessDirs stays []
    await until(() => (lastFrame() ?? "").includes("Nothing changed"), LONG_TRIES);
    expect(lastFrame()).toContain("Nothing changed — config untouched.");
    await press(stdin, ENTER); // Finish
    await until(() => (lastFrame() ?? "").includes("Config untouched"), LONG_TRIES);
    await press(stdin, ENTER); // finish
    await until(() => outcome === "unchanged", LONG_TRIES);
    expect(writeCalls).toBe(1); // io.write called — dirs still ensured
  }, 60000);
});
