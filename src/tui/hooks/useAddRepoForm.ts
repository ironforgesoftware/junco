import { useCallback, useState } from "react";
import type { MutableRefObject, Dispatch, SetStateAction } from "react";
import { join } from "node:path";
import type { DashboardClient } from "../ghClient.js";
import type { View } from "../App.js";
import type { ConfirmState } from "./useConfirm.js";
import { parseRepoInput } from "../../githubInbox.js";
import { expandHome } from "../../config.js";
import type { WatchlistEntry } from "../../watchlist.js";
import type { ToastKind } from "../theme.js";

/**
 * add-repo-modal domain: owns the form's error/busy state plus the
 * submit flow (`handleAddRepo`) — permission probe → fork-PR provisioning OR
 * clone+validate → `addEntry` (injected, Task 13's `useWatchlist.addEntry`) →
 * navigate back + toast → best-effort bot-access grant (confirm-gated for
 * private personal repos via the injected `askConfirm`). `aliveRef` drops any
 * continuation after unmount (one guard per await below) so an in-flight
 * validate never writes the watchlist post-unmount. `setAddRepoError`
 * is exposed deliberately: App resets it at the form-open site, same coupling
 * pattern as `useReview`'s exposed `setReviewState`.
 */
export function useAddRepoForm(opts: {
  client: DashboardClient;
  clonesDir: string;
  addEntry: (entry: WatchlistEntry) => boolean;
  showToast: (kind: ToastKind, text: string) => void;
  setView: (v: View) => void;
  aliveRef: MutableRefObject<boolean>;
  watchlistError: string | null;
  askConfirm: (state: ConfirmState) => void;
}): {
  addRepoError: string | null;
  addRepoBusy: string | null;
  handleAddRepo: (rawNwo: string, path: string) => Promise<void>;
  setAddRepoError: Dispatch<SetStateAction<string | null>>;
} {
  const { client, clonesDir, addEntry, showToast, setView, aliveRef, watchlistError, askConfirm } =
    opts;
  const [addRepoError, setAddRepoError] = useState<string | null>(null);
  const [addRepoBusy, setAddRepoBusy] = useState<string | null>(null);

  const handleAddRepo = useCallback(
    async (rawNwo: string, path: string): Promise<void> => {
      let nwo = rawNwo;
      if (watchlistError) {
        showToast("error", "watchlist unreadable — fix it before writing");
        return;
      }
      // Accept bare owner/repo or a pasted github.com URL.
      const parsed = parseRepoInput(nwo);
      if (parsed === null) {
        setAddRepoError("enter owner/repo or a github.com URL (e.g. https://github.com/acme/api)");
        return;
      }
      nwo = parsed;
      // No push access → fork-PR mode: junco manages the fork + clone; the
      // bridge never polls this entry (external: true). A failed/unknown probe
      // (offline) falls through to the owned-repo flow unchanged.
      setAddRepoBusy("checking permissions…");
      const perm = await client.repoPermission(nwo);
      if (!aliveRef.current) return;
      if (perm.ok && !perm.value.canPush) {
        if (path.trim() !== "") {
          setAddRepoBusy(null);
          setAddRepoError("no push access to this repo — leave path empty (managed fork mode)");
          return;
        }
        setAddRepoBusy("forking & cloning…");
        const prep = await client.prepareExternalRepo(nwo);
        if (!aliveRef.current) return;
        setAddRepoBusy(null);
        if (!prep.ok) {
          setAddRepoError(prep.error);
          return;
        }
        if (!addEntry({ nwo, path: prep.value.path, external: true })) {
          setView("main");
          showToast("error", "watchlist unreadable — not written");
          return;
        }
        setView("main");
        showToast("success", `watching ${nwo} (fork-PR mode via ${prep.value.forkNwo})`);
        return;
      }
      // Empty path = clone into the managed directory for the operator.
      let expanded: string;
      setAddRepoError(null);
      if (path.trim() === "") {
        const [owner, repo] = nwo.split("/");
        expanded = join(clonesDir, owner ?? nwo, repo ?? "repo");
        setAddRepoBusy("cloning repository…");
        const cloned = await client.cloneRepo(nwo, expanded);
        if (!aliveRef.current) return;
        if (!cloned.ok) {
          setAddRepoBusy(null);
          setAddRepoError(cloned.error);
          return;
        }
      } else {
        expanded = expandHome(path); // ONE expansion point: validate + store agree
      }
      setAddRepoBusy("validating…");
      const res = await client.validateAndPrepareRepo(nwo, expanded);
      if (!aliveRef.current) return;
      setAddRepoBusy(null);
      if (!res.ok) {
        setAddRepoError(res.error);
        return;
      }
      if (!addEntry({ nwo, path: expanded })) {
        setView("main");
        showToast("error", "watchlist unreadable — not written");
        return;
      }
      setView("main");
      showToast("success", `watching ${nwo}`);
      // Bot mode: make sure the DAEMON's identity can push here too — the
      // operator's own permission (checked above) says nothing about the
      // bot's. Failure warns with the fix but never un-adds the repo.
      const runGrant = async (): Promise<void> => {
        const grant = await client.ensureBotAccess(nwo);
        if (!aliveRef.current) return;
        if (!grant.ok) {
          showToast("error", `bot access: ${grant.error.split("\n")[0]}`);
        } else if (!grant.value.skipped) {
          showToast("success", `bot ${grant.value.login} granted write on ${nwo}`);
        }
      };
      const pre = await client.botGrantPreflight(nwo);
      if (!aliveRef.current) return;
      if (pre.ok) {
        if (!pre.value.needed) return; // bot mode off, or the bot already has push
        if (pre.value.privatePersonal) {
          // Inviting the bot into a PRIVATE repo on a PERSONAL account is the
          // one grant the operator confirms first — the invitation is
          // outward-facing (it lands in the bot's GitHub inbox and is
          // auto-accepted). Declining leaves the repo watched, grant-less.
          askConfirm({
            title: "invite bot as collaborator?",
            body:
              `${nwo} is private on a personal account — junco will send a ` +
              `collaborator invitation (write access) to the bot ${pre.value.login} ` +
              `and auto-accept it.`,
            danger: false,
            onConfirm: () => void runGrant(),
            onCancel: () =>
              showToast("info", `bot access skipped — grant later with: junco auth grant ${nwo}`),
          });
          return;
        }
      }
      // Preflight failed (offline?) or no gate applies — legacy silent grant.
      await runGrant();
    },
    [client, watchlistError, clonesDir, showToast, addEntry, setView, aliveRef, askConfirm],
  );

  return { addRepoError, addRepoBusy, handleAddRepo, setAddRepoError };
}
