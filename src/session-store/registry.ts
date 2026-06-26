import { SessionStore, clearSessionStorage } from './store'
import { openDb, clearSession } from './idb'

interface StoreEntry {
  store: SessionStore
  refCount: number
  /** Timestamp when refCount last dropped to 0, or 0 if currently retained. */
  idleSince: number
}

/** How long (ms) a store with refCount=0 stays in memory before eviction. */
const IDLE_TTL_MS = 5 * 60 * 1000 // 5 minutes

/** How often (ms) to sweep for idle stores. */
const SWEEP_INTERVAL_MS = 60 * 1000 // 1 minute

class SessionStoreRegistry {
  private stores = new Map<string, StoreEntry>()
  private sweepTimer: ReturnType<typeof setInterval> | null = null
  /** True while a sweep is in flight — prevents overlapping sweeps from
   *  double-destroying the same store (the `await destroy()` yields, and the
   *  60s interval could start a second sweep before the first finishes). */
  private sweeping = false

  getOrCreate(sessionId: string): SessionStore {
    const existing = this.stores.get(sessionId)
    if (existing) return existing.store
    const created: StoreEntry = {
      store: new SessionStore(sessionId),
      refCount: 0,
      idleSince: Date.now(),
    }
    this.stores.set(sessionId, created)
    this.ensureSweep()
    return created.store
  }

  retain(sessionId: string): SessionStore {
    const entry = this.ensureEntry(sessionId)
    entry.refCount += 1
    entry.idleSince = 0 // Cancel idle countdown
    return entry.store
  }

  release(sessionId: string): void {
    const entry = this.stores.get(sessionId)
    if (!entry) return
    entry.refCount = Math.max(0, entry.refCount - 1)
    if (entry.refCount === 0) {
      entry.idleSince = Date.now()
    }
  }

  /** Permanently drop a session's cache. Uses store.purge() (which writes
   *  NOTHING — it drains in-flight writes via the generation bump, then clears
   *  LS + IDB) so there's no "save then clear" window where a rapid re-open
   *  hydrates from a stale LS key. Clears storage unconditionally so a cached
   *  transcript with no live store entry is still purged. */
  async delete(sessionId: string): Promise<void> {
    const entry = this.stores.get(sessionId)
    if (entry) {
      await entry.store.purge()
      this.stores.delete(sessionId)
    } else {
      clearSessionStorage(sessionId)
      // No live store — clear IDB best-effort.
      try {
        const db = await openDb()
        if (db) await clearSession(db, sessionId)
      } catch {
        /* best-effort */
      }
    }
  }

  private ensureEntry(sessionId: string): StoreEntry {
    const existing = this.stores.get(sessionId)
    if (existing) return existing
    const created: StoreEntry = {
      store: new SessionStore(sessionId),
      refCount: 0,
      idleSince: Date.now(),
    }
    this.stores.set(sessionId, created)
    this.ensureSweep()
    return created
  }

  /** Start the periodic sweep if not already running. */
  private ensureSweep(): void {
    if (this.sweepTimer) return
    this.sweepTimer = setInterval(() => { void this.sweep() }, SWEEP_INTERVAL_MS)
    // Allow the process to exit even if the timer is still running.
    if (this.sweepTimer.unref) this.sweepTimer.unref()
  }

  /** Evict stores whose refCount has been 0 for longer than IDLE_TTL_MS. */
  private async sweep(): Promise<void> {
    if (this.sweeping) return
    this.sweeping = true
    try {
      const now = Date.now()
      for (const [id, entry] of this.stores) {
        if (entry.refCount === 0 && entry.idleSince > 0 && now - entry.idleSince > IDLE_TTL_MS) {
          await entry.store.destroy()
          this.stores.delete(id)
        }
      }
      // Stop the sweep timer if there are no more stores to track.
      if (this.stores.size === 0 && this.sweepTimer) {
        clearInterval(this.sweepTimer)
        this.sweepTimer = null
      }
    } finally {
      this.sweeping = false
    }
  }

  async clear(): Promise<void> {
    for (const entry of this.stores.values()) await entry.store.destroy()
    this.stores.clear()
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = null
    }
  }
}

export const sessionStoreRegistry = new SessionStoreRegistry()
