import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { TurnChangesSummary } from '../../shared/turn-changes.js'

const mockGet = vi.fn()
vi.mock('./useApi', () => ({
  api: { get: (...args: unknown[]) => mockGet(...args), post: vi.fn() },
}))

// The real hub object is referentially stable; a fresh object per render would
// re-run every effect that depends on it (and loop forever).
const ws = vi.hoisted(() => ({
  listeners: [] as Array<(frame: unknown) => void>,
  subscribe: vi.fn(() => () => {}),
}))
vi.mock('./useWsHub', () => {
  const hub = {
    subscribe: ws.subscribe,
    addSessionListener: (_id: string, fn: (frame: unknown) => void) => {
      ws.listeners.push(fn)
      return () => { ws.listeners = ws.listeners.filter((listener) => listener !== fn) }
    },
  }
  return { useWsHub: () => hub, useOptionalWsHub: () => hub }
})
const emit = (frame: unknown): void => {
  for (const listener of [...ws.listeners]) listener(frame)
}

import { useTurnChanges, useTurnDiff } from './useTurnChanges'

const SUMMARY: TurnChangesSummary = {
  resultUuid: 'r1',
  assistantUuid: 'a1',
  files: [{ path: 'src/a.ts', display: 'src/a.ts', status: 'modified', additions: 1, deletions: 0 }],
  total: 1,
  added: 1,
  deleted: 0,
}

beforeEach(() => {
  vi.clearAllMocks()
  ws.listeners.length = 0
})
afterEach(() => vi.restoreAllMocks())

describe('useTurnChanges', () => {
  it('loads once, applies a matching live frame, and serves a remount from cache', async () => {
    mockGet.mockResolvedValue({ available: true, summary: SUMMARY })
    const { result } = renderHook(() => useTurnChanges('s-load', 'r1'))
    await waitFor(() => expect(result.current.summary?.resultUuid).toBe('r1'))
    expect(mockGet).toHaveBeenCalledTimes(1)
    expect(mockGet.mock.calls[0]?.[0]).toContain('/sessions/s-load/turn-changes?resultUuid=r1')

    act(() => {
      emit({ kind: 'turn-changes', sessionId: 's-load', summary: { ...SUMMARY, total: 3 } })
    })
    await waitFor(() => expect(result.current.summary?.total).toBe(3))

    const remount = renderHook(() => useTurnChanges('s-load', 'r1'))
    await waitFor(() => expect(remount.result.current.summary?.total).toBe(3))
    expect(mockGet).toHaveBeenCalledTimes(1)
  })

  it('ignores a frame for another turn', async () => {
    mockGet.mockResolvedValue({ available: true, summary: SUMMARY })
    const { result } = renderHook(() => useTurnChanges('s-other', 'r1'))
    await waitFor(() => expect(result.current.summary).not.toBeNull())
    act(() => {
      emit({ kind: 'turn-changes', sessionId: 's-other', summary: { ...SUMMARY, resultUuid: 'r2', total: 9 } })
    })
    expect(result.current.summary?.total).toBe(1)
  })

  it('treats an unavailable response as missing', async () => {
    mockGet.mockResolvedValue({ available: false })
    const { result } = renderHook(() => useTurnChanges('s-missing', 'r1'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.summary).toBeNull()
  })
})

describe('useTurnDiff', () => {
  it('fetches the addressed file and forwards full', async () => {
    mockGet.mockResolvedValue({ available: true, patch: '@@ -1 +1 @@\n-a\n+b', truncated: false, totalLines: 3 })
    const { result } = renderHook(() => useTurnDiff('s-diff', 'r1', 2, { full: true }))
    await waitFor(() => expect(result.current.diff?.available).toBe(true))
    expect(mockGet.mock.calls[0]?.[0]).toBe('/sessions/s-diff/turn-diff?resultUuid=r1&index=2&full=1')
  })

  it('does nothing when the index is null', () => {
    const { result } = renderHook(() => useTurnDiff('s-diff', 'r1', null))
    expect(result.current.diff).toBeNull()
    expect(mockGet).not.toHaveBeenCalled()
  })
})