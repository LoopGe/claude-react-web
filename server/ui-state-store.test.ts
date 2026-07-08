import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rmSync } from 'node:fs'
import { UiStateStore } from './ui-state-store.js'
import type { UiState } from './ui-state-store.js'
import { tempDir } from './__test-utils__/index.js'

function makeGroupsState(): UiState {
  return {
    groups: [{ id: 'g1', name: 'Group 1', sessionIds: ['s1', 's2'] }],
    sidebarOrder: ['s1', 's2', 's3'],
    collapsedGroups: { g1: true },
  }
}

describe('UiStateStore.clearAll', () => {
  let dir: string
  let store: UiStateStore

  beforeEach(() => {
    dir = tempDir('ui-state-clearall')
    store = new UiStateStore({ stateDir: dir })
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  it('resets to empty state and flushes to disk', async () => {
    await store.load()
    store.update(makeGroupsState())
    await store.flush()
    expect(store.getState().groups).toHaveLength(1)

    await store.clearAll()
    const state = store.getState()
    expect(state.groups).toEqual([])
    expect(state.sidebarOrder).toEqual([])
    expect(state.collapsedGroups).toEqual({})

    // Re-read from disk to confirm flush
    const store2 = new UiStateStore({ stateDir: dir })
    const loaded = await store2.load()
    expect(loaded.groups).toEqual([])
    expect(loaded.sidebarOrder).toEqual([])
    expect(loaded.collapsedGroups).toEqual({})
  })

  it('is a no-op when state is already empty', async () => {
    await store.load()
    await store.clearAll()
    const state = store.getState()
    expect(state.groups).toEqual([])
    expect(state.sidebarOrder).toEqual([])
    expect(state.collapsedGroups).toEqual({})
  })
})
