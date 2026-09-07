import { describe, it, expect } from "vitest";
import { parseBlocks } from "../src/tui/markdown/blocks.js";
import { createMdCache, renderMarkdown, type MdCache } from "../src/tui/markdown/render.js";
import type { TranscriptRow } from "../src/transcriptRender.js";

const texts = (rows: TranscriptRow[]): string[] => rows.map((r) => r.text);
const W = 40;

// A document touching every block type once; the open-tail suite streams it
// character by character.
const DOC = [
  "# Title",
  "",
  "Intro paragraph with **bold**, _italic_ and `code`.",
  "",
  "- one",
  "- two",
  "  - nested",
  "1. first",
  "2. second",
  "",
  "> quoted",
  "> more",
  "",
  "```ts",
  "const x = 1;",
  "```",
  "",
  "---",
  "",
  "Final words.",
  "",
].join("\n");

describe("parseBlocks", () => {
  it("splits a document into blocks and leaves the last one open", () => {
    const { closed, open } = parseBlocks("# H\n\npara one\nstill one\n\npara two");
    expect(closed.map((b) => b.kind)).toEqual(["heading", "paragraph"]);
    expect(closed[1]).toMatchObject({ kind: "paragraph", text: "para one still one" });
    expect(open).toMatchObject({ kind: "paragraph", text: "para two" });
  });

  it("closes the last block when the text ends with a blank line", () => {
    const { closed, open } = parseBlocks("para\n\n");
    expect(closed).toHaveLength(1);
    expect(open).toBeNull();
  });

  it("returns nothing for empty or whitespace-only text", () => {
    expect(parseBlocks("")).toEqual({ closed: [], open: null });
    expect(parseBlocks("  \n \n")).toEqual({ closed: [], open: null });
  });

  it("parses headings 1–3 and treats deeper ones as paragraphs", () => {
    const { closed } = parseBlocks("# a\n\n## b\n\n### c\n\n#### d\n\n");
    expect(closed.map((b) => b.kind)).toEqual(["heading", "heading", "heading", "paragraph"]);
    expect(closed[0]).toMatchObject({ level: 1, text: "a" });
    expect(closed[1]).toMatchObject({ level: 2, text: "b" });
    expect(closed[2]).toMatchObject({ level: 3, text: "c" });
    expect(closed[3]).toMatchObject({ text: "#### d" });
  });

  it("parses bullet and numbered lists with one nested level", () => {
    const { open } = parseBlocks("- one\n- two\n  - nested a\n  - nested b\n- three");
    expect(open).toMatchObject({
      kind: "list",
      ordered: false,
      items: [
        { text: "one", children: [] },
        { text: "two", children: [{ text: "nested a" }, { text: "nested b" }] },
        { text: "three", children: [] },
      ],
    });
    const ordered = parseBlocks("1. first\n2. second\n   1. inner\n");
    expect(ordered.open).toMatchObject({
      kind: "list",
      ordered: true,
      start: 1,
      items: [
        { text: "first", children: [] },
        { text: "second", children: [{ text: "inner", ordered: true }] },
      ],
    });
  });

  it("starts a new list when the marker family changes", () => {
    const { closed, open } = parseBlocks("- a\n- b\n1. c");
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({ kind: "list", ordered: false });
    expect(open).toMatchObject({ kind: "list", ordered: true, items: [{ text: "c" }] });
  });

  it("parses a blockquote, joining lines and keeping paragraph breaks", () => {
    const { open } = parseBlocks("> one\n> two\n>\n> three");
    expect(open).toMatchObject({ kind: "quote", text: "one two\nthree" });
  });

  it("parses a fence with and without a language", () => {
    const withLang = parseBlocks("```ts\nconst x = 1;\n```\n");
    expect(withLang.closed[0]).toMatchObject({
      kind: "fence",
      lang: "ts",
      lines: ["const x = 1;"],
      closed: true,
    });
    expect(withLang.open).toBeNull();
    const bare = parseBlocks("```\nplain\n\nmore\n```\n");
    expect(bare.closed[0]).toMatchObject({
      kind: "fence",
      lang: null,
      lines: ["plain", "", "more"],
      closed: true,
    });
  });

  it("keeps an unclosed fence open and does not parse markdown inside it", () => {
    const { closed, open } = parseBlocks("```\n# not a heading\n- not a list");
    expect(closed).toEqual([]);
    expect(open).toMatchObject({
      kind: "fence",
      closed: false,
      lines: ["# not a heading", "- not a list"],
    });
  });

  it("parses a horizontal rule", () => {
    const { closed } = parseBlocks("---\n\n* * *\n\n");
    expect(closed.map((b) => b.kind)).toEqual(["rule", "rule"]);
  });

  it("keeps a table's lines verbatim", () => {
    const { open } = parseBlocks("| a | b |\n|---|---|\n| 1 | 2 |");
    expect(open).toMatchObject({
      kind: "table",
      lines: ["| a | b |", "|---|---|", "| 1 | 2 |"],
    });
  });

  it("lets headings, fences, quotes and lists interrupt a paragraph", () => {
    const { closed, open } = parseBlocks("text\n# h\ntext\n- item\ntext\n> q\ntext\n```\ncode");
    expect(closed.map((b) => b.kind)).toEqual([
      "paragraph",
      "heading",
      "paragraph",
      "list",
      "paragraph",
      "quote",
      "paragraph",
    ]);
    expect(open?.kind).toBe("fence");
  });
});

describe("renderMarkdown blocks", () => {
  it("renders a paragraph wrapped at the width", () => {
    const rows = renderMarkdown("one two three four five six seven eight nine ten", { width: 20 });
    expect(rows.length).toBeGreaterThan(1);
    for (const r of rows) expect(r.text.length).toBeLessThanOrEqual(20);
    expect(rows.map((r) => r.tone)).toEqual(rows.map(() => undefined));
  });

  it("renders headings bold with the # stripped", () => {
    const rows = renderMarkdown("# One\n\n## Two\n\n### Three", { width: W });
    expect(rows.filter((r) => r.text !== "")).toEqual([
      { text: "One", tone: "bold" },
      { text: "Two", tone: "bold" },
      { text: "Three", tone: "bold" },
    ]);
  });

  it("renders bullet and numbered lists with markers and a hanging indent", () => {
    const rows = renderMarkdown(
      "- short\n- a much longer item that must wrap around\n  - nested child\n\n1. first\n2. second",
      { width: 24 },
    );
    expect(texts(rows)).toEqual([
      "• short",
      "• a much longer item",
      "  that must wrap around",
      "  • nested child",
      "",
      "1. first",
      "2. second",
    ]);
  });

  it("renders a blockquote with a dim bar prefix", () => {
    const rows = renderMarkdown("> quoted text\n> continues", { width: W });
    expect(rows).toEqual([{ text: "│ quoted text continues", tone: "dim" }]);
  });

  it("renders a fence without a highlighter as its raw lines", () => {
    const rows = renderMarkdown("```\nconst x = 1;\n  indented\n```\n", { width: W });
    expect(texts(rows)).toEqual(["const x = 1;", "  indented"]);
  });

  it("renders a horizontal rule as a line of ─── once its line is complete", () => {
    // A partial "---" is still paragraph text (it could become "---a").
    expect(texts(renderMarkdown("---", { width: W }))).toEqual(["---"]);
    const rows = renderMarkdown("---\n", { width: W });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.text).toMatch(/^───+$/);
    expect(rows[0]?.text.length).toBeLessThanOrEqual(W);
  });

  it("renders a table as preformatted lines", () => {
    const rows = renderMarkdown("| a | b |\n|---|---|\n| 1 | 2 |", { width: W });
    expect(texts(rows)).toEqual(["| a | b |", "|---|---|", "| 1 | 2 |"]);
  });

  it("separates blocks with one blank row and never leads with one", () => {
    const rows = renderMarkdown("# H\n\npara\n\n- item", { width: W });
    expect(texts(rows)).toEqual(["H", "", "para", "", "• item"]);
  });

  it("renders nothing for empty text", () => {
    expect(renderMarkdown("", { width: W })).toEqual([]);
  });
});

describe("renderMarkdown inline", () => {
  it("strips emphasis markers and renders the text plain", () => {
    const rows = renderMarkdown("some **bold** and *em* and _under_ and ~~gone~~ words", {
      width: 80,
    });
    expect(texts(rows)).toEqual(["some bold and em and under and gone words"]);
  });

  it("keeps inline code's backticks and its contents verbatim", () => {
    const rows = renderMarkdown("run `a*b*c` and `**x**` now", { width: 80 });
    expect(texts(rows)).toEqual(["run `a*b*c` and `**x**` now"]);
  });

  it("leaves snake_case identifiers and arithmetic alone", () => {
    const rows = renderMarkdown("use foo_bar_baz; 2 * 3 * 4", { width: 80 });
    expect(texts(rows)).toEqual(["use foo_bar_baz; 2 * 3 * 4"]);
  });

  it("renders a link as its text followed by the URL and records it on the row", () => {
    const rows = renderMarkdown("see [the docs](https://x.test/d) now", { width: 80 });
    expect(rows).toEqual([
      {
        text: "see the docs (https://x.test/d) now",
        links: [{ text: "the docs", url: "https://x.test/d" }],
      },
    ]);
  });

  it("records links on heading, list and quote rows, and only on the row carrying the text", () => {
    const rows = renderMarkdown(
      "# [H](https://h.test)\n\n- [a](https://a.test) and [b](https://b.test)\n\n> [q](https://q.test)\n\nplain",
      { width: 80 },
    );
    expect(rows).toEqual([
      { text: "H (https://h.test)", tone: "bold", links: [{ text: "H", url: "https://h.test" }] },
      { text: "" },
      {
        text: "• a (https://a.test) and b (https://b.test)",
        links: [
          { text: "a", url: "https://a.test" },
          { text: "b", url: "https://b.test" },
        ],
      },
      { text: "" },
      { text: "│ q (https://q.test)", tone: "dim", links: [{ text: "q", url: "https://q.test" }] },
      { text: "" },
      { text: "plain" },
    ]);
    // A bare url link (`[u](u)`) renders once and is still a link.
    expect(renderMarkdown("[https://x.test](https://x.test)", { width: 80 })).toEqual([
      { text: "https://x.test", links: [{ text: "https://x.test", url: "https://x.test" }] },
    ]);
  });

  it("applies inline handling inside headings, lists and quotes", () => {
    const rows = renderMarkdown("# **H**\n\n- *a*\n\n> _q_", { width: 80 });
    expect(texts(rows)).toEqual(["H", "", "• a", "", "│ q"]);
  });
});

describe("renderMarkdown fences and highlighting", () => {
  const ANSI = "[31m";
  const RESET = "[0m";

  it("passes the highlighter's ANSI lines through untouched and never wraps them", () => {
    const long = `${ANSI}${"x".repeat(200)}${RESET}`;
    const highlight = (code: string, lang: string | null): string[] => {
      expect(code).toBe("const x = 1;\nlet y;");
      expect(lang).toBe("ts");
      return [long, `${ANSI}second${RESET}`];
    };
    const rows = renderMarkdown("```ts\nconst x = 1;\nlet y;\n```\n", { width: 40, highlight });
    expect(texts(rows)).toEqual([long, `${ANSI}second${RESET}`]);
  });

  it("passes null as the language for a bare fence and falls back on a null result", () => {
    const seen: (string | null)[] = [];
    const highlight = (_code: string, lang: string | null): string[] | null => {
      seen.push(lang);
      return null;
    };
    const rows = renderMarkdown("```\nraw line\n```\n", { width: 40, highlight });
    expect(seen).toEqual([null]);
    expect(texts(rows)).toEqual(["raw line"]);
  });

  it("renders an unclosed fence as code from its opening line", () => {
    const highlight = (code: string): string[] =>
      code.split("\n").map((l) => `${ANSI}${l}${RESET}`);
    const rows = renderMarkdown("intro\n\n```py\nprint(1)\nprint(2)", { width: 40, highlight });
    expect(texts(rows)).toEqual([
      "intro",
      "",
      `${ANSI}print(1)${RESET}`,
      `${ANSI}print(2)${RESET}`,
    ]);
  });

  it("renders no rows for a fence with no lines yet", () => {
    expect(renderMarkdown("```ts", { width: 40 })).toEqual([]);
    expect(renderMarkdown("```ts\n", { width: 40 })).toEqual([]);
  });

  // F3 (#512): an OPEN fence is highlighted per line through a per-line cache
  // keyed on (lang, line text), so a streaming frame re-highlights only the
  // line still growing — O(1) calls per frame, however long the block. The
  // closing fence re-highlights the whole block once (multi-line context) and
  // the block cache keeps it.
  it("highlights an open fence per line, re-running only the line still growing", () => {
    const calls: string[] = [];
    const highlight = (code: string, lang: string | null): string[] => {
      calls.push(`${lang}:${code}`);
      return code.split("\n").map((l) => `<${l}>`);
    };
    const cache = createMdCache();
    // Distinct prefixes, so a partial line is never a stale hit from an
    // earlier line ("const a" / "const b" would share "c" … "const ").
    const lines = ["alpha();", "beta();", "gamma();"];
    let text = "```ts\n";
    for (const line of lines) {
      for (let i = 1; i <= line.length; i++) {
        calls.length = 0;
        const rows = renderMarkdown(`${text}${line.slice(0, i)}`, { width: W, cache, highlight });
        expect(calls).toEqual([`ts:${line.slice(0, i)}`]);
        expect(texts(rows).at(-1)).toBe(`<${line.slice(0, i)}>`);
      }
      text += `${line}\n`;
      calls.length = 0;
      const rows = renderMarkdown(text, { width: W, cache, highlight });
      expect(calls).toEqual([]);
      expect(texts(rows)).toEqual(lines.slice(0, lines.indexOf(line) + 1).map((l) => `<${l}>`));
    }
    calls.length = 0;
    const done = renderMarkdown(`${text}\`\`\`\n`, { width: W, cache, highlight });
    expect(calls).toEqual([`ts:${lines.join("\n")}`]);
    expect(texts(done)).toEqual(lines.map((l) => `<${l}>`));
    // The line cache is scoped to the open fence: gone once it closed.
    expect(cache.lines.size).toBe(0);
    calls.length = 0;
    renderMarkdown(`${text}\`\`\`\n`, { width: W, cache, highlight });
    expect(calls).toEqual([]);
  });

  it("falls back to the raw line when the per-line highlight declines or mis-shapes", () => {
    const highlight = (code: string, lang: string | null): string[] | null =>
      lang === "none" ? null : code === "two" ? ["a", "b"] : [`<${code}>`];
    expect(texts(renderMarkdown("```none\nraw", { width: W, highlight }))).toEqual(["raw"]);
    expect(texts(renderMarkdown("```x\ntwo\nok", { width: W, highlight }))).toEqual([
      "two",
      "<ok>",
    ]);
    // Without a cache the per-line path still renders the same rows.
    const cache = createMdCache();
    expect(renderMarkdown("```x\nok\nmore", { width: W, highlight, cache })).toEqual(
      renderMarkdown("```x\nok\nmore", { width: W, highlight }),
    );
  });
});

describe("renderMarkdown open-tail cache", () => {
  const closedRowsOf = (cache: MdCache): TranscriptRow[] => cache.entries.flatMap((e) => e.rows);

  it("reuses the SAME row objects for the closed prefix on every streaming step", () => {
    for (let i = 0; i <= DOC.length; i++) {
      const prefix = DOC.slice(0, i);
      const cache = createMdCache();
      const first = renderMarkdown(prefix, { width: W, cache });
      // The cache holds exactly the closed blocks, in order, and the render
      // starts with their rows.
      expect(cache.entries).toHaveLength(parseBlocks(prefix).closed.length);
      const closedRows = closedRowsOf(cache);
      expect(first.length).toBeGreaterThanOrEqual(closedRows.length);
      closedRows.forEach((row, j) => expect(first[j]).toBe(row));
      // A cached render matches an uncached one.
      expect(first).toEqual(renderMarkdown(prefix, { width: W }));
      // Rendering the full document through the same cache keeps the prefix's
      // closed rows as the same objects at the same positions.
      const full = renderMarkdown(DOC, { width: W, cache });
      closedRows.forEach((row, j) => expect(full[j]).toBe(row));
      expect(full).toEqual(renderMarkdown(DOC, { width: W }));
    }
  });

  it("never lets a closed block change under a streamed continuation", () => {
    // Each of these once tricked a line-based parser: the prefix classified a
    // partial line as a block start (closing the previous block), and the
    // completed line then continued the previous block instead.
    const cases = [
      "- a\n- b\n- c\n",
      "- a\n1. b\n",
      "text\n---\nmore\n",
      "text\n---\n\nmore\n",
      "- a\n* * *\n\nb\n",
      "- a\n  - b\n\n",
      "> a\n>b\n> c\n\n",
      "```\ncode\n```x\n```\n",
      "# h\n#\n## h2\n",
      "| a |\n|---|\n| 1 |\n\n",
      "para\n1.5 things\n1. list\n",
      DOC,
    ];
    for (const s of cases) {
      const full = renderMarkdown(s, { width: W });
      for (let i = 0; i <= s.length; i++) {
        const cache = createMdCache();
        renderMarkdown(s.slice(0, i), { width: W, cache });
        const closedRows = closedRowsOf(cache);
        expect(full.slice(0, closedRows.length), `${JSON.stringify(s)} @ ${i}`).toEqual(closedRows);
      }
    }
  });

  it("drops the cache when the width or the highlighter changes", () => {
    const cache = createMdCache();
    const a = renderMarkdown("para\n\nnext", { width: 40, cache });
    const b = renderMarkdown("para\n\nnext", { width: 30, cache });
    expect(b[0]).not.toBe(a[0]);
    expect(b[0]).toEqual(a[0]);
    const hl = (): string[] => ["hl"];
    const c = renderMarkdown("para\n\nnext", { width: 30, cache, highlight: hl });
    expect(c[0]).not.toBe(b[0]);
    const d = renderMarkdown("para\n\nnext", { width: 30, cache, highlight: hl });
    expect(d[0]).toBe(c[0]);
  });

  it("re-renders a closed block whose source changed at the same index", () => {
    const cache = createMdCache();
    const a = renderMarkdown("one\n\ntail", { width: 40, cache });
    const b = renderMarkdown("two\n\ntail", { width: 40, cache });
    expect(b[0]).not.toBe(a[0]);
    expect(texts(b)).toEqual(["two", "", "tail"]);
    expect(cache.entries).toHaveLength(1);
  });
});
