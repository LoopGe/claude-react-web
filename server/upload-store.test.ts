import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rmSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { UploadStore, coerceStoredUpload, type UploadEntry } from './upload-store.js'
import { tempDir } from './__test-utils__/index.js'

function makeEntry(overrides: Partial<UploadEntry> = {}): UploadEntry {
  return {
    id: 'id-1',
    path: '/proj/claude-web-uploads/1-a.txt',
    cwd: '/proj',
    name: 'a.txt',
    size: 10,
    uploadedAt: 1_700_000_000_000,
    sessionTitle: 'Session A',
    ...overrides,
  }
}

describe('UploadStore', () => {
  let dir: string
  let store: UploadStore

  beforeEach(() => {
    dir = tempDir('upload-store')
    store = new UploadStore({ stateDir: dir })
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
      writeFileSync(join(dir, 'upload-registry.json'), '{not json')
      const entries = await store.load()
      expect(entries).toEqual([])
    })

    it('returns empty array when on-disk value is not an array', async () => {
      writeFileSync(join(dir, 'upload-registry.json'), JSON.stringify({ id: 'x' }))
      const entries = await store.load()
      expect(entries).toEqual([])
    })

    it('drops malformed entries but keeps valid ones, preserving order', async () => {
      writeFileSync(
        join(dir, 'upload-registry.json'),
        JSON.stringify([
          makeEntry({ id: 'a', name: 'a.txt' }),
          { id: 'b' }, // missing everything else → dropped
          makeEntry({ id: 'c', name: 'c.txt', path: '/proj/claude-web-uploads/3-c.txt' }),
          makeEntry({ id: 'd', size: 'big' as unknown as number }), // wrong-typed size → dropped
          makeEntry({ id: 'e', uploadedAt: undefined }), // missing uploadedAt → dropped
        ]),
      )
      await store.load()
      expect(store.list().map((u) => u.id)).toEqual(['a', 'c'])
    })

    it('defaults missing sessionTitle to empty string', async () => {
      writeFileSync(
        join(dir, 'upload-registry.json'),
        JSON.stringify([
          { id: 'a', path: '/p/claude-web-uploads/1-a.txt', cwd: '/p', name: 'a.txt', size: 1, uploadedAt: 1 },
        ]),
      )
      await store.load()
      expect(store.list()[0].sessionTitle).toBe('')
    })
  })

  describe('record / keying', () => {
    it('keys by path — same path with different ids collapses to one entry', () => {
      store.record([makeEntry({ id: 'x' }), makeEntry({ id: 'y' })])
      expect(store.list()).toHaveLength(1)
      expect(store.list()[0].id).toBe('y') // upsert overwrites in place
    })

    it('record appends distinct paths in insertion order', () => {
      store.record([
        makeEntry({ path: '/p/claude-web-uploads/1-a.txt', name: 'a.txt' }),
        makeEntry({ path: '/p/claude-web-uploads/2-b.txt', name: 'b.txt' }),
      ])
      expect(store.list().map((u) => u.name)).toEqual(['a.txt', 'b.txt'])
    })
  })

  describe('getById / removeById / removeByPath', () => {
    beforeEach(() => {
      store.record([
        makeEntry({ id: 'a' }),
        makeEntry({ id: 'b', path: '/proj/claude-web-uploads/2-b.txt', name: 'b.txt' }),
      ])
    })

    it('getById finds by id, not path', () => {
      expect(store.getById('b')?.name).toBe('b.txt')
      expect(store.getById('nope')).toBeUndefined()
    })

    it('removeById removes and reports true; unknown id reports false', () => {
      expect(store.removeById('a')).toBe(true)
      expect(store.getById('a')).toBeUndefined()
      expect(store.removeById('a')).toBe(false)
    })

    it('removeByPath removes the entry with that path', () => {
      store.removeByPath('/proj/claude-web-uploads/2-b.txt')
      expect(store.getById('b')).toBeUndefined()
    })
  })

  describe('coerceStoredUpload', () => {
    it('rejects non-objects and wrong types', () => {
      expect(coerceStoredUpload(null)).toBeNull()
      expect(coerceStoredUpload('x')).toBeNull()
      expect(coerceStoredUpload({ id: 'a' })).toBeNull()
      expect(coerceStoredUpload(makeEntry({ size: Number.NaN }))).toBeNull()
    })

    it('accepts a full valid entry', () => {
      const entry = makeEntry()
      expect(coerceStoredUpload(entry)).toEqual(entry)
    })
  })

  describe('backfillFromSessions', () => {
    it('records files under <cwd>/claude-web-uploads with mtime + provenance', async () => {
      const cwd = tempDir('backfill-cwd')
      const updir = join(cwd, 'claude-web-uploads')
      mkdirSync(updir, { recursive: true })
      writeFileSync(join(updir, '10-report.pdf'), 'hello')

      const added = await store.backfillFromSessions([{ cwd, title: 'My Session' }])
      expect(added).toBe(1)

      const entry = store.list()[0]
      const expectedStat = statSync(join(updir, '10-report.pdf'))
      expect(entry.name).toBe('10-report.pdf')
      expect(entry.size).toBe(5)
      expect(entry.sessionTitle).toBe('My Session')
      expect(entry.uploadedAt).toBe(expectedStat.mtimeMs)
      expect(entry.path).toBe(join(updir, '10-report.pdf'))
      rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    })

    it('is idempotent — second run adds nothing and preserves original uploadedAt', async () => {
      const cwd = tempDir('backfill-cwd')
      const updir = join(cwd, 'claude-web-uploads')
      mkdirSync(updir, { recursive: true })
      writeFileSync(join(updir, '1-a.txt'), 'x')
      await store.backfillFromSessions([{ cwd, title: 'T1' }])
      const before = store.list()[0].uploadedAt

      const added = await store.backfillFromSessions([{ cwd, title: 'T2' }])
      expect(added).toBe(0)
      expect(store.list()).toHaveLength(1)
      expect(store.list()[0].uploadedAt).toBe(before) // not overwritten by second run
      rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    })

    it('skips sessions without cwd, missing dirs, directories, and unreadable paths', async () => {
      const added = await store.backfillFromSessions([
        { title: 'no cwd' },
        { cwd: tempDir('no-upload-dir'), title: 'empty' },
      ])
      expect(added).toBe(0)
    })
  })
})
