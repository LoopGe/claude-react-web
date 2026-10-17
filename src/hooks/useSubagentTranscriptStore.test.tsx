// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useSubagentTranscriptStore, subagentStoreId } from './useSubagentTranscriptStore'
import { sessionStoreRegistry } from '../session-store/registry'
import { api } from './useApi'
import type { WsHubListener } from './useWsHub'

vi.mock('./useApi', () => ({ api: { get: vi.fn() } }))

// Stub hub:捕获 session listener,手动投帧。
let listener: WsHubListener | null = null
const deliver = (frame: unknown) => listener?.(frame as Parameters<WsHubListener>[0])
vi.mock('./useWsHub', () => ({
  useWsHub: () => ({
    addListener: () => () => {},
    addSessionListener: (_sid: string, fn: WsHubListener) => { listener = fn; return () => { listener = null } },
    subscribe: () => () => {},
    subscribeSubagentTranscript: vi.fn(() => () => {}),
  }),
  useWsHubStatus: () => 'online',
}))

beforeEach(() => { listener = null; vi.mocked(api.get).mockReset() })

describe('useSubagentTranscriptStore', () => {
  it('bootstraps via REST into the scratch store, then applies WS increments', async () => {
    vi.mocked(api.get).mockResolvedValue({ messages: [{ type: 'user', uuid: 'u1', restoredFromDisk: true, message: { role: 'user', content: 'go' } }] })
    const { result } = renderHook(() => useSubagentTranscriptStore('s1', 'a1'))
    const store = sessionStoreRegistry.getOrCreate(subagentStoreId('s1', 'a1'))
    await waitFor(() => expect(result.current.replayReady).toBe(true))
    const before = store.getSnapshot().items.length
    expect(before).toBeGreaterThan(0)

    deliver({ kind: 'subagent-transcript', sessionId: 's1', agentId: 'a1', reset: false, frames: [{ type: 'assistant', uuid: 'a2', restoredFromDisk: true, message: { role: 'assistant', content: [{ type: 'text', text: 'x' }] } }] })
    expect(store.getSnapshot().items.length).toBe(before + 1)
  })

  it('a reset frame replaces content (idempotent handover)', async () => {
    vi.mocked(api.get).mockResolvedValue({ messages: [] })
    const { result } = renderHook(() => useSubagentTranscriptStore('s1', 'a2'))
    const store = sessionStoreRegistry.getOrCreate(subagentStoreId('s1', 'a2'))
    await waitFor(() => expect(result.current.replayReady).toBe(true))
    deliver({ kind: 'subagent-transcript', sessionId: 's1', agentId: 'a2', reset: true, frames: [{ type: 'user', uuid: 'u1', restoredFromDisk: true, message: { role: 'user', content: 'go' } }] })
    expect(store.getSnapshot().items.length).toBe(1)
  })

  it('REST failure surfaces as the store error field', async () => {
    vi.mocked(api.get).mockRejectedValue(new Error('boom'))
    const { result } = renderHook(() => useSubagentTranscriptStore('s1', 'a3'))
    await waitFor(() => expect(result.current.error).toContain('boom'))
  })
})
