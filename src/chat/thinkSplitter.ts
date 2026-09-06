/**
 * Streaming `<think>…</think>` splitter (spec 2026-09-06 §2.1). Total over any
 * byte sequence, never throws, never drops bytes: at most `tag.length - 1`
 * trailing chars that could be a tag prefix are held back and released on the
 * next push or on end(). Tags are never emitted; whitespace is trimmed only at
 * the two edges of a thinking block. No nesting; a bare close tag is text.
 */
export interface SplitPiece {
  kind: "text" | "thinking";
  delta: string;
}
export interface ThinkSplitter {
  push(delta: string): SplitPiece[];
  end(): SplitPiece[];
  /** True once an opening tag has been seen (drives `auto` in chatSession). */
  readonly sawTag: boolean;
}

export function makeThinkSplitter(opts: { open?: string; close?: string } = {}): ThinkSplitter {
  const open = opts.open ?? "<think>";
  const close = opts.close ?? "</think>";
  let inThink = false;
  let held = ""; // unemitted tail that may be a tag prefix
  let atBlockStart = false; // trim leading whitespace of a thinking block
  let sawTag = false;

  /** Longest proper prefix of `tag` that `s` ends with — the chars to hold. */
  const tailPrefixLen = (s: string, tag: string): number => {
    for (let n = Math.min(tag.length - 1, s.length); n > 0; n--) {
      if (s.endsWith(tag.slice(0, n))) return n;
    }
    return 0;
  };

  const emit = (out: SplitPiece[], kind: SplitPiece["kind"], delta: string): void => {
    if (delta === "") return;
    if (kind === "thinking" && atBlockStart) {
      delta = delta.replace(/^\s+/, "");
      if (delta === "") return;
      atBlockStart = false;
    }
    out.push({ kind, delta });
  };

  const push = (delta: string): SplitPiece[] => {
    const out: SplitPiece[] = [];
    let buf = held + delta;
    held = "";
    for (;;) {
      const tag = inThink ? close : open;
      const i = buf.indexOf(tag);
      if (i === -1) {
        const keep = tailPrefixLen(buf, tag);
        const body = buf.slice(0, buf.length - keep);
        held = buf.slice(buf.length - keep);
        if (inThink) {
          // Hold trailing whitespace too: it is trimmed if the close tag follows.
          const m = /\s+$/.exec(body);
          const ws = m ? m[0] : "";
          emit(out, "thinking", body.slice(0, body.length - ws.length));
          held = ws + held;
        } else emit(out, "text", body);
        return out;
      }
      const before = buf.slice(0, i);
      if (inThink) {
        emit(out, "thinking", before.replace(/\s+$/, ""));
        inThink = false;
      } else {
        emit(out, "text", before);
        inThink = true;
        sawTag = true;
        atBlockStart = true;
      }
      buf = buf.slice(i + tag.length);
    }
  };

  const end = (): SplitPiece[] => {
    const out: SplitPiece[] = [];
    if (held !== "") {
      if (inThink) emit(out, "thinking", held.replace(/\s+$/, ""));
      else emit(out, "text", held);
      held = "";
    }
    return out;
  };

  return {
    push,
    end,
    get sawTag() {
      return sawTag;
    },
  };
}

/**
 * Non-streaming form for a finished turn whose persisted text still carries the
 * tags (spec §2.1 last paragraph): the whole string through one splitter, pieces
 * joined by kind. `thinking` is null when no opening tag was seen, so a caller
 * can tell "no block" from "an empty block".
 */
export function splitThinkingText(
  text: string,
  opts?: { open?: string; close?: string },
): { thinking: string | null; text: string } {
  const s = makeThinkSplitter(opts);
  const pieces = [...s.push(text), ...s.end()];
  let thinking = "";
  let plain = "";
  for (const p of pieces) {
    if (p.kind === "thinking") thinking += p.delta;
    else plain += p.delta;
  }
  return { thinking: s.sawTag ? thinking : null, text: plain };
}
