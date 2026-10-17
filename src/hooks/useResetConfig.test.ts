import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useResetConfig } from './useResetConfig'
import { inputHistoryStore } from '../state/inputHistoryStore'
import { sessionStoreRegistry } from '../session-store/registry'

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  inputHistoryStore.reset()
})

describe('useResetConfig', () => {
  it('posts server items and clears requested browser items', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ results: { 'mcp-configs': { ok: true } }, deletedSessionIds: [] }), { status: 200, headers: { 'content-type': 'application/json' } }),
    )
    // Drafts live in SESSION storage (Chat.tsx writes them there) — the
    // drafts reset must clear this area, not localStorage.
    sessionStorage.setItem('claude-react-web:draft:s1', 'hi')
    inputHistoryStore.add('old', 's1')
    const { result } = renderHook(() => useResetConfig())
    await act(async () => {
      await result.current.reset({ server: ['mcp-configs'], browser: ['input-history', 'drafts'] })
    })
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/config/reset'), expect.objectContaining({ method: 'POST' }))
    expect(inputHistoryStore.getAll()).toEqual([])
    expect(sessionStorage.getItem('claude-react-web:draft:s1')).toBeNull()
  })

  it('deletes in-memory stores for the deleted session ids', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ results: { sessions: { ok: true } }, deletedSessionIds: ['a', 'b'] }), { status: 200, headers: { 'content-type': 'application/json' } }),
    )
    // The reset flow drops each deleted session's in-memory store; legacy
    // pre-refactor localStorage keys are NOT its business — they are pure
    // orphans owned by the boot sweep (legacy-transcript-cache.ts). Per-key
    // deletion here is exactly what let orphans accumulate against the quota.
    const registryDelete = vi
      .spyOn(sessionStoreRegistry, 'delete')
      .mockResolvedValue(undefined)
    const { result } = renderHook(() => useResetConfig())
    await act(async () => {
      await result.current.reset({ server: ['sessions'], browser: [] })
    })
    expect(registryDelete).toHaveBeenCalledWith('a')
    expect(registryDelete).toHaveBeenCalledWith('b')
  })
})
