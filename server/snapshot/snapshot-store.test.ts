import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SnapshotStore, type SessionSnapshotMeta } from './snapshot-store.js'

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
})
