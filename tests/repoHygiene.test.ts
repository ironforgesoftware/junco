import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Repo-level policy files (#383). None of them is code, so nothing else in
// the suite would notice if one went missing or lost the line that matters —
// these checks pin the parts a reporter or contributor is meant to act on.
const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

describe("SECURITY.md", () => {
  const doc = read("SECURITY.md");

  it("states the support window as the latest minor line, without a version number to rot", () => {
    expect(doc).toContain("## Supported versions");
    expect(doc).toMatch(/latest minor/i);
    // Lookarounds keep the loopback address (127.0.0.1) from reading as a semver.
    expect(doc).not.toMatch(/(?<![\d.])\d+\.\d+\.\d+(?![\d.])/);
  });

  it("routes reports to this repo's private vulnerability reporting, never a public issue", () => {
    expect(doc).toContain("## Reporting a vulnerability");
    expect(doc).toContain("https://github.com/ironforgesoftware/junco/security/advisories/new");
    expect(doc).toMatch(/do not open a public issue/i);
  });

  it("commits to an acknowledgement within 72 hours", () => {
    expect(doc).toMatch(/72 hours/);
  });

  it("names the four in-scope boundaries", () => {
    expect(doc).toContain("## Scope");
    expect(doc).toMatch(/execution sandbox/i);
    expect(doc).toMatch(/approval chain/i);
    expect(doc).toMatch(/bot[- ]account/i);
    expect(doc).toMatch(/health endpoint/i);
  });
});

describe(".github/PULL_REQUEST_TEMPLATE.md", () => {
  const tpl = read(".github/PULL_REQUEST_TEMPLATE.md");

  it("carries the full gate command verbatim", () => {
    expect(tpl).toContain(
      "npm run lint && npm run format:check && npm run typecheck && npm run build && npm test",
    );
  });

  it("restates the no-AI-attribution rule", () => {
    expect(tpl).toContain("Co-Authored-By");
    expect(tpl).toMatch(/Generated with/);
  });

  it("reminds about the CHANGELOG entry and the conventional title", () => {
    expect(tpl).toContain("CHANGELOG.md");
    expect(tpl).toMatch(/conventional/i);
  });
});

describe(".editorconfig", () => {
  const ec = read(".editorconfig");

  it("is the root file with the shared defaults", () => {
    expect(ec).toMatch(/^root = true$/m);
    expect(ec).toMatch(/^indent_style = space$/m);
    expect(ec).toMatch(/^indent_size = 2$/m);
    expect(ec).toMatch(/^end_of_line = lf$/m);
    expect(ec).toMatch(/^charset = utf-8$/m);
    expect(ec).toMatch(/^insert_final_newline = true$/m);
    expect(ec).toMatch(/^trim_trailing_whitespace = true$/m);
  });

  it("keeps trailing spaces in Markdown (two spaces = hard line break)", () => {
    expect(ec).toMatch(/^\[\*\.md\]\ntrim_trailing_whitespace = false$/m);
  });

  it("does not set max_line_length, which prettier would honor over printWidth", () => {
    expect(ec).not.toMatch(/^\s*max_line_length/m);
  });
});

describe("eslint.config.js", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));

  const configFor = async (rel: string): Promise<Record<string, [number, ...unknown[]]>> => {
    const { ESLint } = await import("eslint");
    const cfg = await new ESLint({ cwd: root }).calculateConfigForFile(join(root, rel));
    return cfg.rules as Record<string, [number, ...unknown[]]>;
  };

  // #354: `any` in src/ is an enforced error, not a convention — the remaining
  // ones are SDK-boundary casts carrying an eslint-disable with a reason.
  it("enforces no-explicit-any on src/", async () => {
    const rules = await configFor("src/agent/guardManager.ts");
    expect(rules["@typescript-eslint/no-explicit-any"][0]).toBe(2);
  });

  // #361: a structural ceiling so the next 900-line function trips the gate.
  // The five already over it are pinned at their measured size, not exempted —
  // the rule stays on for those files, so each can shrink but not grow.
  describe("max-lines-per-function", () => {
    type Entry = { file: string; max: number; comment: string };

    /**
     * The `GRANDFATHERED_FUNCTION_LINES` table, read out of the config as text
     * rather than imported: `tsconfig.eslint.json` type-checks the tests but
     * sets no `allowJs`, so a TS test cannot import the `.js` config. Each
     * entry carries the comment lines that precede it.
     */
    const grandfathered = (): Entry[] => {
      const src = read("eslint.config.js");
      const table = /GRANDFATHERED_FUNCTION_LINES = \[\n([\s\S]*?)\n\];/.exec(src);
      if (!table) throw new Error("eslint.config.js has no GRANDFATHERED_FUNCTION_LINES table");
      const entries: Entry[] = [];
      let comment = "";
      for (const line of table[1].split("\n")) {
        const m = /\{ file: "([^"]+)", max: (\d+) \}/.exec(line);
        if (m) {
          entries.push({ file: m[1], max: Number(m[2]), comment });
          comment = "";
        } else comment += `${line}\n`;
      }
      return entries;
    };

    it("caps a src/ function at 400 lines of code", async () => {
      expect((await configFor("src/agent/guardManager.ts"))["max-lines-per-function"]).toEqual([
        2,
        { max: 400, skipComments: true, skipBlankLines: true, IIFEs: true },
      ]);
    });

    it("leaves tests/ uncapped — a `describe` body is a function too", async () => {
      expect(
        (await configFor("tests/repoHygiene.test.ts"))["max-lines-per-function"],
      ).toBeUndefined();
    });

    it("raises the cap for a grandfathered file instead of switching the rule off", async () => {
      const entries = grandfathered();
      expect(entries.length).toBeGreaterThan(0);
      for (const { file, max } of entries) {
        const rule = (await configFor(file))["max-lines-per-function"];
        expect(rule[0], `${file} must keep the rule at error`).toBe(2);
        expect(rule[1], `${file} must be pinned at its own size`).toMatchObject({ max });
        expect(max, `${file} would not need a pin under the ceiling`).toBeGreaterThan(400);
      }
    });

    it("names the follow-up that retires each pin", () => {
      for (const { file, comment } of grandfathered()) {
        expect(comment, `${file}'s pin must cite the issue that retires it`).toMatch(/#\d+/);
      }
    });

    // A ratchet on the ratchet: the list may only shrink. A sixth offender
    // means a function grew past 400 lines and someone exempted it instead.
    it("does not grow past the five offenders it was written for", () => {
      expect(grandfathered().length).toBeLessThanOrEqual(5);
    });
  });
});
