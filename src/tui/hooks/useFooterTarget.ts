/**
 * The footer's row-1 target label (spec 2026-09-02 §3.1/§6, Ruling R12): what
 * the actions row's verbs act on, in the FOOTER's vocabulary.
 *
 * App used to hand `buildFooterRows` the tail of its breadcrumb trail, which
 * is the HEADER's vocabulary — the scope you are inside, most-general first.
 * The two disagree wherever a pane narrows the scope: the issue list read
 * `acme/api` when the verbs act on `issue #46`, pane 3 read `acme/api` when
 * they act on `PR #12`, the chat view read the bare session key rather than
 * `chat · <key>`, and a local-only checkout (`UnifiedRepo.nwo === null`) read
 * `no repo` next to a live chat pill. This hook is the footer's own reading,
 * derived from the same spine App already holds — never from the chips.
 *
 * Pure apart from the memo; every case is pinned by tests/useFooterTarget.
 */
import { useMemo } from "react";
import { basename } from "node:path";
import type { View, DetailState, PrDetailState } from "../App.js";
import type { BodyKind, UnifiedRepo } from "../railModel.js";
import type { DashIssue } from "../state.js";
import type { DashPr } from "../prState.js";
import type { TranscriptState } from "./useTranscript.js";
import type { CmdState } from "./useCmdOutput.js";
import type { ChatState } from "./useChat.js";

/** The overlay/selection state the label reads. App's own locals, in one bag
 * so the call site stays a line: `view`, `pane` and `body` are the nav spine
 * proper and stay positional. (`null` is App's "nothing selected";
 * `undefined` is what an index past a shrunk list yields — both mean the
 * same thing here, exactly as in useViewActions.) */
export interface FooterTargetSources {
  currentIssue: DashIssue | null | undefined;
  selectedPane3Pr: DashPr | null | undefined;
  selectedPr: DashPr | null | undefined;
  detail: DetailState | null;
  prDetail: PrDetailState | null;
  transcript: TranscriptState | null;
  chatState: ChatState | null;
  repoDetailTarget: UnifiedRepo | null;
  cmd: CmdState | null;
}

/** A repo row's name: the nwo when GitHub knows it, else the checkout's own
 * directory name. Never "no repo" — a repo row always has a chat pill, and
 * spec §3.1 pairs the pill with the thing it would chat about. */
const repoLabel = (repo: UnifiedRepo): string => repo.nwo ?? basename(repo.path);

/** The main view's label: the rail names the row, a body pane names the row
 * under ITS cursor (spec §3.1's `issue #46` / `PR #12`), and a system row
 * names its section on either pane. */
function mainTarget(
  pane: 1 | 2 | 3,
  body: BodyKind | null,
  currentIssue: DashIssue | null | undefined,
  selectedPane3Pr: DashPr | null | undefined,
): string {
  if (body === null) return "no repo";
  if (body.kind === "section") return body.section;
  if (pane === 2 && body.kind === "issues" && currentIssue) return `issue #${currentIssue.number}`;
  if (pane === 3 && selectedPane3Pr) return `PR #${selectedPane3Pr.number}`;
  return body.kind === "issues" ? body.nwo : repoLabel(body.repo);
}

export function useFooterTarget(
  view: View,
  pane: 1 | 2 | 3,
  body: BodyKind | null,
  sources: FooterTargetSources,
): string {
  const { currentIssue, selectedPane3Pr, selectedPr, detail, prDetail } = sources;
  const { transcript, chatState, repoDetailTarget, cmd } = sources;
  return useMemo((): string => {
    switch (view) {
      // Each overlay falls back to its own NAME, never to the rail's row: the
      // one frame between "open" and "state landed" must not claim the verbs
      // act on whatever the rail happens to be parked on.
      case "detail":
        return detail ? `#${detail.issue.number}` : "issue";
      case "prDetail":
        return prDetail ? `PR #${prDetail.pr.number}` : "pull request";
      case "prs":
        return selectedPr ? `PR #${selectedPr.number}` : "pull requests";
      case "transcript":
        return transcript ? transcript.id : "transcript";
      case "review":
        return "review";
      case "cmdOutput":
        return cmd ? cmd.title : "command";
      case "chat":
        return chatState ? `chat · ${chatState.key}` : "chat";
      case "repoDetail":
        return repoDetailTarget ? repoLabel(repoDetailTarget) : "repo";
      case "palette":
        return "palette";
      case "config":
        return "config";
      case "addRepo":
        return "add repo";
      case "help":
        return "help";
      case "main":
        return mainTarget(pane, body, currentIssue, selectedPane3Pr);
    }
  }, [
    view,
    pane,
    body,
    currentIssue,
    selectedPane3Pr,
    selectedPr,
    detail,
    prDetail,
    transcript,
    chatState,
    repoDetailTarget,
    cmd,
  ]);
}
