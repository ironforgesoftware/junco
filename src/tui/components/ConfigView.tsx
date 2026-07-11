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
import { Box, Text, useInput } from "ink";
import { theme } from "../theme.js";
import { TextField } from "./TextField.js";
import { LEVERS, getAtPath, setAtPath, coerceLever, type Lever } from "../../configLevers.js";
import { validateConfigObject } from "../../config.js";

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
}: {
  configPath: string;
  onExit: () => void;
}): React.JSX.Element {
  const [raw, setRaw] = useState<Record<string, unknown>>(() => tryReadRaw(configPath) ?? {});
  const [sectionIdx, setSectionIdx] = useState(0);
  const [fieldIdx, setFieldIdx] = useState(0);
  // null = not editing; otherwise the live text buffer for the focused
  // number/string/secret lever (booleans toggle and enums cycle immediately,
  // with no intermediate buffer).
  const [editing, setEditing] = useState<string | null>(null);
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
    setEditing(lever.type === "secret" ? "" : String(currentValue(raw, lever) ?? ""));
  };

  const commitEdit = (): void => {
    const target = lever;
    const buffer = editing ?? "";
    setEditing(null);
    const c = coerceLever(target, buffer);
    if ("error" in c) {
      showToast("error", c.error);
      return;
    }
    commit(target, c.value);
  };

  useInput((_input, key) => {
    if (editing !== null) {
      // Typing/backspace/submit belong to the inline TextField below (it has
      // its own active useInput); this hook's only job while editing is Esc.
      if (key.escape) setEditing(null);
      return;
    }
    if (key.escape) {
      onExit();
      return;
    }
    if (key.upArrow) {
      setFieldIdx((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow) {
      setFieldIdx((i) => Math.min(fields.length - 1, i + 1));
      return;
    }
    if (key.leftArrow) {
      setSectionIdx((i) => Math.max(0, i - 1));
      setFieldIdx(0);
      return;
    }
    if (key.rightArrow) {
      setSectionIdx((i) => Math.min(SECTIONS.length - 1, i + 1));
      setFieldIdx(0);
      return;
    }
    if (key.return) startEdit();
  });

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      <Text bold color={theme.accent}>
        config <Text dimColor>{configPath}</Text>
      </Text>
      <Box flexGrow={1}>
        <Box flexDirection="column" width={20} borderStyle="round" borderColor={theme.border}>
          {SECTIONS.map((s, i) => {
            const sel = i === sectionIdx;
            return (
              <Text
                key={s.key}
                color={sel ? theme.accent : undefined}
                bold={sel}
                wrap="truncate-end"
              >
                {sel ? "▌ " : "  "}
                {s.key}
              </Text>
            );
          })}
        </Box>
        <Box
          flexDirection="column"
          flexGrow={1}
          borderStyle="round"
          borderColor={theme.accent}
          paddingX={1}
        >
          {fields.map((l, i) => {
            const sel = i === fieldIdxSafe;
            const isEditingThis = sel && editing !== null;
            return (
              <Box
                key={l.path}
                width="100%"
                backgroundColor={sel ? theme.selectionBg : undefined}
                gap={1}
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
                      onChange={setEditing}
                      onSubmit={commitEdit}
                      focus
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
              </Box>
            );
          })}
        </Box>
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
