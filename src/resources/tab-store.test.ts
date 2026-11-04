// @vitest-environment node
// Per-session resource-pane state: tab identity `(kind, address)`, focus-on-
// reopen, close rules, navigation revision, and localStorage persistence with
// per-key validation (docs/resource-tabs-research.md §12). Pure logic — no
// DOM; the storage adapter is injected.

import { describe, it, expect } from 'vitest'
import {
  RESOURCE_PANE_KEY_PREFIX,
  ResourcePaneStore,
  type StorageLike,
} from './tab-store'
import { fileResource } from '../../shared/resource-address'

function memoryStorage(seed: Record<string, string> = {}) {
  const data = new Map(Object.entries(seed))
  const storage: StorageLike = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value)
    },
    removeItem: (key) => {
      data.delete(key)
    },
  }
  return { storage, data }
}

const keyFor = (sessionId: string) => `${RESOURCE_PANE_KEY_PREFIX}${sessionId}`
const A = fileResource('s1', '/repo/a.ts')
const B = fileResource('s1', '/repo/b.ts')
const C = fileResource('s1', '/repo/c.ts')

describe('ResourcePaneStore', () => {
  it('opening the same address twice keeps one tab and refocuses it', () => {
    const store = new ResourcePaneStore({ storage: memoryStorage().storage })
    const first = store.open('s1', A)
    expect(first.status).toBe('opened')
    const second = store.open('s1', A)
    expect(second).toEqual({ status: 'focused', tabId: (first as { tabId: string }).tabId })
    const state = store.getState('s1')
    expect(state.tabs).toHaveLength(1)
    expect(state.activeTabId).toBe((first as { tabId: string }).tabId)
  })

  it('expands the pane when content is opened', () => {
    const store = new ResourcePaneStore({ storage: memoryStorage().storage })
    expect(store.getState('s1').expanded).toBe(false)
    store.open('s1', A)
    expect(store.getState('s1').expanded).toBe(true)
  })

  it('revealIfOpened:false opens a second tab with the same address', () => {
    const store = new ResourcePaneStore({ storage: memoryStorage().storage })
    store.open('s1', A)
    const second = store.open('s1', A, { revealIfOpened: false })
    expect(second.status).toBe('opened')
    expect(store.getState('s1').tabs).toHaveLength(2)
  })

  it('keeps per-session state isolated', () => {
    const store = new ResourcePaneStore({ storage: memoryStorage().storage })
    store.open('s1', A)
    store.open('s2', fileResource('s2', '/repo/a.ts'))
    expect(store.getState('s1').tabs).toHaveLength(1)
    expect(store.getState('s2').tabs).toHaveLength(1)
    expect(store.getState('s1').tabs[0].id).not.toBe(store.getState('s2').tabs[0].id)
  })

  it('bumps the navigation revision on every open of the same tab', () => {
    const store = new ResourcePaneStore({ storage: memoryStorage().storage })
    const opened = store.open('s1', A, { params: { line: 10 } })
    const tabId = (opened as { tabId: string }).tabId
    expect(store.getNavigation(tabId)).toEqual({ params: { line: 10 }, revision: 1 })
    store.open('s1', A, { params: { line: 10 } })
    expect(store.getNavigation(tabId)).toEqual({ params: { line: 10 }, revision: 2 })
  })

  it('replaces navigation params; a plain reopen clears them', () => {
    const store = new ResourcePaneStore({ storage: memoryStorage().storage })
    const tabId = (
      store.open('s1', A, { params: { line: 10, endLine: 20 } }) as { tabId: string }
    ).tabId
    store.open('s1', A)
    const navigation = store.getNavigation(tabId)
    expect(navigation?.revision).toBe(2)
    expect(navigation?.params).toBeUndefined()
  })

  it('keeps navigation params per tab', () => {
    const store = new ResourcePaneStore({ storage: memoryStorage().storage })
    const a = (store.open('s1', A, { params: { line: 1 } }) as { tabId: string }).tabId
    const b = (store.open('s1', B, { params: { line: 2 } }) as { tabId: string }).tabId
    expect(store.getNavigation(a)?.params).toEqual({ line: 1 })
    expect(store.getNavigation(b)?.params).toEqual({ line: 2 })
  })

  it('does not persist navigation params', () => {
    const { storage, data } = memoryStorage()
    const store = new ResourcePaneStore({ storage })
    store.open('s1', A, { params: { line: 10 } })
    expect(data.get(keyFor('s1'))).not.toContain('line')
  })

  it('closing the active tab activates the previous sibling', () => {
    const store = new ResourcePaneStore({ storage: memoryStorage().storage })
    const a = (store.open('s1', A) as { tabId: string }).tabId
    const b = (store.open('s1', B) as { tabId: string }).tabId
    const c = (store.open('s1', C) as { tabId: string }).tabId

    store.close('s1', c)
    expect(store.getState('s1').activeTabId).toBe(b)
    store.close('s1', b)
    expect(store.getState('s1').activeTabId).toBe(a)
    expect(store.getState('s1').tabs).toHaveLength(1)
  })

  it('closing the last tab collapses the pane', () => {
    const store = new ResourcePaneStore({ storage: memoryStorage().storage })
    const a = (store.open('s1', A) as { tabId: string }).tabId
    store.close('s1', a)
    const state = store.getState('s1')
    expect(state.tabs).toEqual([])
    expect(state.activeTabId).toBeNull()
    expect(state.expanded).toBe(false)
  })

  it('rejects an address that does not parse without throwing', () => {
    const store = new ResourcePaneStore({ storage: memoryStorage().storage })
    expect(store.open('s1', 'not-an-address')).toEqual({ status: 'none', reason: 'invalid-address' })
    expect(store.getState('s1').tabs).toHaveLength(0)
  })

  it('rejects a kind nothing can open', () => {
    const store = new ResourcePaneStore({
      storage: memoryStorage().storage,
      canOpen: (kind) => kind === 'file',
    })
    expect(store.open('s1', 'crw-resource://diff/s1/worktree/a.ts')).toEqual({
      status: 'none',
      reason: 'unknown-kind',
    })
  })

  it('restores tabs from storage and drops addresses that no longer parse', () => {
    const { storage } = memoryStorage({
      [keyFor('s1')]: JSON.stringify({
        tabs: [
          { id: 't1', kind: 'file', address: A },
          { id: 't2', kind: 'file', address: 'garbage' },
        ],
        activeTabId: 't2',
      }),
    })
    const store = new ResourcePaneStore({ storage })
    const state = store.getState('s1')
    expect(state.tabs.map((tab) => tab.id)).toEqual(['t1'])
    expect(state.activeTabId).toBe('t1')
    // A persisted surface always starts closed — the modal must not auto-open.
    expect(state.expanded).toBe(false)
  })

  it('a corrupt session key collapses only that session and is removed', () => {
    const { storage, data } = memoryStorage({
      [keyFor('s1')]: JSON.stringify({ tabs: [{ id: 't1', kind: 'file', address: A }] }),
      [keyFor('s2')]: '{not json',
    })
    const store = new ResourcePaneStore({ storage })
    expect(store.getState('s1').tabs).toHaveLength(1)
    expect(store.getState('s2').tabs).toEqual([])
    expect(data.has(keyFor('s2'))).toBe(false)
    expect(data.has(keyFor('s1'))).toBe(true)
  })

  it('persists the pane state per session', () => {
    const { storage } = memoryStorage()
    const store = new ResourcePaneStore({ storage })
    store.open('s1', A)
    const raw = JSON.parse(storage.getItem(keyFor('s1'))!) as {
      tabs: unknown[]
      expanded?: boolean
    }
    expect(raw.tabs).toHaveLength(1)
    expect('expanded' in raw).toBe(false)
    expect(storage.getItem(keyFor('s2'))).toBeNull()
  })

  it('does not rewrite storage when only visibility changes', () => {
    const writes: string[] = []
    const storage: StorageLike = {
      getItem: () => null,
      setItem: (_key, value) => {
        writes.push(value)
      },
      removeItem: () => {},
    }
    const store = new ResourcePaneStore({ storage })
    store.open('s1', A)
    store.setExpanded('s1', false)
    store.setExpanded('s1', true)
    expect(writes).toHaveLength(1)
  })

  it('adopts another tab’s write without dropping locally open tabs', () => {
    const { storage } = memoryStorage()
    const store = new ResourcePaneStore({ storage })
    store.open('s1', A)
    // Another tab persisted a layout containing A plus B.
    store.adoptExternalWrite(
      's1',
      JSON.stringify({
        tabs: [
          { id: 't1', kind: 'file', address: A },
          { id: 't2', kind: 'file', address: B },
        ],
        activeTabId: 't2',
      }),
    )
    const state = store.getState('s1')
    expect(state.tabs.map((tab) => tab.id)).toEqual(['t1', 't2'])
    expect(state.activeTabId).toBe('t2')
    // Visibility is local host state and survives an external layout write.
    expect(state.expanded).toBe(true)
  })

  it('notifies subscribers on every mutation', () => {
    const store = new ResourcePaneStore({ storage: memoryStorage().storage })
    let calls = 0
    const off = store.subscribe(() => {
      calls++
    })
    store.open('s1', A)
    store.setExpanded('s1', false)
    store.setExpanded('s1', true)
    expect(calls).toBe(3)
    off()
    store.setExpanded('s1', true)
    expect(calls).toBe(3)
  })

  it('removeSession drops state and the stored key', () => {
    const { storage, data } = memoryStorage()
    const store = new ResourcePaneStore({ storage })
    store.open('s1', A)
    store.open('s2', fileResource('s2', '/repo/a.ts'))
    store.removeSession('s1')
    expect(store.getState('s1').tabs).toEqual([])
    expect(store.getState('s2').tabs).toHaveLength(1)
    expect(data.has(keyFor('s1'))).toBe(false)
    expect(data.has(keyFor('s2'))).toBe(true)
  })
})