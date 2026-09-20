import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
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

  it('update chains writes and filters fork copy', async () => {
    await store.update('x', () =>
      empty({
        byMessage: { U1: { start: 'a' }, U2: { start: 'b' } },
        patches: [
          { messageId: 'A1', hash: 'a', files: ['/w/f1'] },
          { messageId: 'A2', hash: 'b', files: ['/w/f2'] },
        ],
      }),
    )
    await store.copyForFork('x', 'y', new Set(['U1']), new Set(['A1']))
    const y = await store.load('y')
    expect(y?.byMessage).toEqual({ U1: { start: 'a' } })
    expect(y?.patches).toEqual([{ messageId: 'A1', hash: 'a', files: ['/w/f1'] }])
    await store.remove('y')
    expect(await store.load('y')).toBeNull()
  })
})
