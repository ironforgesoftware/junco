/** The walkthrough shell: chapter rail (✓/▶), chapter router, footer legend,
 * and global navigation keys. Chapters own Enter; this component owns
 * q/Esc/←/Ctrl-C. `textEditing` mutes q while a TextField is focused so "q"
 * can be typed into paths. Outcome is reported exactly once via onOutcome;
 * the HOST — Root — swaps views or exits. */
import React, { useRef, useState } from "react";
import { Box, Text } from "ink";
import { CHAPTERS, type WizardAnswers } from "../../wizard/flow.js";
import type { WizardIO, WizardOutcome, WriteResult } from "../../wizard/io.js";
import { theme } from "../theme.js";
import { useTerminalSize, type TerminalSize } from "../useTerminalSize.js";
import { useGuardedInput } from "../useGuardedInput.js";
import { Welcome } from "./chapters/Welcome.js";
import { Workspace } from "./chapters/Workspace.js";
import { Model } from "./chapters/Model.js";
import { RepoSafety } from "./chapters/RepoSafety.js";
import { Github } from "./chapters/Github.js";
import { Extras } from "./chapters/Extras.js";
import { Review } from "./chapters/Review.js";
import { Finale } from "./chapters/Finale.js";

export interface WizardAppProps {
  io: WizardIO;
  onOutcome: (o: WizardOutcome) => void;
  sizeOverride?: TerminalSize;
  revealMs?: number;
}

export function WizardApp({
  io,
  onOutcome,
  sizeOverride,
  revealMs,
}: WizardAppProps): React.JSX.Element {
  const size = useTerminalSize(sizeOverride);
  const narrow = size.columns < 80;
  const [answers, setAnswers] = useState<WizardAnswers>(io.initialAnswers);
  const [idx, setIdx] = useState(0);
  const [result, setResult] = useState<WriteResult | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const textEditing = useRef(false);
  const reported = useRef(false);

  const finishWith = (o: WizardOutcome): void => {
    if (reported.current) return;
    reported.current = true;
    onOutcome(o);
  };
  const cancel = (): void => finishWith("cancelled");
  const patch = (p: Partial<WizardAnswers>): void => setAnswers((a) => ({ ...a, ...p }));
  const setTextEditing = (b: boolean): void => {
    textEditing.current = b;
  };
  const next = (): void => setIdx((i) => Math.min(CHAPTERS.length - 1, i + 1));
  const back = (): void => setIdx((i) => Math.max(0, i - 1));
  // io.write can throw — a schema-invalid config on a zero-diff rerun, an
  // EACCES on a read-only config dir, a fresh-mode validation gap. Uncaught,
  // that exception would escape straight through Select's useInput handler
  // with nothing above it to catch it: a raw stack trace inside the live Ink
  // alt-screen session, terminal left in raw mode. Catch it here and stay on
  // Review (result stays null) so the user can retry, go back, or quit.
  const write = (): void => {
    setWriteError(null);
    try {
      setResult(io.write(answers));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // validateConfigObject throws a raw ZodError whose .message is a
      // multi-line JSON blob (src/config.ts) — the banner is a one-line
      // summary, so take the first line and cap it; the full message isn't
      // needed anywhere else (this banner is its only consumer).
      const firstLine = msg.split("\n")[0] ?? "";
      const brief = firstLine.length > 120 ? `${firstLine.slice(0, 120)}…` : firstLine;
      setWriteError(brief);
    }
  };
  const done = (): void => finishWith(result?.written ? "written" : "unchanged");

  useGuardedInput((input, key) => {
    if (key.ctrl && input === "c") return result !== null ? done() : cancel();
    if (result !== null) {
      if (input === "q") return done(); // config already written — q finishes
      return;
    }
    if (input === "q" && !textEditing.current) return cancel();
    if (key.escape) return idx === 0 ? cancel() : back();
    if (key.leftArrow) return back();
  });

  const chapterProps = { answers, patch, onNext: next, onBack: back, io, setTextEditing };
  const body =
    result !== null ? (
      <Finale result={result} io={io} onDone={done} revealMs={revealMs} />
    ) : idx === 0 ? (
      <Welcome {...chapterProps} />
    ) : idx === 1 ? (
      <Workspace {...chapterProps} />
    ) : idx === 2 ? (
      <Model {...chapterProps} />
    ) : idx === 3 ? (
      <RepoSafety {...chapterProps} />
    ) : idx === 4 ? (
      <Github {...chapterProps} />
    ) : idx === 5 ? (
      <Extras {...chapterProps} />
    ) : (
      <Review {...chapterProps} onWrite={write} onCancel={cancel} />
    );

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color={theme.accent}>
        junco setup
      </Text>
      <Box marginTop={1}>
        {!narrow && (
          <Box flexDirection="column" width={16} marginRight={2}>
            {CHAPTERS.map((c, i) => {
              const mark = result !== null || i < idx ? "✓" : i === idx ? "▶" : " ";
              return (
                <Text
                  key={c}
                  color={i === idx && result === null ? theme.accent : undefined}
                  dimColor={i > idx && result === null}
                >
                  {mark} {c}
                </Text>
              );
            })}
          </Box>
        )}
        <Box flexDirection="column" flexGrow={1}>
          {narrow && (
            <Text dimColor>
              {result !== null ? "done" : `${idx + 1}/${CHAPTERS.length} · ${CHAPTERS[idx]}`}
            </Text>
          )}
          {writeError !== null && result === null && (
            <Box flexDirection="column" marginBottom={1}>
              <Text color={theme.error}>✗ Write failed: {writeError}</Text>
              <Text dimColor>fix the problem, then Write again — or Quit without writing</Text>
            </Box>
          )}
          {body}
        </Box>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>enter continue · ← back · q quit</Text>
      </Box>
    </Box>
  );
}
