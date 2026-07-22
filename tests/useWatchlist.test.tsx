// tests/useWatchlist.test.tsx
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import React from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { useWatchlist } from "../src/tui/hooks/useWatchlist.js";
import { readWatchlist, writeWatchlist } from "../src/watchlist.js";
import type { GithubRepoMapping } from "../src/types.js";
import { until } from "./helpers/until.js";

function tmpFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "junco-usewatchlist-"));
  return join(dir, "watchlist.json");
}

function Probe({
  watchlistFile,
  configRepos,
  onReady,
}: {
  watchlistFile: string;
  configRepos: GithubRepoMapping[];
  onReady: (api: ReturnType<typeof useWatchlist>) => void;
}) {
  const api = useWatchlist(watchlistFile, configRepos);
  onReady(api);
  return (
    <Text>
      {`mappings:${api.repoMappings.map((r) => r.nwo).join(",")}:error:${api.watchlistError ?? "none"}`}
    </Text>
  );
}

describe("useWatchlist", () => {
  it("repoMappings is the union of configRepos and watchlistEntries", () => {
    const file = tmpFile();
    writeWatchlist(file, [{ nwo: "alx/coral", path: "/c/coral" }]);
    const configRepos: GithubRepoMapping[] = [{ nwo: "acme/api", path: "/c/api" }];
    let api!: ReturnType<typeof useWatchlist>;
    const r = render(
      <Probe watchlistFile={file} configRepos={configRepos} onReady={(a) => (api = a)} />,
    );
    expect(api.repoMappings).toEqual([
      { nwo: "acme/api", path: "/c/api", fromConfig: true, external: false },
      { nwo: "alx/coral", path: "/c/coral", fromConfig: false, external: false },
    ]);
    expect(api.watchlistEntries).toEqual([{ nwo: "alx/coral", path: "/c/coral" }]);
    expect(api.watchlistError).toBeNull();
    r.unmount();
  });

  it("configRepos wins on an nwo collision with a watchlist entry", () => {
    const file = tmpFile();
    writeWatchlist(file, [{ nwo: "acme/api", path: "/watchlist/api" }]);
    const configRepos: GithubRepoMapping[] = [{ nwo: "acme/api", path: "/config/api" }];
    let api!: ReturnType<typeof useWatchlist>;
    render(<Probe watchlistFile={file} configRepos={configRepos} onReady={(a) => (api = a)} />);
    expect(api.repoMappings).toEqual([
      { nwo: "acme/api", path: "/config/api", fromConfig: true, external: false },
    ]);
  });

  it("addEntry appends to the watchlist, persists it, and returns true", () => {
    const file = tmpFile();
    let api!: ReturnType<typeof useWatchlist>;
    const r = render(<Probe watchlistFile={file} configRepos={[]} onReady={(a) => (api = a)} />);
    const ok = api.addEntry({ nwo: "alx/coral", path: "/c/coral" });
    expect(ok).toBe(true);
    expect(readWatchlist(file).entries).toEqual([{ nwo: "alx/coral", path: "/c/coral" }]);
    r.unmount();
  });

  it("removeEntry drops an entry by nwo (case-insensitive), persists it, and returns true", () => {
    const file = tmpFile();
    writeWatchlist(file, [
      { nwo: "alx/coral", path: "/c/coral" },
      { nwo: "beta/web", path: "/c/web" },
    ]);
    let api!: ReturnType<typeof useWatchlist>;
    const r = render(<Probe watchlistFile={file} configRepos={[]} onReady={(a) => (api = a)} />);
    const ok = api.removeEntry("ALX/CORAL");
    expect(ok).toBe(true);
    expect(readWatchlist(file).entries).toEqual([{ nwo: "beta/web", path: "/c/web" }]);
    r.unmount();
  });

  it("addEntry returns false and sets watchlistError when the file goes corrupt before the write", async () => {
    // Mount clean (watchlistError starts null), then corrupt the file on disk
    // — same "went corrupt since mount" scenario the re-read-at-write-time
    // guard exists for. addEntry must refuse to write and flip the error.
    const file = tmpFile();
    writeWatchlist(file, []);
    let api!: ReturnType<typeof useWatchlist>;
    const r = render(<Probe watchlistFile={file} configRepos={[]} onReady={(a) => (api = a)} />);
    expect(api.watchlistError).toBeNull();
    const corrupted = "{ not valid json";
    writeFileSync(file, corrupted, "utf8");
    const ok = api.addEntry({ nwo: "alx/coral", path: "/c/coral" });
    expect(ok).toBe(false);
    await until(() => api.watchlistError !== null);
    expect(api.watchlistError).not.toBeNull();
    // Bytes untouched — the corrupt file must never be clobbered by addEntry.
    expect(readFileSync(file, "utf8")).toBe(corrupted);
    r.unmount();
  });
});
