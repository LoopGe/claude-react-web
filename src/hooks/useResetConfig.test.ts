import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useResetConfig } from './useResetConfig'
import { inputHistoryStore } from '../state/inputHistoryStore'

beforeEach(() => { localStorage.clear(); inputHistoryStore.reset() })

describe('useResetConfig', () => {
  it('posts server items and clears requested browser items', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ results: { 'mcp-configs': { ok: true } }, deletedSessionIds: [] }), { status: 200, headers: { 'content-type': 'application/json' } }),
    )
    localStorage.setItem('claude-react-web:draft:s1', 'hi')
    inputHistoryStore.add('old', 's1')
    const { result } = renderHook(() => useResetConfig())
    await act(async () => {
      await result.current.reset({ server: ['mcp-configs'], browser: ['input-history', 'drafts'] })
    })
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/config/reset'), expect.objectContaining({ method: 'POST' }))
    expect(inputHistoryStore.getAll()).toEqual([])
    expect(localStorage.getItem('claude-react-web:draft:s1')).toBeNull()
  })

  it('clears session caches when sessions were reset', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ results: { sessions: { ok: true } }, deletedSessionIds: ['a', 'b'] }), { status: 200, headers: { 'content-type': 'application/json' } }),
    )
    localStorage.setItem('claude-web-session:a', '{}')
    const { result } = renderHook(() => useResetConfig())
    await act(async () => {
      await result.current.reset({ server: ['sessions'], browser: [] })
    })
    expect(localStorage.getItem('claude-web-session:a')).toBeNull()
  })
})
