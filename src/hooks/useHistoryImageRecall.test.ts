// Tests for the Chat-side history image recall handler: recallEntry loads an
// entry's images from the IDB side store and DECODES them through the image
// decode cache (async, off the main thread) before applying; restoreDraft
// applies the Composer's browse-entry stash the same way. A sequence guard
// keeps a slow load/decode from clobbering a newer step or a user image edit
// (invalidate()).
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { putImages, type PersistedImage } from '../state/inputHistoryImages'
import type { PastedImage } from '../types'
import { imageRefId, type ImageAttachmentRef } from '../../shared/image-attachment'
import { useHistoryImageRecall } from './useHistoryImageRecall'
import { resetInputHistoryIdb, makeImg as img } from '../test-utils/inputHistoryIdb'

function built(data = 'AAAA'): PastedImage {
  return {
    id: `built-${data}`, data, mediaType: 'image/png',
    width: 10, height: 20, size: 3, previewUrl: `blob:built-${data}`,
  }
}

/** The recall pipeline is fire-and-forget over IDB loads + decodes — flush
 *  it with a macrotask (a microtask drain isn't enough for fake-indexeddb). */
async function flushPipeline(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 25))
  })
}

beforeEach(() => {
  resetInputHistoryIdb()
})

describe('useHistoryImageRecall', () => {
  it('restoreDraft decodes the stash and applies it', async () => {
    const apply = vi.fn()
    const build = vi.fn(async (imgs: readonly PersistedImage[]) => [built(imgs[0].data)])
    const { result } = renderHook(() => useHistoryImageRecall(apply, build))
    const stash = [img('STASH')]
    act(() => result.current.restoreDraft(stash))
    await flushPipeline()
    expect(build).toHaveBeenCalledWith(stash)
    expect(apply).toHaveBeenCalledWith([built('STASH')])
  })

  it('recallEntry clears the composer images synchronously before the async apply', async () => {
    // The sync clear closes the send window: text changes immediately,
    // images are gone at once — a fast Enter can never pair the NEW text
    // with the PREVIOUS step's images.
    await putImages('e1', [img('LOADED')])
    let release!: () => void
    const apply = vi.fn()
    const build = vi.fn((): Promise<PastedImage[]> =>
      new Promise<PastedImage[]>((resolve) => { release = () => resolve([built('LOADED')]) }),
    )
    const { result } = renderHook(() => useHistoryImageRecall(apply, build))
    act(() => result.current.recallEntry('e1'))
    expect(apply).toHaveBeenCalledWith([]) // sync clear, before any decode
    expect(apply).toHaveBeenCalledTimes(1)
    await flushPipeline() // let the IDB load reach the hanging decode
    release()
    await flushPipeline()
    expect(apply).toHaveBeenLastCalledWith([built('LOADED')])
  })

  it('restoreDraft also clears synchronously before the async apply', async () => {
    let release!: () => void
    const apply = vi.fn()
    const build = vi.fn((): Promise<PastedImage[]> =>
      new Promise<PastedImage[]>((resolve) => { release = () => resolve([built('STASH')]) }),
    )
    const { result } = renderHook(() => useHistoryImageRecall(apply, build))
    act(() => result.current.restoreDraft([img('STASH')]))
    expect(apply).toHaveBeenCalledWith([]) // sync clear
    expect(apply).toHaveBeenCalledTimes(1)
    release()
    await flushPipeline()
    expect(apply).toHaveBeenLastCalledWith([built('STASH')])
  })

  it('recallEntry loads from IDB, decodes, and applies', async () => {
    await putImages('e1', [img('LOADED')])
    const apply = vi.fn()
    const build = vi.fn(async (imgs: readonly PersistedImage[]) => [built(imgs[0].data)])
    const { result } = renderHook(() => useHistoryImageRecall(apply, build))
    act(() => result.current.recallEntry('e1'))
    await flushPipeline()
    expect(build).toHaveBeenCalledWith([img('LOADED')])
    expect(apply).toHaveBeenCalledWith([built('LOADED')])
  })

  it('recallEntry(null) applies [] synchronously (text-only entry)', async () => {
    const apply = vi.fn()
    const build = vi.fn()
    const { result } = renderHook(() => useHistoryImageRecall(apply, build))
    act(() => result.current.recallEntry(null))
    expect(apply).toHaveBeenCalledWith([])
    expect(build).not.toHaveBeenCalled()
  })

  it('an entry with no IDB record applies [] (legacy entry)', async () => {
    const apply = vi.fn()
    // Echo the (empty) input through — mirrors the production cache, which
    // maps an empty set to an empty result.
    const build = vi.fn(async (imgs: readonly PersistedImage[]) => imgs as PastedImage[])
    const { result } = renderHook(() => useHistoryImageRecall(apply, build))
    act(() => result.current.recallEntry('missing'))
    await flushPipeline()
    expect(apply).toHaveBeenCalledWith([])
    expect(build).toHaveBeenCalledWith([])
  })

  it('a stale load/decode never clobbers a newer step', async () => {
    const apply = vi.fn()
    await putImages('a', [img('SLOW-IDB')])
    let resolveA!: (v: PastedImage[]) => void
    // 'a' carries a hanging decode; 'b' is a text-only entry (→ []).
    const build = vi.fn((imgs: readonly PersistedImage[]): Promise<PastedImage[]> =>
      imgs[0]?.data === 'SLOW-IDB'
        ? new Promise<PastedImage[]>((r) => { resolveA = r })
        : Promise.resolve(imgs as PastedImage[]),
    )
    const { result } = renderHook(() => useHistoryImageRecall(apply, build))
    act(() => result.current.recallEntry('a'))
    act(() => result.current.recallEntry('b'))
    await flushPipeline()
    expect(apply).toHaveBeenLastCalledWith([])
    act(() => { resolveA([built('SLOW-IDB')]) })
    await flushPipeline()
    // The stale 'a' apply was suppressed by the sequence guard.
    expect(apply).toHaveBeenLastCalledWith([])
  })

  it('invalidate() drops an in-flight pipeline so a user image edit wins', async () => {
    const apply = vi.fn()
    await putImages('a', [img('SLOW')])
    let resolveA!: (v: PastedImage[]) => void
    const build = vi.fn((): Promise<PastedImage[]> =>
      new Promise<PastedImage[]>((r) => { resolveA = r }),
    )
    const { result } = renderHook(() => useHistoryImageRecall(apply, build))
    act(() => result.current.recallEntry('a'))
    await flushPipeline() // let the IDB load reach the hanging decode
    // The entry's sync clear already ran (apply #1 = []).
    expect(apply).toHaveBeenCalledTimes(1)
    // The user pastes/removes an image while the pipeline is in flight —
    // Chat calls invalidate(). The eventual result must be discarded: no
    // SECOND apply lands after the sync clear.
    act(() => result.current.invalidate())
    act(() => { resolveA([built('SLOW')]) })
    await flushPipeline()
    expect(apply).toHaveBeenCalledTimes(1)
    expect(apply).toHaveBeenLastCalledWith([])
  })

  // Task 6 contract: recall is a transparent pipe over the persisted records —
  // it forwards a record's durable image ref to `build` and applies whatever
  // ref-carrying images build returns, never stripping the ref. Producing the
  // ref-carrying live image from a ref record is the decode cache's job
  // (buildPastedImages, Task 5); the hook must not obstruct it. Legacy base64
  // records (no ref) flow through unchanged.
  it('forwards a persisted image ref to build and applies the ref-carrying result', async () => {
    const ref: ImageAttachmentRef = {
      id: imageRefId('e'.repeat(64)), mediaType: 'image/png', bytes: 3, width: 10, height: 20,
    }
    const record = { ...img('REFDATA'), attachment: ref } as PersistedImage
    await putImages('e-ref', [record])
    const apply = vi.fn()
    // build preserves the ref onto the live image (as the ref-aware decode
    // cache will); the hook must pass the record through and apply the result.
    const build = vi.fn(async (imgs: readonly PersistedImage[]) =>
      imgs.map((p) => ({ ...built(p.data), attachment: (p as { attachment?: ImageAttachmentRef }).attachment })),
    )
    const { result } = renderHook(() => useHistoryImageRecall(apply, build))
    act(() => result.current.recallEntry('e-ref'))
    await flushPipeline()
    expect(build).toHaveBeenCalledWith([record])
    const applied = apply.mock.calls.at(-1)![0] as Array<PastedImage & { attachment?: ImageAttachmentRef }>
    expect(applied).toHaveLength(1)
    expect(applied[0].attachment).toEqual(ref)
  })

  it('recalls a legacy base64 record without introducing a ref', async () => {
    await putImages('e-legacy', [img('LEGACY')])
    const apply = vi.fn()
    const build = vi.fn(async (imgs: readonly PersistedImage[]) => imgs.map((p) => built(p.data)))
    const { result } = renderHook(() => useHistoryImageRecall(apply, build))
    act(() => result.current.recallEntry('e-legacy'))
    await flushPipeline()
    const applied = apply.mock.calls.at(-1)![0] as Array<PastedImage & { attachment?: ImageAttachmentRef }>
    expect(applied).toHaveLength(1)
    expect(applied[0].data).toBe('LEGACY')
    expect(applied[0].attachment).toBeUndefined()
  })
})
