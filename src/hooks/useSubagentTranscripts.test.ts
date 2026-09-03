import { describe, expect, it, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

vi.mock('./useApi', () => ({
  api: { get: vi.fn() },
}))

import { useSubagentTranscripts, subagentMessageText } from './useSubagentTranscripts'
import { api } from './useApi'

const mockGet = api.get as unknown as ReturnType<typeof vi.fn>

describe('useSubagentTranscripts', () => {
  beforeEach(() => vi.clearAllMocks())

  it('list() fetches the subagent index and returns ids', async () => {
    mockGet.mockResolvedValue({ subagents: ['agent-1', 'agent-2'] })
    const { result } = renderHook(() => useSubagentTranscripts('s1'))
    let ids: string[] = []
    await act(async () => {
      ids = await result.current.list()
    })
    expect(mockGet).toHaveBeenCalledWith('/sessions/s1/subagents')
    expect(ids).toEqual(['agent-1', 'agent-2'])
  })

  it('getTranscript() fetches one agent transcript with the agentId encoded', async () => {
    mockGet.mockResolvedValue({ messages: [{ type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: 'hi' } }] })
    const { result } = renderHook(() => useSubagentTranscripts('s1'))
    let msgs: unknown[] = []
    await act(async () => {
      msgs = await result.current.getTranscript('agent 1')
    })
    expect(mockGet).toHaveBeenCalledWith('/sessions/s1/subagents/agent%201')
    expect(msgs).toHaveLength(1)
  })

  it('getTranscript() defaults to [] when the response lacks messages', async () => {
    mockGet.mockResolvedValue({})
    const { result } = renderHook(() => useSubagentTranscripts('s1'))
    let msgs: unknown[] | undefined
    await act(async () => {
      msgs = await result.current.getTranscript('agent-1')
    })
    expect(msgs).toEqual([])
  })

  it('list() defaults to [] when the response lacks subagents', async () => {
    mockGet.mockResolvedValue({})
    const { result } = renderHook(() => useSubagentTranscripts('s1'))
    let ids: string[] | undefined
    await act(async () => {
      ids = await result.current.list()
    })
    expect(ids).toEqual([])
  })
})

describe('subagentMessageText', () => {
  it('extracts string content verbatim', () => {
    expect(subagentMessageText({ message: { role: 'user', content: 'hello' } })).toBe('hello')
  })

  it('joins text blocks from array content', () => {
    expect(
      subagentMessageText({
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'one' },
            { type: 'tool_use', id: 'tu1', name: 'Read', input: {} },
            { type: 'text', text: 'two' },
          ],
        },
      }),
    ).toBe('one\n\ntwo')
  })

  it('returns empty string for non-text content', () => {
    expect(subagentMessageText({ message: { role: 'user', content: undefined } })).toBe('')
    expect(subagentMessageText({})).toBe('')
  })
})
