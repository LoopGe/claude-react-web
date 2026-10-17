import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sessionStoreRegistry } from './registry'
import { sweepLegacyTranscriptCache } from './legacy-transcript-cache'

// Mirrors the legacy key prefix the pre-seq-refactor builds wrote. Since the
// seq-window refactor nothing reads or writes these keys; the ONLY sanctioned
// removal path is the boot-time sweep (legacy-transcript-cache.ts) — not
// registry.delete, which used to clear them per session and thereby let
// long-lived orphans accumulate until they starved the ~5MB quota.
const STORAGE_PREFIX = 'claude-web-session:'

describe('sessionStoreRegistry.delete', () => {
  beforeEach(async () => {
    localStorage.clear()
    await sessionStoreRegistry.clear()
  })
  afterEach(async () => {
    localStorage.clear()
    await sessionStoreRegistry.clear()
  })

  it('deletes an in-memory store without touching legacy localStorage keys', async () => {
    const id = 'session-with-store'
    sessionStoreRegistry.getOrCreate(id)
    localStorage.setItem(STORAGE_PREFIX + id, 'stale-legacy-data')
    // Deleting a session that still has a live store must evict the store
    // (a later getOrCreate returns a fresh one) — but legacy keys are NOT
    // its business: per-key deletion is what let orphans accumulate. The
    // boot sweep owns them.
    await sessionStoreRegistry.delete(id)
    expect(localStorage.getItem(STORAGE_PREFIX + id)).toBe('stale-legacy-data')
  })

  it('delete of an unknown session is a safe no-op', async () => {
    localStorage.setItem(STORAGE_PREFIX + 'orphan-session', 'stale')
    await sessionStoreRegistry.delete('orphan-session')
    expect(localStorage.getItem(STORAGE_PREFIX + 'orphan-session')).toBe('stale')
  })

  it('the boot sweep removes legacy keys that delete() left behind', async () => {
    // The full modern lifecycle: orphans accumulate (written by pre-refactor
    // builds), the sweep wipes them all at next boot.
    localStorage.setItem(STORAGE_PREFIX + 'orphan-session', 'stale')
    await sessionStoreRegistry.delete('orphan-session')
    expect(localStorage.getItem(STORAGE_PREFIX + 'orphan-session')).toBe('stale')
    expect(sweepLegacyTranscriptCache()).toBe(1)
    expect(localStorage.getItem(STORAGE_PREFIX + 'orphan-session')).toBeNull()
  })
})
