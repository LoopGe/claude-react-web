import { SessionStore, clearSessionStorage } from './store'

interface StoreEntry {
  store: SessionStore
  refCount: number
}

class SessionStoreRegistry {
  private stores = new Map<string, StoreEntry>()

  getOrCreate(sessionId: string): SessionStore {
    const existing = this.stores.get(sessionId)
    if (existing) return existing.store
    const created: StoreEntry = {
      store: new SessionStore(sessionId),
      refCount: 0,
    }
    this.stores.set(sessionId, created)
    return created.store
  }

  retain(sessionId: string): SessionStore {
    const entry = this.ensureEntry(sessionId)
    entry.refCount += 1
    return entry.store
  }

  release(sessionId: string): void {
    const entry = this.stores.get(sessionId)
    if (!entry) return
    entry.refCount = Math.max(0, entry.refCount - 1)
  }

  delete(sessionId: string): void {
    const entry = this.stores.get(sessionId)
    if (!entry) return
    entry.store.destroy()
    clearSessionStorage(sessionId)
    this.stores.delete(sessionId)
  }

  private ensureEntry(sessionId: string): StoreEntry {
    const existing = this.stores.get(sessionId)
    if (existing) return existing
    const created: StoreEntry = {
      store: new SessionStore(sessionId),
      refCount: 0,
    }
    this.stores.set(sessionId, created)
    return created
  }

  clear(): void {
    for (const entry of this.stores.values()) entry.store.destroy()
    this.stores.clear()
  }
}

export const sessionStoreRegistry = new SessionStoreRegistry()
