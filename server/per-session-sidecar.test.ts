import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PerSessionSidecar } from './per-session-sidecar.js'
import { writeAtomic } from './json-file-store.js'
import { TurnAnchorStore, type TurnAnchorEntry } from './turn-anchor-store.js'

interface Item { id: string }

async function exists(file: string): Promise<boolean> {
  try {
    await access(file)
    return true
  } catch (err) {
    expect((err as NodeJS.ErrnoException).code).toBe('ENOENT')
    return false
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => { resolve = r })
  return { promise, resolve }
}

describe('PerSessionSidecar', () => {
  let root: string
  let dir: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sidecar-'))
    dir = join(root, 'items')
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('update after remove does not recreate the file; revive re-enables writes', async () => {
    const sc = new PerSessionSidecar<Item>({ dir, label: 'test' })
    await sc.update('s1', () => [{ id: 'a' }])
    expect(await exists(join(dir, 's1.json'))).toBe(true)

    await sc.remove('s1')
    await sc.update('s1', (prev) => [...(prev ?? []), { id: 'b' }])
    expect(await exists(join(dir, 's1.json'))).toBe(false)
    expect(await sc.load('s1')).toBeNull()

    sc.revive('s1')
    await sc.update('s1', (prev) => [...(prev ?? []), { id: 'c' }])
    expect(await sc.load('s1')).toEqual([{ id: 'c' }])
    expect(await exists(join(dir, 's1.json'))).toBe(true)
  })

  it('an update already writing when remove is called lands before the unlink (file gone afterwards)', async () => {
    const gate = deferred()
    const started = deferred()
    let writes = 0
    const sc = new PerSessionSidecar<Item>({
      dir,
      label: 'test',
      write: async (d, f, data) => {
        started.resolve()
        await gate.promise
        await writeAtomic(d, f, data)
        writes++
      },
    })
    const u = sc.update('s1', () => [{ id: 'a' }])
    await started.promise
    const r = sc.remove('s1')
    // A fire-and-forget update after the remove is dropped at enqueue.
    const late = sc.update('s1', () => [{ id: 'late' }])
    gate.resolve()
    await Promise.all([u, r, late])
    expect(writes).toBe(1)
    expect(await exists(join(dir, 's1.json'))).toBe(false)
    expect(await sc.load('s1')).toBeNull()
  })

  it('an update still queued behind another write when remove is called is dropped', async () => {
    const gate = deferred()
    const started = deferred()
    let writes = 0
    const sc = new PerSessionSidecar<Item>({
      dir,
      label: 'test',
      write: async (d, f, data) => {
        started.resolve()
        await gate.promise
        await writeAtomic(d, f, data)
        writes++
      },
    })
    const first = sc.update('s1', () => [{ id: 'a' }])
    const queued = sc.update('s1', (prev) => [...(prev ?? []), { id: 'b' }])
    await started.promise
    const r = sc.remove('s1')
    gate.resolve()
    await Promise.all([first, queued, r])
    expect(writes).toBe(1)
    expect(await exists(join(dir, 's1.json'))).toBe(false)
  })

  it('sessions do not wait on each other', async () => {
    const gateA = deferred()
    const sc = new PerSessionSidecar<Item>({
      dir,
      label: 'test',
      write: async (d, f, data) => {
        if (f.endsWith('A.json')) await gateA.promise
        await writeAtomic(d, f, data)
      },
    })
    let aDone = false
    const a = sc.update('A', () => [{ id: 'a' }]).then(() => { aDone = true })
    await sc.update('B', () => [{ id: 'b' }])
    expect(aDone).toBe(false)
    expect(await exists(join(dir, 'B.json'))).toBe(true)
    expect(await sc.load('B')).toEqual([{ id: 'b' }])
    gateA.resolve()
    await a
    expect(await sc.load('A')).toEqual([{ id: 'a' }])
  })

  it('serves appends from the cache instead of re-reading the file', async () => {
    let reads = 0
    const sc = new PerSessionSidecar<Item>({
      dir,
      label: 'test',
      read: async (f) => { reads++; return readFile(f, 'utf8') },
    })
    await sc.update('s1', (prev) => [...(prev ?? []), { id: 'a' }]) // miss: ENOENT read
    expect(reads).toBe(1)
    await sc.update('s1', (prev) => [...(prev ?? []), { id: 'b' }])
    await sc.update('s1', (prev) => [...(prev ?? []), { id: 'c' }])
    expect(await sc.load('s1')).toEqual([{ id: 'a' }, { id: 'b' }, { id: 'c' }])
    expect(reads).toBe(1)
  })

  it('load returns a copy, not the cached array', async () => {
    const sc = new PerSessionSidecar<Item>({ dir, label: 'test' })
    await sc.update('s1', () => [{ id: 'a' }])
    const first = await sc.load('s1')
    first!.push({ id: 'mutated' })
    expect(await sc.load('s1')).toEqual([{ id: 'a' }])
  })

  it('a failed write drops the cache and does not wedge the chain', async () => {
    let fail = false
    let reads = 0
    const sc = new PerSessionSidecar<Item>({
      dir,
      label: 'test',
      read: async (f) => { reads++; return readFile(f, 'utf8') },
      write: async (d, f, data) => {
        if (fail) throw new Error('disk full')
        await writeAtomic(d, f, data)
      },
    })
    await sc.update('s1', () => [{ id: 'a' }])
    fail = true
    await expect(sc.update('s1', (prev) => [...(prev ?? []), { id: 'b' }])).resolves.toBeUndefined()
    fail = false
    const readsBefore = reads
    expect(await sc.load('s1')).toEqual([{ id: 'a' }]) // back to disk
    expect(reads).toBe(readsBefore + 1)
  })

  it('keeps the on-disk format: pretty JSON array in, JSON array out', async () => {
    await mkdir(dir, { recursive: true })
    const legacy = [{ id: 'old1' }, { id: 'old2' }]
    await writeFile(join(dir, 's1.json'), JSON.stringify(legacy, null, 2), 'utf8')
    const sc = new PerSessionSidecar<Item>({ dir, label: 'test' })
    expect(await sc.load('s1')).toEqual(legacy)

    await sc.update('s1', (prev) => [...(prev ?? []), { id: 'new' }])
    const raw = await readFile(join(dir, 's1.json'), 'utf8')
    expect(raw).toBe(JSON.stringify([...legacy, { id: 'new' }], null, 2))
    expect(JSON.parse(raw)).toEqual([...legacy, { id: 'new' }])
  })

  it('returns null for a non-array file', async () => {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 's1.json'), '{"not":"an array"}', 'utf8')
    const sc = new PerSessionSidecar<Item>({ dir, label: 'test' })
    expect(await sc.load('s1')).toBeNull()
  })

  it('no-ops everything when dir is null', async () => {
    const sc = new PerSessionSidecar<Item>({ dir: null, label: 'test' })
    await expect(sc.update('s1', () => [{ id: 'a' }])).resolves.toBeUndefined()
    await expect(sc.load('s1')).resolves.toBeNull()
    await expect(sc.remove('s1')).resolves.toBeUndefined()
    expect(await exists(dir)).toBe(false)
  })
})

describe('TurnAnchorStore on PerSessionSidecar', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'turn-anchors-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('50 concurrent appends on one session all persist', async () => {
    const store = new TurnAnchorStore(root, 100)
    const entries: TurnAnchorEntry[] = Array.from({ length: 50 }, (_, i) => ({
      assistantUuid: `a${i}`,
      completedAt: 1000 + i,
    }))
    await Promise.all(entries.map((e) => store.append('s1', e)))
    expect(await store.load('s1')).toEqual(entries)
    // Same content on disk (a fresh store has an empty cache).
    expect(await new TurnAnchorStore(root, 100).load('s1')).toEqual(entries)
  })

  it('append after remove does not recreate the file; revive re-enables', async () => {
    const store = new TurnAnchorStore(root, 100)
    await store.append('s1', { assistantUuid: 'a1', completedAt: 1 })
    const removing = store.remove('s1')
    void store.append('s1', { assistantUuid: 'a2', completedAt: 2 })
    await removing
    await store.load('s1') // drains the chain
    expect(await exists(join(root, 'turn-anchors', 's1.json'))).toBe(false)

    store.revive('s1')
    await store.append('s1', { assistantUuid: 'a3', completedAt: 3 })
    expect(await store.load('s1')).toEqual([{ assistantUuid: 'a3', completedAt: 3 }])
  })
})
