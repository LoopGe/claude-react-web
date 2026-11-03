import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useResetConfig } from './useResetConfig'
import { inputHistoryStore } from '../state/inputHistoryStore'
import { sessionStoreRegistry } from '../session-store/registry'
import { useRecentModels, useRecentCwds } from './useRecentItems'
import {
  RECENT_MODELS_KEY,
  RECENT_CWDS_KEY,
  RECENT_MODELS_CAP_KEY,
  RECENT_CWDS_CAP_KEY,
} from '../constants/recentKeys'

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

  it('resets recent model/cwd list keys via removeLocalStorageKey and preserves cap keys', async () => {
    // Pre-seed list + cap keys, and mount the recent adapters so the reset
    // must propagate to mounted React state, not just localStorage. The old
    // impl used localStorage.removeItem for every appearance key, which:
    //   - never notified same-tab listeners, so mounted adapters kept
    //     ['old-model'] / ['/old/cwd'] in React state;
    //   - left the persist effect free to write those stale values back on
    //     the next render, so the key didn't even stay null;
    //   - let a post-reset remember('fresh') stack onto ['old-model'],
    //     resurrecting a value the user just erased.
    localStorage.setItem(RECENT_MODELS_KEY, JSON.stringify(['old-model']))
    localStorage.setItem(RECENT_CWDS_KEY, JSON.stringify(['/old/cwd']))
    localStorage.setItem(RECENT_MODELS_CAP_KEY, JSON.stringify(7))
    localStorage.setItem(RECENT_CWDS_CAP_KEY, JSON.stringify(8))

    const models = renderHook(() => useRecentModels())
    const cwds = renderHook(() => useRecentCwds())
    expect(models.result.current.recents).toEqual(['old-model'])
    expect(cwds.result.current.recents).toEqual(['/old/cwd'])

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ results: {}, deletedSessionIds: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const { result } = renderHook(() => useResetConfig())
    await act(async () => {
      await result.current.reset({ browser: ['appearance'], server: [] })
    })

    // List keys are null: removeLocalStorageKey removed them AND suppressed
    // the reset echo so mounted adapters don't write [] back over the gap.
    expect(localStorage.getItem(RECENT_MODELS_KEY)).toBeNull()
    expect(localStorage.getItem(RECENT_CWDS_KEY)).toBeNull()
    // Cap keys are NOT in the reset set — they survive.
    expect(JSON.parse(localStorage.getItem(RECENT_MODELS_CAP_KEY)!)).toBe(7)
    expect(JSON.parse(localStorage.getItem(RECENT_CWDS_CAP_KEY)!)).toBe(8)
    // Mounted adapters collapsed to [] immediately via the deletion sentinel.
    expect(models.result.current.recents).toEqual([])
    expect(cwds.result.current.recents).toEqual([])

    // A subsequent remember must NOT resurrect old entries — the adapter's
    // prev is [] (not the pre-reset ['old-model']), so nextMru produces
    // only ['fresh'].
    act(() => models.result.current.remember('fresh'))
    expect(models.result.current.recents).toEqual(['fresh'])
    expect(JSON.parse(localStorage.getItem(RECENT_MODELS_KEY)!)).toEqual(['fresh'])
  })
})
