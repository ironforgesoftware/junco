/**
 * markdown/blocks — a line-based block parser for the chat answer (spec
 * 2026-09-06 §4.2, D5). Junco-owned, no dependency: the subset is paragraph,
 * heading 1–3, bullet/numbered list with one nested level, blockquote, fenced
 * code, horizontal rule, and a table kept as preformatted lines.
 *
 * The streaming contract is the whole point of the module. `closed` blocks are
 * final: no character appended to the text can change them, so render.ts
 * caches their rows by index. `open` is the single tail block that may still
 * grow. That is a stronger guarantee than "everything before the last blank
 * line": a block is closed as soon as a LATER block has started, which means
 * every rule below has to be prefix-stable — a partial last line must never
 * start a new block that its completion would fold back into the previous
 * one. Concretely:
 *
 * - The last line is `incomplete` unless the text ends with "\n". An
 *   incomplete line that is only a prefix of a continuation marker for the
 *   current block ("-" that could become "- item" under a list) is ignored
 *   for the frame rather than starting a paragraph that would close the list.
 * - Whitespace-only incomplete lines are ignored too (a blank line only
 *   terminates a block once it is complete: "- a\n  " must not close the
 *   list that "  - b" is about to continue).
 * - A rule is only recognised on a complete line ("---" could still become
 *   "---a", a paragraph line); a partial one is paragraph text.
 * - A closing fence line only closes the fence once complete ("```" could
 *   still become "```x", a code line); a partial one is left out of the
 *   fence's lines so the frame does not show a stray "```".
 * - Headings need the space after the hashes ("#" alone is text: it could
 *   still become "#x"), list markers need the space after the marker.
 * - Interrupters of a paragraph are exactly the line starts that stay
 *   interrupters under any completion: a fence opener, a heading, a quote,
 *   a list marker, a table pipe.
 *
 * tests/markdown.test.ts streams a document one character at a time and
 * checks that the closed rows never change — that suite is the proof.
 */

export interface MdListChild {
  ordered: boolean;
  text: string;
}

export interface MdListItem {
  text: string;
  children: MdListChild[];
}

export type MdBlock =
  | { kind: "paragraph"; text: string; source: string }
  | { kind: "heading"; level: 1 | 2 | 3; text: string; source: string }
  | { kind: "list"; ordered: boolean; start: number; items: MdListItem[]; source: string }
  | { kind: "quote"; text: string; source: string }
  | { kind: "fence"; lang: string | null; lines: string[]; closed: boolean; source: string }
  | { kind: "rule"; source: string }
  | { kind: "table"; lines: string[]; source: string };

export interface ParsedBlocks {
  closed: MdBlock[];
  open: MdBlock | null;
}

type Draft =
  | { kind: "paragraph"; raw: string[] }
  | { kind: "list"; ordered: boolean; start: number; items: MdListItem[]; raw: string[] }
  | { kind: "quote"; raw: string[] }
  | { kind: "fence"; lang: string | null; fenceLen: number; lines: string[]; raw: string[] }
  | { kind: "table"; raw: string[] };

const FENCE_OPEN = /^(`{3,})\s*([^`\s]*)/;
const HEADING = /^(#{1,3})[ \t](.*)$/;
const BULLET = /^([-*+])[ \t](.*)$/;
const ORDERED = /^(\d{1,9})[.)][ \t](.*)$/;
const RULE = /^([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
/** A partial line that could still complete into a list marker. */
const MARKER_PREFIX = /^(?:[-*+]|\d{1,9}[.)]?)$/;

const indentOf = (line: string): number => line.length - line.trimStart().length;
const isBlank = (line: string): boolean => line.trim() === "";

const finalize = (d: Draft): MdBlock => {
  const source = d.raw.join("\n");
  switch (d.kind) {
    case "paragraph":
      return { kind: "paragraph", text: d.raw.map((l) => l.trim()).join(" "), source };
    case "list":
      return { kind: "list", ordered: d.ordered, start: d.start, items: d.items, source };
    case "quote":
      return { kind: "quote", text: quoteText(d.raw), source };
    case "fence":
      return { kind: "fence", lang: d.lang, lines: d.lines, closed: false, source };
    case "table":
      return { kind: "table", lines: d.raw, source };
  }
};

/** Strip the `>` markers; consecutive lines join with a space, an empty `>`
 * line is a paragraph break. */
const quoteText = (raw: string[]): string => {
  const paras: string[][] = [[]];
  for (const line of raw) {
    const body = line.trimStart().slice(1).replace(/^ /, "");
    if (body.trim() === "") {
      if (paras[paras.length - 1]!.length > 0) paras.push([]);
    } else paras[paras.length - 1]!.push(body.trim());
  }
  return paras
    .filter((p) => p.length > 0)
    .map((p) => p.join(" "))
    .join("\n");
};

/** Which block, if any, does a non-blank line START (as opposed to continue)? */
const startOf = (line: string, complete: boolean, inParagraph: boolean): Draft | MdBlock | null => {
  const indent = indentOf(line);
  if (indent > 3) return null;
  const body = line.trimStart();
  const fence = FENCE_OPEN.exec(body);
  if (fence) {
    return {
      kind: "fence",
      lang: fence[2] === "" ? null : fence[2]!,
      fenceLen: fence[1]!.length,
      lines: [],
      raw: [line],
    };
  }
  const heading = HEADING.exec(body);
  if (heading) {
    return {
      kind: "heading",
      level: heading[1]!.length as 1 | 2 | 3,
      text: heading[2]!.trim(),
      source: line,
    };
  }
  if (body.startsWith(">")) return { kind: "quote", raw: [line] };
  if (body.startsWith("|")) return { kind: "table", raw: [line] };
  // A rule outranks a bullet ("* * *"), but only once the line is complete,
  // and never inside a paragraph (where "---" stays text: its completion
  // "---a" would continue the paragraph).
  if (complete && !inParagraph && RULE.test(body)) return { kind: "rule", source: line };
  const bullet = BULLET.exec(body);
  if (bullet) {
    return {
      kind: "list",
      ordered: false,
      start: 1,
      items: [{ text: bullet[2]!.trim(), children: [] }],
      raw: [line],
    };
  }
  const ordered = ORDERED.exec(body);
  if (ordered) {
    return {
      kind: "list",
      ordered: true,
      start: Number(ordered[1]),
      items: [{ text: ordered[2]!.trim(), children: [] }],
      raw: [line],
    };
  }
  return null;
};

/** Try to fold `line` into the current draft; false means it does not belong. */
const continueDraft = (d: Draft, line: string): boolean => {
  const body = line.trimStart();
  switch (d.kind) {
    case "paragraph":
      return false; // decided by the caller: anything that is not an interrupter
    case "quote":
      if (indentOf(line) > 3 || !body.startsWith(">")) return false;
      d.raw.push(line);
      return true;
    case "table":
      if (indentOf(line) > 3 || !body.startsWith("|")) return false;
      d.raw.push(line);
      return true;
    case "fence":
      return false; // handled before classification
    case "list": {
      const item = d.items[d.items.length - 1]!;
      if (indentOf(line) >= 2) {
        const bullet = BULLET.exec(body);
        const ordered = BULLET.test(body) ? null : ORDERED.exec(body);
        const marker = bullet ?? ordered;
        if (marker) item.children.push({ ordered: ordered !== null, text: marker[2]!.trim() });
        else if (item.children.length > 0) {
          const child = item.children[item.children.length - 1]!;
          child.text = `${child.text} ${body.trim()}`;
        } else item.text = `${item.text} ${body.trim()}`;
        d.raw.push(line);
        return true;
      }
      const marker = d.ordered ? ORDERED.exec(body) : BULLET.exec(body);
      if (!marker) return false;
      d.items.push({ text: marker[2]!.trim(), children: [] });
      d.raw.push(line);
      return true;
    }
  }
};

export function parseBlocks(text: string): ParsedBlocks {
  const lines = text.split("\n");
  const endsComplete = text.endsWith("\n");
  if (endsComplete) lines.pop();
  const blocks: MdBlock[] = [];
  let cur: Draft | null = null;
  // True when the last block was ended by a complete blank line or a closing
  // fence — i.e. nothing appended can reopen it.
  let terminated = false;

  const flush = (): void => {
    if (cur) blocks.push(finalize(cur));
    cur = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const complete = endsComplete || i < lines.length - 1;

    if (cur?.kind === "fence") {
      const body = line.trimStart();
      const closer = /^(`{3,})[ \t]*$/.exec(body);
      if (closer && closer[1]!.length >= cur.fenceLen && indentOf(line) <= 3) {
        if (complete) {
          cur.raw.push(line);
          blocks.push({ ...finalize(cur), closed: true } as MdBlock);
          cur = null;
          terminated = true;
        }
        // An incomplete closer is left out: it may still become a code line.
        continue;
      }
      cur.lines.push(line);
      cur.raw.push(line);
      continue;
    }

    if (isBlank(line)) {
      if (!complete) continue;
      flush();
      terminated = true;
      continue;
    }

    if (cur && cur.kind !== "paragraph") {
      if (continueDraft(cur, line)) continue;
      if (!complete && cur.kind === "list" && MARKER_PREFIX.test(line.trim())) continue;
    }

    const start = startOf(line, complete, cur?.kind === "paragraph");
    if (start === null) {
      if (cur?.kind === "paragraph") {
        cur.raw.push(line);
      } else {
        flush();
        cur = { kind: "paragraph", raw: [line] };
        terminated = false;
      }
      continue;
    }
    flush();
    terminated = false;
    if ("raw" in start) cur = start;
    else blocks.push(start);
  }
  flush();

  if (terminated || blocks.length === 0) return { closed: blocks, open: null };
  const open = blocks.pop()!;
  return { closed: blocks, open };
}
