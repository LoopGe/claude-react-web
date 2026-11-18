import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ForkSeedStore } from './fork-seed-store.js'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })))
})
async function tmpDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'crw-fork-seed-'))
  dirs.push(d)
  return d
}

describe('ForkSeedStore (spec §11)', () => {
  it('save persists the snapshot with spawn not started; load round-trips', async () => {
    const store = new ForkSeedStore(await tmpDir())
    await store.save('f1', [{ type: 'assistant', uuid: 'a' }])
    const loaded = await store.load('f1')
    expect(loaded).toEqual({ snapshot: [{ type: 'assistant', uuid: 'a' }], spawnStarted: false, targetLogObserved: false })
  })

  it('markSpawnStarted then markTargetLogObserved advance the markers independently', async () => {
    const store = new ForkSeedStore(await tmpDir())
    await store.save('f1', [])
    await store.markSpawnStarted('f1')
    expect((await store.load('f1'))!.spawnStarted).toBe(true)
    expect((await store.load('f1'))!.targetLogObserved).toBe(false)
    await store.markTargetLogObserved('f1')
    const loaded = await store.load('f1')
    expect(loaded!.spawnStarted).toBe(true)
    expect(loaded!.targetLogObserved).toBe(true)
  })

  it('markTargetLogObserved is a no-op without a saved seed', async () => {
    const store = new ForkSeedStore(await tmpDir())
    await store.markTargetLogObserved('missing')
    expect(await store.load('missing')).toBeNull()
  })

  it('remove deletes the seed', async () => {
    const store = new ForkSeedStore(await tmpDir())
    await store.save('f1', [])
    await store.remove('f1')
    expect(await store.load('f1')).toBeNull()
  })

  it('absent stateDir no-ops', async () => {
    const store = new ForkSeedStore(undefined)
    await store.save('f1', [])
    expect(await store.load('f1')).toBeNull()
  })

  it('I2: corrupt JSON load throws (not null) — fail closed, not "not a fork"', async () => {
    const dir = await tmpDir()
    const store = new ForkSeedStore(dir)
    await mkdir(join(dir, 'fork-seeds'), { recursive: true })
    await writeFile(join(dir, 'fork-seeds', 'f1.json'), '{ not valid json')
    await expect(store.load('f1')).rejects.toThrow()
  })

  it('I2: shape-invalid load throws (snapshot not an array)', async () => {
    const dir = await tmpDir()
    const store = new ForkSeedStore(dir)
    await mkdir(join(dir, 'fork-seeds'), { recursive: true })
    await writeFile(join(dir, 'fork-seeds', 'f1.json'), JSON.stringify({ spawnStarted: true }))
    await expect(store.load('f1')).rejects.toThrow(/corrupt-fork-seed/)
  })

  it('I2: ENOENT load returns null (verified absence)', async () => {
    const store = new ForkSeedStore(await tmpDir())
    expect(await store.load('absent')).toBeNull()
  })

  it('M9: markSpawnStarted without a saved seed creates an empty-snapshot seed', async () => {
    const store = new ForkSeedStore(await tmpDir())
    await store.markSpawnStarted('f1')
    const loaded = await store.load('f1')
    expect(loaded).toEqual({ snapshot: [], spawnStarted: true, targetLogObserved: false })
  })

})
