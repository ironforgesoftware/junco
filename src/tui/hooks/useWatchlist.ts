import { useCallback, useMemo, useState } from "react";
import { readWatchlist, writeWatchlist } from "../../watchlist.js";
import type { WatchlistEntry } from "../../watchlist.js";
import type { GithubRepoMapping } from "../../types.js";
import type { WatchedMapping } from "../railModel.js";

/**
 * Watchlist domain: the mutable watched-repo list (backed by `watchlistFile`
 * on disk) plus `repoMappings` — the config ∪ watchlist union that feeds the
 * whole GitHub surface (rail, issues, PRs). `addEntry`/`removeEntry` re-read
 * the file fresh at write time (never clobber a file that went corrupt since
 * mount): on a read error they set `watchlistError` and return `false`
 * without writing; on success they persist and return `true`. Callers own
 * every other side effect (toasts, view changes, issue/PR eviction) — this
 * hook owns only the on-disk list and its derived union.
 */
export function useWatchlist(
  watchlistFile: string,
  configRepos: GithubRepoMapping[],
): {
  repoMappings: WatchedMapping[];
  watchlistEntries: WatchlistEntry[];
  watchlistError: string | null;
  addEntry: (entry: WatchlistEntry) => boolean;
  removeEntry: (nwo: string) => boolean;
  reload: () => void;
} {
  const initialWatchlist = readWatchlist(watchlistFile);
  const [watchlistEntries, setWatchlistEntries] = useState<WatchlistEntry[]>(
    initialWatchlist.entries,
  );
  const [watchlistError, setWatchlistError] = useState<string | null>(initialWatchlist.error);

  // Config repos ∪ watchlist, deduped by nwo (config wins) — recomputed after
  // every watchlist write since setWatchlistEntries drives this memo.
  const repoMappings = useMemo(() => {
    const out: WatchedMapping[] = configRepos.map((r) => ({
      nwo: r.nwo,
      path: r.path,
      fromConfig: true,
      external: false,
    }));
    const seen = new Set(out.map((r) => r.nwo.toLowerCase()));
    for (const e of watchlistEntries) {
      if (seen.has(e.nwo.toLowerCase())) continue;
      seen.add(e.nwo.toLowerCase());
      // external === true → fork-PR mode: dispatch queues a ticket (no labels).
      out.push({ nwo: e.nwo, path: e.path, fromConfig: false, external: e.external === true });
    }
    return out;
  }, [configRepos, watchlistEntries]);

  const commitMutation = useCallback(
    (mutate: (cur: WatchlistEntry[]) => WatchlistEntry[]): boolean => {
      // Re-read at write time: never clobber a file that went corrupt since mount.
      const { entries: cur, error } = readWatchlist(watchlistFile);
      if (error) {
        setWatchlistError(error);
        return false;
      }
      const next = mutate(cur);
      writeWatchlist(watchlistFile, next);
      setWatchlistEntries(next);
      return true;
    },
    [watchlistFile],
  );

  const addEntry = useCallback(
    (entry: WatchlistEntry): boolean => commitMutation((cur) => [...cur, entry]),
    [commitMutation],
  );
  const removeEntry = useCallback(
    (nwo: string): boolean =>
      commitMutation((cur) => cur.filter((e) => e.nwo.toLowerCase() !== nwo.toLowerCase())),
    [commitMutation],
  );

  // Re-read the file into state after something ELSE wrote it — the `unwatch`
  // CLI owns the removal now, so the dashboard has to pick the result up
  // rather than mutate its own copy. Error state is always refreshed (a file
  // that went corrupt must surface); entries only on a clean read, so a
  // transient parse failure can't blank the rail.
  const reload = useCallback(() => {
    const { entries, error } = readWatchlist(watchlistFile);
    setWatchlistError(error);
    if (!error) setWatchlistEntries(entries);
  }, [watchlistFile]);

  return { repoMappings, watchlistEntries, watchlistError, addEntry, removeEntry, reload };
}
