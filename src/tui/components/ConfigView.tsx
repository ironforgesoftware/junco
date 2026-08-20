/**
 * In-dashboard config editor. A self-contained, full-body view — mirrors
 * AddRepoForm.tsx's shape (its own `useInput`, an `onExit`/`onCancel`
 * callback, no App-level key routing once open) rather than QueueView/
 * ReviewView (pure render components App.tsx drives keystroke-by-keystroke);
 * ConfigView owns 100% of input while mounted, matching the two-pane +
 * inline-edit interaction this view needs. Wired into App.tsx on `,` — the
 * settings idiom, confirmed free via `grep -n 'input === ' src/tui/App.tsx`
 * (nothing in that cascade binds `,`).
 *
 * Left pane: `LEVERS` (src/configLevers.ts) grouped by top-level section,
 * order fixed by `SECTION_ORDER`. Right pane: the focused section's levers
 * (label · current value), edited in place. Footer: the focused lever's
 * `description`, then a save/error toast. Every commit mirrors the `junco
 * config set` CLI's save path (src/configCmd.ts): coerce (or toggle/cycle),
 * `setAtPath` a clone, `validateConfigObject`, atomic write (temp + rename —
 * same pattern as ghClient.ts's cache writers), re-read the file into state.
 */
import React, { useEffect, useRef, useState } from "react";
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { Box, Text, useStdout } from "ink";
import { theme } from "../theme.js";
import { ClickableBox } from "../ClickableBox.js";
import { TextField } from "./TextField.js";
import { LEVERS, getAtPath, setAtPath, coerceLever, type Lever } from "../../configLevers.js";
import { validateConfigObject } from "../../config.js";
import { useGuardedInput } from "../useGuardedInput.js";

/** Top-level scalar leaves that share one "general" section rather than each
 * getting a one-row section of their own. */
const TOP_LEVEL_KEYS = new Set(["vaultRoot", "juncoSubdir", "tools"]);

const SECTION_ORDER = [
  "general",
  "model",
  "worker",
  "supervisor",
  "git",
  "pr",
  "verify",
  "sandbox",
  "critic",
  "planLint",
  "observability",
  "github",
  "assess",
];

interface Section {
  key: string;
  levers: Lever[];
}

function sectionKeyFor(path: string): string {
  const top = path.split(".")[0];
  return TOP_LEVEL_KEYS.has(top) ? "general" : top;
}

function buildSections(): Section[] {
  const byKey = new Map<string, Lever[]>();
  for (const l of LEVERS) {
    const k = sectionKeyFor(l.path);
    const arr = byKey.get(k);
    if (arr) arr.push(l);
    else byKey.set(k, [l]);
  }
  return SECTION_ORDER.filter((k) => byKey.has(k)).map((k) => ({
    key: k,
    levers: byKey.get(k) as Lever[],
  }));
}

// Static — LEVERS is a module-level constant, so this never changes at runtime.
const SECTIONS = buildSections();

/** Row label: the section prefix is already implied by the pane, so only the
 * remainder of the dotted path is shown (`model.cost.input` → `cost.input`
 * inside the `model` section); "general" levers have no shared prefix to
 * strip, so they show in full. */
function leverLabel(section: Section, lever: Lever): string {
  return section.key === "general" ? lever.path : lever.path.slice(section.key.length + 1);
}

function currentValue(raw: Record<string, unknown>, lever: Lever): unknown {
  const v = getAtPath(raw, lever.path);
  return v === undefined ? lever.default : v;
}

/** A compact summary for structured (array/object) values — the full
 * JSON.stringify of `tools`' 7-entry default alone is wider than the row has
 * room for once the " — edit config.json" hint is appended, which would
 * truncate the hint itself away. */
function formatValue(lever: Lever, value: unknown): string {
  if (lever.type === "secret") return "••••";
  if (value === undefined) return "";
  if (lever.type === "structured") {
    if (Array.isArray(value)) {
      return value.length === 0 ? "[]" : `[${value.length} item${value.length === 1 ? "" : "s"}]`;
    }
    if (typeof value === "object" && value !== null) {
      const n = Object.keys(value).length;
      return n === 0 ? "{}" : `{${n} key${n === 1 ? "" : "s"}}`;
    }
    return JSON.stringify(value);
  }
  return String(value);
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Chrome budget (title + border × 2 + footer description + toast + hint,
 * with a little slack for the ▲/▼ "more" indicators) subtracted from the
 * terminal height to size the right-pane viewport; clamped to a minimum so a
 * tiny or unknown terminal still shows something usable. */
const CHROME_ROWS = 8;
const MIN_VISIBLE_ROWS = 5;

/** Standard "scroll into view" clamp: nudge `offset` just far enough that
 * `focusIdx` re-enters the `[offset, offset + visibleCount)` window, then
 * clamp the result to the list's valid offset range. Pure function of the
 * previous offset (not just the focus index) so scrolling one lever past the
 * bottom shifts by one row rather than re-paging to a fixed grid. */
function clampScrollOffset(
  offset: number,
  focusIdx: number,
  visibleCount: number,
  total: number,
): number {
  let next = offset;
  if (focusIdx < next) next = focusIdx;
  if (focusIdx >= next + visibleCount) next = focusIdx - visibleCount + 1;
  const maxOffset = Math.max(0, total - visibleCount);
  return Math.min(Math.max(next, 0), maxOffset);
}

/** Parses the config file; `null` on a missing/corrupt file so callers can
 * fall back (mount: to `{}`; a mid-session re-read: to the last-known state
 * — never let a transient read hiccup zero out the write). */
function tryReadRaw(configPath: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Atomic write: a PID-suffixed temp file (avoids colliding with a concurrent
 * `junco config set`) written then renamed over the target — mirrors
 * configCmd.ts's `set` and ghClient.ts's cache writers. */
function writeRaw(configPath: string, obj: Record<string, unknown>): void {
  const tmp = join(dirname(configPath), `.config.json.tmp-${process.pid}`);
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", "utf8");
  renameSync(tmp, configPath);
}

export function ConfigView({
  configPath,
  onExit,
  visibleRows,
  inputActive = true,
}: {
  configPath: string;
  onExit: () => void;
  /** Override for the right pane's lever-row viewport height. Defaults to
   * the terminal height minus `CHROME_ROWS`; exposed so tests can force a
   * small deterministic window instead of depending on the terminal size
   * ink-testing-library reports (it has no `rows` at all). */
  visibleRows?: number;
  /** False while a modal above owns input (App's confirm gate can open
   * asynchronously over the still-mounted editor): detaches this view's
   * useInput AND the inline edit TextField's, so modal keys never
   * double-handle here. */
  inputActive?: boolean;
}): React.JSX.Element {
  const { stdout } = useStdout();
  const terminalRows = stdout?.rows ?? 24;
  const visibleCount = visibleRows ?? Math.max(MIN_VISIBLE_ROWS, terminalRows - CHROME_ROWS);
  const [raw, setRaw] = useState<Record<string, unknown>>(() => tryReadRaw(configPath) ?? {});
  const [sectionIdx, setSectionIdx] = useState(0);
  const [fieldIdx, setFieldIdx] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  // null = not editing; otherwise the live text buffer for the focused
  // number/string/secret lever (booleans toggle and enums cycle immediately,
  // with no intermediate buffer).
  const [editing, setEditing] = useState<string | null>(null);
  // Synchronous mirror of `editing` for commitEdit's stale-handler guard: a
  // cancel (wheel/click section switch, Esc) unmounts the TextField, but its
  // useInput detaches in a PASSIVE cleanup — an Enter arriving after the
  // cancel and before that cleanup still reaches the stale handler, whose
  // closure holds the abandoned buffer and the OLD lever. State alone can't
  // guard this (the stale closure sees the old state); the ref sees the
  // cancel immediately. Caught by the 2026-07-16 macos merge gates; pinned by
  // configView.test.tsx's wheel-then-Enter cancel-race test.
  const editingRef = useRef<string | null>(null);
  const updateEditing = (v: string | null): void => {
    editingRef.current = v;
    setEditing(v);
  };
  const [toast, setToast] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    [],
  );

  const showToast = (kind: "success" | "error", text: string): void => {
    setToast({ kind, text });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4000);
  };

  const section = SECTIONS[Math.min(sectionIdx, SECTIONS.length - 1)];
  const fields = section.levers;
  const fieldIdxSafe = Math.max(0, Math.min(fieldIdx, fields.length - 1));
  const lever = fields[fieldIdxSafe];

  // Re-derive (rather than trust the raw state value) so the initial mount,
  // a shrunk `visibleRows` prop, or a section swap that hasn't gone through
  // the left/right handlers yet can't leave the offset out of range.
  const scrollOffsetSafe = clampScrollOffset(
    scrollOffset,
    fieldIdxSafe,
    visibleCount,
    fields.length,
  );
  const visibleFields = fields.slice(scrollOffsetSafe, scrollOffsetSafe + visibleCount);
  const hiddenAbove = scrollOffsetSafe;
  const hiddenBelow = Math.max(0, fields.length - (scrollOffsetSafe + visibleCount));

  /** Save path shared by toggle/cycle (immediate) and inline-edit commit:
   * re-read the file at write time (never mutate a stale in-memory copy —
   * same rule App.tsx's watchlist writers follow), setAtPath a clone,
   * validate, atomic-write on success, reload `raw` from the written file. */
  const commit = (target: Lever, value: unknown): void => {
    const fresh = tryReadRaw(configPath) ?? raw;
    const clone: Record<string, unknown> = JSON.parse(JSON.stringify(fresh));
    setAtPath(clone, target.path, value);
    try {
      validateConfigObject(clone);
    } catch (e) {
      showToast("error", errMsg(e));
      return;
    }
    writeRaw(configPath, clone);
    setRaw(tryReadRaw(configPath) ?? clone);
    showToast(
      "success",
      target.reload === "restart" ? "Saved — restart to apply" : "Saved — applies live",
    );
  };

  const startEdit = (): void => {
    if (!lever.editable) return; // structured — edit config.json directly
    if (lever.type === "boolean") {
      commit(lever, currentValue(raw, lever) !== true);
      return;
    }
    if (lever.type === "enum") {
      const values = lever.enumValues ?? [];
      if (values.length === 0) return;
      const idx = values.indexOf(String(currentValue(raw, lever)));
      commit(lever, values[(idx + 1) % values.length]);
      return;
    }
    // number | string | secret: inline TextField, committed on its Enter.
    updateEditing(lever.type === "secret" ? "" : String(currentValue(raw, lever) ?? ""));
  };

  const commitEdit = (): void => {
    if (editingRef.current === null) return; // edit already canceled — stale submit, drop it
    const target = lever;
    const buffer = editingRef.current; // ref, not closure: reads through to the freshest buffer
    updateEditing(null);
    const c = coerceLever(target, buffer);
    if ("error" in c) {
      showToast("error", c.error);
      return;
    }
    commit(target, c.value);
  };

  /** Move focus within the current section's field list by `d` — shared by
   * the up/down arrow keys and the right pane's wheel. */
  const moveField = (d: 1 | -1): void => {
    setFieldIdx((i) => {
      const next = Math.max(0, Math.min(fields.length - 1, i + d));
      setScrollOffset((o) => clampScrollOffset(o, next, visibleCount, fields.length));
      return next;
    });
  };

  /** Move the selected section by `d`, resetting focus to that section's
   * first field — shared by the left/right arrow keys and the left pane's
   * wheel. Cancels any in-progress edit first (same invariant as the
   * section-click handler): a section switch re-binds the TextField to the
   * new section's field 0, and a surviving buffer would then commit the old
   * text to the wrong lever on Enter. The arrow keys can't reach here while
   * editing (useGuardedInput returns early), but the left pane's wheel can. */
  const moveSection = (d: 1 | -1): void => {
    if (editing !== null) updateEditing(null);
    setSectionIdx((i) => Math.max(0, Math.min(SECTIONS.length - 1, i + d)));
    setFieldIdx(0);
    setScrollOffset(0);
  };

  useGuardedInput(
    (_input, key) => {
      if (editing !== null) {
        // Typing/backspace/submit belong to the inline TextField below (it has
        // its own active useInput); this hook's only job while editing is Esc.
        if (key.escape) updateEditing(null);
        return;
      }
      if (key.escape) {
        onExit();
        return;
      }
      if (key.upArrow) {
        moveField(-1);
        return;
      }
      if (key.downArrow) {
        moveField(1);
        return;
      }
      if (key.leftArrow) {
        moveSection(-1);
        return;
      }
      if (key.rightArrow) {
        moveSection(1);
        return;
      }
      if (key.return) startEdit();
    },
    { isActive: inputActive },
  );

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      <Text bold color={theme.accent}>
        config <Text dimColor>{configPath}</Text>
      </Text>
      <Box flexGrow={1}>
        <ClickableBox
          flexDirection="column"
          width={20}
          borderStyle="round"
          borderColor={theme.border}
          onWheel={(d) => moveSection(d)}
        >
          {SECTIONS.map((s, i) => {
            const sel = i === sectionIdx;
            return (
              <ClickableBox
                key={s.key}
                hoverBg={sel ? theme.selectionBg : theme.hoverBg}
                onPress={() => {
                  if (editing !== null) updateEditing(null);
                  setSectionIdx(i);
                  setFieldIdx(0);
                  setScrollOffset(0);
                }}
              >
                <Text color={sel ? theme.accent : undefined} bold={sel} wrap="truncate-end">
                  {sel ? "▌ " : "  "}
                  {s.key}
                </Text>
              </ClickableBox>
            );
          })}
        </ClickableBox>
        <ClickableBox
          flexDirection="column"
          flexGrow={1}
          borderStyle="round"
          borderColor={theme.accent}
          paddingX={1}
          onWheel={(d) => {
            if (editing === null) moveField(d);
          }}
        >
          {hiddenAbove > 0 && <Text dimColor>▲ {hiddenAbove} more</Text>}
          {visibleFields.map((l, visibleI) => {
            const i = scrollOffsetSafe + visibleI;
            const sel = i === fieldIdxSafe;
            const isEditingThis = sel && editing !== null;
            return (
              <ClickableBox
                key={l.path}
                width="100%"
                backgroundColor={sel ? theme.selectionBg : undefined}
                hoverBg={sel ? theme.selectionBg : theme.hoverBg}
                gap={1}
                onPress={() => {
                  if (editing !== null) {
                    updateEditing(null); // click during edit cancels FIRST (spec §3)
                    return;
                  }
                  if (i === fieldIdxSafe) {
                    startEdit();
                    return;
                  }
                  setFieldIdx(i);
                  setScrollOffset((o) => clampScrollOffset(o, i, visibleCount, fields.length));
                }}
              >
                <Text color={theme.accent}>{sel ? "▌" : " "}</Text>
                <Box width={26}>
                  <Text dimColor={!l.editable} wrap="truncate-end">
                    {leverLabel(section, l)}
                  </Text>
                </Box>
                <Box flexGrow={1} minWidth={0}>
                  {isEditingThis ? (
                    <TextField
                      value={editing ?? ""}
                      onChange={updateEditing}
                      onSubmit={commitEdit}
                      focus={inputActive}
                      mask={l.type === "secret"}
                      placeholder=""
                    />
                  ) : (
                    <Text dimColor={!l.editable} wrap="truncate-end">
                      {formatValue(l, currentValue(raw, l))}
                      {l.type === "structured" ? " — edit config.json" : ""}
                    </Text>
                  )}
                </Box>
                {l.reload === "restart" && <Text color={theme.warn}>↻ restart</Text>}
              </ClickableBox>
            );
          })}
          {hiddenBelow > 0 && <Text dimColor>▼ {hiddenBelow} more</Text>}
        </ClickableBox>
      </Box>
      <Text dimColor wrap="truncate-end">
        {lever.description}
      </Text>
      {toast && (
        <Text color={toast.kind === "error" ? theme.error : theme.success}>{toast.text}</Text>
      )}
      <Text dimColor>
        ↑/↓ field · ←/→ section · enter {editing !== null ? "save" : "edit/toggle"} · esc{" "}
        {editing !== null ? "cancel" : "close"}
      </Text>
    </Box>
  );
}
