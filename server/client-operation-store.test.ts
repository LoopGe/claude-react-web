import { describe, it, expect } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClientOperationStore } from './client-operation-store.js'

async function tmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'client-op-'))
}

describe('ClientOperationStore (spec §8.3 idempotency)', () => {
  it('records a dispatch and returns it by clientOperationId', async () => {
    const dir = await tmpDir()
    try {
      const store = new ClientOperationStore(dir)
      expect(await store.get('s1', 'op-1')).toBeNull()
      await store.record('s1', { clientOperationId: 'op-1', promptUuid: 'U1', receivedAt: 123 })
      expect(await store.get('s1', 'op-1')).toEqual({ clientOperationId: 'op-1', promptUuid: 'U1', receivedAt: 123 })
      // A different key is unseen; a different session is isolated.
      expect(await store.get('s1', 'op-2')).toBeNull()
      expect(await store.get('s2', 'op-1')).toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('persists across store instances (a retry after restart dedups)', async () => {
    const dir = await tmpDir()
    try {
      const a = new ClientOperationStore(dir)
      await a.record('s1', { clientOperationId: 'op-1', promptUuid: 'U1', receivedAt: 1 })
      const b = new ClientOperationStore(dir)
      expect(await b.get('s1', 'op-1')).toEqual({ clientOperationId: 'op-1', promptUuid: 'U1', receivedAt: 1 })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('a repeat key replaces its prior entry (no duplicate)', async () => {
    const dir = await tmpDir()
    try {
      const store = new ClientOperationStore(dir)
      await store.record('s1', { clientOperationId: 'op-1', promptUuid: 'U1' })
      await store.record('s1', { clientOperationId: 'op-1', promptUuid: 'U1', receivedAt: 9 })
      const entries = await store.load('s1')
      expect(entries).toHaveLength(1)
      expect(entries![0]).toEqual({ clientOperationId: 'op-1', promptUuid: 'U1', receivedAt: 9 })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('bounds the window to the newest 256 entries', async () => {
    const dir = await tmpDir()
    try {
      const store = new ClientOperationStore(dir)
      for (let i = 0; i < 300; i++) {
        await store.record('s1', { clientOperationId: `op-${i}`, promptUuid: `U${i}` })
      }
      const entries = await store.load('s1')
      expect(entries).toHaveLength(256)
      // Oldest evicted; newest retained.
      expect(await store.get('s1', 'op-0')).toBeNull()
      expect(await store.get('s1', 'op-299')).toEqual({ clientOperationId: 'op-299', promptUuid: 'U299' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('remove tombstones the session; revive clears it', async () => {
    const dir = await tmpDir()
    try {
      const store = new ClientOperationStore(dir)
      await store.record('s1', { clientOperationId: 'op-1', promptUuid: 'U1' })
      await store.remove('s1')
      expect(await store.get('s1', 'op-1')).toBeNull()
      // A record after remove no-ops until revive.
      await store.record('s1', { clientOperationId: 'op-2', promptUuid: 'U2' })
      expect(await store.get('s1', 'op-2')).toBeNull()
      store.revive('s1')
      await store.record('s1', { clientOperationId: 'op-3', promptUuid: 'U3' })
      expect(await store.get('s1', 'op-3')).toEqual({ clientOperationId: 'op-3', promptUuid: 'U3' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('no-ops without a state dir', async () => {
    const store = new ClientOperationStore(undefined)
    await store.record('s1', { clientOperationId: 'op-1', promptUuid: 'U1' })
    expect(await store.get('s1', 'op-1')).toBeNull()
  })
})