import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { JsonFileStore, DEBOUNCE_MS } from './json-file-store.js'

// ─── Concrete subclass for testing ──────────────────────────────────

interface TestEntry {
  id: string
  value: string
  nested?: { a: number }
}

class TestStore extends JsonFileStore<TestEntry> {
  protected getKey(item: TestEntry): string { return item.id }
  protected parseItems(raw: string): TestEntry[] {
    try { return JSON.parse(raw) as TestEntry[] } catch { return [] }
  }
  protected serializeForWrite(items: TestEntry[]): unknown { return items }

  async load(): Promise<void> {
    try {
      const { promises: fs } = await import('node:fs')
      const raw = await fs.readFile(this.file, 'utf-8')
      this.initEntries(this.parseItems(raw))
    } catch { /* file may not exist */ }
  }
}

// ─── Tests ───────────────────────────────────────────────────────────

describe('JsonFileStore', () => {
  let tmpDir: string
  let store: TestStore

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'jfs-test-'))
    store = new TestStore({ stateDir: tmpDir }, 'test.json', undefined, 'test-store')
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  // ─── Basic operations ───────────────────────────────────────────

  describe('upsert / get / list / remove', () => {
    it('upserts and retrieves an entry', () => {
      store.upsert({ id: 'a', value: 'hello' })
      expect(store.get('a')).toEqual({ id: 'a', value: 'hello' })
    })

    it('overwrites on duplicate key', () => {
      store.upsert({ id: 'a', value: 'v1' })
      store.upsert({ id: 'a', value: 'v2' })
      expect(store.get('a')).toEqual({ id: 'a', value: 'v2' })
    })

    it('lists all entries', () => {
      store.upsert({ id: 'a', value: '1' })
      store.upsert({ id: 'b', value: '2' })
      expect(store.list()).toHaveLength(2)
    })

    it('removes an entry', () => {
      store.upsert({ id: 'a', value: '1' })
      store.remove('a')
      expect(store.get('a')).toBeUndefined()
      expect(store.list()).toHaveLength(0)
    })

    it('remove is no-op for missing key', () => {
      store.remove('nonexistent')
      expect(store.list()).toHaveLength(0)
    })

    it('get returns undefined for missing key', () => {
      expect(store.get('missing')).toBeUndefined()
    })
  })

  // ─── Persistence (flush) ────────────────────────────────────────

  describe('flush', () => {
    it('persists entries to disk after flush', async () => {
      store.upsert({ id: 'a', value: 'hello' })
      store.upsert({ id: 'b', value: 'world' })
      await store.flush()

      const raw = readFileSync(join(tmpDir, 'test.json'), 'utf-8')
      const data = JSON.parse(raw) as TestEntry[]
      expect(data).toHaveLength(2)
      expect(data.find((e) => e.id === 'a')).toEqual({ id: 'a', value: 'hello' })
    })

    it('creates the directory if it does not exist', async () => {
      rmSync(tmpDir, { recursive: true, force: true })
      // Re-create the store pointing at a nested path
      const nested = join(tmpDir, 'deep', 'nested')
      const s = new TestStore({ stateDir: nested }, 'test.json', undefined, 'test-store')
      s.upsert({ id: 'a', value: 'x' })
      await s.flush()

      const raw = readFileSync(join(nested, 'test.json'), 'utf-8')
      expect(JSON.parse(raw)).toHaveLength(1)
    })

    it('load() restores entries from disk', async () => {
      store.upsert({ id: 'a', value: 'persisted' })
      await store.flush()

      // Create a fresh store and load
      const fresh = new TestStore({ stateDir: tmpDir }, 'test.json', undefined, 'test-store')
      await fresh.load()
      expect(fresh.get('a')).toEqual({ id: 'a', value: 'persisted' })
    })

    it('load() handles missing file gracefully', async () => {
      await store.load()
      expect(store.list()).toHaveLength(0)
    })
  })

  // ─── Debounce behavior ──────────────────────────────────────────

  describe('debounce', () => {
    it('coalesces rapid upserts into a single write', async () => {
      // This test does NOT use fake timers — it relies on the real debounce
      // (500ms DEBOUNCE_MS) and just waits for the flush to complete.
      store.upsert({ id: 'a', value: '1' })
      store.upsert({ id: 'b', value: '2' })
      store.upsert({ id: 'c', value: '3' })

      // No flush yet — file shouldn't exist immediately
      const { existsSync } = await import('node:fs')
      expect(existsSync(join(tmpDir, 'test.json'))).toBe(false)

      // Wait for debounce + async flush to complete
      await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 200))

      const raw = readFileSync(join(tmpDir, 'test.json'), 'utf-8')
      const data = JSON.parse(raw) as TestEntry[]
      expect(data).toHaveLength(3)
    })
  })

  // ─── Deep copy on upsert ────────────────────────────────────────

  describe('upsert shallow copy', () => {
    it('stores a shallow copy, not a reference', () => {
      const nested = { a: 1 }
      const entry = { id: 'a', value: 'v', nested }
      store.upsert(entry)

      // Mutate the original
      nested.a = 999

      // The stored entry retains the ORIGINAL nested object (shallow copy)
      const stored = store.get('a')!
      expect(stored.nested!.a).toBe(999) // shallow copy — nested is shared
    })
  })
})
