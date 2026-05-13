import { SessionStore } from './store'

const MAX_IDLE_STORES = 5

interface StoreEntry {
  store: SessionStore
  refCount: number
  releasedAt: number
}

class SessionStoreRegistry {
  private stores = new Map<string, StoreEntry>()

  getOrCreate(sessionId: string): SessionStore {
    const existing = this.stores.get(sessionId)
    if (existing) return existing.store
    const created: StoreEntry = {
      store: new SessionStore(sessionId),
      refCount: 0,
      releasedAt: 0,
    }
    this.stores.set(sessionId, created)
    this.pruneIdle()
    return created.store
  }

  retain(sessionId: string): SessionStore {
    const entry = this.ensureEntry(sessionId)
    entry.refCount += 1
    entry.releasedAt = 0
    return entry.store
  }

  release(sessionId: string): void {
    const entry = this.stores.get(sessionId)
    if (!entry) return
    entry.refCount = Math.max(0, entry.refCount - 1)
    if (entry.refCount === 0) {
      entry.releasedAt = Date.now()
      this.pruneIdle()
    }
  }

  delete(sessionId: string): void {
    const entry = this.stores.get(sessionId)
    if (!entry) return
    entry.store.destroy()
    this.stores.delete(sessionId)
  }

  private ensureEntry(sessionId: string): StoreEntry {
    const existing = this.stores.get(sessionId)
    if (existing) return existing
    const created: StoreEntry = {
      store: new SessionStore(sessionId),
      refCount: 0,
      releasedAt: 0,
    }
    this.stores.set(sessionId, created)
    return created
  }

  clear(): void {
    for (const entry of this.stores.values()) entry.store.destroy()
    this.stores.clear()
  }

  private pruneIdle(): void {
    const idleEntries = Array.from(this.stores.entries())
      .filter(([, entry]) => entry.refCount === 0)
      .sort((a, b) => a[1].releasedAt - b[1].releasedAt)
    while (idleEntries.length > MAX_IDLE_STORES) {
      const [sessionId] = idleEntries.shift()!
      const entry = this.stores.get(sessionId)
      if (!entry || entry.refCount !== 0) continue
      entry.store.destroy()
      this.stores.delete(sessionId)
    }
  }
}

export const sessionStoreRegistry = new SessionStoreRegistry()
