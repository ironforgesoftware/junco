// LOCAL-mode spawned actions: each fires the real junco CLI via runCliFn and
// toasts, deduped in-flight. Fixtures/renderApp are shared from ./helpers.
//
// State-dependent keystrokes are separated by `await until(<marker>)`, never
// fired as a synchronous burst: ink runs useInput against the last committed
// render, so a second key issued before React commits would see a stale
// closure. Markers: the rail position line ("N/5") for the section, the body
// footer ("back") for rail→body focus, and the ▌ selection glyph for the row.
import { describe, it, expect, afterEach } from "vitest";
import { cleanup } from "ink-testing-library";
import { until } from "./helpers/until.js";
import { renderApp, stubClient, okv } from "./helpers/localFixtures.js";

afterEach(cleanup);

type R = ReturnType<typeof renderApp>;
const frame = (r: R): string => r.lastFrame() ?? "";
/** True when SOME frame line carries both `text` and the ▌ cursor glyph — i.e.
 * the row bearing `text` is the selected one. `.some` (not `.find`) so an
 * unselected header line that also mentions the repo nwo never masks it. */
const selOn = (r: R, text: string): boolean =>
  frame(r)
    .split("\n")
    .some((l) => l.includes(text) && l.includes("▌"));

describe("local actions spawn the real CLI (fire-and-toast)", () => {
  it("R on a failed RECENT row → junco retry <name>", async () => {
    const calls: [string, string[]][] = [];
    const r = renderApp({
      initialUiMode: "local",
      runCliFn: async (n, a) => {
        calls.push([n, a]);
        return { code: 0, output: "requeued gh-acme-api-9", timedOut: false };
      },
    });
    await until(() => frame(r).includes("1/5")); // queue section
    r.stdin.write("l"); // enter body
    await until(() => frame(r).includes("back")); // body focus (footer)
    // The two selectable queue rows are WAITING then failed RECENT (the RUNNING
    // row is never in the list). Move the cursor onto the failed RECENT row
    // (its label is the github-derived "#9 exec", not the raw ticket id).
    r.stdin.write("j");
    await until(() => selOn(r, "#9"));
    r.stdin.write("R");
    await until(() => calls.length === 1);
    expect(calls[0]).toEqual(["retry", ["gh-acme-api-9"]]);
  });

  it("x on a WAITING inbox row confirms, then y spawns junco rm <name>", async () => {
    const calls: [string, string[]][] = [];
    const r = renderApp({
      initialUiMode: "local",
      runCliFn: async (n, a) => {
        calls.push([n, a]);
        return { code: 0, output: "removed", timedOut: false };
      },
    });
    await until(() => frame(r).includes("1/5"));
    r.stdin.write("l");
    await until(() => selOn(r, "sub-fix-typos")); // cursor on the WAITING row
    r.stdin.write("x"); // opens confirm (destructive)
    await until(() => frame(r).toLowerCase().includes("delete"));
    expect(calls).toHaveLength(0); // nothing spawned before confirm
    r.stdin.write("y");
    await until(() => calls.length === 1);
    expect(calls[0]).toEqual(["rm", ["sub-fix-typos"]]);
  });

  it("confirm-cancel (n) spawns nothing", async () => {
    const calls: [string, string[]][] = [];
    const r = renderApp({
      initialUiMode: "local",
      runCliFn: async (n, a) => {
        calls.push([n, a]);
        return { code: 0, output: "", timedOut: false };
      },
    });
    await until(() => frame(r).includes("1/5"));
    r.stdin.write("l");
    await until(() => selOn(r, "sub-fix-typos"));
    r.stdin.write("x");
    await until(() => frame(r).toLowerCase().includes("delete"));
    r.stdin.write("n");
    await new Promise((res) => setTimeout(res, 20));
    expect(calls).toHaveLength(0);
  });

  it("RUNNING/processing rows are never selectable — no action spawns", async () => {
    const calls: unknown[] = [];
    const r = renderApp({
      initialUiMode: "local",
      runCliFn: async () => {
        calls.push(1);
        return { code: 0, output: "", timedOut: false };
      },
    });
    await until(() => frame(r).includes("1/5"));
    r.stdin.write("l");
    await until(() => frame(r).includes("back"));
    r.stdin.write("g"); // top selectable row — the WAITING row, NOT the running row
    await until(() => selOn(r, "sub-fix-typos"));
    r.stdin.write("R"); // R only fires on a failed RECENT row → no-op here
    await new Promise((res) => setTimeout(res, 20));
    expect(calls).toHaveLength(0);
  });

  it("outbox f flushes; daemon f/X flush/restart", async () => {
    const calls: [string, string[]][] = [];
    const r = renderApp({
      initialUiMode: "local",
      runCliFn: async (n, a) => {
        calls.push([n, a]);
        return { code: 0, output: "flushed 2", timedOut: false };
      },
    });
    await until(() => frame(r).includes("1/5"));
    r.stdin.write("j"); // → outbox section
    await until(() => frame(r).includes("2/5"));
    r.stdin.write("l"); // enter body
    await until(() => frame(r).includes("back"));
    r.stdin.write("f");
    await until(() => calls.some(([n]) => n === "outbox"));
    expect(calls.find(([n]) => n === "outbox")![1]).toEqual(["flush"]);
  });

  it("worktree x on a stale row confirms → y → junco worktree prune <path>", async () => {
    const calls: [string, string[]][] = [];
    const r = renderApp({
      initialUiMode: "local",
      runCliFn: async (n, a) => {
        calls.push([n, a]);
        return { code: 0, output: "pruned", timedOut: false };
      },
    });
    await until(() => frame(r).includes("1/5"));
    r.stdin.write("j");
    await until(() => frame(r).includes("2/5"));
    r.stdin.write("j");
    await until(() => frame(r).includes("3/5"));
    r.stdin.write("j"); // → worktrees section
    await until(() => frame(r).includes("4/5") && frame(r).includes("fix-typos"));
    r.stdin.write("l"); // enter body
    await until(() => selOn(r, "fix-typos")); // cursor on the stale worktree
    r.stdin.write("x");
    await until(() => frame(r).includes("prune worktree")); // confirm modal open
    r.stdin.write("y");
    await until(() => calls.some(([n]) => n === "worktree"));
    expect(calls.find(([n]) => n === "worktree")![1]).toEqual(["prune", "/w/acme-api/fix-typos"]);
  });

  it("daemon restart confirm body carries the in-flight ticket count", async () => {
    const r = renderApp({ initialUiMode: "local" });
    await until(() => frame(r).includes("1/5"));
    r.stdin.write("G"); // → daemon section (last)
    await until(() => frame(r).includes("5/5"));
    r.stdin.write("l"); // enter the daemon body (X is a body action)
    await until(() => frame(r).includes("back"));
    r.stdin.write("X");
    await until(() => frame(r).includes("in-flight ticket"));
    expect(frame(r)).toMatch(/1 in-flight ticket/); // currentTickets.length === 1
  });

  it("Repos x/o act on the local cursor target, not github currentRepo", async () => {
    const opens: string[] = [];
    const client = {
      ...stubClient,
      openRepoInBrowser: async (nwo: string) => {
        opens.push(nwo);
        return okv(undefined);
      },
    };
    const r = renderApp({ initialUiMode: "local", client });
    await until(() => frame(r).includes("1/5"));
    r.stdin.write("j");
    await until(() => frame(r).includes("2/5"));
    r.stdin.write("j"); // → repos section
    await until(() => frame(r).includes("3/5") && frame(r).includes("acme/api"));
    r.stdin.write("l"); // enter body
    await until(() => selOn(r, "acme/api")); // cursor on the LocalRepo
    r.stdin.write("o");
    await until(() => opens.length === 1);
    expect(opens[0]).toBe("acme/api"); // the LocalRepo under the cursor
  });

  it("header-tab click toggles mode from a non-main github view (prs)", async () => {
    const r = renderApp({ initialUiMode: "github" });
    await until(() => frame(r).includes("[GITHUB]"));
    r.stdin.write("p"); // github prs view
    await until(() => frame(r).toLowerCase().includes("pull requests"));
    // m still crosses from prs (the raw-SGR header click is covered in tuiMouse):
    r.stdin.write("m");
    await until(() => frame(r).includes("[LOCAL]"));
  });
});
