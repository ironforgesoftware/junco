/**
 * Derived-mnemonic bindings + the two footer rows (mnemonic spec §2/§4,
 * footer spec 2026-09-02 §6): ONE context table drives the footer, the help
 * modal and App's keyboard dispatch tail — render and input consume the same
 * derivation and cannot drift. App passes its nav spine in read-only (the
 * src/tui/hooks convention) and reads the four results back.
 */
import { useMemo } from "react";
import {
  buildContextBindings,
  type BindingContext,
  type ContextBindings,
  type MainBody,
} from "../viewActions.js";
import { buildFooterRows, type FooterRows } from "../footerModel.js";
import type { LayoutMode } from "../layout.js";
import type { BodyKind } from "../railModel.js";
import type { View } from "../App.js";

export interface FooterBindingsInput {
  view: View;
  pane: 1 | 2 | 3;
  /** App's `body` (`bodyKindFor(selectedRow, …)`): `BodyKind` from railModel. */
  body: BodyKind | null;
  logOverlay: boolean;
  filtering: boolean;
  composerFocused: boolean;
  /** A junco_submit card is waiting on the operator (spec 2026-09-03 §4.3) →
   * the blurred chat's context is `chatConfirm`, whose keymap is empty. */
  chatPending: boolean;
  mode: LayoutMode;
  /** Terminal width — the navigate row fits itself to this (Ruling R10). */
  columns: number;
  /** Row-1 target (App's crumbs' last element). */
  target: string;
  /** A repo is in context → the chat pill renders. */
  chatReachable: boolean;
  /** The context help was opened FROM, captured at open time (Ruling R5, spec
   * §3.2 — `?` is help from every overlay, and the modal lists the surface
   * underneath it). null → the main body's context, the pre-R5 behavior. */
  helpContext: BindingContext | null;
}

export interface FooterBindings {
  bindingContext: BindingContext;
  /** The keymap App's layer-3d dispatch reads. */
  bindings: ContextBindings;
  /** The bindings the help modal lists. */
  helpBindings: ContextBindings;
  footer: FooterRows;
}

const mainBody = (body: BodyKind | null): MainBody =>
  body?.kind === "issues" ? "issues" : body?.kind === "section" ? body.section : "repoDetail";

export function useFooterBindings(input: FooterBindingsInput): FooterBindings {
  const {
    view,
    pane,
    body,
    logOverlay,
    filtering,
    composerFocused,
    chatPending,
    mode,
    columns,
    target,
    chatReachable,
    helpContext,
  } = input;
  const bindingContext = useMemo((): BindingContext => {
    // Help FIRST — ahead of the log overlay and everything else (Ruling R6').
    // The modal covers the body but not the footer, so whatever context wins
    // here is what a pointer can reach underneath it. Letting `logOverlay` win
    // rendered the OVERLAY's live chips below the modal, `? help` among them:
    // clicking that re-entered openHelp and trapped the dashboard. Help's own
    // structuralOnly context has one chip (`any key close`) and no keymap, so
    // nothing under the modal dispatches. The modal's CONTENT is unaffected —
    // it comes from `helpContext`, the origin captured at open time (R5).
    if (view === "help") return { kind: "structuralOnly", view: "help" };
    if (logOverlay) return { kind: "logOverlay" };
    if (filtering) return { kind: "structuralOnly", view: "filtering" };
    // A focused composer derives NOTHING (spec §8.3): the empty keymap is
    // what keeps typed prose off the mnemonic dispatch at layer 3d.
    if (view === "chat")
      return composerFocused
        ? { kind: "structuralOnly", view: "chatCompose" }
        : chatPending
          ? { kind: "structuralOnly", view: "chatConfirm" }
          : { kind: "view", view: "chat" };
    switch (view) {
      case "palette":
      case "addRepo":
      case "config":
        return { kind: "structuralOnly", view };
      case "detail":
      case "repoDetail":
      case "prs":
      case "prDetail":
      case "review":
      case "cmdOutput":
      case "transcript":
        return { kind: "view", view };
      case "main":
        return { kind: "main", pane, body: mainBody(body) };
    }
  }, [logOverlay, filtering, view, composerFocused, chatPending, body, pane]);
  const bindings = useMemo(
    () => buildContextBindings(bindingContext, mode),
    [bindingContext, mode],
  );
  // The modal lists the bindings of the surface UNDER it: the context App
  // captured when `?` was pressed, or — before any open, and for the plain
  // main-view `?` — the main body's own.
  const helpBindings = useMemo(
    () => buildContextBindings(helpContext ?? { kind: "main", pane, body: mainBody(body) }, mode),
    [helpContext, body, pane, mode],
  );
  const footer = useMemo(
    () =>
      buildFooterRows({ context: bindingContext, bindings, target, chatReachable, mode, columns }),
    [bindingContext, bindings, target, chatReachable, mode, columns],
  );
  return { bindingContext, bindings, helpBindings, footer };
}
