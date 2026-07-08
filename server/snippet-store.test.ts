import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SnippetStore, coerceStoredSnippet, type StoredSnippet } from './snippet-store.js'
import { tempDir } from './__test-utils__/index.js'

function makeSnippet(overrides: Partial<StoredSnippet> = {}): StoredSnippet {
  return {
    id: 'id-1',
    label: 'Label',
    content: 'Content',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  }
}

describe('SnippetStore', () => {
  let dir: string
  let store: SnippetStore

  beforeEach(() => {
    dir = tempDir('snippet-store')
    store = new SnippetStore({ stateDir: dir })
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  describe('load', () => {
    it('returns empty array when file is missing (ENOENT)', async () => {
      const entries = await store.load()
      expect(entries).toEqual([])
      expect(store.list()).toEqual([])
    })

    it('returns empty array on corrupt JSON without throwing', async () => {
      writeFileSync(join(dir, 'composer-snippets.json'), '{not json')
      const entries = await store.load()
      expect(entries).toEqual([])
    })

    it('returns empty array when on-disk value is not an array', async () => {
      writeFileSync(join(dir, 'composer-snippets.json'), JSON.stringify({ id: 'x' }))
      const entries = await store.load()
      expect(entries).toEqual([])
    })

    it('drops malformed entries but keeps valid ones, preserving order', async () => {
      writeFileSync(
        join(dir, 'composer-snippets.json'),
        JSON.stringify([
          makeSnippet({ id: 'a', label: 'A' }),
          { id: 'b' }, // missing label/content → dropped
          makeSnippet({ id: 'c', label: 'C' }),
          { label: 'no-id', content: 'x' }, // missing id → dropped
        ]),
      )
      await store.load()
      expect(store.list().map((s) => s.id)).toEqual(['a', 'c'])
    })
  })

  describe('upsert / list ordering', () => {
    it('appends new snippets in insertion order', () => {
      store.upsert(makeSnippet({ id: 'a' }))
      store.upsert(makeSnippet({ id: 'b' }))
      store.upsert(makeSnippet({ id: 'c' }))
      expect(store.list().map((s) => s.id)).toEqual(['a', 'b', 'c'])
    })

    it('updates an existing snippet in place without reordering', () => {
      store.upsert(makeSnippet({ id: 'a' }))
      store.upsert(makeSnippet({ id: 'b' }))
      store.upsert(makeSnippet({ id: 'a', label: 'A2' }))
      expect(store.list().map((s) => s.id)).toEqual(['a', 'b'])
      expect(store.get('a')?.label).toBe('A2')
    })
  })

  describe('reorder', () => {
    beforeEach(() => {
      store.upsert(makeSnippet({ id: 'a' }))
      store.upsert(makeSnippet({ id: 'b' }))
      store.upsert(makeSnippet({ id: 'c' }))
    })

    it('reorders to the exact requested order', () => {
      store.reorder(['c', 'a', 'b'])
      expect(store.list().map((s) => s.id)).toEqual(['c', 'a', 'b'])
    })

    it('appends entries not mentioned in the id list (defensive)', () => {
      store.reorder(['c'])
      expect(store.list().map((s) => s.id)).toEqual(['c', 'a', 'b'])
    })

    it('ignores unknown ids without crashing', () => {
      store.reorder(['zzz', 'b', 'a', 'c'])
      expect(store.list().map((s) => s.id)).toEqual(['b', 'a', 'c'])
    })

    it('persists the new order after flush', async () => {
      store.reorder(['c', 'b', 'a'])
      await store.flush()
      const raw = JSON.parse(readFileSync(join(dir, 'composer-snippets.json'), 'utf8')) as StoredSnippet[]
      expect(raw.map((s) => s.id)).toEqual(['c', 'b', 'a'])
    })
  })

  describe('importMany', () => {
    it('imports new snippets and is idempotent by id on re-run', () => {
      const incoming = [
        { id: 'a', label: 'A', content: 'x' },
        { id: 'b', label: 'B', content: 'y' },
      ]
      const first = store.importMany(incoming)
      expect(first).toEqual({ imported: 2, skipped: 0 })
      const second = store.importMany(incoming)
      expect(second).toEqual({ imported: 0, skipped: 2 })
      expect(store.list().map((s) => s.id)).toEqual(['a', 'b'])
    })

    it('skips malformed entries', () => {
      const result = store.importMany([
        { id: 'a', label: 'A', content: 'x' },
        { id: '', label: 'bad', content: 'x' },
      ])
      expect(result).toEqual({ imported: 1, skipped: 1 })
    })
  })
})

describe('coerceStoredSnippet', () => {
  it('rejects missing id / label / content', () => {
    expect(coerceStoredSnippet({ label: 'a', content: 'b' })).toBeNull()
    expect(coerceStoredSnippet({ id: 'x', content: 'b' })).toBeNull()
    expect(coerceStoredSnippet({ id: 'x', label: 'a', content: '' })).toBeNull()
    expect(coerceStoredSnippet({ id: 'x', label: '   ', content: 'b' })).toBeNull()
  })

  it('backfills timestamps when absent', () => {
    const s = coerceStoredSnippet({ id: 'x', label: 'a', content: 'b' })
    expect(s).not.toBeNull()
    expect(typeof s!.createdAt).toBe('number')
    expect(typeof s!.updatedAt).toBe('number')
  })
})

describe('SnippetStore.clearAll', () => {
  let dir: string
  let store: SnippetStore

  beforeEach(() => {
    dir = tempDir('snippet-clearall')
    store = new SnippetStore({ stateDir: dir })
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  it('removes all snippets and flushes to disk', async () => {
    await store.load()
    store.upsert(makeSnippet({ id: 'a', label: 'A' }))
    store.upsert(makeSnippet({ id: 'b', label: 'B' }))
    await store.flush()
    expect(store.list()).toHaveLength(2)

    await store.clearAll()
    expect(store.list()).toHaveLength(0)

    // Re-read from disk to confirm flush
    const store2 = new SnippetStore({ stateDir: dir })
    expect(await store2.load()).toHaveLength(0)
  })

  it('is a no-op when store is already empty', async () => {
    await store.load()
    await store.clearAll()
    expect(store.list()).toHaveLength(0)
  })
})
