import { describe, it, expect, afterEach } from "vitest";
import React from "react";
import { render, cleanup } from "ink-testing-library";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ConfigView } from "../src/tui/components/ConfigView.js";
import { MouseProvider } from "../src/tui/MouseProvider.js";
import { until, fireUntil, tick } from "./helpers/until.js";

afterEach(cleanup);

const DOWN = "\x1b[B";
const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const ENTER = "\r";
const ESC = "\x1b";
const BACKSPACE = "\x7f";

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

// SGR mouse sequences at 0-based cell (x,y) — mirrors tuiClickable.test.tsx's
// and tuiMouseApp.test.tsx's helpers (b=0 press, b=65 wheel-down; a JS `\u`
// escape, not a raw ESC byte, so file edits never drop it). Named `click`
// rather than `press` — this file's `press(stdin, ...keys)` above already
// owns that name for keyboard sequences.
const click = (x: number, y: number): string => `\u001b[<0;${x + 1};${y + 1}M`;
const wheelDown = (x: number, y: number): string => `\u001b[<65;${x + 1};${y + 1}M`;

const lineOf = (frame: string, needle: string): number =>
  frame.split("\n").findIndex((l) => l.includes(needle));

/** Mounts ConfigView under a MouseProvider (mouse dispatch requires the
 * context) with a small deterministic `visibleRows` window, mirroring the
 * plain `fixture()` + `render()` pairing above. Exposes the tmp config path
 * as `configPath` for file-content assertions. */
function renderConfigViewInProvider(opts?: {
  configObj?: unknown;
  visibleRows?: number;
}): ReturnType<typeof render> & { configPath: string } {
  const p = fixture(opts?.configObj ?? { vaultRoot: "/v" });
  const r = render(
    <MouseProvider>
      <ConfigView configPath={p} onExit={() => {}} visibleRows={opts?.visibleRows ?? 8} />
    </MouseProvider>,
  );
  return Object.assign(r, { configPath: p });
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

  // surface-legibility Task 2: the CLI verb over config.json's `assess.*` keys
  // (assess.fileAs, …) is now `junco audit` — config.json's own key name stays
  // `assess` (a persisted user key, out of this task's scope; see
  // sectionKeyFor/SECTION_ORDER in ConfigView.tsx), but the rendered tab must
  // track the renamed verb so the dashboard never shows the retired word.
  it("renders the assess.* section's tab as 'audit', never 'assess'", async () => {
    const p = fixture({ vaultRoot: "/v" });
    const { lastFrame } = render(<ConfigView configPath={p} onExit={() => {}} />);
    await until(() => /audit/i.test(lastFrame() ?? ""));
    const f = lastFrame() ?? "";
    expect(f).toMatch(/audit/);
    expect(f).not.toMatch(/\bassess\b/);
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

  it("inputActive={false} makes the editor inert (a confirm modal owns input over it)", async () => {
    const p = fixture({ vaultRoot: "/v" });
    let exited = false;
    const { lastFrame, stdin } = render(
      <ConfigView configPath={p} onExit={() => (exited = true)} inputActive={false} />,
    );
    await until(() => /model/i.test(lastFrame() ?? ""));
    // Same sequence that toggles model.reasoning when active, plus an Esc
    // that would call onExit. press() ticks after every key, so the writes
    // below had every chance to land before the assertions.
    await press(stdin, RIGHT, DOWN, DOWN, DOWN, DOWN, DOWN, DOWN, DOWN, DOWN);
    await press(stdin, ENTER, ESC);
    expect(readCfg(p).model).toBeUndefined(); // no toggle write
    expect(exited).toBe(false); // esc never reached onExit
    // Focus never left the initial general/vaultRoot lever.
    expect(lastFrame() ?? "").toMatch(/Root directory Junco keeps its ticket queue under/);
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

  it("windows the right pane so a long section (model, 19 levers) doesn't overflow", async () => {
    const p = fixture({ vaultRoot: "/v" });
    const { lastFrame, stdin } = render(
      <ConfigView configPath={p} onExit={() => {}} visibleRows={4} />,
    );
    await until(() => /model/i.test(lastFrame() ?? ""));
    await press(stdin, RIGHT); // general → model
    await until(() => /id\s+local\/my-model/.test(lastFrame() ?? ""));
    // The initial window covers only the first 4 of model's 19 levers
    // (id, source, modelsJson, api) — the rest is clipped, not overflowed.
    let f = lastFrame() ?? "";
    expect(f).toMatch(/id\s+local\/my-model/);
    expect(f).not.toMatch(/compat\s+\{\}/); // last lever, well past the window
    expect(f).toMatch(/▼ 15 more/); // clipped-below indicator

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

describe("ConfigView mouse", () => {
  it("clicking a section in the left pane switches sections", async () => {
    const r = renderConfigViewInProvider();
    await until(() => (r.lastFrame() ?? "").includes("general"));
    const y = lineOf(r.lastFrame() ?? "", "worker");
    await fireUntil(
      r.stdin,
      click(3, y),
      () => (r.lastFrame() ?? "").split("\n")[y]?.includes("▌ worker") ?? false,
    );
  });

  it("clicking a lever row focuses it (not the auto-focused one); clicking the focused row activates (boolean toggles)", async () => {
    const r = renderConfigViewInProvider();
    await until(() => (r.lastFrame() ?? "").includes("general"));
    const sandboxY = lineOf(r.lastFrame() ?? "", "sandbox");
    await fireUntil(r.stdin, click(3, sandboxY), () => (r.lastFrame() ?? "").includes("▌ sandbox"));
    // Switching sections resets fieldIdx to 0, so `sandbox.enabled` (row 0)
    // is ALREADY focused here. Click a different row first, so the next
    // click on `enabled` is a genuine "focus a non-focused row" case rather
    // than one that happens to already be focused.
    const backendY = lineOf(r.lastFrame() ?? "", "backend");
    await fireUntil(
      r.stdin,
      click(30, backendY),
      () => (r.lastFrame() ?? "").split("\n")[backendY]?.includes("▌ backend") ?? false,
    );
    expect(r.lastFrame() ?? "").not.toMatch(/Saved/);
    const enabledY = lineOf(r.lastFrame() ?? "", "enabled");
    // First click on the (currently unfocused) `enabled` row: focus only.
    r.stdin.write(click(30, enabledY));
    await until(() => (r.lastFrame() ?? "").split("\n")[enabledY]?.includes("▌ enabled") ?? false);
    expect(r.lastFrame() ?? "").not.toMatch(/Saved/);
    // Second click on the now-focused row: activate (toggle the boolean).
    r.stdin.write(click(30, enabledY));
    await until(() => (r.lastFrame() ?? "").includes("Saved"));
  });

  it("wheel over the lever pane moves the field cursor", async () => {
    const r = renderConfigViewInProvider();
    await until(() => (r.lastFrame() ?? "").includes("general"));
    // The first lever row (vaultRoot) carries the `▌` focus marker initially.
    // Anchor on "▌ vaultRoot" specifically, not a bare "▌" — the left pane's
    // OWN section marker ("▌ general", always selected here) lands on this
    // same terminal row and would otherwise make the check vacuously true.
    const firstRowY = lineOf(r.lastFrame() ?? "", "vaultRoot");
    expect((r.lastFrame() ?? "").split("\n")[firstRowY]).toContain("▌ vaultRoot");
    // wheelDown is monotone and clamped (never wraps back to row 0), so
    // re-sending on a lost/raced first event is safe — fireUntil's
    // "clamped wheel" case.
    await fireUntil(
      r.stdin,
      wheelDown(30, firstRowY),
      () => !((r.lastFrame() ?? "").split("\n")[firstRowY]?.includes("▌ vaultRoot") ?? false),
    );
  });

  it("wheel over the lever pane does nothing while editing", async () => {
    const r = renderConfigViewInProvider();
    await until(() => (r.lastFrame() ?? "").includes("general"));
    // vaultRoot (row 0) is already focused at mount, so a single click on it
    // activates the inline editor directly.
    const rowY = lineOf(r.lastFrame() ?? "", "vaultRoot");
    await fireUntil(r.stdin, click(30, rowY), () => (r.lastFrame() ?? "").includes("/v█"));
    const before = r.lastFrame() ?? "";
    r.stdin.write(wheelDown(30, rowY));
    await new Promise((res) => setTimeout(res, 60));
    expect(r.lastFrame() ?? "").toBe(before); // unchanged: no field movement, no scroll
  });

  it("clicking a secret lever opens an empty edit buffer (masking preserved)", async () => {
    const r = renderConfigViewInProvider();
    await until(() => (r.lastFrame() ?? "").includes("general"));
    const modelY = lineOf(r.lastFrame() ?? "", "model");
    await fireUntil(r.stdin, click(3, modelY), () => (r.lastFrame() ?? "").includes("▌ model"));
    await until(() => /••••/.test(r.lastFrame() ?? ""));
    const apiKeyY = lineOf(r.lastFrame() ?? "", "apiKey");
    // First click focuses apiKey (not the section's auto-focused row 0: `id`).
    await fireUntil(
      r.stdin,
      click(30, apiKeyY),
      () => (r.lastFrame() ?? "").split("\n")[apiKeyY]?.includes("▌ apiKey") ?? false,
    );
    // Second click activates: opens the inline editor with an EMPTY buffer
    // (startEdit's existing secret-type branch), never the plaintext value.
    r.stdin.write(click(30, apiKeyY));
    await until(() => (r.lastFrame() ?? "").split("\n")[apiKeyY]?.includes("█") ?? false);
    const line = (r.lastFrame() ?? "").split("\n")[apiKeyY] ?? "";
    expect(line).not.toContain("••••");
  });

  it("left-pane wheel during an open edit cancels the edit (no commit to the new section's lever)", async () => {
    const r = renderConfigViewInProvider();
    await until(() => (r.lastFrame() ?? "").includes("general"));
    // vaultRoot (row 0) is focused at mount — one click activates the edit.
    const rowY = lineOf(r.lastFrame() ?? "", "vaultRoot");
    await fireUntil(r.stdin, click(30, rowY), () => (r.lastFrame() ?? "").includes("/v█"));
    // fireUntil, not press: the editor's TextInput just mounted, so a one-shot
    // keystroke can land before its useInput attaches (the keyboard flavor of
    // the region-registration race — flaked the 2026-07-16 macos merge gate).
    await fireUntil(r.stdin, "XYZ", () => (r.lastFrame() ?? "").includes("/vXYZ")); // distinctive buffer
    const before = readFileSync(r.configPath, "utf8");
    // Wheel over the LEFT pane while the edit is open. Without moveSection
    // cancelling the edit, the buffer survives the section switch, rebinds
    // to the new section's field 0, and a later Enter commits "/vXYZ" to the
    // wrong lever. The condition anchors on the buffer disappearing — it is
    // monotone under repeated wheel events, so fireUntil re-sends are safe.
    const leftY = lineOf(r.lastFrame() ?? "", "worker");
    await fireUntil(r.stdin, wheelDown(3, leftY), () => !(r.lastFrame() ?? "").includes("/vXYZ"));
    const f = r.lastFrame() ?? "";
    expect(f).not.toContain("▌ general"); // the section DID switch...
    expect(f).not.toMatch(/█/); // ...but no editor is open anymore
    expect(f).not.toMatch(/Saved/);
    expect(readFileSync(r.configPath, "utf8")).toBe(before); // untouched
    // Enter-after-cancel is covered deterministically by the same-chunk test
    // below — a separately-timed Enter here can only reproduce the same race
    // probabilistically (it flaked the 2026-07-16 macos gate doing exactly that).
  });

  it("Enter arriving right after a canceling wheel must not commit the abandoned buffer", async () => {
    const r = renderConfigViewInProvider();
    await until(() => (r.lastFrame() ?? "").includes("general"));
    const rowY = lineOf(r.lastFrame() ?? "", "vaultRoot");
    await fireUntil(r.stdin, click(30, rowY), () => (r.lastFrame() ?? "").includes("/v█"));
    await fireUntil(r.stdin, "XYZ", () => (r.lastFrame() ?? "").includes("/vXYZ")); // distinctive buffer
    const before = readFileSync(r.configPath, "utf8");
    const leftY = lineOf(r.lastFrame() ?? "", "worker");
    // TWO back-to-back writes with no await between them (NOT one chunk: in a
    // single chunk ink's own stdin listener hands Enter to the still-open
    // TextField BEFORE MouseProvider parses the wheel, which is a legitimate
    // Enter-then-wheel commit, a different scenario). Sequential writes pin
    // the CI ordering: the wheel's moveSection cancels the edit synchronously,
    // but React's unmount of the TextField is still pending, so its useInput
    // is STILL SUBSCRIBED when Enter's data event fires — the stale closure
    // holds the abandoned buffer AND the old lever. Without commitEdit's
    // editingRef guard this commits "/vXYZ" to vaultRoot ("Saved — restart to
    // apply") — the deterministic replay of the cleanup-window race that
    // failed the 2026-07-16 macos merge gates (useInput detaches in a PASSIVE
    // cleanup, so the same window opens between any wheel-cancel and a fast
    // following Enter).
    r.stdin.write(wheelDown(3, leftY));
    r.stdin.write(ENTER);
    await until(() => (r.lastFrame() ?? "").includes("▌ model")); // wheel landed: general → model
    await until(() => !(r.lastFrame() ?? "").includes("/vXYZ"));
    const f = r.lastFrame() ?? "";
    expect(f).not.toMatch(/Saved/);
    expect(readFileSync(r.configPath, "utf8")).toBe(before); // buffer never committed anywhere
  });

  it("clicking a different lever row during an open edit cancels the edit and does nothing else", async () => {
    const r = renderConfigViewInProvider();
    await until(() => (r.lastFrame() ?? "").includes("general"));
    const rowY = lineOf(r.lastFrame() ?? "", "vaultRoot");
    await fireUntil(r.stdin, click(30, rowY), () => (r.lastFrame() ?? "").includes("/v█"));
    // fireUntil, not press: same freshly-mounted-TextInput race as the wheel
    // test above.
    await fireUntil(r.stdin, "ZZZ", () => (r.lastFrame() ?? "").includes("/vZZZ")); // distinctive buffer
    const before = readFileSync(r.configPath, "utf8");
    // ONE click on a DIFFERENT row while editing: the row onPress must
    // cancel the edit and return — no focus move, no activation, no save.
    const otherY = lineOf(r.lastFrame() ?? "", "juncoSubdir");
    r.stdin.write(click(30, otherY));
    await until(() => !(r.lastFrame() ?? "").includes("/vZZZ"));
    const f = r.lastFrame() ?? "";
    expect(f.split("\n")[rowY]).toContain("▌ vaultRoot"); // focus unmoved
    expect(f.split("\n")[otherY]).not.toContain("▌ juncoSubdir"); // not focused
    expect(f).not.toMatch(/█/); // no editor open anywhere
    expect(f).not.toMatch(/Saved/);
    expect(readFileSync(r.configPath, "utf8")).toBe(before); // untouched
  });
});
