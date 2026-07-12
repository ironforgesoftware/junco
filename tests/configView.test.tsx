import { describe, it, expect, afterEach } from "vitest";
import React from "react";
import { render, cleanup } from "ink-testing-library";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ConfigView } from "../src/tui/components/ConfigView.js";
import { until } from "./helpers/until.js";

afterEach(cleanup);

const DOWN = "\x1b[B";
const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const ENTER = "\r";
const ESC = "\x1b";
const BACKSPACE = "\x7f";

// A single native `data` event (one `stdin.write` call) is one keypress, and
// Ink schedules its resulting state update as a React "discrete" update — a
// SECOND write issued before that update has committed can race a stale
// closure (confirmed empirically: chained writes with no tick between them
// silently dropped keystrokes). tuiApp.test.tsx's own `tick()` helper exists
// for the same reason — mirrored here for every multi-step key sequence.
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 30));

async function press(stdin: { write: (s: string) => void }, ...keys: string[]): Promise<void> {
  for (const k of keys) {
    stdin.write(k);
    await tick();
  }
}

function fixture(obj: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "cfgview-"));
  const p = join(dir, "config.json");
  writeFileSync(p, JSON.stringify(obj, null, 2), "utf8");
  return p;
}

function readCfg(p: string): Record<string, unknown> {
  return JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
}

describe("ConfigView", () => {
  it("renders every section and the initially-focused lever's description", async () => {
    const p = fixture({ vaultRoot: "/v" });
    const { lastFrame } = render(<ConfigView configPath={p} onExit={() => {}} />);
    await until(() => /worker/i.test(lastFrame() ?? ""));
    const f = lastFrame() ?? "";
    for (const section of [
      "general",
      "model",
      "worker",
      "supervisor",
      "git",
      "verify",
      "sandbox",
    ]) {
      expect(f).toMatch(new RegExp(section));
    }
    // sectionIdx/fieldIdx default to 0 → the focused lever is `vaultRoot`.
    expect(f).toMatch(/Root directory Junco keeps its ticket queue under/);
  });

  it("toggling a boolean lever writes the file", async () => {
    const p = fixture({ vaultRoot: "/v" });
    const { lastFrame, stdin } = render(<ConfigView configPath={p} onExit={() => {}} />);
    await until(() => /model/i.test(lastFrame() ?? ""));
    await press(stdin, RIGHT); // general → model
    // id, source, modelsJson, api, baseUrl, apiKey, retry.maxRetries,
    // retry.baseDelayMs, reasoning
    await press(stdin, DOWN, DOWN, DOWN, DOWN, DOWN, DOWN, DOWN, DOWN);
    await press(stdin, ENTER); // toggle reasoning: true → false
    await until(() => readCfg(p).model !== undefined);
    expect((readCfg(p).model as { reasoning: boolean }).reasoning).toBe(false);
  });

  it("surfaces the sandbox section and toggles sandbox.enabled from the editor", async () => {
    // Explicit false so the toggle → true regardless of the schema default.
    const p = fixture({ vaultRoot: "/v", sandbox: { enabled: false } });
    const { lastFrame, stdin } = render(<ConfigView configPath={p} onExit={() => {}} />);
    await until(() => /sandbox/i.test(lastFrame() ?? ""));
    // Section-change resets fieldIdx to 0, so landing on `sandbox` focuses its
    // first lever — `sandbox.enabled`, identified by its description.
    for (let i = 0; i < 15 && !/Wrap agent tool subprocesses/.test(lastFrame() ?? ""); i++) {
      await press(stdin, RIGHT);
    }
    expect(lastFrame() ?? "").toMatch(/Wrap agent tool subprocesses/);
    await press(stdin, ENTER); // toggle sandbox.enabled: false → true
    await until(() => (readCfg(p).sandbox as { enabled?: boolean }).enabled === true);
    expect((readCfg(p).sandbox as { enabled: boolean }).enabled).toBe(true);
  });

  it("cycling an enum lever writes the file", async () => {
    const p = fixture({ vaultRoot: "/v" });
    const { lastFrame, stdin } = render(<ConfigView configPath={p} onExit={() => {}} />);
    await until(() => /observability/i.test(lastFrame() ?? ""));
    for (let i = 0; i < 10; i++) await press(stdin, RIGHT); // general..observability (sandbox added after verify)
    await press(stdin, DOWN, DOWN, DOWN); // healthEnabled, healthHost, healthPort, logLevel
    await press(stdin, ENTER); // cycle logLevel: info → warn
    await until(() => readCfg(p).observability !== undefined);
    expect((readCfg(p).observability as { logLevel: string }).logLevel).toBe("warn");
  });

  it("editing a string lever writes the file", async () => {
    const p = fixture({ vaultRoot: "/v" });
    const { lastFrame, stdin } = render(<ConfigView configPath={p} onExit={() => {}} />);
    await until(() => /git/i.test(lastFrame() ?? ""));
    await press(stdin, RIGHT, RIGHT, RIGHT, RIGHT); // general, model, worker, supervisor, git
    await press(stdin, DOWN, DOWN); // gitBin, ghBin, defaultBaseBranch
    await press(stdin, ENTER); // start edit — buffer prefilled "main"
    await press(stdin, BACKSPACE, BACKSPACE, BACKSPACE, BACKSPACE); // clear "main"
    await press(stdin, "trunk");
    await press(stdin, ENTER); // commit
    await until(() => readCfg(p).git !== undefined);
    expect((readCfg(p).git as { defaultBaseBranch: string }).defaultBaseBranch).toBe("trunk");
  });

  it("editing a number lever writes the file", async () => {
    const p = fixture({ vaultRoot: "/v" });
    const { lastFrame, stdin } = render(<ConfigView configPath={p} onExit={() => {}} />);
    await until(() => /worker/i.test(lastFrame() ?? ""));
    await press(stdin, RIGHT, RIGHT); // general, model, worker
    await press(stdin, ENTER); // start edit on defaultTimeoutMinutes — buffer prefilled "30"
    await press(stdin, BACKSPACE, BACKSPACE); // clear "30"
    await press(stdin, "45");
    await press(stdin, ENTER); // commit
    await until(() => readCfg(p).worker !== undefined);
    expect((readCfg(p).worker as { defaultTimeoutMinutes: number }).defaultTimeoutMinutes).toBe(45);
  });

  it("an invalid number edit shows an error toast and does not write", async () => {
    const p = fixture({ vaultRoot: "/v" });
    const before = readFileSync(p, "utf8");
    const { lastFrame, stdin } = render(<ConfigView configPath={p} onExit={() => {}} />);
    await until(() => /worker/i.test(lastFrame() ?? ""));
    await press(stdin, RIGHT, RIGHT); // general, model, worker
    await press(stdin, DOWN, DOWN, DOWN, DOWN, DOWN, DOWN, DOWN); // ...down to maxConcurrent (min 1)
    await press(stdin, ENTER); // start edit — buffer prefilled "1"
    await press(stdin, BACKSPACE); // clear "1"
    await press(stdin, "0"); // violates min:1
    await press(stdin, ENTER); // commit attempt
    await until(() => /must be >= 1/.test(lastFrame() ?? ""));
    expect(readFileSync(p, "utf8")).toBe(before); // untouched
    expect(readCfg(p).worker).toBeUndefined();
  });

  it("a structured lever is read-only — Enter does not write or open an editor", async () => {
    const p = fixture({ vaultRoot: "/v" });
    const before = readFileSync(p, "utf8");
    const { lastFrame, stdin } = render(<ConfigView configPath={p} onExit={() => {}} />);
    await until(() => /tools/.test(lastFrame() ?? ""));
    await press(stdin, DOWN, DOWN); // vaultRoot, juncoSubdir, tools
    await until(() => /edit config\.json/.test(lastFrame() ?? ""));
    await press(stdin, ENTER); // structured — must no-op
    await new Promise((r) => setTimeout(r, 30));
    expect(readFileSync(p, "utf8")).toBe(before);
    expect(lastFrame()).not.toMatch(/█/); // no inline text-field cursor appeared
  });

  it("shows the ↻ restart marker on a restart-kind lever", async () => {
    const p = fixture({ vaultRoot: "/v" });
    const { lastFrame } = render(<ConfigView configPath={p} onExit={() => {}} />);
    // vaultRoot itself is reload:"restart" and is visible without navigating.
    await until(() => /↻ restart/.test(lastFrame() ?? ""));
    expect(lastFrame()).toMatch(/↻ restart/);
  });

  it("renders apiKey masked, never the plaintext default", async () => {
    const p = fixture({ vaultRoot: "/v" });
    const { lastFrame, stdin } = render(<ConfigView configPath={p} onExit={() => {}} />);
    await until(() => /model/i.test(lastFrame() ?? ""));
    await press(stdin, RIGHT); // general → model
    await until(() => /••••/.test(lastFrame() ?? ""));
    // baseUrl's default ("http://127.0.0.1:1234/v1") also contains "1234" —
    // pin the check to the apiKey row specifically, not a bare substring scan.
    expect(lastFrame()).toMatch(/apiKey\s+••••/);
  });

  it("Esc with no in-progress edit calls onExit", async () => {
    const p = fixture({ vaultRoot: "/v" });
    let exited = false;
    const { lastFrame, stdin } = render(
      <ConfigView configPath={p} onExit={() => (exited = true)} />,
    );
    await until(() => /general/.test(lastFrame() ?? ""));
    stdin.write(ESC);
    await until(() => exited);
    expect(exited).toBe(true);
  });

  it("Esc while editing cancels the edit instead of exiting", async () => {
    const p = fixture({ vaultRoot: "/v" });
    let exited = false;
    const { lastFrame, stdin } = render(
      <ConfigView configPath={p} onExit={() => (exited = true)} />,
    );
    await until(() => /general/.test(lastFrame() ?? ""));
    await press(stdin, ENTER); // start editing vaultRoot
    await until(() => /█/.test(lastFrame() ?? "")); // TextField cursor visible
    await press(stdin, ESC); // cancel the edit, not the view
    expect(exited).toBe(false);
    expect(lastFrame()).not.toMatch(/█/);
    expect(readCfg(p).vaultRoot).toBe("/v"); // untouched
  });

  it("left/right move sections back and forth", async () => {
    const p = fixture({ vaultRoot: "/v" });
    const { lastFrame, stdin } = render(<ConfigView configPath={p} onExit={() => {}} />);
    await until(() => /model/i.test(lastFrame() ?? ""));
    await press(stdin, RIGHT);
    await until(() => /Provider-prefixed model id/.test(lastFrame() ?? ""));
    await press(stdin, LEFT);
    await until(() => /Root directory Junco keeps its ticket queue under/.test(lastFrame() ?? ""));
  });

  it("two rapid down-arrows with no tick between them advance focus by two", async () => {
    // Regression test: the up/down handlers used to read a render-time-fixed
    // `fieldIdxSafe` into a `next` local before calling `setFieldIdx(next)`.
    // Two keystrokes fired before React commits a render between them both
    // computed the same stale `next`, so the second `setFieldIdx` was a
    // no-op and one keystroke silently vanished. Firing the two raw
    // `stdin.write`s back-to-back (no `tick()` in between, unlike `press()`)
    // reproduces that race; the fix nests the scroll-offset update inside a
    // stale-safe functional `setFieldIdx` updater so each keystroke
    // compounds off the previous one regardless of commit timing.
    const p = fixture({ vaultRoot: "/v" });
    const { lastFrame, stdin } = render(<ConfigView configPath={p} onExit={() => {}} />);
    await until(() => /general/.test(lastFrame() ?? ""));
    // general section, field order: vaultRoot (0) -> juncoSubdir (1) -> tools (2).
    expect(lastFrame()).toMatch(/Root directory Junco keeps its ticket queue under/);
    stdin.write(DOWN);
    stdin.write(DOWN);
    await until(() => /Tool allowlist granted to the coding agent\./.test(lastFrame() ?? ""));
    const f = lastFrame() ?? "";
    expect(f).toMatch(/Tool allowlist granted to the coding agent\./);
    // If only one keystroke had landed, focus would have stopped on
    // juncoSubdir instead — assert that description is NOT what's shown.
    expect(f).not.toMatch(/Subdirectory under vaultRoot holding inbox\/processing\/done\/failed\./);
  });

  it("windows the right pane so a long section (model, 18 levers) doesn't overflow", async () => {
    const p = fixture({ vaultRoot: "/v" });
    const { lastFrame, stdin } = render(
      <ConfigView configPath={p} onExit={() => {}} visibleRows={4} />,
    );
    await until(() => /model/i.test(lastFrame() ?? ""));
    await press(stdin, RIGHT); // general → model
    await until(() => /id\s+local\/my-model/.test(lastFrame() ?? ""));
    // The initial window covers only the first 4 of model's 18 levers
    // (id, source, modelsJson, api) — the rest is clipped, not overflowed.
    let f = lastFrame() ?? "";
    expect(f).toMatch(/id\s+local\/my-model/);
    expect(f).not.toMatch(/compat\s+\{\}/); // last lever, well past the window
    expect(f).toMatch(/▼ 14 more/); // clipped-below indicator

    // Move focus 13 rows down, past the window bottom (id..api); the
    // window must scroll so the newly focused lever (index 13: cost.output)
    // stays visible, while the now-scrolled-off id row disappears.
    for (let i = 0; i < 13; i++) await press(stdin, DOWN);
    await until(() => /cost\.output\s+0/.test(lastFrame() ?? ""));
    f = lastFrame() ?? "";
    expect(f).toMatch(/cost\.output\s+0/); // focused lever scrolled into view
    expect(f).not.toMatch(/id\s+local\/my-model/); // scrolled off the top
  });
});
