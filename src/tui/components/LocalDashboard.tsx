import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.js";
import { fmtAge } from "../queueFmt.js";
import type { LocalCheap, LocalHeavy, LocalSection } from "../localSnapshot.js";

// LocalSection already lives in localSnapshot.ts (it gates the cheap-tick
// `section` option) — re-export rather than redeclare so the union has one
// source of truth.
export type { LocalSection } from "../localSnapshot.js";
export type { UiMode } from "../geometry.js";

const SECTIONS: readonly LocalSection[] = ["queue", "outbox", "repos", "worktrees", "daemon"];

/** Compact live badge for a section, derived from the cheap/heavy snapshots.
 * Empty string → no badge (hidden at zero). */
function sectionBadge(s: LocalSection, cheap: LocalCheap | null, heavy: LocalHeavy | null): string {
  if (cheap === null) return "";
  switch (s) {
    case "queue": {
      const n = cheap.queue.running.length;
      return n > 0 ? `▸${n}` : "";
    }
    case "outbox":
      return cheap.outbox.depth > 0 ? `⇡${cheap.outbox.depth}` : "";
    case "worktrees": {
      const n = (heavy?.worktrees ?? []).filter((w) => w.kind === "stale").length;
      return n > 0 ? `⚑${n}` : "";
    }
    case "daemon":
      return cheap.daemon.up ? "●" : "○";
    case "repos":
      return "";
  }
}

/** LOCAL section rail — a fixed 5-row list (never windowed), rendered like the
 * GitHub Rail: `▌` accent cursor + selectionBg on the selected section, border
 * accent when the rail holds focus. Live badges come from the cheap/heavy
 * snapshots; an optional `↻ <age>` stamp is pinned at the bottom so the tall
 * 26-wide column doesn't read as empty. */
export function SectionRail({
  section,
  focus,
  cheap,
  heavy,
  width,
  height,
  now,
  refreshedAt,
}: {
  section: LocalSection;
  focus: "rail" | "body";
  cheap: LocalCheap | null;
  heavy: LocalHeavy | null;
  width: number;
  height: number;
  now: Date;
  refreshedAt?: string | null;
}): React.JSX.Element {
  const idx = SECTIONS.indexOf(section);
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={focus === "rail" ? theme.accent : theme.border}
      paddingX={1}
      width={width}
      height={height}
    >
      <Text bold color={focus === "rail" ? theme.accent : undefined}>
        sections
      </Text>
      {SECTIONS.map((s, i) => {
        const sel = i === idx;
        const badge = sectionBadge(s, cheap, heavy);
        return (
          <Box key={s} width="100%" backgroundColor={sel ? theme.selectionBg : undefined}>
            <Text color={theme.accent}>{sel ? "▌" : " "}</Text>
            <Text wrap="truncate">
              {s}
              {badge ? `  ${badge}` : ""}
            </Text>
          </Box>
        );
      })}
      <Text dimColor>
        {idx + 1}/{SECTIONS.length}
      </Text>
      <Box flexGrow={1} />
      {refreshedAt != null && (
        <Text dimColor wrap="truncate">
          ↻ {fmtAge(refreshedAt, now)}
        </Text>
      )}
    </Box>
  );
}
