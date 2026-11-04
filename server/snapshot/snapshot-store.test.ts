import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SnapshotStore, type SessionSnapshotMeta, type TurnChangesRecord } from './snapshot-store.js'
import { capturesDir, metaFile } from './paths.js'

let dir: string
let store: SnapshotStore

function empty(over: Partial<SessionSnapshotMeta> = {}): SessionSnapshotMeta {
  return {
    version: 1,
    gitDir: '/g',
    worktree: '/w',
    scope: '.',
    byMessage: {},
    patches: [],
    ...over,
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'snap-meta-'))
  store = new SnapshotStore(dir)
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('SnapshotStore', () => {
  it('returns null when missing; save/load roundtrips', async () => {
    expect(await store.load('s1')).toBeNull()
    const meta = empty({ byMessage: { U1: { start: 'tree1' } } })
    await store.save('s1', meta)
    expect(await store.load('s1')).toEqual(meta)
  })

  it('treats corrupt JSON as null', async () => {
    await store.save('s1', empty())
    const file = join(dir, 'snapshots', 'meta', 's1.json')
    const { writeFile } = await import('node:fs/promises')
    await writeFile(file, '{not json', 'utf8')
    expect(await store.load('s1')).toBeNull()
  })

  it('update reads previous value through the write chain', async () => {
    await store.update('x', () =>
      empty({
        byMessage: { U1: { start: 'a' }, U2: { start: 'b' } },
        patches: [
          { messageId: 'A1', hash: 'a', files: ['/w/f1'] },
          { messageId: 'A2', hash: 'b', files: ['/w/f2'] },
        ],
      }),
    )
    const loaded = await store.load('x')
    expect(loaded?.byMessage).toEqual({ U1: { start: 'a' }, U2: { start: 'b' } })
    expect(loaded?.patches).toHaveLength(2)
  })

  it('copyForFork filters byMessage and patches to kept sets', async () => {
    await store.save('x', empty({
      byMessage: { U1: { start: 'a' }, U2: { start: 'b' } },
      patches: [
        { messageId: 'A1', hash: 'a', files: ['/w/f1'] },
        { messageId: 'A2', hash: 'b', files: ['/w/f2'] },
      ],
    }))
    await store.copyForFork('x', 'y', new Set(['U1']), new Set(['A1']))
    const y = await store.load('y')
    expect(y?.byMessage).toEqual({ U1: { start: 'a' } })
    expect(y?.patches).toEqual([{ messageId: 'A1', hash: 'a', files: ['/w/f1'] }])
  })

  it('copyForFork clears last', async () => {
    await store.save('x', empty({
      last: { tree: 'deadbeef', at: 1234567890 },
    }))
    await store.copyForFork('x', 'y', new Set(), new Set())
    const y = await store.load('y')
    expect(y?.last).toBeUndefined()
  })

  it('remove deletes the sidecar', async () => {
    await store.save('x', empty())
    expect(await store.load('x')).not.toBeNull()
    await store.remove('x')
    expect(await store.load('x')).toBeNull()
  })

  it('remove also deletes the odb directory', async () => {
    const { mkdir } = await import('node:fs/promises')
    const odbPath = join(dir, 'snapshots', 'odb', 'x', 'objects')
    await mkdir(odbPath, { recursive: true })
    await store.save('x', empty())
    await store.remove('x')
    // odb directory should be gone
    await expect(
      import('node:fs/promises').then((fs) => fs.access(join(dir, 'snapshots', 'odb', 'x'))),
    ).rejects.toThrow()
  })

  it('remove is ENOENT-tolerant when odb dir is missing', async () => {
    await store.save('x', empty())
    // Should not throw even though odb/x does not exist
    await store.remove('x')
    expect(await store.load('x')).toBeNull()
  })

  it('copyForFork copies odb so remove(fromId) does not destroy fork objects', async () => {
    const { mkdir, writeFile, access } = await import('node:fs/promises')
    // Create source odb with a dummy object
    const srcOdb = join(dir, 'snapshots', 'odb', 'x', 'objects', 'pack')
    await mkdir(srcOdb, { recursive: true })
    await writeFile(join(srcOdb, 'dummy'), 'data')
    await store.save('x', empty({
      gitDir: join(dir, 'snapshots', 'odb', 'x'),
      byMessage: { U1: { start: 'a' }, U2: { start: 'b' } },
      patches: [
        { messageId: 'A1', hash: 'a', files: ['/w/f1'] },
        { messageId: 'A2', hash: 'b', files: ['/w/f2'] },
      ],
    }))
    await store.copyForFork('x', 'y', new Set(['U1']), new Set(['A1']))
    // Fork's gitDir should point to its own odb, not the source's
    const y = await store.load('y')
    expect(y?.gitDir).toBe(join(dir, 'snapshots', 'odb', 'y'))
    expect(y?.gitDir).not.toBe(join(dir, 'snapshots', 'odb', 'x'))
    // Fork's odb directory should exist with copied content
    await expect(access(join(dir, 'snapshots', 'odb', 'y', 'objects', 'pack', 'dummy'))).resolves.toBeUndefined()
    // Remove source — fork should still be intact
    await store.remove('x')
    expect(await store.load('x')).toBeNull()
    const yAfter = await store.load('y')
    expect(yAfter).not.toBeNull()
    expect(yAfter?.gitDir).toBe(join(dir, 'snapshots', 'odb', 'y'))
    await expect(access(join(dir, 'snapshots', 'odb', 'y', 'objects', 'pack', 'dummy'))).resolves.toBeUndefined()
  })

  it('remove then update does not recreate the file (tombstone)', async () => {
    await store.save('x', empty({ last: { tree: 'old', at: 100 } }))
    await store.remove('x')
    expect(await store.load('x')).toBeNull()
    // A concurrent fire-and-forget update should not resurrect the session
    await store.update('x', () => empty({ last: { tree: 'new', at: 200 } }))
    expect(await store.load('x')).toBeNull()
  })

  it('capAnchors evicts oldest byMessage entries beyond MAX_ANCHORS', async () => {
    const byMessage: Record<string, { start: string }> = {}
    for (let i = 0; i < 502; i++) {
      byMessage[`U${i}`] = { start: `tree${i}` }
    }
    await store.save('x', empty({ byMessage }))
    const loaded = await store.load('x')
    // Only the last 500 entries should survive
    const keys = Object.keys(loaded!.byMessage)
    expect(keys.length).toBe(500)
    expect(keys[0]).toBe('U2')
    expect(keys[keys.length - 1]).toBe('U501')
  })

  it('tolerates metadata without turns and round-trips a turn record', async () => {
    await store.save('x', empty())
    expect((await store.load('x'))?.turns ?? []).toEqual([])

    const turn: TurnChangesRecord = {
      resultUuid: 'r1', assistantUuid: 'a1', start: 't0', end: 't1', at: 2, total: 1, added: 1, deleted: 0,
      files: [{
        path: 'src/a.ts', display: 'src/a.ts', status: 'added', additions: 1, deletions: 0,
        source: { kind: 'tree', repoPath: 'src/a.ts' },
      }],
    }
    await store.update('x', (prev) => prev && { ...prev, turns: [turn] })
    expect((await store.load('x'))?.turns?.[0]?.resultUuid).toBe('r1')
  })

  it('rejects a non-array turns field', async () => {
    await mkdir(join(dir, 'snapshots', 'meta'), { recursive: true })
    await writeFile(metaFile(dir, 'x'), JSON.stringify({ ...empty(), turns: 'bad' }), 'utf8')
    expect(await store.load('x')).toBeNull()
  })

  it('capAnchors evicts the oldest turn records beyond MAX_ANCHORS', async () => {
    const turns: TurnChangesRecord[] = Array.from({ length: 502 }, (_, i) => ({
      resultUuid: `r${i}`, assistantUuid: `a${i}`, start: 's', end: 'e', at: i, total: 0, added: 0, deleted: 0, files: [],
    }))
    await store.save('x', empty({ turns }))
    const loaded = await store.load('x')
    expect(loaded?.turns).toHaveLength(500)
    expect(loaded?.turns?.[0]?.resultUuid).toBe('r2')
  })

  it('copyForFork filters turns by assistant uuid and copies captures', async () => {
    const hash = 'abc123'
    await mkdir(capturesDir(dir, 'x'), { recursive: true })
    await writeFile(join(capturesDir(dir, 'x'), hash), 'content')

    const turn = (resultUuid: string, assistantUuid: string): TurnChangesRecord => ({
      resultUuid, assistantUuid, start: 's', end: 'e', at: 1, total: 1, added: 1, deleted: 0,
      files: [{
        path: 'a.local', display: 'a.local', status: 'modified', additions: 1, deletions: 0,
        source: { kind: 'copy', before: join(capturesDir(dir, 'x'), hash), after: null },
      }],
    })
    await store.save('x', empty({ turns: [turn('r1', 'a1'), turn('r2', 'a2')] }))
    await store.copyForFork('x', 'y', new Set(), new Set(['a1']))
    expect((await store.load('y'))?.turns?.map((t) => t.resultUuid)).toEqual(['r1'])
    await expect(access(join(capturesDir(dir, 'y'), hash))).resolves.toBeUndefined()
  })

  it('revive clears tombstone so a re-created session can write again', async () => {
    await store.save('x', empty({ last: { tree: 'old', at: 100 } }))
    await store.remove('x')
    expect(await store.load('x')).toBeNull()
    // Tombstone prevents update
    await store.update('x', () => empty({ last: { tree: 'new', at: 200 } }))
    expect(await store.load('x')).toBeNull()
    // Revive clears the tombstone
    store.revive('x')
    await store.update('x', () => empty({ last: { tree: 'new', at: 200 } }))
    const loaded = await store.load('x')
    expect(loaded).not.toBeNull()
    expect(loaded?.last?.tree).toBe('new')
  })
})
