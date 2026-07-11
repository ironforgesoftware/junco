import { describe, it, expect, afterEach } from "vitest";
import React from "react";
import { render, cleanup } from "ink-testing-library";
import { until } from "./helpers/until.js";
import { Tip, ReceiptList, Select, MultiSelect } from "../src/tui/wizard/controls.js";
import { Welcome } from "../src/tui/wizard/chapters/Welcome.js";
import { Workspace } from "../src/tui/wizard/chapters/Workspace.js";
import { Model } from "../src/tui/wizard/chapters/Model.js";
import { RepoSafety } from "../src/tui/wizard/chapters/RepoSafety.js";
import { Github } from "../src/tui/wizard/chapters/Github.js";
import { Extras } from "../src/tui/wizard/chapters/Extras.js";
import { Review } from "../src/tui/wizard/chapters/Review.js";
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
    write: () => ({
      written: true,
      configPath: "/tmp/config.json",
      queueRoot: "/tmp/q",
      changes: [],
    }),
    flightCheck: async () => [],
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
  it("edits vaultRoot and advances on enter, refusing empty", async () => {
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
    for (let i = 0; i < "~/Junco".length; i++) {
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
    expect(answers.vaultRoot).toBe("/tmp/nest");
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
    await press(stdin, DOWN, ENTER); // second option: models.json
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
    for (let i = 0; i < 2; i++) {
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
    }
    await press(stdin, ENTER); // empty nwo → done adding
    rerender(<Github {...props()} />);
    await until(() => (lastFrame() ?? "").includes("approval"));
    await press(stdin, ENTER);
    await until(() => advanced);
    expect(answers.github.repos).toEqual([{ nwo: "acme/api", path: "/tmp/acme" }]);
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
    await until(() => (lastFrame() ?? "").includes('"vaultRoot"'));
    expect(lastFrame()).toContain("junco config list");
    await press(stdin, ENTER); // "Write config" is the first option
    await until(() => wrote);
  });

  it("rerun mode shows a diff, or the untouched note when nothing changed", async () => {
    const raw = { vaultRoot: "/v", model: { id: "p/m", baseUrl: "http://h:1/v1", apiKey: "k" } };
    const changed = { ...answersFromConfig(raw), vaultRoot: "/v2" };
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
    await until(() => (lastFrame() ?? "").includes("vaultRoot"));
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
});
