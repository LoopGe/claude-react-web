// Task 1 (session-synchronizer): the React adapter over the session command
// factory. `useSessionCommands(sessionId)` resolves the session's store and
// returns its shared `SessionCommands` instance.
//
// Memoization is keyed by the SessionStore instance (a WeakMap), so every
// caller for a given session — the Chat and SideChatDrawer components today
// — shares ONE factory result. The entry is
// GC'd when the store leaves the registry (session deleted), so the cache
// never outlives the store it serves.
import { getSessionStore } from '../session-store/selectors'
import { createSessionCommands, type SessionCommands } from '../session-store/commands'
import type { SessionStore } from '../session-store/store'

const commandsByStore = new WeakMap<SessionStore, SessionCommands>()

/** Returns the shared `SessionCommands` for the given session's store.
 *  One factory result per session store (WeakMap cache keyed by the
 *  SessionStore instance). Safe to call from any React component or hook;
 *  the lookup is a pure read of the registry, and the cache write is
 *  idempotent. */
export function useSessionCommands(sessionId: string): SessionCommands {
  const store = getSessionStore(sessionId)
  const cached = commandsByStore.get(store)
  if (cached !== undefined) return cached
  const created = createSessionCommands(store)
  commandsByStore.set(store, created)
  return created
}
