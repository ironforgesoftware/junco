import { describe, it, expect } from "vitest";
import React, { useState } from "react";
import { render } from "ink-testing-library";
import { Composer, slashMatches } from "../src/tui/components/Composer.js";
import { until, tick, wait } from "./helpers/until.js";

function Host({
  onSubmit,
  disabled = false,
}: {
  onSubmit: (v: string) => void;
  disabled?: boolean;
}) {
  const [v, setV] = useState("");
  return (
    <Composer
      value={v}
      onChange={setV}
      onSubmit={onSubmit}
      focused
      width={60}
      disabled={disabled}
      disabledReason="daemon down"
    />
  );
}

describe("Composer (spec 2026-09-01 §8.2, §8.4)", () => {
  it("types, submits on enter, inserts newlines on alt+enter and ctrl+j", async () => {
    const sent: string[] = [];
    const r = render(<Host onSubmit={(v) => sent.push(v)} />);
    r.stdin.write("hi");
    await until(() => r.lastFrame()!.includes("hi"));
    r.stdin.write("\x1b\r"); // alt+enter → key.return && key.meta
    await until(
      () =>
        r
          .lastFrame()!
          .split("\n")
          .filter((l) => l.includes("│")).length >= 2 || r.lastFrame()!.includes("hi\n"),
    );
    r.stdin.write("there");
    await until(() => r.lastFrame()!.includes("there"));
    r.stdin.write("\n"); // ctrl+j → input "\n", key.return false
    r.stdin.write("end");
    await until(() => r.lastFrame()!.includes("end"));
    r.stdin.write("\r");
    await until(() => sent.length === 1);
    expect(sent[0]).toBe("hi\nthere\nend");
  });

  it("a paste lands as one insertion, newlines intact, and never submits", async () => {
    const sent: string[] = [];
    const r = render(<Host onSubmit={(v) => sent.push(v)} />);
    r.stdin.write("\x1b[200~line one\nline two\x1b[201~");
    await until(() => r.lastFrame()!.includes("line two"));
    expect(sent).toEqual([]);
    r.stdin.write("\r");
    await until(() => sent.length === 1);
    expect(sent[0]).toBe("line one\nline two");
  });

  it("a paste normalises CRLF line endings to bare newlines", async () => {
    const sent: string[] = [];
    const r = render(<Host onSubmit={(v) => sent.push(v)} />);
    r.stdin.write("\x1b[200~row one\r\nrow two\x1b[201~");
    await until(() => r.lastFrame()!.includes("row two"));
    r.stdin.write("\r");
    await until(() => sent.length === 1);
    expect(sent[0]).toBe("row one\nrow two");
  });

  it("a leading slash shows matching commands; tab completes; enter submits the command", async () => {
    const sent: string[] = [];
    const r = render(<Host onSubmit={(v) => sent.push(v)} />);
    r.stdin.write("/a");
    await until(
      () =>
        r.lastFrame()!.includes("/abort") &&
        r.lastFrame()!.includes("/audit") &&
        !r.lastFrame()!.includes("/investigate"),
    );
    expect(r.lastFrame()).not.toContain("/draft");
    r.stdin.write("\t");
    await until(() => r.lastFrame()!.includes("/audit") && !r.lastFrame()!.includes("/abort"));
    r.stdin.write("\r");
    await until(() => sent.length === 1);
    expect(sent[0]).toBe("/audit");
  });

  it("down arrow moves the highlighted slash entry; tab picks the highlighted one", async () => {
    const sent: string[] = [];
    const r = render(<Host onSubmit={(v) => sent.push(v)} />);
    r.stdin.write("/a");
    await until(() => r.lastFrame()!.includes("/abort") && r.lastFrame()!.includes("/audit"));
    r.stdin.write("\x1b[B"); // down arrow — move highlight from audit (0) to abort (1)
    await tick();
    r.stdin.write("\x1b[B"); // down arrow again — clamps at the last entry (1)
    await tick();
    r.stdin.write("\x1b[A"); // up arrow — back to audit (0)
    await tick();
    r.stdin.write("\x1b[A"); // up arrow again — clamps at the first entry (0)
    await tick();
    r.stdin.write("\x1b[B"); // down once more — abort (1)
    await tick();
    r.stdin.write("\t");
    await until(() => r.lastFrame()!.includes("/abort") && !r.lastFrame()!.includes("/audit"));
    r.stdin.write("\r");
    await until(() => sent.length === 1);
    expect(sent[0]).toBe("/abort");
  });

  it("tab-completing an arg-taking command appends a trailing space for the argument", async () => {
    const sent: string[] = [];
    const r = render(<Host onSubmit={(v) => sent.push(v)} />);
    r.stdin.write("/pr");
    await until(() => r.lastFrame()!.includes("pull PR #N")); // the /pr suggestion is showing
    r.stdin.write("\t");
    await until(() => !r.lastFrame()!.includes("pull PR #N")); // the space ends completion, closing the list
    r.stdin.write("4");
    await until(() => r.lastFrame()!.includes("/pr 4"));
    r.stdin.write("\r");
    await until(() => sent.length === 1);
    expect(sent[0]).toBe("/pr 4");
  });

  it("backspace deletes the last character", async () => {
    const sent: string[] = [];
    const r = render(<Host onSubmit={(v) => sent.push(v)} />);
    r.stdin.write("xyz");
    await until(() => r.lastFrame()!.includes("xyz"));
    r.stdin.write("\x7f"); // backspace
    await until(() => r.lastFrame()!.includes("xy") && !r.lastFrame()!.includes("xyz"));
    r.stdin.write("\r");
    await until(() => sent.length === 1);
    expect(sent[0]).toBe("xy");
  });

  it("ctrl+letter and a lone escape are swallowed: no insertion, no submit", async () => {
    const sent: string[] = [];
    const r = render(<Host onSubmit={(v) => sent.push(v)} />);
    r.stdin.write("hi");
    await until(() => r.lastFrame()!.includes("hi"));
    r.stdin.write("\x01"); // ctrl+a — a modifier key, not a printable insertion
    await tick();
    r.stdin.write("\x1b"); // lone escape — Ink holds it ~20ms to rule out a longer sequence
    await wait(60); // negative assertion: prove nothing changed once it resolves
    expect(r.lastFrame()).toContain("hi");
    expect(r.lastFrame()).not.toContain("hia");
    expect(sent).toEqual([]);
  });

  it("more than maxRows lines scroll to the tail (default maxRows=4)", async () => {
    const r = render(<Host onSubmit={() => {}} />);
    const lines = ["AAAA", "BBBB", "CCCC", "DDDD", "EEEE", "FFFF"];
    for (let i = 0; i < lines.length; i++) {
      r.stdin.write(lines[i]!);
      await until(() => r.lastFrame()!.includes(lines[i]!));
      if (i < lines.length - 1) {
        r.stdin.write("\n"); // ctrl+j newline
        await tick();
      }
    }
    const frame = r.lastFrame()!;
    expect(frame).toContain("CCCC");
    expect(frame).toContain("DDDD");
    expect(frame).toContain("EEEE");
    expect(frame).toContain("FFFF");
    expect(frame).not.toContain("AAAA");
    expect(frame).not.toContain("BBBB");
  });

  it("disabled: shows the reason and swallows input", async () => {
    const sent: string[] = [];
    const r = render(<Host onSubmit={(v) => sent.push(v)} disabled />);
    await until(() => r.lastFrame()!.includes("daemon down"));
    r.stdin.write("x\r");
    await new Promise((res) => setTimeout(res, 30));
    expect(sent).toEqual([]);
    expect(r.lastFrame()).not.toContain("x");
  });

  it("disabled with no disabledReason falls back to a generic message", async () => {
    const r = render(
      <Composer value="" onChange={() => {}} onSubmit={() => {}} focused width={60} disabled />,
    );
    await until(() => r.lastFrame()!.includes("chat unavailable"));
  });

  it("shows a placeholder hint when unfocused and empty; no cursor glyph", async () => {
    const r = render(
      <Composer value="" onChange={() => {}} onSubmit={() => {}} focused={false} width={60} />,
    );
    await until(() => r.lastFrame()!.includes("type a message"));
    expect(r.lastFrame()).not.toContain("█");
  });

  it("slashMatches is pure and prefix-based", () => {
    expect(slashMatches("/").map((c) => c.name)).toEqual([
      "draft",
      "audit",
      "investigate",
      "pr",
      "issue",
      "abort",
      "new",
    ]);
    expect(slashMatches("/in").map((c) => c.name)).toEqual(["investigate"]);
    expect(slashMatches("/a").map((c) => c.name)).toEqual(["audit", "abort"]);
    expect(slashMatches("hello")).toEqual([]);
    expect(slashMatches("/pr 4")).toEqual([]); // an argument ends completion
  });
});
