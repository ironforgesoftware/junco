import { describe, it, expect, afterEach } from "vitest";
import React from "react";
import { render, cleanup } from "ink-testing-library";
import { until } from "./helpers/until.js";
import { Tip, ReceiptList, Select, MultiSelect } from "../src/tui/wizard/controls.js";

afterEach(cleanup);
const DOWN = "\x1b[B";
const ENTER = "\r";
const SPACE = " ";
// Ink's input-parser (input-parser.js) only splits a stdin chunk into
// multiple key events at an escape boundary (or a backspace byte) — two
// adjacent PLAIN characters like " " + "\r" are coalesced into a single
// unrecognized " \r" event and silently dropped by useInput handlers
// (verified directly against createInputParser: push(" \r") returns one
// event, not two). So a literal space-then-enter burst can't reach the
// stale-closure race at all in this Ink version; meta+Space ("\x1b ") is
// parsed as its own atomic escaped-codepoint event whose `input` is
// stripped down to a plain " " by the time useInput's handler sees it
// (ink/build/components/App.js strips a leading ESC), while still forcing
// the parser to emit Enter as a separate trailing event. That reproduces
// the real two-events-in-one-chunk dispatch the fix must survive.
const META_SPACE = "\x1b ";
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 30));
async function press(stdin: { write: (s: string) => void }, ...keys: string[]): Promise<void> {
  for (const k of keys) {
    stdin.write(k);
    await tick();
  }
}

describe("controls", () => {
  it("Tip renders the junco glyph and copy", () => {
    const { lastFrame } = render(<Tip>Every answer is editable later.</Tip>);
    expect(lastFrame()).toContain("🐦");
    expect(lastFrame()).toContain("editable later");
  });

  it("ReceiptList renders one mark per verdict", () => {
    const { lastFrame } = render(
      <ReceiptList
        items={[
          { verdict: "ok", label: "git", detail: "2.44" },
          { verdict: "warn", label: "gh", detail: "not authenticated" },
          { verdict: "fail", label: "node", detail: "too old" },
        ]}
      />,
    );
    const f = lastFrame() ?? "";
    expect(f).toContain("✓ git");
    expect(f).toContain("⚠ gh");
    expect(f).toContain("✗ node");
  });

  it("Select moves with ↓ and submits the highlighted value", async () => {
    let picked = "";
    const { stdin } = render(
      <Select
        options={[
          { value: "a", label: "Alpha" },
          { value: "b", label: "Beta", hint: "recommended" },
        ]}
        onSubmit={(v) => {
          picked = v;
        }}
        focus
      />,
    );
    await press(stdin, DOWN, ENTER);
    await until(() => picked === "b");
    expect(picked).toBe("b");
  });

  it("MultiSelect toggles with space and submits checked values", async () => {
    let result: string[] | null = null;
    const { stdin } = render(
      <MultiSelect
        items={[
          { value: "sandbox", label: "OS sandbox", checked: true },
          { value: "verify", label: "Verify before PR", checked: true },
        ]}
        onSubmit={(vals) => {
          result = vals;
        }}
        onFocusChange={() => {}}
        focus
      />,
    );
    await press(stdin, DOWN, SPACE, ENTER); // uncheck "verify"
    await until(() => result !== null);
    expect(result).toEqual(["sandbox"]);
  });

  it("Select submits the SECOND option when ↓ and Enter arrive in one stdin chunk", async () => {
    let picked = "";
    const { stdin } = render(
      <Select
        options={[
          { value: "a", label: "Alpha" },
          { value: "b", label: "Beta", hint: "recommended" },
        ]}
        onSubmit={(v) => {
          picked = v;
        }}
        focus
      />,
    );
    // Ink parses one stdin chunk into multiple key events dispatched
    // synchronously in a for-loop, with React's flush deferred past the whole
    // loop. A single write carrying both keys must still see the updated
    // index by the time Enter's handler runs.
    stdin.write(DOWN + ENTER);
    await until(() => picked !== "");
    expect(picked).toBe("b");
  });

  it("MultiSelect submits the toggled set when Space and Enter arrive in one stdin chunk", async () => {
    let result: string[] | null = null;
    const { stdin } = render(
      <MultiSelect
        items={[
          { value: "sandbox", label: "OS sandbox", checked: true },
          { value: "verify", label: "Verify before PR", checked: true },
        ]}
        onSubmit={(vals) => {
          result = vals;
        }}
        onFocusChange={() => {}}
        focus
      />,
    );
    // Space (uncheck "sandbox", the focused item) and Enter in the SAME
    // chunk — the submit must reflect the toggle, not the pre-toggle state.
    // (META_SPACE, not a literal " ", so Ink's parser actually splits this
    // into two dispatched events instead of coalescing them — see the
    // comment on META_SPACE above.)
    stdin.write(META_SPACE + ENTER);
    await until(() => result !== null);
    expect(result).toEqual(["verify"]);
  });
});
