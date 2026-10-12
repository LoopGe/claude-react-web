// Tests for the Chat-side history image recall handler: recallEntry loads an
// entry's images from the IDB side store; restoreDraft applies the stash the
// Composer captured on browse entry. A sequence guard keeps a slow load from
// clobbering a newer step or a user image edit (invalidate()).
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { putImages, type PersistedImage } from '../state/inputHistoryImages'
import { useHistoryImageRecall } from './useHistoryImageRecall'
import { resetInputHistoryIdb, makeImg as img } from '../test-utils/inputHistoryIdb'

beforeEach(() => {
  resetInputHistoryIdb()
})

describe('useHistoryImageRecall', () => {
  it('restoreDraft applies the stash immediately', () => {
    const restore = vi.fn()
    const { result } = renderHook(() => useHistoryImageRecall(restore))
    const stash = [img('STASH')]
    act(() => result.current.restoreDraft(stash))
    expect(restore).toHaveBeenCalledWith(stash)
  })

  it('restoreDraft([]) restores [] — text-only draft', () => {
    const restore = vi.fn()
    const { result } = renderHook(() => useHistoryImageRecall(restore))
    act(() => result.current.restoreDraft([]))
    expect(restore).toHaveBeenCalledWith([])
  })

  it('recallEntry loads the entry images from IDB and restores them', async () => {
    await putImages('e1', [img('LOADED')])
    const restore = vi.fn()
    const { result } = renderHook(() => useHistoryImageRecall(restore))
    await act(async () => result.current.recallEntry('e1'))
    expect(restore).toHaveBeenCalledWith([img('LOADED')])
  })

  it('recallEntry(null) restores [] synchronously (text-only entry)', async () => {
    const restore = vi.fn()
    const { result } = renderHook(() => useHistoryImageRecall(restore))
    await act(async () => result.current.recallEntry(null))
    expect(restore).toHaveBeenCalledWith([])
  })

  it('recallEntry with no IDB record restores [] (legacy entry)', async () => {
    const restore = vi.fn()
    const { result } = renderHook(() => useHistoryImageRecall(restore))
    // First IDB touch in this test — the open spans several macrotasks, so
    // flush with a short timer rather than a single microtask drain.
    await act(async () => {
      result.current.recallEntry('missing')
      await new Promise((r) => setTimeout(r, 25))
    })
    expect(restore).toHaveBeenCalledWith([])
  })

  it('a stale load never clobbers a newer step', async () => {
    const restore = vi.fn()
    // 'a' is issued first but its load hangs; 'b' is issued second and
    // resolves immediately. When 'a' finally resolves it must be dropped.
    let resolveA!: (v: PersistedImage[]) => void
    const loader = vi.fn((id: string): Promise<PersistedImage[]> =>
      id === 'a'
        ? new Promise<PersistedImage[]>((r) => { resolveA = r })
        : Promise.resolve([img('FAST')]),
    )
    const { result } = renderHook(() => useHistoryImageRecall(restore, loader))
    act(() => result.current.recallEntry('a'))
    act(() => result.current.recallEntry('b'))
    await act(async () => { await Promise.resolve() })
    expect(restore).toHaveBeenLastCalledWith([img('FAST')])
    act(() => { resolveA([img('SLOW')]) })
    await act(async () => { await Promise.resolve() })
    // The stale 'a' restore was suppressed by the sequence guard.
    expect(restore).toHaveBeenLastCalledWith([img('FAST')])
  })

  it('invalidate() drops an in-flight load so a user image edit wins', async () => {
    const restore = vi.fn()
    let resolveA!: (v: PersistedImage[]) => void
    const loader = vi.fn((): Promise<PersistedImage[]> =>
      new Promise<PersistedImage[]>((r) => { resolveA = r }),
    )
    const { result } = renderHook(() => useHistoryImageRecall(restore, loader))
    act(() => result.current.recallEntry('a'))
    // The user pastes/removes an image while the load is in flight — Chat
    // calls invalidate(). The load's eventual result must be discarded.
    act(() => result.current.invalidate())
    act(() => { resolveA([img('SLOW')]) })
    await act(async () => { await Promise.resolve() })
    expect(restore).not.toHaveBeenCalled()
  })
})
