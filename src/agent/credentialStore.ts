/**
 * An in-memory `CredentialStore` for the Pi SDK's `ModelRuntime`.
 *
 * THE SECURITY INVARIANT: junco must never write the operator's API key to
 * disk. `ModelRuntime.create` defaults `credentials` to storage file-backed at
 * `~/.pi/agent/auth.json` — and that backend CREATES the file — so every
 * `ModelRuntime.create` call in junco passes one of these instead. Nothing
 * here touches the filesystem; the Map dies with the process.
 *
 * Typed structurally against `@earendil-works/pi-ai`'s `CredentialStore`
 * (`dist/auth/types.d.ts:57-79`, verified against 0.84.4) rather than by
 * importing it: this module stays SDK-free so it is unit-testable. No cast to
 * the SDK's `CredentialStore` type exists anywhere in this codebase.
 * Conformance is checked twice at `sdkRegistryOps` (session.ts): its
 * parameter is narrowed to this module's own `InMemoryCredentialStore` (see
 * that function's doc comment), and the `satisfies CreateModelRuntimeOptions`
 * annotation on the `ModelRuntime.create(...)` options literal there
 * additionally resolves `credentials` against the SDK's real `CredentialStore`
 * — with no cast needed, since this store is structurally assignable to it.
 */

/** Mirrors pi-ai's `ApiKeyCredential` (`dist/auth/types.d.ts:15-19`). */
export interface ApiKeyCredentialLike {
  type: "api_key";
  key?: string;
}

/** Mirrors pi-ai's `CredentialInfo` (`dist/auth/types.d.ts:34-37`). */
export interface CredentialInfoLike {
  providerId: string;
  type: "api_key";
}

export interface InMemoryCredentialStore {
  read(providerId: string): Promise<ApiKeyCredentialLike | undefined>;
  list(): Promise<readonly CredentialInfoLike[]>;
  modify(
    providerId: string,
    fn: (current: ApiKeyCredentialLike | undefined) => Promise<ApiKeyCredentialLike | undefined>,
  ): Promise<ApiKeyCredentialLike | undefined>;
  delete(providerId: string): Promise<void>;
}

/**
 * `seed` maps provider id → API key. Seeding up front (rather than calling
 * `ModelRuntime.setRuntimeApiKey`, which is async in 0.84 and can reject with
 * `CredentialSynchronizationError`) reaches the same resolution result with no
 * extra failure mode and no async ordering hazard.
 */
export function inMemoryCredentialStore(
  seed: Record<string, string> = {},
): InMemoryCredentialStore {
  const creds = new Map<string, ApiKeyCredentialLike>(
    Object.entries(seed).map(([providerId, key]) => [providerId, { type: "api_key", key }]),
  );
  return {
    read: async (providerId) => creds.get(providerId),
    list: async () =>
      [...creds.keys()].map((providerId) => ({ providerId, type: "api_key" as const })),
    modify: async (providerId, fn) => {
      const current = creds.get(providerId);
      const next = await fn(current);
      // Per the SDK contract, `undefined` leaves the entry UNCHANGED (it does
      // not delete — that is `delete`'s job) and the call resolves with the
      // post-write credential. Mirrors pi-ai's own InMemoryCredentialStore.
      if (next !== undefined) creds.set(providerId, next);
      return next ?? current;
    },
    delete: async (providerId) => {
      creds.delete(providerId);
    },
  };
}
