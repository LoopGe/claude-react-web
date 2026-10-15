// Tests for useDraftImages: the composer draft's image half. The TEXT draft
// lives in sessionStorage and survives a panel unmount (session switch, group
// switch, close); images are far too large for that quota, so this hook
// mirrors the text draft's lifecycle against the IDB side store instead —
// debounced write on change, immediate delete on clear, flush on unmount,
// async restore on mount. Store/build functions are injected: the REAL IDB
// round-trip is covered by inputHistoryImages.test.ts; these tests pin the
// ORCHESTRATION (timing, guards, write-back).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useDraftImages } from './useDraftImages'
import type { ImageMutations } from './usePastedImages'
import type { PastedImage } from '../types'
import type { PersistedImage } from '../state/inputHistoryImages'

// happy-dom has no URL.createObjectURL/revokeObjectURL (same as jsdom — see
// usePastedImages.test.tsx). The revoke stub matters for the dropped-restore
// test: the hook revokes built URLs it never applied.
const revokeObjectURL = vi.fn()
beforeEach(() => {
  revokeObjectURL.mockClear()
  Object.defineProperty(URL, 'revokeObjectURL', {
    value: revokeObjectURL, configurable: true, writable: true,
  })
})
afterEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (URL as any).revokeObjectURL
})

function pimg(data: string): PastedImage {
  return {
    id: `built-${data}`,
    data,
    mediaType: 'image/png',
    width: 10,
    height: 20,
    size: 3,
    previewUrl: `blob:built-${data}`,
  }
}

function persist(data: string): PersistedImage {
  return { data, mediaType: 'image/png', width: 10, height: 20, size: 3 }
}

async function flushMicrotasks(ticks = 8): Promise<void> {
  for (let i = 0; i < ticks; i++) await Promise.resolve()
}

/** Let a small injected debounce (5ms) fire under real timers. */
async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

type Images = PastedImage[]

/** The usePastedImages mutation signal fixture. `bump` simulates a user
 *  mutation landing (the kind the producing mutation stamped). */
function mutRef() {
  const ref: { current: ImageMutations } = { current: { seq: 0, kind: 'apply' } }
  const bump = (kind: ImageMutations['kind']) => {
    ref.current = { seq: ref.current.seq + 1, kind }
  }
  return { ref, bump }
}

function renderDraft(
  mutations: { current: ImageMutations },
  apply: (imgs: readonly PastedImage[]) => void,
  deps: Parameters<typeof useDraftImages>[4],
) {
  return renderHook(
    ({ images }: { images: Images }) =>
      useDraftImages('s1', images, mutations, apply, deps),
    { initialProps: { images: [] as Images } },
  )
}

describe('useDraftImages persistence', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not write on mount — the persisted record must survive until the restore has read it', async () => {
    const get = vi.fn(async () => [persist('DDDD')])
    const put = vi.fn()
    const del = vi.fn()
    renderDraft(mutRef().ref, vi.fn(), {
      get,
      put,
      del,
      build: vi.fn(async (imgs: readonly PersistedImage[]) => imgs.map((p) => pimg(p.data))),
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    // An eager empty-write on mount would DELETE the record before the
    // restore pipeline (which read it) could apply it.
    expect(put).not.toHaveBeenCalled()
    expect(del).not.toHaveBeenCalled()
  })

  it('writes after the debounce, replacing an earlier pending set (trailing edge)', async () => {
    const put = vi.fn()
    const del = vi.fn()
    const { rerender } = renderDraft(mutRef().ref, vi.fn(), {
      get: async () => [],
      put,
      del,
      build: async () => [],
    })
    rerender({ images: [pimg('AAAA')] })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(399)
    })
    expect(put).not.toHaveBeenCalled()
    // A second mutation resets the timer; only the LAST set may be written.
    rerender({ images: [pimg('AAAA'), pimg('BBBB')] })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(399)
    })
    expect(put).not.toHaveBeenCalled()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(put).toHaveBeenCalledTimes(1)
    expect(put).toHaveBeenCalledWith('s1', [persist('AAAA'), persist('BBBB')])
  })

  it('deletes the record immediately when the images are cleared (send consumed the draft)', async () => {
    const put = vi.fn()
    const del = vi.fn()
    const { ref, bump } = mutRef()
    const { rerender } = renderDraft(ref, vi.fn(), {
      get: async () => [],
      put,
      del,
      build: async () => [],
    })
    rerender({ images: [pimg('AAAA')] })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400)
    })
    expect(put).toHaveBeenCalledWith('s1', [persist('AAAA')])
    // clearPastedImages() (send) — kind 'clear' is a consumption.
    bump('clear')
    rerender({ images: [] })
    expect(del).toHaveBeenCalledWith('s1')
  })

  it('deletes the record when the user removes the last image (kind remove)', async () => {
    const del = vi.fn()
    const { ref, bump } = mutRef()
    const { rerender } = renderDraft(ref, vi.fn(), {
      get: async () => [],
      put: vi.fn(),
      del,
      build: async () => [],
    })
    rerender({ images: [pimg('AAAA')] })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400)
    })
    bump('remove')
    rerender({ images: [] })
    expect(del).toHaveBeenCalledWith('s1')
  })

  it('a history-recall sync-clear (kind apply) does NOT delete the record — the draft is replaced, not consumed', async () => {
    // ↑ onto a text-only entry applies [] over a non-empty composer. The
    // only surviving copies are the Composer's in-memory browse stash and
    // the IDB record — deleting the record here means an unmount before ↓
    // loses the draft images permanently (the exact loss this feature
    // fixes). A later non-empty put (the ↓ restore, or a fresh paste)
    // replaces the record content instead.
    const del = vi.fn()
    const { ref, bump } = mutRef()
    const { rerender } = renderDraft(ref, vi.fn(), {
      get: async () => [],
      put: vi.fn(),
      del,
      build: async () => [],
    })
    rerender({ images: [pimg('AAAA')] })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400)
    })
    bump('apply')
    rerender({ images: [] })
    expect(del).not.toHaveBeenCalled()
  })

  it('a clear cancels a pending debounced write instead of letting it land afterwards', async () => {
    const put = vi.fn()
    const del = vi.fn()
    const { ref, bump } = mutRef()
    const { rerender } = renderDraft(ref, vi.fn(), {
      get: async () => [],
      put,
      del,
      build: async () => [],
    })
    rerender({ images: [pimg('AAAA')] })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    bump('clear')
    rerender({ images: [] })
    expect(del).toHaveBeenCalledWith('s1')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400)
    })
    // The cancelled write would resurrect the sent draft as a phantom.
    expect(put).not.toHaveBeenCalled()
  })

  it('an empty→empty change (a recall sync-clear during the restore window) does NOT delete the record', async () => {
    // Reopen a panel with a persisted draft, press ↑ before the async
    // restore lands: the recall applies [] (a NEW empty identity over the
    // mount-time empty). That is not a draft consumption — deleting here
    // would destroy the record while the in-flight restore is simultaneously
    // seq-dropped, losing both copies (the ↑-stash captured the pre-restore
    // empty composer).
    const del = vi.fn()
    const { rerender } = renderDraft(mutRef().ref, vi.fn(), {
      get: async () => [persist('DDDD')],
      put: vi.fn(),
      del,
      build: async () => [],
    })
    rerender({ images: [] }) // fresh [] identity — applyImages([]) semantics
    expect(del).not.toHaveBeenCalled()
  })

  it('flushes a pending debounced write on unmount (panel close / group switch)', async () => {
    const put = vi.fn()
    const del = vi.fn()
    const { rerender, unmount } = renderDraft(mutRef().ref, vi.fn(), {
      get: async () => [],
      put,
      del,
      build: async () => [],
    })
    rerender({ images: [pimg('AAAA')] })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(put).not.toHaveBeenCalled()
    unmount()
    expect(put).toHaveBeenCalledTimes(1)
    expect(put).toHaveBeenCalledWith('s1', [persist('AAAA')])
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400)
    })
    expect(put).toHaveBeenCalledTimes(1)
  })

  it('flushes a pending debounced write on pagehide / visibilitychange (tab hidden or closing)', async () => {
    // The text half flushes on the same events (Chat.tsx flushDraft); a
    // paste followed by a tab switch inside the debounce window must not
    // rely on the unmount that never comes.
    const put = vi.fn()
    const { rerender } = renderDraft(mutRef().ref, vi.fn(), {
      get: async () => [],
      put,
      del: vi.fn(),
      build: async () => [],
    })
    rerender({ images: [pimg('AAAA')] })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(put).not.toHaveBeenCalled()
    act(() => {
      window.dispatchEvent(new Event('pagehide'))
    })
    expect(put).toHaveBeenCalledTimes(1)
    expect(put).toHaveBeenCalledWith('s1', [persist('AAAA')])
    // The flush consumed the pending write: no double put later.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400)
    })
    expect(put).toHaveBeenCalledTimes(1)
  })
})

describe('useDraftImages restore', () => {
  it('restores persisted draft images on mount', async () => {
    const apply = vi.fn()
    const built = [pimg('DDDD')]
    renderDraft(mutRef().ref, apply, {
      get: async () => [persist('DDDD')],
      put: vi.fn(),
      del: vi.fn(),
      build: vi.fn(async () => built),
    })
    await waitFor(() => expect(apply).toHaveBeenCalledWith(built))
  })

  it('does not restore when there is no persisted draft', async () => {
    const apply = vi.fn()
    renderDraft(mutRef().ref, apply, {
      get: async () => [],
      put: vi.fn(),
      del: vi.fn(),
      build: vi.fn(async () => []),
    })
    await act(async () => {
      await flushMicrotasks()
    })
    expect(apply).not.toHaveBeenCalled()
  })

  it('skips the restore when a user mutation lands before the load (paste wins)', async () => {
    const apply = vi.fn()
    const { ref, bump } = mutRef()
    let resolveGet!: (v: PersistedImage[]) => void
    renderDraft(ref, apply, {
      get: () => new Promise<PersistedImage[]>((r) => { resolveGet = r }),
      put: vi.fn(),
      del: vi.fn(),
      build: vi.fn(async (imgs: readonly PersistedImage[]) => imgs.map((p) => pimg(p.data))),
    })
    // The user pasted while the IDB read was in flight.
    bump('add')
    await act(async () => {
      resolveGet([persist('DDDD')])
      await flushMicrotasks()
    })
    expect(apply).not.toHaveBeenCalled()
  })

  it('skips the restore when a user mutation lands during the decode', async () => {
    const apply = vi.fn()
    const { ref, bump } = mutRef()
    let resolveBuild!: (v: PastedImage[]) => void
    renderDraft(ref, apply, {
      get: async () => [persist('DDDD')],
      put: vi.fn(),
      del: vi.fn(),
      build: () => new Promise<PastedImage[]>((r) => { resolveBuild = r }),
    })
    await act(async () => {
      await flushMicrotasks()
    })
    // The load landed, the decode is in flight — the user edits now.
    bump('remove')
    await act(async () => {
      resolveBuild([pimg('DDDD')])
      await flushMicrotasks()
    })
    expect(apply).not.toHaveBeenCalled()
  })

  it('revokes the built URLs when the restore is dropped after the decode', async () => {
    // buildPastedImages mints fresh composer-owned URLs; a dropped apply
    // never hands them to the composer, so nothing else would revoke them —
    // each multi-MB Blob would stay pinned for the tab's lifetime.
    const { ref, bump } = mutRef()
    let resolveBuild!: (v: PastedImage[]) => void
    renderDraft(ref, vi.fn(), {
      get: async () => [persist('DDDD')],
      put: vi.fn(),
      del: vi.fn(),
      build: () => new Promise<PastedImage[]>((r) => { resolveBuild = r }),
    })
    await act(async () => {
      await flushMicrotasks()
    })
    bump('clear')
    await act(async () => {
      resolveBuild([pimg('DDDD')])
      await flushMicrotasks()
    })
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:built-DDDD')
  })

  it('re-arms store writes on mount — a resumed id may have been tombstoned by a removal flow', async () => {
    // resume() re-spawns under the SAME id; without re-arming, every future
    // putDraftImages for the resumed session is silently dropped.
    const armWrites = vi.fn()
    renderDraft(mutRef().ref, vi.fn(), {
      get: async () => [],
      put: vi.fn(),
      del: vi.fn(),
      build: async () => [],
      armWrites,
    })
    expect(armWrites).toHaveBeenCalledWith('s1')
  })

  it('does not re-write the record when the restored set lands unchanged', async () => {
    // The restored set is byte-identical to what was just read from IDB —
    // re-putting it writes the full multi-MB payload on every panel open.
    const apply = vi.fn()
    const put = vi.fn()
    const built = [pimg('DDDD')]
    const { rerender } = renderDraft(mutRef().ref, apply, {
      get: async () => [persist('DDDD')],
      put,
      del: vi.fn(),
      build: vi.fn(async () => built),
      debounceMs: 5,
    })
    await waitFor(() => expect(apply).toHaveBeenCalledWith(built))
    // What applyImages → setImages → re-render does in production.
    await act(async () => {
      rerender({ images: built })
    })
    // Long enough for the 5ms debounce to fire IF one was scheduled.
    await act(async () => {
      await sleep(25)
    })
    expect(put).not.toHaveBeenCalled()
  })

  it('still persists a real change after the restore (the skip is one-shot)', async () => {
    const apply = vi.fn()
    const put = vi.fn()
    const built = [pimg('DDDD')]
    const { rerender } = renderDraft(mutRef().ref, apply, {
      get: async () => [persist('DDDD')],
      put,
      del: vi.fn(),
      build: vi.fn(async () => built),
      debounceMs: 5,
    })
    await waitFor(() => expect(apply).toHaveBeenCalledWith(built))
    await act(async () => {
      rerender({ images: built })
    })
    // The user pastes one more image — a genuine change must be written.
    await act(async () => {
      rerender({ images: [...built, pimg('NEW')] })
    })
    await waitFor(() => expect(put).toHaveBeenCalledWith('s1', [persist('DDDD'), persist('NEW')]))
  })
})
