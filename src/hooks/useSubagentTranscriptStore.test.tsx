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
const { subscribeSubagentTranscript } = vi.hoisted(() => ({
  subscribeSubagentTranscript: vi.fn(() => () => {}),
}))
vi.mock('./useWsHub', () => ({
  useWsHub: () => ({
    addListener: () => () => {},
    addSessionListener: (_sid: string, fn: WsHubListener) => { listener = fn; return () => { listener = null } },
    subscribe: () => () => {},
    subscribeSubagentTranscript,
  }),
  useWsHubStatus: () => 'online',
}))

beforeEach(() => {
  listener = null
  vi.mocked(api.get).mockReset()
  subscribeSubagentTranscript.mockClear()
})

describe('useSubagentTranscriptStore', () => {
  it('bootstraps via REST into the scratch store, then applies WS increments', async () => {
    vi.mocked(api.get).mockResolvedValue({ messages: [{ type: 'user', uuid: 'u1', restoredFromDisk: true, message: { role: 'user', content: 'go' } }] })
    const { result } = renderHook(() => useSubagentTranscriptStore('s1', 'a1'))
    const store = sessionStoreRegistry.getOrCreate(subagentStoreId('s1', 'a1'))
    await waitFor(() => expect(result.current.replayReady).toBe(true))
    expect(subscribeSubagentTranscript).toHaveBeenCalledWith('s1', 'a1')
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

  it('skips MESSAGE frames whose uuid the store already holds (hub overlap increments)', async () => {
    // hub 双订阅者的 offset 纪律:共享 offset 只随广播推进,晚加入的订阅者
    // 在 reset 快照之后还会把重叠字节作为 reset:false 增量再收一遍。
    // REPLAY_REPLACE 内部去重,但 MESSAGE 是无条件 append——增量必须跳过
    // 已在 store 里的 uuid,否则重叠段渲染两遍。
    vi.mocked(api.get).mockResolvedValue({ messages: [] })
    const { result } = renderHook(() => useSubagentTranscriptStore('s1', 'a9'))
    const store = sessionStoreRegistry.getOrCreate(subagentStoreId('s1', 'a9'))
    await waitFor(() => expect(result.current.replayReady).toBe(true))

    deliver({
      kind: 'subagent-transcript', sessionId: 's1', agentId: 'a9', reset: true,
      frames: [
        { type: 'user', uuid: 'u1', restoredFromDisk: true, message: { role: 'user', content: 'go' } },
        { type: 'assistant', uuid: 'a1', restoredFromDisk: true, message: { role: 'assistant', content: [{ type: 'text', text: 'x' }] } },
      ],
    })
    expect(store.getSnapshot().items).toHaveLength(2)

    deliver({
      kind: 'subagent-transcript', sessionId: 's1', agentId: 'a9', reset: false,
      frames: [
        { type: 'assistant', uuid: 'a1', restoredFromDisk: true, message: { role: 'assistant', content: [{ type: 'text', text: 'x' }] } },
      ],
    })
    expect(store.getSnapshot().items).toHaveLength(2)
  })
})
