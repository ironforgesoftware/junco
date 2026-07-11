import { describe, it, expect, afterEach } from "vitest";
import React from "react";
import { render, cleanup } from "ink-testing-library";
import { until } from "./helpers/until.js";
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
  await press(stdin, ENTER); // vaultRoot default
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
  await until(() => (lastFrame() ?? "").includes("Which extras"), LONG_TRIES);
  await press(stdin, ENTER); // keep recommended set
  await until(() => (lastFrame() ?? "").includes('"vaultRoot"'), LONG_TRIES);
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
    write: (a) => {
      written.push(a);
      return { written: true, configPath: "/tmp/config.json", queueRoot: "/tmp/q", changes: [] };
    },
    flightCheck: async () => [{ verdict: "ok", label: "inference endpoint", detail: "up" }],
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
    await press(stdin, ENTER); // vaultRoot default
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
    await until(() => (lastFrame() ?? "").includes("Which extras"), LONG_TRIES);
    await press(stdin, ENTER); // keep recommended set
    await until(() => (lastFrame() ?? "").includes('"vaultRoot"'), LONG_TRIES);
    await press(stdin, ENTER); // Write config
    await until(() => (lastFrame() ?? "").includes("The nest is ready"), LONG_TRIES);
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
    await until(() => (lastFrame() ?? "").includes("~/Juncoq"));
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
    await until(() => (lastFrame() ?? "").includes("1/7"));
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
    await press(stdin, ENTER); // vaultRoot unchanged
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
    await until(() => (lastFrame() ?? "").includes("Which extras"), LONG_TRIES);
    await press(stdin, ENTER); // recommended set unchanged
    await until(() => (lastFrame() ?? "").includes("Nothing changed"), LONG_TRIES);
    expect(lastFrame()).toContain("Nothing changed — config untouched.");
    await press(stdin, ENTER); // Finish
    await until(() => (lastFrame() ?? "").includes("Config untouched"), LONG_TRIES);
    await press(stdin, ENTER); // finish
    await until(() => outcome === "unchanged", LONG_TRIES);
    expect(writeCalls).toBe(1); // io.write called — dirs still ensured
  }, 60000);
});
