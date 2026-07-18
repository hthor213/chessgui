// Player identity (spec 225 follow-on): the I/O half. The user's own
// names/aliases persist through the StorageProvider KV (localStorage on both
// shells — no new provider needed), and drive board orientation when a loaded
// game names the user on one side. Pure parsing/matching lives in
// @chessgui/core/identity.

import { cleanNames, parseIdentityStore, type IdentityStore } from "@chessgui/core/identity"
import { getProviders } from "@/lib/platform"

const IDENTITY_KEY = "chessgui-identity-names"

/** The user's names, cleaned (deduped, blank-free). Empty when never set. */
export function loadIdentityNames(): string[] {
  return parseIdentityStore(getProviders().storage.get(IDENTITY_KEY)).names
}

/** Persist the name list, cleaned first. Returns what was stored. */
export function saveIdentityNames(names: string[]): string[] {
  const store: IdentityStore = { v: 1, names: cleanNames(names) }
  getProviders().storage.set(IDENTITY_KEY, JSON.stringify(store))
  return store.names
}
