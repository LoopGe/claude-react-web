import { describe, it, expect, vi } from 'vitest'
import { PinnedMessageStore } from './pinned-message-store'

describe('PinnedMessageStore', () => {
  it('starts empty with no presence', () => {
    const store = new PinnedMessageStore()
    expect(store.getSnapshot()).toEqual({ info: null, text: '' })
    expect(store.getPresence()).toBe(false)
  })

  it('stores the pinned message and reports presence', () => {
    const store = new PinnedMessageStore()
    store.set({ id: 'a', text: 'A' })
    expect(store.getSnapshot()).toEqual({ info: { id: 'a', text: 'A' }, text: 'A' })
    expect(store.getPresence()).toBe(true)
  })

  it('retains the last text after the pinned message clears (exit animation)', () => {
    const store = new PinnedMessageStore()
    store.set({ id: 'a', text: 'A' })
    store.set(null)
    expect(store.getSnapshot().info).toBeNull()
    expect(store.getSnapshot().text).toBe('A')
    expect(store.getPresence()).toBe(false)
  })

  it('notifies subscribers on change and stops after unsubscribe', () => {
    const store = new PinnedMessageStore()
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)
    store.set({ id: 'a', text: 'A' })
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
    store.set({ id: 'b', text: 'B' })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('does not notify when the snapshot is unchanged', () => {
    const store = new PinnedMessageStore()
    const info = { id: 'a', text: 'A' }
    store.set(info)
    const listener = vi.fn()
    store.subscribe(listener)
    store.set(info)
    expect(listener).not.toHaveBeenCalled()
  })
})