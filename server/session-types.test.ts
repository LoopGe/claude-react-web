import { describe, it, expect, vi } from 'vitest'
import { endAllSubscribers, type Session } from './session-types.js'

function fakeSession(): Session {
  return {
    id: 's1', provider: 'claude', createdAt: 0, lastActivityAt: 0,
    handle: {} as any, pumpTask: Promise.resolve(), running: true, terminated: false,
    subscribers: new Map(), permissionSubscribers: new Map(),
    elicitationSubscribers: new Map(), dialogSubscribers: new Map(),
    contextUsageSubscribers: new Map(), promptSuggestionSubscribers: new Map(),
    taskSubscribers: new Map(), gitStatusSubscribers: new Map(),
    messageStatusSubscribers: new Map(), commandSubscribers: new Map(),
    hookRunSubscribers: new Map(), recapSubscribers: new Map(),
    sessionClearedSubscribers: new Map(),
    pluginSubscribers: new Map(), // the new field — must exist
    pending: new Map(), elicitationPending: new Map(), dialogPending: new Map(),
    history: [], subagentHistory: [],
  } as unknown as Session
}

describe('endAllSubscribers handles pluginSubscribers', () => {
  it('ends and clears the plugin subscriber set', () => {
    const s = fakeSession()
    const end = vi.fn()
    s.pluginSubscribers.set('peer1', { id: 'peer1', push: () => {}, end, closed: false })
    endAllSubscribers(s)
    expect(end).toHaveBeenCalledTimes(1)
    expect(s.pluginSubscribers.size).toBe(0)
  })
})
