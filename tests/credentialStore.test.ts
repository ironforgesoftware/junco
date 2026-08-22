import { describe, it, expect } from "vitest";
import { inMemoryCredentialStore } from "../src/agent/credentialStore.js";

describe("inMemoryCredentialStore", () => {
  it("reads back a seeded api key as an api_key credential", async () => {
    const store = inMemoryCredentialStore({ omlx: "sk-secret" });
    expect(await store.read("omlx")).toEqual({ type: "api_key", key: "sk-secret" });
  });

  it("returns undefined for an unseeded provider", async () => {
    const store = inMemoryCredentialStore({ omlx: "sk-secret" });
    expect(await store.read("anthropic")).toBeUndefined();
  });

  it("lists seeded providers without exposing secrets", async () => {
    const store = inMemoryCredentialStore({ omlx: "sk-secret", anthropic: "sk-other" });
    const listed = await store.list();
    expect([...listed].map((c) => c.providerId).sort()).toEqual(["anthropic", "omlx"]);
    expect(JSON.stringify(listed)).not.toContain("sk-secret");
  });

  it("modify writes through and delete removes", async () => {
    const store = inMemoryCredentialStore();
    const returned = await store.modify("omlx", async () => ({ type: "api_key", key: "k1" }));
    expect(returned).toEqual({ type: "api_key", key: "k1" });
    expect(await store.read("omlx")).toEqual({ type: "api_key", key: "k1" });
    await store.delete("omlx");
    expect(await store.read("omlx")).toBeUndefined();
  });

  it("modify returning undefined leaves the entry unchanged and resolves with the current credential", async () => {
    const store = inMemoryCredentialStore({ omlx: "k1" });
    const returned = await store.modify("omlx", async () => undefined);
    expect(returned).toEqual({ type: "api_key", key: "k1" });
    expect(await store.read("omlx")).toEqual({ type: "api_key", key: "k1" });
  });

  it("starts empty when no seed is given", async () => {
    expect(await inMemoryCredentialStore().list()).toEqual([]);
  });
});
