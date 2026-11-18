import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ResetJournal } from './reset-journal.js'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })))
})
async function tmpDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'crw-journal-'))
  dirs.push(d)
  return d
}

describe('ResetJournal (spec §8.3)', () => {
  it('prepare then commit advances clearEpoch and persists committed', async () => {
    const dir = await tmpDir()
    const j = new ResetJournal(dir, 's1')
    await j.prepare({ generation: 5, reason: 'clear' })
    expect(j.latest?.state).toBe('prepared')
    await j.commit(5)
    expect(j.clearEpoch).toBe(1)
    expect(j.latest?.state).toBe('committed')
    const reloaded = new ResetJournal(dir, 's1')
    await reloaded.ready
    expect(reloaded.latest).toMatchObject({ generation: 5, state: 'committed' })
    expect(reloaded.clearEpoch).toBe(1)
  })

  it('recovery reason advances rebaseEpoch, not clearEpoch', async () => {
    const dir = await tmpDir()
    const j = new ResetJournal(dir, 's1')
    await j.prepare({ generation: 9, reason: 'recovery' })
    await j.commit(9)
    expect(j.rebaseEpoch).toBe(1)
    expect(j.clearEpoch).toBe(0)
  })

  it('epochs accumulate across multiple resets and persist', async () => {
    const dir = await tmpDir()
    const j = new ResetJournal(dir, 's1')
    await j.prepare({ generation: 5, reason: 'clear' })
    await j.commit(5)
    await j.prepare({ generation: 6, reason: 'compact', seedBoundaryUuid: 'b' })
    await j.commit(6)
    expect(j.clearEpoch).toBe(2)
    const reloaded = new ResetJournal(dir, 's1')
    await reloaded.ready
    expect(reloaded.clearEpoch).toBe(2)
    expect(reloaded.latest).toMatchObject({ generation: 6, reason: 'compact', state: 'committed' })
  })

  it('recover undoes a prepared reset with no provider floor', async () => {
    const dir = await tmpDir()
    const j = new ResetJournal(dir, 's1')
    await j.prepare({ generation: 5, reason: 'compact', seedBoundaryUuid: 'b' })
    expect(await j.recover(() => false)).toBe('undone')
    expect(j.latest).toBeNull()
    const reloaded = new ResetJournal(dir, 's1')
    await reloaded.ready
    expect(reloaded.latest).toBeNull()
  })

  it('recover completes a prepared reset whose provider floor exists', async () => {
    const dir = await tmpDir()
    const j = new ResetJournal(dir, 's1')
    await j.prepare({ generation: 5, reason: 'compact', seedBoundaryUuid: 'b' })
    expect(await j.recover(() => true)).toBe('completed')
    expect(j.latest?.state).toBe('committed')
    expect(j.clearEpoch).toBe(1)
  })

  it('recover fails journal-inconsistent when committed lacks provider evidence', async () => {
    const dir = await tmpDir()
    const j = new ResetJournal(dir, 's1')
    await j.prepare({ generation: 5, reason: 'compact' })
    await j.commit(5)
    expect(await j.recover(() => false)).toBe('journal-inconsistent')
  })

  it('recover committed-ok when committed has provider evidence', async () => {
    const dir = await tmpDir()
    const j = new ResetJournal(dir, 's1')
    await j.prepare({ generation: 5, reason: 'compact' })
    await j.commit(5)
    expect(await j.recover(() => true)).toBe('committed-ok')
  })

  it('recover with no journal is a no-op (committed-ok)', async () => {
    const dir = await tmpDir()
    const j = new ResetJournal(dir, 's1')
    await j.ready
    expect(await j.recover(() => false)).toBe('committed-ok')
    expect(j.latest).toBeNull()
  })

  it('undoPrepared clears a prepared entry without bumping epochs', async () => {
    const dir = await tmpDir()
    const j = new ResetJournal(dir, 's1')
    await j.prepare({ generation: 5, reason: 'clear' })
    await j.undoPrepared()
    expect(j.latest).toBeNull()
    expect(j.clearEpoch).toBe(0)
  })

  it('commit without a prepared entry throws', async () => {
    const dir = await tmpDir()
    const j = new ResetJournal(dir, 's1')
    await j.ready
    await expect(j.commit(5)).rejects.toThrow()
  })

  it('absent stateDir no-ops persistence but keeps in-memory state', async () => {
    const j = new ResetJournal(undefined, 's1')
    await j.prepare({ generation: 5, reason: 'clear' })
    await j.commit(5)
    expect(j.clearEpoch).toBe(1)
    expect(j.latest?.state).toBe('committed')
  })
})
