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

  /** Permanently drop a session's cache. Awaits the in-memory store's final
   *  IDB flush (destroy) BEFORE clearing localStorage + IDB — otherwise the
   *  idle sweep's destroy()→save() IDB write could land after the clear and
   *  resurrect the orphan. Clears storage unconditionally so a cached
   *  transcript with no live store entry is still purged. */
  async delete(sessionId: string): Promise<void> {
    const entry = this.stores.get(sessionId)
    if (entry) {
      await entry.store.destroy()
      this.stores.delete(sessionId)
    }
    clearSessionStorage(sessionId)
    // Clear IDB records for the session too — a deleted session must not
    // linger in the IDB cache. Best-effort: if IDB is unavailable, the LS
    // clear above + the source-of-truth server disk log cover it.
    try {
      const db = await openDb()
      if (db) await clearSession(db, sessionId)
    } catch {
      /* best-effort */
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
