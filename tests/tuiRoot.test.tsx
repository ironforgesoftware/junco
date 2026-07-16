import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup } from "ink-testing-library";
import { Root } from "../src/tui/Root.js";
import { defaultAnswers } from "../src/wizard/flow.js";
import type { WizardIO } from "../src/wizard/io.js";
import { makeAppProps } from "./helpers/localFixtures.js";
import { until } from "./helpers/until.js";

afterEach(cleanup);

// A scripted WizardIO: fresh mode, deterministic checks, io.write records.
// Shape matches src/wizard/io.ts exactly (every method that Welcome/WizardApp
// awaits is async).
function fakeIo(overrides: Partial<WizardIO> = {}): WizardIO {
  return {
    mode: "fresh",
    configPath: "/tmp/x/config.json",
    initialAnswers: defaultAnswers(),
    currentRaw: null,
    greetName: async () => "friend",
    preflight: async () => [],
    discoverModels: async () => [],
    listModelsJson: () => [],
    listCatalogProviders: async () => [],
    write: vi.fn(() => ({
      written: true,
      configPath: "/tmp/x/config.json",
      queueRoot: "/tmp/x/q",
      changes: [],
    })),
    flightCheck: async () => [],
    botGhConfigDir: "/sbx/junco-gh",
    detectBotLogin: async () => null,
    runGhLogin: async () => 0,
    ...overrides,
  };
}

const ENTER = "\r";
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 30));
async function press(stdin: { write: (s: string) => void }, key: string): Promise<void> {
  stdin.write(key);
  await tick();
}
// Generous ceiling for the Enter-through walkthrough (see wizardApp.test.tsx:
// exits as soon as the condition holds; only paid under CPU oversubscription).
const LONG_TRIES = 500;

/** Press `key` repeatedly — but only while `fromMarker` still shows — until
 * `toMarker` appears. Verbatim from tests/wizardApp.test.tsx (see the doc
 * comment there): the Model chapter's "pick" step is mounted from a bare
 * Promise .then(), so under CPU starvation a single keystroke can arrive in
 * the gap before its useInput subscribes and be dropped for good. */
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

/** Enter-through choreography from Welcome to (and including) Review's
 * "Write config" — adapted from wizardApp.test.tsx's driveToReview against
 * this file's fakeIo (greet "friend", one discovered model). Ends the instant
 * the Finale's write receipt shows; `q` then finishes immediately (WizardApp's
 * global handler maps q → done once result is set — no reveal wait needed). */
async function driveToWritten(
  stdin: { write: (s: string) => void },
  lastFrame: () => string | undefined,
): Promise<void> {
  await until(() => (lastFrame() ?? "").includes("friend"), LONG_TRIES);
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
  await until(() => (lastFrame() ?? "").includes("This is the exact config.json"), LONG_TRIES);
  await press(stdin, ENTER); // Write config → io.write()
  await until(() => (lastFrame() ?? "").includes("Wrote config:"), LONG_TRIES);
}

describe("Root FTUE switcher", () => {
  it("no config → renders the wizard; fresh-mode cancel exits 130", async () => {
    const onCode = vi.fn();
    const r = render(
      <Root
        configPath="/tmp/x/config.json"
        initialConfig={null}
        buildAppProps={() => {
          throw new Error("App must not mount before a config exists");
        }}
        makeWizardIo={() => ({ ok: true, io: fakeIo(), mode: "fresh" })}
        loadConfigFn={() => {
          throw new Error("unused");
        }}
        onFinalExitCode={onCode}
      />,
    );
    await until(() => (r.lastFrame() ?? "").includes("junco setup"));
    r.stdin.write("q"); // Welcome chapter → cancel (q, no text field focused)
    await until(() => onCode.mock.calls.length === 1);
    expect(onCode).toHaveBeenCalledWith(130);
  });

  it("no config → Ctrl-C in the wizard is a truthful FTUE cancel (exit 130)", async () => {
    // Production renders the host with exitOnCtrlC:false so WizardApp's own
    // Ctrl-C branch runs (it maps a pre-write Ctrl-C → cancel). A fresh-mode
    // cancel has nothing to fall back to, so Root reports 130.
    // ink-testing-library also uses exitOnCtrlC:false → production parity.
    const onCode = vi.fn();
    const r = render(
      <Root
        configPath="/tmp/x/config.json"
        initialConfig={null}
        buildAppProps={() => {
          throw new Error("App must not mount before a config exists");
        }}
        makeWizardIo={() => ({ ok: true, io: fakeIo(), mode: "fresh" })}
        loadConfigFn={() => {
          throw new Error("unused");
        }}
        onFinalExitCode={onCode}
      />,
    );
    await until(() => (r.lastFrame() ?? "").includes("junco setup"));
    r.stdin.write("\x03"); // Ctrl-C in the Welcome chapter (result still null)
    await until(() => onCode.mock.calls.length === 1);
    expect(onCode).toHaveBeenCalledWith(130);
  });

  it("config present → renders the App props straight away", async () => {
    const r = render(
      <Root
        configPath="/tmp/x/config.json"
        initialConfig={{} as never}
        buildAppProps={() => makeAppProps()}
        makeWizardIo={() => ({ ok: false, error: "unused" })}
        loadConfigFn={() => ({}) as never}
        onFinalExitCode={() => {}}
      />,
    );
    // makeAppProps mounts the real App in github mode at 120 cols — its
    // bracketed mode tab is the header proof the App path was taken (not the
    // wizard, which would print "junco setup").
    await until(() => (r.lastFrame() ?? "").includes("[GITHUB]"));
    expect(r.lastFrame() ?? "").not.toContain("junco setup");
  });

  it("FTUE completion: written outcome → loadConfigFn(configPath) once → App remounts on that config", async () => {
    // The feature's core path, through the REAL WizardApp: no config → drive
    // the whole walkthrough to a written outcome → Root reloads the config
    // and hands EXACTLY that object to buildAppProps → dashboard renders.
    const sentinelCfg = { marker: "loaded-after-write" } as unknown as never;
    const loadSpy = vi.fn(() => sentinelCfg);
    const onCode = vi.fn();
    const buildAppProps = vi.fn((_cfg: unknown) => makeAppProps());
    const r = render(
      <Root
        configPath="/tmp/x/config.json"
        initialConfig={null}
        buildAppProps={buildAppProps}
        makeWizardIo={() => ({
          ok: true,
          io: fakeIo({ discoverModels: async () => ["m-fast"] }),
          mode: "fresh",
        })}
        loadConfigFn={loadSpy}
        onFinalExitCode={onCode}
      />,
    );
    expect(buildAppProps).not.toHaveBeenCalled(); // wizard first — no App yet
    await driveToWritten(r.stdin, () => r.lastFrame());
    await press(r.stdin, "q"); // result is set — q finishes → outcome "written"
    await until(() => (r.lastFrame() ?? "").includes("[GITHUB]"), LONG_TRIES);
    expect(loadSpy).toHaveBeenCalledTimes(1);
    expect(loadSpy).toHaveBeenCalledWith("/tmp/x/config.json");
    // Every App render received the config loadConfigFn returned — never a stale one.
    expect(buildAppProps.mock.calls.length).toBeGreaterThan(0);
    for (const call of buildAppProps.mock.calls) expect(call[0]).toBe(sentinelCfg);
    expect(onCode).not.toHaveBeenCalled(); // completion never exits the host
    expect(r.lastFrame() ?? "").not.toContain("junco setup");
  }, 60000);

  it("palette 'setup' opens the wizard in-process (no subprocess); cancel returns to the dashboard untouched", async () => {
    const loadSpy = vi.fn(() => ({}) as never);
    const onCode = vi.fn();
    // runCliFn is the subprocess-spawn seam — it must NEVER fire for "setup".
    const runCli = vi.fn(async () => ({ code: 0, output: "ok", timedOut: false }));
    const r = render(
      <Root
        configPath="/tmp/x/config.json"
        initialConfig={{} as never}
        buildAppProps={() => makeAppProps({ runCliFn: runCli })}
        makeWizardIo={() => ({ ok: true, io: fakeIo(), mode: "fresh" })}
        loadConfigFn={loadSpy}
        onFinalExitCode={onCode}
      />,
    );
    await until(() => (r.lastFrame() ?? "").includes("[GITHUB]"));
    // Open the command palette, filter to "setup", run it.
    r.stdin.write(":");
    await until(() => (r.lastFrame() ?? "").includes("run a junco command"));
    r.stdin.write("setup");
    await until(() => (r.lastFrame() ?? "").includes("Guided setup walkthrough"));
    r.stdin.write("\r"); // enter → App.onRequestWizard → Root swaps to WizardApp
    await until(() => (r.lastFrame() ?? "").includes("junco setup"));
    expect(runCli).not.toHaveBeenCalled(); // in-process — nothing spawned
    // Cancel the re-run: dashboard resumes, config never reloaded, no exit.
    r.stdin.write("q");
    await until(() => (r.lastFrame() ?? "").includes("[GITHUB]"));
    expect(loadSpy).not.toHaveBeenCalled(); // config untouched on a re-run cancel
    expect(onCode).not.toHaveBeenCalled(); // re-run cancel never exits the host
  });
});
