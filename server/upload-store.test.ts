import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rmSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
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
    it('keys by id — re-recording the same id updates the entry in place', () => {
      store.record([makeEntry({ id: 'x', name: 'old.txt' }), makeEntry({ id: 'x', name: 'new.txt' })])
      expect(store.list()).toHaveLength(1)
      expect(store.list()[0].name).toBe('new.txt')
    })

    it('keeps distinct ids even when they share one path', () => {
      store.record([makeEntry({ id: 'x' }), makeEntry({ id: 'y' })])
      expect(store.list().map((u) => u.id)).toEqual(['x', 'y'])
      expect(new Set(store.list().map((u) => u.path)).size).toBe(1)
    })

    it('record appends distinct ids in insertion order', () => {
      store.record([
        makeEntry({ id: 'a1', path: '/p/claude-web-uploads/1-a.txt', name: 'a.txt' }),
        makeEntry({ id: 'b1', path: '/p/claude-web-uploads/2-b.txt', name: 'b.txt' }),
      ])
      expect(store.list().map((u) => u.name)).toEqual(['a.txt', 'b.txt'])
    })
  })

  describe('digest index', () => {
    it('indexes entries by digest and resolves digest ids', () => {
      const digest = 'a'.repeat(64)
      store.record([
        makeEntry({ id: 'u1', path: '/tmp/a.txt', name: 'a.txt', digest }),
        makeEntry({ id: 'u2', path: '/tmp/b.txt', name: 'b.txt', digest }),
      ])
      expect(store.getByDigest(digest).map((e) => e.id)).toEqual(['u1', 'u2'])
      expect(store.getById('u1')?.path).toBe('/tmp/a.txt')
      expect(store.getById(`sha256:${digest}`)?.id).toBe('u1')
    })

    it('returns no entries for an unknown digest', () => {
      expect(store.getByDigest('b'.repeat(64))).toEqual([])
    })

    it('ignores sha256-shaped ids that are not 64 lowercase hex characters', () => {
      store.record([makeEntry({ id: 'u1', digest: 'a'.repeat(64) })])
      expect(store.getById(`sha256:${'A'.repeat(64)}`)).toBeUndefined()
      expect(store.getById('sha256:abc')).toBeUndefined()
    })

    it('drops a removed entry from its digest bucket, keeping its peers', () => {
      const digest = 'a'.repeat(64)
      store.record([
        makeEntry({ id: 'u1', digest }),
        makeEntry({ id: 'u2', path: '/tmp/b.txt', digest }),
      ])
      store.removeById('u1')
      expect(store.getByDigest(digest).map((e) => e.id)).toEqual(['u2'])
    })

    it('follows a re-recorded digest', () => {
      const first = 'a'.repeat(64)
      const second = 'b'.repeat(64)
      store.record([makeEntry({ id: 'u1', digest: first })])
      store.record([makeEntry({ id: 'u1', digest: second })])
      expect(store.getByDigest(first)).toEqual([])
      expect(store.getByDigest(second).map((e) => e.id)).toEqual(['u1'])
    })

    it('rebuilds the index when loading from disk', async () => {
      const digest = 'c'.repeat(64)
      writeFileSync(
        join(dir, 'upload-registry.json'),
        JSON.stringify([makeEntry({ id: 'u1', digest })]),
      )
      await store.load()
      expect(store.getById(`sha256:${digest}`)?.id).toBe('u1')
    })

    it('clears the index with clearAll', async () => {
      const digest = 'a'.repeat(64)
      store.record([makeEntry({ id: 'u1', digest })])
      await store.clearAll()
      expect(store.getByDigest(digest)).toEqual([])
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

    it('removeByPath removes every entry that shares the path', () => {
      const shared = '/proj/claude-web-uploads/9-shared.txt'
      store.record([
        makeEntry({ id: 'c', path: shared, name: 'shared.txt' }),
        makeEntry({ id: 'd', path: shared, name: 'shared.txt' }),
      ])
      store.removeByPath(shared)
      expect(store.getById('c')).toBeUndefined()
      expect(store.getById('d')).toBeUndefined()
      expect(store.getById('a')).toBeDefined() // a different path is untouched
    })

    it('getByPath returns the first entry recorded for a shared path', () => {
      const shared = '/proj/claude-web-uploads/9-shared.txt'
      store.record([
        makeEntry({ id: 'c', path: shared, name: 'first.txt' }),
        makeEntry({ id: 'd', path: shared, name: 'second.txt' }),
      ])
      expect(store.getByPath(shared)?.id).toBe('c')
    })

    it('getByPath returns the entry for a known path', () => {
      expect(store.getByPath('/proj/claude-web-uploads/1-a.txt')?.name).toBe('a.txt')
    })

    it('getByPath returns undefined for an unknown path', () => {
      expect(store.getByPath('/no/such/path')).toBeUndefined()
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

    it('round-trips origin: "common"', () => {
      const entry = makeEntry({ origin: 'common' })
      expect(coerceStoredUpload(entry)).toEqual(entry)
    })

    it('maps absent origin to undefined', () => {
      const raw = { id: 'a', path: '/p', cwd: '/c', name: 'a.txt', size: 1, uploadedAt: 1 }
      expect(coerceStoredUpload(raw)!.origin).toBeUndefined()
    })

    it('maps origin: "session" (unknown literal) to undefined', () => {
      const entry = makeEntry({ origin: 'session' as unknown as 'common' })
      expect(coerceStoredUpload(entry)!.origin).toBeUndefined()
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

  describe('backfillCommonDir', () => {
    it('seeds entries with cwd=stateDir, empty sessionTitle, origin common, correct size and mtime', async () => {
      const updir = join(dir, 'claude-web-uploads')
      mkdirSync(updir, { recursive: true })
      writeFileSync(join(updir, '10-report.pdf'), 'hello')

      const added = await store.backfillCommonDir()
      expect(added).toBe(1)

      const entry = store.list()[0]
      const expectedStat = statSync(join(updir, '10-report.pdf'))
      expect(entry.name).toBe('10-report.pdf')
      expect(entry.size).toBe(5)
      expect(entry.sessionTitle).toBe('')
      expect(entry.origin).toBe('common')
      expect(entry.cwd).toBe(dir)
      expect(entry.uploadedAt).toBe(expectedStat.mtimeMs)
      expect(entry.path).toBe(join(updir, '10-report.pdf'))
    })

    it('is idempotent — second run adds 0', async () => {
      const updir = join(dir, 'claude-web-uploads')
      mkdirSync(updir, { recursive: true })
      writeFileSync(join(updir, '1-a.txt'), 'x')

      const first = await store.backfillCommonDir()
      expect(first).toBe(1)
      const second = await store.backfillCommonDir()
      expect(second).toBe(0)
      expect(store.list()).toHaveLength(1)
    })

    it('skips a subdirectory inside the upload dir', async () => {
      const updir = join(dir, 'claude-web-uploads')
      mkdirSync(join(updir, 'subdir'), { recursive: true })

      const added = await store.backfillCommonDir()
      expect(added).toBe(0)
    })

    it('returns 0 without throwing for a missing dir', async () => {
      const added = await store.backfillCommonDir()
      expect(added).toBe(0)
    })
  })

  describe('backfillDigests', () => {
    function legacyEntry(path: string, overrides: Partial<UploadEntry> = {}): UploadEntry {
      return { id: 'u1', path, cwd: dir, name: 'a.txt', size: 0, uploadedAt: 1, sessionTitle: '', ...overrides }
    }

    it('backfills a digest for a legacy entry', async () => {
      const updir = join(dir, 'claude-web-uploads')
      mkdirSync(updir, { recursive: true })
      const path = join(updir, 'a.txt')
      writeFileSync(path, 'hello')
      store.record([legacyEntry(path, { size: 5 })])

      await expect(store.backfillDigests()).resolves.toBe(1)

      const digest = createHash('sha256').update('hello').digest('hex')
      expect(store.getById('u1')?.digest).toBe(digest)
      expect(store.getByDigest(digest).map((e) => e.id)).toEqual(['u1'])
    })

    it('skips missing files without throwing', async () => {
      store.record([legacyEntry(join(dir, 'claude-web-uploads', 'gone.txt'))])

      await expect(store.backfillDigests()).resolves.toBe(0)

      expect(store.getById('u1')?.digest).toBeUndefined()
    })

    it('isolates a per-entry read error and keeps hashing the rest', async () => {
      const updir = join(dir, 'claude-web-uploads')
      mkdirSync(updir, { recursive: true })
      const good = join(updir, 'good.txt')
      writeFileSync(good, 'hello')
      // A directory entry recorded by a hand edit / stale registry: reading it
      // fails with EISDIR, which must not abort the whole backfill.
      const bad = join(updir, 'a-directory')
      mkdirSync(bad)
      store.record([
        legacyEntry(good, { id: 'good', name: 'good.txt', size: 5 }),
        legacyEntry(bad, { id: 'bad', name: 'a-directory' }),
      ])

      await expect(store.backfillDigests()).resolves.toBe(1)

      expect(store.getById('good')?.digest).toBe(createHash('sha256').update('hello').digest('hex'))
      expect(store.getById('bad')?.digest).toBeUndefined()
    })

    it('leaves entries that already have a digest alone', async () => {
      const updir = join(dir, 'claude-web-uploads')
      mkdirSync(updir, { recursive: true })
      const path = join(updir, 'a.txt')
      writeFileSync(path, 'hello')
      const recorded = 'b'.repeat(64)
      store.record([legacyEntry(path, { digest: recorded })])

      await expect(store.backfillDigests()).resolves.toBe(0)

      expect(store.getById('u1')?.digest).toBe(recorded)
    })

    it('hashes more entries than the concurrency bound', async () => {
      const updir = join(dir, 'claude-web-uploads')
      mkdirSync(updir, { recursive: true })
      const entries: UploadEntry[] = []
      for (let i = 0; i < 10; i++) {
        const path = join(updir, `${i}.txt`)
        writeFileSync(path, `content-${i}`)
        entries.push(legacyEntry(path, { id: `u${i}`, name: `${i}.txt` }))
      }
      store.record(entries)

      await expect(store.backfillDigests()).resolves.toBe(10)

      for (let i = 0; i < 10; i++) {
        expect(store.getById(`u${i}`)?.digest).toBe(
          createHash('sha256').update(`content-${i}`).digest('hex'),
        )
      }
    })
  })
})
