import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sessionStoreRegistry } from './registry'

// Mirrors the literal in store.ts (not exported there).
const STORAGE_PREFIX = 'claude-web-session:'

/** Seed a transcript cache entry directly, as if a prior session/tab wrote it. */
function seedCache(id: string): void {
  localStorage.setItem(
    STORAGE_PREFIX + id,
    JSON.stringify({ v: 2, savedAt: Date.now(), messages: [] }),
  )
}

describe('sessionStoreRegistry.delete', () => {
  beforeEach(async () => {
    localStorage.clear()
    await sessionStoreRegistry.clear()
  })
  afterEach(async () => {
    localStorage.clear()
    await sessionStoreRegistry.clear()
  })

  it('clears the transcript cache for a session with a live in-memory store', async () => {
    const id = 'session-with-store'
    // Touch the registry so an in-memory store exists, then give it a cache.
    sessionStoreRegistry.getOrCreate(id)
    seedCache(id)
    expect(localStorage.getItem(STORAGE_PREFIX + id)).not.toBeNull()

    await sessionStoreRegistry.delete(id)
    expect(localStorage.getItem(STORAGE_PREFIX + id)).toBeNull()
  })

  it('clears an orphan cache even when no in-memory store exists', async () => {
    // The common real case: a deleted session whose cache was written by a
    // previous tab/session, so this tab never instantiated a store for it.
    const id = 'orphan-session'
    seedCache(id)
    expect(localStorage.getItem(STORAGE_PREFIX + id)).not.toBeNull()

    await sessionStoreRegistry.delete(id)
    expect(localStorage.getItem(STORAGE_PREFIX + id)).toBeNull()
  })
})
