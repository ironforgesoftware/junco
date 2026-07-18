import { describe, it, expect, afterEach, vi } from "vitest";
import React from "react";
import { Text } from "ink";
import { render, cleanup } from "ink-testing-library";
import { until, fireUntil } from "./helpers/until.js";
import { MouseProvider } from "../src/tui/MouseProvider.js";
import { Tip, ReceiptList, Select, MultiSelect } from "../src/tui/wizard/controls.js";
import { Welcome } from "../src/tui/wizard/chapters/Welcome.js";
import { Workspace } from "../src/tui/wizard/chapters/Workspace.js";
import { Model } from "../src/tui/wizard/chapters/Model.js";
import { RepoSafety } from "../src/tui/wizard/chapters/RepoSafety.js";
import { Github } from "../src/tui/wizard/chapters/Github.js";
import { Account } from "../src/tui/wizard/chapters/Account.js";
import { Extras } from "../src/tui/wizard/chapters/Extras.js";
import { Review } from "../src/tui/wizard/chapters/Review.js";
import { Finale } from "../src/tui/wizard/chapters/Finale.js";
import { useSuspend, SuspendProvider } from "../src/tui/useSuspend.js";
import { defaultAnswers, answersFromConfig } from "../src/wizard/flow.js";
import type { WizardIO } from "../src/wizard/io.js";

afterEach(cleanup);
const DOWN = "\x1b[B";
const ENTER = "\r";
const SPACE = " ";
const BACKSPACE = "\x7f";
// Ink's input-parser (input-parser.js) only splits a stdin chunk into
// multiple key events at an escape boundary (or a backspace byte) — two
// adjacent PLAIN characters like " " + "\r" are coalesced into a single
// unrecognized " \r" event and silently dropped by useInput handlers
// (verified directly against createInputParser: push(" \r") returns one
// event, not two). So a literal space-then-enter burst can't reach the
// stale-closure race at all in this Ink version; meta+Space ("\x1b ") is
// parsed as its own atomic escaped-codepoint event whose `input` is
// stripped down to a plain " " by the time useInput's handler sees it
// (ink/build/hooks/use-input.js's handleData strips a leading ESC), while still forcing
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

// SGR mouse press at 0-based cell (x, y) — a JS `\u001b` escape (not a raw ESC byte) so
// file edits never drop it. Named mousePress (not `press`) to avoid
// colliding with this file's keyboard press(stdin, ...keys) helper above;
// mirrors tests/tuiClickable.test.tsx / tests/tuiMouseApp.test.tsx.
const mousePress = (x: number, y: number): string => `\u001b[<0;${x + 1};${y + 1}M`;
const lineOf = (frame: string, needle: string): number =>
  frame.split("\n").findIndex((l) => l.includes(needle));

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

  it("Select: clicking an option chooses it (enter parity)", async () => {
    const onSubmit = vi.fn();
    const r = render(
      <MouseProvider>
        <Select
          options={[
            { value: "a", label: "Alpha" },
            { value: "b", label: "Beta" },
          ]}
          onSubmit={onSubmit}
          focus
        />
      </MouseProvider>,
    );
    await until(() => (r.lastFrame() ?? "").includes("Beta"));
    const y = lineOf(r.lastFrame() ?? "", "Beta");
    r.stdin.write(mousePress(2, y));
    await until(() => onSubmit.mock.calls.length === 1);
    expect(onSubmit).toHaveBeenCalledWith("b");
  });

  it("Select: an unfocused option is not clickable", async () => {
    const onSubmit = vi.fn();
    const r = render(
      <MouseProvider>
        <Select
          options={[
            { value: "a", label: "Alpha" },
            { value: "b", label: "Beta" },
          ]}
          onSubmit={onSubmit}
          focus={false}
        />
      </MouseProvider>,
    );
    await until(() => (r.lastFrame() ?? "").includes("Beta"));
    const y = lineOf(r.lastFrame() ?? "", "Beta");
    r.stdin.write(mousePress(2, y));
    // Negative assertion: give a buggy handler a bounded window to fire.
    await new Promise((res) => setTimeout(res, 50));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("MultiSelect: clicking an option toggles it without submitting", async () => {
    const onSubmit = vi.fn();
    const r = render(
      <MouseProvider>
        <MultiSelect
          items={[
            { value: "a", label: "Alpha", checked: false },
            { value: "b", label: "Beta", checked: false },
          ]}
          onSubmit={onSubmit}
          onFocusChange={() => {}}
          focus
        />
      </MouseProvider>,
    );
    await until(() => (r.lastFrame() ?? "").includes("Beta"));
    const y = lineOf(r.lastFrame() ?? "", "Beta");
    r.stdin.write(mousePress(4, y));
    await until(() => (r.lastFrame() ?? "").split("\n")[y].includes("[x]"));
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

function fakeIo(over: Partial<WizardIO> = {}): WizardIO {
  return {
    mode: "fresh",
    configPath: "/tmp/config.json",
    initialAnswers: defaultAnswers(),
    currentRaw: null,
    greetName: async () => "Ada",
    preflight: async () => [{ verdict: "ok", label: "git", detail: "2.44" }],
    discoverModels: async () => ["m-fast", "m-big"],
    listModelsJson: () => [],
    listCatalogProviders: async () => [
      { provider: "acme", ids: ["big", "small"] },
      { provider: "globex", ids: ["fast"] },
    ],
    write: () => ({
      written: true,
      configPath: "/tmp/config.json",
      queueRoot: "/tmp/q",
      changes: [],
    }),
    flightCheck: async () => [],
    botGhConfigDir: "/sbx/junco-gh",
    detectBotLogin: async () => null,
    runGhLogin: async () => 0,
    ...over,
  };
}

const noopChapter = {
  patch: () => {},
  onBack: () => {},
  setTextEditing: () => {},
};

describe("Welcome", () => {
  it("greets by name, shows preflight receipts, and advances on enter", async () => {
    let advanced = false;
    const { lastFrame, stdin } = render(
      <Welcome
        {...noopChapter}
        answers={defaultAnswers()}
        io={fakeIo()}
        onNext={() => {
          advanced = true;
        }}
      />,
    );
    await until(() => (lastFrame() ?? "").includes("Ada"));
    await until(() => (lastFrame() ?? "").includes("✓ git"));
    expect(lastFrame()).toContain("🐦");
    await press(stdin, ENTER);
    await until(() => advanced);
  });

  it("rerun mode names the config being tuned", async () => {
    const { lastFrame } = render(
      <Welcome
        {...noopChapter}
        answers={defaultAnswers()}
        io={fakeIo({ mode: "rerun", configPath: "/etc/junco.json" })}
        onNext={() => {}}
      />,
    );
    await until(() => (lastFrame() ?? "").includes("/etc/junco.json"));
    expect(lastFrame()).toContain("tune");
  });
});

describe("Workspace", () => {
  it("edits dataDir and advances on enter, refusing empty", async () => {
    let answers = defaultAnswers();
    let advanced = false;
    const view = (
      <Workspace
        {...noopChapter}
        answers={answers}
        patch={(p) => {
          answers = { ...answers, ...p };
        }}
        io={fakeIo()}
        onNext={() => {
          advanced = true;
        }}
      />
    );
    const { stdin, rerender } = render(view);
    // wipe the default then type a path
    for (let i = 0; i < defaultAnswers().dataDir.length; i++) {
      await press(stdin, BACKSPACE);
      rerender(
        <Workspace
          {...noopChapter}
          answers={answers}
          patch={(p) => {
            answers = { ...answers, ...p };
          }}
          io={fakeIo()}
          onNext={() => {
            advanced = true;
          }}
        />,
      );
    }
    await press(stdin, ENTER); // empty → must NOT advance
    expect(advanced).toBe(false);
    stdin.write("/tmp/nest");
    await tick();
    rerender(
      <Workspace
        {...noopChapter}
        answers={answers}
        patch={(p) => {
          answers = { ...answers, ...p };
        }}
        io={fakeIo()}
        onNext={() => {
          advanced = true;
        }}
      />,
    );
    await press(stdin, ENTER);
    await until(() => advanced);
    expect(answers.dataDir).toBe("/tmp/nest");
  });
});

describe("Model chapter", () => {
  it("inline path: url → key → probe → pick, prefixing the discovered id", async () => {
    let answers = defaultAnswers();
    let advanced = false;
    const io = fakeIo({ discoverModels: async () => ["m-fast", "m-big"] });
    const props = () => ({
      ...noopChapter,
      answers,
      patch: (p: Partial<typeof answers>) => {
        answers = { ...answers, ...p };
      },
      io,
      onNext: () => {
        advanced = true;
      },
    });
    const { lastFrame, stdin, rerender } = render(<Model {...props()} />);
    await until(() => (lastFrame() ?? "").includes("How is the model configured?"));
    await press(stdin, ENTER); // source: inline (first option)
    rerender(<Model {...props()} />);
    await until(() => (lastFrame() ?? "").includes("endpoint"));
    await press(stdin, ENTER); // accept default URL
    rerender(<Model {...props()} />);
    await until(() => (lastFrame() ?? "").includes("API key"));
    await press(stdin, ENTER); // accept default key
    rerender(<Model {...props()} />);
    await until(() => (lastFrame() ?? "").includes("2 models found"));
    await press(stdin, ENTER); // pick first discovered id
    await until(() => advanced);
    expect(answers.modelId).toBe("local/m-fast"); // 127.0.0.1 → "local" prefix
    expect(answers.mode).toBe("inline");
  });

  it("empty discovery falls to manual entry", async () => {
    let answers = defaultAnswers();
    let advanced = false;
    const io = fakeIo({ discoverModels: async () => [] });
    const props = () => ({
      ...noopChapter,
      answers,
      patch: (p: Partial<typeof answers>) => {
        answers = { ...answers, ...p };
      },
      io,
      onNext: () => {
        advanced = true;
      },
    });
    const { lastFrame, stdin, rerender } = render(<Model {...props()} />);
    await until(() => (lastFrame() ?? "").includes("How is the model configured?"));
    await press(stdin, ENTER);
    rerender(<Model {...props()} />);
    await press(stdin, ENTER); // url
    rerender(<Model {...props()} />);
    await press(stdin, ENTER); // key
    rerender(<Model {...props()} />);
    await until(() => (lastFrame() ?? "").includes("Model id"));
    stdin.write("anthropic/claude");
    await tick();
    rerender(<Model {...props()} />);
    await press(stdin, ENTER);
    await until(() => advanced);
    expect(answers.modelId).toBe("anthropic/claude"); // slash → kept as-is
  });

  it("key step (fresh): masks typed input and never leaks the raw key", async () => {
    let answers = defaultAnswers();
    const props = () => ({
      ...noopChapter,
      answers,
      patch: (p: Partial<typeof answers>) => {
        answers = { ...answers, ...p };
      },
      io: fakeIo(),
      onNext: () => {},
    });
    const { lastFrame, stdin, rerender } = render(<Model {...props()} />);
    await until(() => (lastFrame() ?? "").includes("How is the model configured?"));
    await press(stdin, ENTER); // source: inline
    rerender(<Model {...props()} />);
    await until(() => (lastFrame() ?? "").includes("endpoint"));
    await press(stdin, ENTER); // accept default URL
    rerender(<Model {...props()} />);
    await until(() => (lastFrame() ?? "").includes("API key"));
    // wipe the default "1234" draft first so the masked-length assertion below
    // is exact, not just "contains a bullet somewhere".
    for (let i = 0; i < "1234".length; i++) {
      await press(stdin, BACKSPACE);
      rerender(<Model {...props()} />);
    }
    stdin.write("sk-secret");
    await tick();
    rerender(<Model {...props()} />);
    await until(() => (lastFrame() ?? "").includes("•"));
    expect(lastFrame()).toContain("•".repeat("sk-secret".length));
    expect(lastFrame()).not.toContain("sk-secret");
  });

  it("key step (rerun): starts empty, never shows the stored key, empty submit keeps it", async () => {
    const raw = { model: { id: "p/m", baseUrl: "http://h:1/v1", apiKey: "stored-key" } };
    let answers = answersFromConfig(raw);
    let discoverArgs: [string, string] | null = null;
    const io = fakeIo({
      mode: "rerun",
      currentRaw: raw,
      discoverModels: async (baseUrl, apiKey) => {
        discoverArgs = [baseUrl, apiKey];
        return ["m1"];
      },
    });
    const props = () => ({
      ...noopChapter,
      answers,
      patch: (p: Partial<typeof answers>) => {
        answers = { ...answers, ...p };
      },
      io,
      onNext: () => {},
    });
    const { lastFrame, stdin, rerender } = render(<Model {...props()} />);
    await until(() => (lastFrame() ?? "").includes("How is the model configured?"));
    await press(stdin, ENTER); // source: inline (preselected from answersFromConfig)
    rerender(<Model {...props()} />);
    await until(() => (lastFrame() ?? "").includes("endpoint"));
    await press(stdin, ENTER); // url unchanged
    rerender(<Model {...props()} />);
    await until(() => (lastFrame() ?? "").includes("API key"));
    expect(lastFrame()).toContain("unchanged — enter keeps the current key");
    expect(lastFrame()).not.toContain("stored-key");
    await press(stdin, ENTER); // empty submit → keep the stored key
    rerender(<Model {...props()} />);
    await until(() => discoverArgs !== null);
    expect(discoverArgs).toEqual(["http://h:1/v1", "stored-key"]);
    expect(answers.apiKey).toBe("stored-key");
    expect(lastFrame()).not.toContain("stored-key");
  });

  it("key step (rerun, replace): typing a new key patches answers.apiKey", async () => {
    const raw = { model: { id: "p/m", baseUrl: "http://h:1/v1", apiKey: "stored-key" } };
    let answers = answersFromConfig(raw);
    const io = fakeIo({ mode: "rerun", currentRaw: raw, discoverModels: async () => ["m1"] });
    const props = () => ({
      ...noopChapter,
      answers,
      patch: (p: Partial<typeof answers>) => {
        answers = { ...answers, ...p };
      },
      io,
      onNext: () => {},
    });
    const { lastFrame, stdin, rerender } = render(<Model {...props()} />);
    await until(() => (lastFrame() ?? "").includes("How is the model configured?"));
    await press(stdin, ENTER); // source: inline
    rerender(<Model {...props()} />);
    await until(() => (lastFrame() ?? "").includes("endpoint"));
    await press(stdin, ENTER); // url unchanged
    rerender(<Model {...props()} />);
    await until(() => (lastFrame() ?? "").includes("API key"));
    stdin.write("new-key");
    await tick();
    rerender(<Model {...props()} />);
    await press(stdin, ENTER);
    await until(() => answers.apiKey === "new-key");
    expect(answers.apiKey).toBe("new-key");
  });

  it("models_json path lists file entries", async () => {
    let answers = defaultAnswers();
    let advanced = false;
    const io = fakeIo({ listModelsJson: () => ["prov/m1", "prov/m2"] });
    const props = () => ({
      ...noopChapter,
      answers,
      patch: (p: Partial<typeof answers>) => {
        answers = { ...answers, ...p };
      },
      io,
      onNext: () => {
        advanced = true;
      },
    });
    const { lastFrame, stdin, rerender } = render(<Model {...props()} />);
    await until(() => (lastFrame() ?? "").includes("How is the model configured?"));
    await press(stdin, DOWN, DOWN, ENTER); // third option: models.json (after inline, hosted)
    rerender(<Model {...props()} />);
    await until(() => (lastFrame() ?? "").includes("models.json"));
    await press(stdin, ENTER); // accept default path
    rerender(<Model {...props()} />);
    await until(() => (lastFrame() ?? "").includes("prov/m1"));
    await press(stdin, ENTER);
    await until(() => advanced);
    expect(answers.mode).toBe("models_json");
    expect(answers.modelId).toBe("prov/m1");
  });

  it("hosted chain: source → provider → model → key → finish, verbatim provider/id (no inferProvider)", async () => {
    let answers = defaultAnswers();
    let advanced = false;
    const io = fakeIo();
    const props = () => ({
      ...noopChapter,
      answers,
      patch: (p: Partial<typeof answers>) => {
        answers = { ...answers, ...p };
      },
      io,
      onNext: () => {
        advanced = true;
      },
    });
    const { lastFrame, stdin, rerender } = render(<Model {...props()} />);
    await until(() => (lastFrame() ?? "").includes("How is the model configured?"));
    await press(stdin, DOWN, ENTER); // second option: hosted
    rerender(<Model {...props()} />);
    await until(() => (lastFrame() ?? "").includes("Which hosted provider?"));
    // catalog is [{acme}, {globex}] (alphabetical) — DOWN picks the second, globex
    await press(stdin, DOWN, ENTER);
    rerender(<Model {...props()} />);
    await until(() => (lastFrame() ?? "").includes("Which globex model?"));
    await press(stdin, ENTER); // globex's only id: "fast"
    rerender(<Model {...props()} />);
    await until(() => (lastFrame() ?? "").includes("API key for globex?"));
    // No backspacing: switching into hosted must already have blanked the
    // inline-placeholder "1234" draft (regression proof for the fix — a
    // paste here must land exactly, never append onto a stale draft).
    stdin.write("sk-hosted");
    await tick();
    rerender(<Model {...props()} />);
    await press(stdin, ENTER);
    await until(() => advanced);
    expect(answers.mode).toBe("hosted");
    expect(answers.modelId).toBe("globex/fast"); // verbatim provider/id, no inferProvider
    expect(answers.apiKey).toBe("sk-hosted");
  });

  it("hosted chain: blank key submit leaves answers.apiKey unset (env-var deferral)", async () => {
    let answers = defaultAnswers();
    let advanced = false;
    const io = fakeIo();
    const props = () => ({
      ...noopChapter,
      answers,
      patch: (p: Partial<typeof answers>) => {
        answers = { ...answers, ...p };
      },
      io,
      onNext: () => {
        advanced = true;
      },
    });
    const { lastFrame, stdin, rerender } = render(<Model {...props()} />);
    await until(() => (lastFrame() ?? "").includes("How is the model configured?"));
    await press(stdin, DOWN, ENTER); // hosted
    rerender(<Model {...props()} />);
    await until(() => (lastFrame() ?? "").includes("Which hosted provider?"));
    await press(stdin, ENTER); // first provider: acme
    rerender(<Model {...props()} />);
    await until(() => (lastFrame() ?? "").includes("Which acme model?"));
    await press(stdin, ENTER); // acme's first id: "big"
    rerender(<Model {...props()} />);
    await until(() => (lastFrame() ?? "").includes("API key for acme?"));
    // No backspacing: the draft must already be blank on arrival (regression
    // proof) — a bare enter-through must leave answers.apiKey unset, not
    // silently write the inline-placeholder "1234" into a hosted config.
    expect(lastFrame()).toContain("blank = provider's own env var at runtime");
    await press(stdin, ENTER); // blank submit
    await until(() => advanced);
    expect(answers.modelId).toBe("acme/big");
    expect(answers.apiKey).toBeUndefined();
  });

  it("hosted chain: catalog-load failure shows a friendly message and routes back to source", async () => {
    let answers = defaultAnswers();
    const io = fakeIo({
      listCatalogProviders: async () => {
        throw new Error("boom");
      },
    });
    const props = () => ({
      ...noopChapter,
      answers,
      patch: (p: Partial<typeof answers>) => {
        answers = { ...answers, ...p };
      },
      io,
      onNext: () => {},
    });
    const { lastFrame, stdin, rerender } = render(<Model {...props()} />);
    await until(() => (lastFrame() ?? "").includes("How is the model configured?"));
    await press(stdin, DOWN, ENTER); // hosted
    rerender(<Model {...props()} />);
    await until(() => (lastFrame() ?? "").includes("Couldn't load the hosted-provider catalog"));
    expect(lastFrame()).toContain("boom");
    // Back on the source step, not crashed and not stuck on a spinner.
    expect(lastFrame()).toContain("How is the model configured?");
    expect(lastFrame()).toContain("Inline — an OpenAI-compatible endpoint");
  });

  it('rerun over a hosted config preselects "hosted" at the source step (continuity fix)', async () => {
    const raw = { model: { id: "anthropic/claude-fancy" } }; // no baseUrl, no modelsJson → mode "hosted"
    let answers = answersFromConfig(raw);
    expect(answers.mode).toBe("hosted"); // sanity check on Task 9's answersFromConfig
    const io = fakeIo({ mode: "rerun", currentRaw: raw });
    const props = () => ({
      ...noopChapter,
      answers,
      patch: (p: Partial<typeof answers>) => {
        answers = { ...answers, ...p };
      },
      io,
      onNext: () => {},
    });
    const { lastFrame, stdin, rerender } = render(<Model {...props()} />);
    await until(() => (lastFrame() ?? "").includes("How is the model configured?"));
    // Bare Enter, no DOWN: before the fix this defaulted to inline's index
    // and would land on the URL step instead.
    await press(stdin, ENTER);
    rerender(<Model {...props()} />);
    await until(() => (lastFrame() ?? "").includes("Which hosted provider?"));
    expect(answers.mode).toBe("hosted");
  });
});

describe("RepoSafety chapter", () => {
  it("adds roots until an empty submit advances", async () => {
    let answers = defaultAnswers();
    let advanced = false;
    const props = () => ({
      ...noopChapter,
      answers,
      patch: (p: Partial<typeof answers>) => {
        answers = { ...answers, ...p };
      },
      io: fakeIo(),
      onNext: () => {
        advanced = true;
      },
    });
    const { lastFrame, stdin, rerender } = render(<RepoSafety {...props()} />);
    await until(() => (lastFrame() ?? "").includes("Which folders"));
    stdin.write("/code");
    await tick();
    rerender(<RepoSafety {...props()} />);
    await press(stdin, ENTER); // add /code
    rerender(<RepoSafety {...props()} />);
    await until(() => (lastFrame() ?? "").includes("✓ /code"));
    await press(stdin, ENTER); // empty → advance
    await until(() => advanced);
    expect(answers.repoRoots).toEqual(["/code"]);
    expect(lastFrame()).toContain("never commits to your branches");
  });

  it("adding the same root twice results in one entry", async () => {
    let answers = defaultAnswers();
    let advanced = false;
    const props = () => ({
      ...noopChapter,
      answers,
      patch: (p: Partial<typeof answers>) => {
        answers = { ...answers, ...p };
      },
      io: fakeIo(),
      onNext: () => {
        advanced = true;
      },
    });
    const { lastFrame, stdin, rerender } = render(<RepoSafety {...props()} />);
    await until(() => (lastFrame() ?? "").includes("Which folders"));
    stdin.write("/code");
    await tick();
    rerender(<RepoSafety {...props()} />);
    await press(stdin, ENTER); // add /code
    rerender(<RepoSafety {...props()} />);
    await until(() => (lastFrame() ?? "").includes("✓ /code"));
    stdin.write("/code");
    await tick();
    rerender(<RepoSafety {...props()} />);
    await press(stdin, ENTER); // add /code again — duplicate, ignored
    rerender(<RepoSafety {...props()} />);
    await press(stdin, ENTER); // empty → advance
    await until(() => advanced);
    expect(answers.repoRoots).toEqual(["/code"]);
  });
});

describe("Github chapter", () => {
  it("Off (default) advances immediately", async () => {
    let answers = defaultAnswers();
    let advanced = false;
    const { lastFrame, stdin } = render(
      <Github
        {...noopChapter}
        answers={answers}
        patch={(p) => {
          answers = { ...answers, ...p };
        }}
        io={fakeIo()}
        onNext={() => {
          advanced = true;
        }}
      />,
    );
    await until(() => (lastFrame() ?? "").includes("GitHub bridge"));
    expect(lastFrame()).toContain("zero gh calls");
    await press(stdin, ENTER); // "Off" is first/default
    await until(() => advanced);
    expect(answers.github.enabled).toBe(false);
  });

  it("On collects repos then the approval toggle", async () => {
    let answers = defaultAnswers();
    let advanced = false;
    const props = () => ({
      ...noopChapter,
      answers,
      patch: (p: Partial<typeof answers>) => {
        answers = { ...answers, ...p };
      },
      io: fakeIo(),
      onNext: () => {
        advanced = true;
      },
    });
    const { lastFrame, stdin, rerender } = render(<Github {...props()} />);
    await until(() => (lastFrame() ?? "").includes("GitHub bridge"));
    await press(stdin, DOWN, ENTER); // On
    rerender(<Github {...props()} />);
    await until(() => (lastFrame() ?? "").includes("owner/repo"));
    stdin.write("acme/api");
    await tick();
    rerender(<Github {...props()} />);
    await press(stdin, ENTER);
    rerender(<Github {...props()} />);
    await until(() => (lastFrame() ?? "").includes("local clone path"));
    stdin.write("/tmp/acme");
    await tick();
    rerender(<Github {...props()} />);
    await press(stdin, ENTER);
    rerender(<Github {...props()} />);
    await press(stdin, ENTER); // empty nwo → done adding
    rerender(<Github {...props()} />);
    await until(() => (lastFrame() ?? "").includes("approval"));
    await press(stdin, ENTER); // keep approval required (default)
    await until(() => advanced);
    expect(answers.github).toEqual({
      enabled: true,
      repos: [{ nwo: "acme/api", path: "/tmp/acme" }],
      requireApproval: true,
    });
  });

  it("persists an added repo to answers immediately, before the approval step submits", async () => {
    // The upcoming WizardApp mounts one chapter at a time, so back
    // navigation unmounts Github between adds. A repo entry must survive
    // that unmount, which means it has to land in answers as soon as it's
    // completed — not only at the final approval submit.
    let answers = defaultAnswers();
    const props = () => ({
      ...noopChapter,
      answers,
      patch: (p: Partial<typeof answers>) => {
        answers = { ...answers, ...p };
      },
      io: fakeIo(),
      onNext: () => {},
    });
    const { lastFrame, stdin, rerender } = render(<Github {...props()} />);
    await until(() => (lastFrame() ?? "").includes("GitHub bridge"));
    await press(stdin, DOWN, ENTER); // On
    rerender(<Github {...props()} />);
    await until(() => (lastFrame() ?? "").includes("owner/repo"));
    stdin.write("acme/api");
    await tick();
    rerender(<Github {...props()} />);
    await press(stdin, ENTER);
    rerender(<Github {...props()} />);
    await until(() => (lastFrame() ?? "").includes("local clone path"));
    stdin.write("/tmp/acme");
    await tick();
    rerender(<Github {...props()} />);
    await press(stdin, ENTER);
    rerender(<Github {...props()} />);
    // Still mid-flow (back on the nwo step, prompting for another repo) —
    // the approval Select hasn't been reached, let alone submitted.
    await until(() => (lastFrame() ?? "").includes("owner/repo"));
    expect(answers.github.repos).toEqual([{ nwo: "acme/api", path: "/tmp/acme" }]);
  });

  it("adding the same nwo twice results in one entry", async () => {
    let answers = defaultAnswers();
    let advanced = false;
    const props = () => ({
      ...noopChapter,
      answers,
      patch: (p: Partial<typeof answers>) => {
        answers = { ...answers, ...p };
      },
      io: fakeIo(),
      onNext: () => {
        advanced = true;
      },
    });
    const { lastFrame, stdin, rerender } = render(<Github {...props()} />);
    await until(() => (lastFrame() ?? "").includes("GitHub bridge"));
    await press(stdin, DOWN, ENTER); // On
    rerender(<Github {...props()} />);
    // First entry: acme/api → /tmp/acme
    await until(() => (lastFrame() ?? "").includes("owner/repo"));
    stdin.write("acme/api");
    await tick();
    rerender(<Github {...props()} />);
    await press(stdin, ENTER);
    rerender(<Github {...props()} />);
    await until(() => (lastFrame() ?? "").includes("local clone path"));
    stdin.write("/tmp/acme");
    await tick();
    rerender(<Github {...props()} />);
    await press(stdin, ENTER);
    rerender(<Github {...props()} />);
    // Second entry: same nwo, different path
    await until(() => (lastFrame() ?? "").includes("owner/repo"));
    stdin.write("acme/api");
    await tick();
    rerender(<Github {...props()} />);
    await press(stdin, ENTER);
    rerender(<Github {...props()} />);
    await until(() => (lastFrame() ?? "").includes("local clone path"));
    stdin.write("/tmp/acme-updated");
    await tick();
    rerender(<Github {...props()} />);
    await press(stdin, ENTER);
    rerender(<Github {...props()} />);
    await press(stdin, ENTER); // empty nwo → done adding
    rerender(<Github {...props()} />);
    await until(() => (lastFrame() ?? "").includes("approval"));
    await press(stdin, ENTER);
    await until(() => advanced);
    expect(answers.github.repos).toEqual([{ nwo: "acme/api", path: "/tmp/acme-updated" }]);
  });
});

describe("Extras chapter", () => {
  it("pre-checks the recommended set, shows the focused description, unchecking persists", async () => {
    let answers = defaultAnswers();
    let advanced = false;
    const { lastFrame, stdin } = render(
      <Extras
        {...noopChapter}
        answers={answers}
        patch={(p) => {
          answers = { ...answers, ...p };
        }}
        io={fakeIo()}
        onNext={() => {
          advanced = true;
        }}
      />,
    );
    await until(() => (lastFrame() ?? "").includes("OS sandbox"));
    // focused row's LEVERS description shows below the list
    expect(lastFrame()).toContain("Wrap agent tool subprocesses");
    await press(stdin, SPACE); // uncheck sandbox (first row)
    await press(stdin, ENTER);
    await until(() => advanced);
    expect(answers.extras).toEqual({
      sandbox: false,
      verify: true,
      health: true,
      transcripts: true,
    });
  });
});

describe("Review chapter", () => {
  it("fresh mode shows the exact JSON and writes on confirm", async () => {
    let wrote = false;
    const { lastFrame, stdin } = render(
      <Review
        {...noopChapter}
        answers={defaultAnswers()}
        patch={() => {}}
        io={fakeIo()}
        onNext={() => {}}
        onWrite={() => {
          wrote = true;
        }}
        onCancel={() => {}}
      />,
    );
    await until(() => (lastFrame() ?? "").includes("This is the exact config.json"));
    expect(lastFrame()).toContain("junco config list");
    await press(stdin, ENTER); // "Write config" is the first option
    await until(() => wrote);
  });

  it("rerun mode shows a diff, or the untouched note when nothing changed", async () => {
    const raw = { dataDir: "/v", model: { id: "p/m", baseUrl: "http://h:1/v1", apiKey: "k" } };
    const changed = { ...answersFromConfig(raw), dataDir: "/v2" };
    const { lastFrame } = render(
      <Review
        {...noopChapter}
        answers={changed}
        patch={() => {}}
        io={fakeIo({ mode: "rerun", currentRaw: raw })}
        onNext={() => {}}
        onWrite={() => {}}
        onCancel={() => {}}
      />,
    );
    await until(() => (lastFrame() ?? "").includes("dataDir"));
    expect(lastFrame()).toContain("/v → /v2");

    const same = render(
      <Review
        {...noopChapter}
        answers={answersFromConfig(raw)}
        patch={() => {}}
        io={fakeIo({ mode: "rerun", currentRaw: raw })}
        onNext={() => {}}
        onWrite={() => {}}
        onCancel={() => {}}
      />,
    );
    await until(() => (same.lastFrame() ?? "").includes("Nothing changed"));
  });

  it("fresh mode: hosted config preview shows model.id verbatim, no baseUrl/modelsJson line", async () => {
    const answers = {
      ...defaultAnswers(),
      mode: "hosted" as const,
      modelId: "anthropic/claude-fancy",
      apiKey: undefined,
      baseUrl: undefined,
    };
    const { lastFrame } = render(
      <Review
        {...noopChapter}
        answers={answers}
        patch={() => {}}
        io={fakeIo()}
        onNext={() => {}}
        onWrite={() => {}}
        onCancel={() => {}}
      />,
    );
    await until(() => (lastFrame() ?? "").includes("This is the exact config.json"));
    expect(lastFrame()).toContain('"id": "anthropic/claude-fancy"');
    expect(lastFrame()).not.toContain("baseUrl");
    expect(lastFrame()).not.toContain("modelsJson");
  });

  it("fresh mode redacts model.apiKey in the JSON preview", async () => {
    const answers = { ...defaultAnswers(), apiKey: "sk-realkey" };
    const { lastFrame } = render(
      <Review
        {...noopChapter}
        answers={answers}
        patch={() => {}}
        io={fakeIo()}
        onNext={() => {}}
        onWrite={() => {}}
        onCancel={() => {}}
      />,
    );
    await until(() => (lastFrame() ?? "").includes("This is the exact config.json"));
    expect(lastFrame()).toContain("••••");
    expect(lastFrame()).not.toContain("sk-realkey");
  });

  it("rerun diff masks a changed model.apiKey (both sides)", async () => {
    const raw = {
      vaultRoot: "/v",
      model: { id: "p/m", baseUrl: "http://h:1/v1", apiKey: "old-key" },
    };
    const changed = { ...answersFromConfig(raw), apiKey: "new-key" };
    const { lastFrame } = render(
      <Review
        {...noopChapter}
        answers={changed}
        patch={() => {}}
        io={fakeIo({ mode: "rerun", currentRaw: raw })}
        onNext={() => {}}
        onWrite={() => {}}
        onCancel={() => {}}
      />,
    );
    await until(() => (lastFrame() ?? "").includes("model.apiKey"));
    expect(lastFrame()).toContain("•••• → ••••");
    expect(lastFrame()).not.toContain("old-key");
    expect(lastFrame()).not.toContain("new-key");
  });
});

describe("Finale", () => {
  it("shows write receipts, flight-check results, staged next steps, sign-off", async () => {
    let done = false;
    const io = fakeIo({
      flightCheck: async () => [
        { verdict: "ok", label: "inference endpoint", detail: "http://h:1/v1" },
      ],
    });
    const { lastFrame, stdin } = render(
      <Finale
        result={{ written: true, configPath: "/tmp/c.json", queueRoot: "/tmp/q", changes: [] }}
        io={io}
        onDone={() => {
          done = true;
        }}
        revealMs={0}
      />,
    );
    await until(() => (lastFrame() ?? "").includes("✓ Wrote config"));
    await until(() => (lastFrame() ?? "").includes("inference endpoint"));
    await until(() => (lastFrame() ?? "").includes("junco start"));
    await until(() => (lastFrame() ?? "").includes("The nest is ready"));
    await press(stdin, ENTER);
    await until(() => done);
  });

  it("zero-diff rerun says the config was untouched", async () => {
    const { lastFrame } = render(
      <Finale
        result={{ written: false, configPath: "/tmp/c.json", queueRoot: "/tmp/q", changes: [] }}
        io={fakeIo()}
        onDone={() => {}}
        revealMs={0}
      />,
    );
    await until(() => (lastFrame() ?? "").includes("Config untouched"));
  });

  it("clicking the body finishes once revealed (enter parity)", async () => {
    const onDone = vi.fn();
    const r = render(
      <MouseProvider>
        <Finale
          result={{ written: true, configPath: "/tmp/c.json", queueRoot: "/tmp/q", changes: [] }}
          io={fakeIo()}
          onDone={onDone}
          revealMs={0}
        />
      </MouseProvider>,
    );
    // Wait for the signoff line (flight check resolved + steps revealed).
    await until(() => (r.lastFrame() ?? "").includes("enter to finish"));
    r.stdin.write(mousePress(2, 1));
    await until(() => onDone.mock.calls.length === 1);
  });
});

describe("useSuspend", () => {
  it("under a fake non-TTY stdout, writes no mouse/alt-screen escapes and still runs+returns the wrapped fn", async () => {
    let result: string | null = null;
    function Probe(): React.JSX.Element {
      const suspend = useSuspend();
      React.useEffect(() => {
        void suspend(async () => "done").then((v) => {
          result = v;
        });
      }, []);
      return <Text>probe</Text>;
    }
    const { lastFrame, frames } = render(<Probe />);
    await until(() => result !== null);
    expect(result).toBe("done");
    expect(lastFrame()).toContain("probe");
    // ink-testing-library's fake stdout has no isTTY (Boolean(undefined) ===
    // false), so the TTY-gated branch must never write — a raw write() there
    // is indistinguishable from a real frame and would clobber lastFrame().
    const written = frames.join("\n");
    expect(written).not.toContain("\x1b[?1000"); // MOUSE_ENABLE/MOUSE_DISABLE share this prefix
    expect(written).not.toContain("\x1b[?1049"); // ALT_SCREEN_ENTER/LEAVE share this prefix
  });

  it("SuspendProvider: frame is blank while the wrapped fn runs, restored after, state kept", async () => {
    let frameDuring: string | null = null;
    let getFrame: () => string | undefined = () => undefined;
    let done = false;
    function Probe(): React.JSX.Element {
      const suspend = useSuspend();
      const [label] = React.useState("probe-42"); // must survive the suspension
      React.useEffect(() => {
        void suspend(async () => {
          frameDuring = getFrame() ?? "<unrendered>";
          return 0;
        }).then(() => {
          done = true;
        });
      }, []);
      return <Text>{label}</Text>;
    }
    const { lastFrame } = render(
      <SuspendProvider>
        <Probe />
      </SuspendProvider>,
    );
    getFrame = lastFrame;
    await until(() => done);
    // The commit that blanks the UI must land BEFORE the child runs…
    expect(frameDuring).toBe("");
    // …and the tree must re-render (not remount) afterwards, state intact.
    await until(() => (lastFrame() ?? "").includes("probe-42"));
  });

  it("Account under SuspendProvider: login blanks the wizard, then re-detects without resetting", async () => {
    let frameDuring: string | null = null;
    let getFrame: () => string | undefined = () => undefined;
    let loggedIn = false;
    const io = fakeIo({
      detectBotLogin: async () => (loggedIn ? "junco-agent" : null),
      runGhLogin: async () => {
        frameDuring = getFrame() ?? "<unrendered>";
        loggedIn = true;
        return 0;
      },
    });
    const { lastFrame, stdin } = render(
      <SuspendProvider>
        <Account {...noopChapter} answers={defaultAnswers()} io={io} onNext={() => {}} />
      </SuspendProvider>,
    );
    getFrame = lastFrame;
    await until(() => (lastFrame() ?? "").includes("Who should junco act as"));
    await fireUntil(stdin, DOWN + ENTER, () => (lastFrame() ?? "").includes("Log in now"));
    await fireUntil(stdin, ENTER, () => (lastFrame() ?? "").includes("acting as junco-agent"), 200);
    // gh owned the terminal alone: no wizard frame was painted while it ran.
    expect(frameDuring).toBe("");
  });
});

describe("Account chapter", () => {
  it("default choice keeps ambient identity and advances", async () => {
    let answers = defaultAnswers();
    let advanced = false;
    const { lastFrame, stdin } = render(
      <Account
        {...noopChapter}
        answers={answers}
        patch={(p) => {
          answers = { ...answers, ...p };
        }}
        io={fakeIo()}
        onNext={() => {
          advanced = true;
        }}
      />,
    );
    await until(() => (lastFrame() ?? "").includes("Who should junco act as"));
    expect(lastFrame()).toContain("Your gh login");
    // fireUntil, not press: every input in this describe follows a mount or
    // view swap, and a one-shot keystroke can land in the window before the
    // new view's useInput attaches (see fireUntil's doc) — this exact class
    // flaked the 2026-07-16 macos merge gates (#191 configView, #194 here).
    await fireUntil(stdin, ENTER, () => advanced); // "Your gh login" is first/default
    expect(answers.botAccount).toBe(false);
  });

  it("bot choice with an existing login shows acting-as, then Continue advances", async () => {
    let answers = defaultAnswers();
    let advanced = false;
    const { lastFrame, stdin } = render(
      <Account
        {...noopChapter}
        answers={answers}
        patch={(p) => {
          answers = { ...answers, ...p };
        }}
        io={fakeIo({ detectBotLogin: async () => "junco-agent" })}
        onNext={() => {
          advanced = true;
        }}
      />,
    );
    await until(() => (lastFrame() ?? "").includes("Who should junco act as"));
    // DOWN+ENTER as ONE chunk: the parser splits at the escape boundary and
    // Select's idxRef handles both events in-order (pinned by the one-chunk
    // tests above), so the pair can't half-land — it either lands or drops
    // whole, which is what makes the re-send safe.
    await fireUntil(stdin, DOWN + ENTER, () =>
      (lastFrame() ?? "").includes("acting as junco-agent"),
    ); // "A dedicated bot account"
    expect(answers.botAccount).toBe(true);
    await fireUntil(stdin, ENTER, () => advanced); // Continue
  });

  it("bot choice without a login offers Log in now / Skip; Skip patches botAccount:true and advances", async () => {
    let answers = defaultAnswers();
    let advanced = false;
    const { lastFrame, stdin } = render(
      <Account
        {...noopChapter}
        answers={answers}
        patch={(p) => {
          answers = { ...answers, ...p };
        }}
        io={fakeIo({ detectBotLogin: async () => null })}
        onNext={() => {
          advanced = true;
        }}
      />,
    );
    await until(() => (lastFrame() ?? "").includes("Who should junco act as"));
    await fireUntil(stdin, DOWN + ENTER, () => (lastFrame() ?? "").includes("Log in now")); // "A dedicated bot account"
    expect(lastFrame()).toContain("Skip");
    await fireUntil(stdin, DOWN + ENTER, () => advanced); // Skip
    expect(answers.botAccount).toBe(true);
  });

  it("Log in now runs io.runGhLogin then re-detects", async () => {
    let loggedIn = false;
    const io = fakeIo({
      detectBotLogin: async () => (loggedIn ? "junco-agent" : null),
      runGhLogin: async () => {
        loggedIn = true;
        return 0;
      },
    });
    const { lastFrame, stdin } = render(
      <Account {...noopChapter} answers={defaultAnswers()} io={io} onNext={() => {}} />,
    );
    await until(() => (lastFrame() ?? "").includes("Who should junco act as"));
    await fireUntil(stdin, DOWN + ENTER, () => (lastFrame() ?? "").includes("Log in now")); // "A dedicated bot account"
    // Re-sent ENTER is idempotent here: a second "Log in now" just re-runs the
    // fake login (loggedIn stays true) and re-detects — still converges.
    await fireUntil(stdin, ENTER, () => (lastFrame() ?? "").includes("acting as junco-agent"), 200); // "Log in now" is first/default
  });
});
