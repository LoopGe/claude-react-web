import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskResultStore } from './task-result-store.js'
import type { TaskRecordUi } from '../shared/tasks.js'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'task-results-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const rec = (taskId: string, over: Partial<TaskRecordUi> = {}): TaskRecordUi => ({
  taskId,
  description: `desc ${taskId}`,
  status: 'completed',
  updatedAt: 1,
  ...over,
})

describe('TaskResultStore', () => {
  it('saves and reloads records, including result bodies', async () => {
    const store = new TaskResultStore(dir)
    await store.save('s1', [rec('t1', { result: 'OUTPUT-1' }), rec('t2')])
    const reloaded = await new TaskResultStore(dir).load('s1')
    expect(reloaded).toHaveLength(2)
    expect(reloaded!.find((r) => r.taskId === 't1')!.result).toBe('OUTPUT-1')
  })

  it('save replaces the whole set (upsert-by-taskId is the caller\'s job)', async () => {
    const store = new TaskResultStore(dir)
    await store.save('s1', [rec('t1'), rec('t2')])
    await store.save('s1', [rec('t1', { result: 'UPDATED' })])
    const reloaded = await store.load('s1')
    expect(reloaded).toHaveLength(1)
    expect(reloaded![0]!.result).toBe('UPDATED')
  })

  it('caps terminal records at MAX_TERMINAL_TASKS, keeping the newest', async () => {
    const store = new TaskResultStore(dir)
    const many = Array.from({ length: 60 }, (_, i) =>
      rec(`t${String(i).padStart(3, '0')}`, { status: 'completed', updatedAt: i }))
    await store.save('s1', many)
    const reloaded = await store.load('s1')
    expect(reloaded).toHaveLength(50)
    // Newest 50 survive: t010..t059
    expect(reloaded![0]!.taskId).toBe('t010')
    expect(reloaded![49]!.taskId).toBe('t059')
  })

  it('never drops non-terminal records when capping', async () => {
    const store = new TaskResultStore(dir)
    const mixed = [
      rec('live1', { status: 'running' }),
      ...Array.from({ length: 60 }, (_, i) => rec(`t${i}`, { status: 'completed', updatedAt: i })),
    ]
    await store.save('s1', mixed)
    const reloaded = await store.load('s1')
    expect(reloaded!.some((r) => r.taskId === 'live1')).toBe(true)
  })

  it('load returns null for a session with no sidecar', async () => {
    expect(await new TaskResultStore(dir).load('nope')).toBeNull()
  })

  it('tolerates a corrupted JSON file without throwing', async () => {
    await mkdir(join(dir, 'task-results'), { recursive: true })
    await writeFile(join(dir, 'task-results', 's1.json'), '{not json', 'utf8')
    expect(await new TaskResultStore(dir).load('s1')).toBeNull()
  })

  it('remove deletes the file and tombstones against a late save', async () => {
    const store = new TaskResultStore(dir)
    await store.save('s1', [rec('t1')])
    await store.remove('s1')
    await store.save('s1', [rec('t1')]) // tombstoned — must not recreate
    await expect(readFile(join(dir, 'task-results', 's1.json'), 'utf8')).rejects.toThrow()
    expect(await store.load('s1')).toBeNull()
  })

  it('revive clears the tombstone', async () => {
    const store = new TaskResultStore(dir)
    await store.save('s1', [rec('t1')])
    await store.remove('s1')
    store.revive('s1')
    await store.save('s1', [rec('t2')])
    expect(await store.load('s1')).toHaveLength(1)
  })
})
