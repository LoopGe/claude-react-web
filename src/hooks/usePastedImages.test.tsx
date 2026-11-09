// Tests for usePastedImages: live paste management + applyImages (the
// history-recall applier, which receives PREBUILT images from the decode
// cache). All images are composer-owned — the decode cache is a pure Blob
// memo and never owns URLs. jsdom has no implementation of
// URL.createObjectURL/revokeObjectURL, so both are stubbed.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { usePastedImages } from './usePastedImages'
import { getMaxPastedImageBytes } from './config-store'
import type { PastedImage } from '../types'
import type { NormalizedImage } from '../utils/image-normalize'

const prepareMock = vi.hoisted(() => vi.fn())
vi.mock('../utils/image-normalize', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/image-normalize')>()
  return { ...actual, preparePastedImage: prepareMock }
})

/** Browser File with a declared size but no real bytes: the hook only reads
 *  size/type/name, and the normalizer is mocked below. */
function sizedFile(type: string, size: number, name = 'f'): File {
  return { type, size, name } as unknown as File
}

function built(data = 'AAAA'): PastedImage {
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

function normalizedFor(file: Blob, overrides: Partial<NormalizedImage> = {}): NormalizedImage {
  return {
    data: 'NORMALIZED',
    mediaType: 'image/webp',
    width: 10,
    height: 20,
    size: 5,
    original: { mediaType: 'image/png', width: 10, height: 20, size: file.size },
    ...overrides,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

let urlCounter = 0
const createObjectURL = vi.fn(() => `blob:mock-${++urlCounter}`)
const revokeObjectURL = vi.fn()

beforeEach(() => {
  urlCounter = 0
  createObjectURL.mockClear()
  revokeObjectURL.mockClear()
  prepareMock.mockReset()
  prepareMock.mockImplementation(async (file: Blob) => normalizedFor(file))
  Object.defineProperty(URL, 'createObjectURL', {
    value: createObjectURL, configurable: true, writable: true,
  })
  Object.defineProperty(URL, 'revokeObjectURL', {
    value: revokeObjectURL, configurable: true, writable: true,
  })
})

afterEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (URL as any).createObjectURL
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (URL as any).revokeObjectURL
})

describe('usePastedImages.applyImages', () => {
  it('replaces pending images with the prebuilt set', () => {
    const { result } = renderHook(() => usePastedImages())
    act(() => result.current.applyImages([built('AAAA')]))
    expect(result.current.images).toHaveLength(1)
    expect(result.current.images[0]).toEqual(built('AAAA'))
    act(() => result.current.applyImages([built('BBBB')]))
    expect(result.current.images).toEqual([built('BBBB')])
  })

  it('revokes replaced images (all composer-owned)', async () => {
    const { result } = renderHook(() => usePastedImages())
    await act(async () => {
      await result.current.addImages([new File(['x'], 'p.png', { type: 'image/png' })])
    })
    const live = result.current.images[0]
    expect(live.previewUrl).toBe('blob:mock-1')
    act(() => result.current.applyImages([built('AAAA')]))
    expect(revokeObjectURL).toHaveBeenCalledWith(live.previewUrl)
    act(() => result.current.applyImages([built('BBBB')]))
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:built-AAAA')
  })

  it('applyImages([]) clears (the text-only recall case)', () => {
    const { result } = renderHook(() => usePastedImages())
    act(() => result.current.applyImages([built('AAAA')]))
    act(() => result.current.applyImages([]))
    expect(result.current.images).toEqual([])
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:built-AAAA')
  })

  it('removeImage and clear revoke their images', () => {
    const { result } = renderHook(() => usePastedImages())
    act(() => result.current.applyImages([built('AAAA'), built('BBBB')]))
    const first = result.current.images[0]
    const second = result.current.images[1]
    act(() => result.current.removeImage(first.id))
    expect(revokeObjectURL).toHaveBeenCalledWith(first.previewUrl)
    act(() => result.current.removeImage(second.id))
    expect(revokeObjectURL).toHaveBeenCalledWith(second.previewUrl)
    act(() => result.current.applyImages([built('CCCC')]))
    act(() => result.current.clear())
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:built-CCCC')
  })

  it('an in-flight paste survives an applyImages (no data loss on recall)', async () => {
    const { result } = renderHook(() => usePastedImages())
    const pending = deferred<NormalizedImage>()
    prepareMock.mockReturnValueOnce(pending.promise)
    const file = new File(['x'], 'p.png', { type: 'image/png' })
    await act(async () => {
      const adding = result.current.addImages([file])
      result.current.applyImages([built('RESTORED')])
      pending.resolve(normalizedFor(file))
      await adding
    })
    expect(result.current.images.map((i) => i.data)).toEqual(['RESTORED', 'NORMALIZED'])
  })
})

describe('usePastedImages.addImages', () => {
  it('adds every supported image in source order, one add bump per landed image', async () => {
    const { result } = renderHook(() => usePastedImages())
    const a = new File(['a'], 'a.png', { type: 'image/png' })
    const b = new File(['b'], 'b.jpg', { type: 'image/jpeg' })
    await act(async () => {
      await result.current.addImages([a, b])
    })
    expect(prepareMock).toHaveBeenCalledTimes(2)
    expect(result.current.images.map((i) => i.data)).toEqual(['NORMALIZED', 'NORMALIZED'])
    expect(result.current.images[0]?.original?.size).toBe(a.size)
    expect(result.current.error).toBeNull()
    expect(result.current.mutationsRef.current).toMatchObject({ seq: 2, kind: 'add' })
  })

  it('counts the whole batch against the total limit instead of checking each file alone', async () => {
    const maxTotal = getMaxPastedImageBytes()
    // Three files that each fit the per-image limit but together exceed the
    // configured total; the third must be refused.
    const each = Math.floor(maxTotal / 3) + 1
    const { result } = renderHook(() => usePastedImages())
    await act(async () => {
      await result.current.addImages([
        sizedFile('image/png', each, 'big-0.png'),
        sizedFile('image/png', each, 'big-1.png'),
        sizedFile('image/png', each, 'big-2.png'),
      ])
    })
    expect(result.current.images).toHaveLength(2)
    expect(result.current.error).toMatch(/Total image size too large/)
    expect(prepareMock).toHaveBeenCalledTimes(2)
  })

  it('skips an oversized image without dropping the rest of the batch', async () => {
    const { result } = renderHook(() => usePastedImages())
    await act(async () => {
      await result.current.addImages([
        sizedFile('image/png', 10 * 1024 * 1024 + 1, 'too-big.png'),
        new File(['x'], 'ok.png', { type: 'image/png' }),
      ])
    })
    expect(result.current.images).toHaveLength(1)
    expect(result.current.error).toMatch(/Image too large/)
    expect(prepareMock).toHaveBeenCalledTimes(1)
    expect(prepareMock.mock.calls[0]?.[0]).toMatchObject({ name: 'ok.png' })
  })

  it('skips an unsupported image type without dropping the rest of the batch', async () => {
    const { result } = renderHook(() => usePastedImages())
    await act(async () => {
      await result.current.addImages([
        new File(['<svg/>'], 'vector.svg', { type: 'image/svg+xml' }),
        new File(['x'], 'ok.png', { type: 'image/png' }),
      ])
    })
    expect(result.current.images).toHaveLength(1)
    expect(result.current.error).toMatch(/Unsupported image type/)
    expect(prepareMock).toHaveBeenCalledTimes(1)
  })

  it('does not stamp a mutation when every file is refused', async () => {
    const { result } = renderHook(() => usePastedImages())
    await act(async () => {
      await result.current.addImages([sizedFile('image/png', 10 * 1024 * 1024 + 1)])
    })
    expect(result.current.images).toEqual([])
    expect(result.current.mutationsRef.current).toMatchObject({ seq: 0, kind: 'apply' })
    expect(prepareMock).not.toHaveBeenCalled()
  })

  it('returns null when the whole batch lands', async () => {
    const { result } = renderHook(() => usePastedImages())
    const error = await result.current.addImages([
      new File(['a'], 'a.png', { type: 'image/png' }),
    ])
    expect(error).toBeNull()
  })

  it('returns the refusal message on every call so a caller can surface it again', async () => {
    const { result } = renderHook(() => usePastedImages())
    const tooBig = () => sizedFile('image/png', 10 * 1024 * 1024 + 1, 'too-big.png')
    const first = await result.current.addImages([tooBig()])
    const second = await result.current.addImages([tooBig()])
    expect(first).toMatch(/Image too large/)
    expect(second).toBe(first)
    expect(prepareMock).not.toHaveBeenCalled()
  })

  it('reserves accepted bytes across overlapping batches', async () => {
    const { result } = renderHook(() => usePastedImages())
    const each = Math.floor(getMaxPastedImageBytes() / 4) + 1
    const sized = (name: string) => sizedFile('image/png', each, name)
    await act(async () => {
      const first = result.current.addImages([sized('a.png'), sized('b.png')])
      const second = result.current.addImages([sized('c.png'), sized('d.png')])
      await Promise.all([first, second])
    })
    // The first batch reserves two files. The second may add one more and
    // must refuse the last (four files exceed the aggregate cap).
    expect(result.current.images).toHaveLength(3)
    expect(result.current.error).toMatch(/Total image size too large/)
  })

  it('counts a resolved batch against the next call in the same task', async () => {
    const { result } = renderHook(() => usePastedImages())
    const each = Math.floor(getMaxPastedImageBytes() / 4) + 1
    const sized = (name: string) => sizedFile('image/png', each, name)
    await act(async () => {
      // The first batch resolves before the second starts. React has not
      // committed/run the imagesRef sync effect yet, so the second call
      // must still see the first batch's bytes.
      await result.current.addImages([sized('a.png'), sized('b.png')])
      await result.current.addImages([sized('c.png'), sized('d.png')])
    })
    expect(result.current.images).toHaveLength(3)
    expect(result.current.error).toMatch(/Total image size too large/)
  })

  it('discards the whole in-flight batch when the draft is cleared during decoding', async () => {
    const { result } = renderHook(() => usePastedImages())
    const pending = deferred<NormalizedImage>()
    prepareMock.mockReturnValueOnce(pending.promise)
    const file = new File(['a'], 'a.png', { type: 'image/png' })
    await act(async () => {
      const adding = result.current.addImages([file])
      result.current.clear()
      pending.resolve(normalizedFor(file))
      await adding
    })
    expect(result.current.images).toEqual([])
    expect(result.current.mutationsRef.current).toMatchObject({ seq: 1, kind: 'clear' })
  })

  it('caps images per message', async () => {
    const { result } = renderHook(() => usePastedImages())
    const files = Array.from({ length: 21 }, (_, i) => new File(['x'], `${i}.png`, { type: 'image/png' }))
    await act(async () => { await result.current.addImages(files) })
    expect(result.current.error ?? '').toMatch(/too many images/i)
    expect(result.current.images).toHaveLength(20)
    expect(prepareMock).toHaveBeenCalledTimes(20)
  })
})

describe('usePastedImages.pending', () => {
  it('is true while a batch decodes and false once it settles', async () => {
    const { result } = renderHook(() => usePastedImages())
    const pending = deferred<NormalizedImage>()
    prepareMock.mockReturnValueOnce(pending.promise)
    const file = new File(['a'], 'a.png', { type: 'image/png' })
    let adding!: Promise<string | null>
    act(() => {
      adding = result.current.addImages([file])
    })
    expect(result.current.pending).toBe(true)
    await act(async () => {
      pending.resolve(normalizedFor(file))
      await adding
    })
    expect(result.current.pending).toBe(false)
  })

  it('stays pending until every overlapping batch settles', async () => {
    const { result } = renderHook(() => usePastedImages())
    const firstPending = deferred<NormalizedImage>()
    const secondPending = deferred<NormalizedImage>()
    prepareMock.mockReturnValueOnce(firstPending.promise).mockReturnValueOnce(secondPending.promise)
    const firstFile = new File(['a'], 'a.png', { type: 'image/png' })
    const secondFile = new File(['b'], 'b.png', { type: 'image/png' })
    let first!: Promise<string | null>
    let second!: Promise<string | null>
    act(() => {
      first = result.current.addImages([firstFile])
      second = result.current.addImages([secondFile])
    })
    expect(result.current.pending).toBe(true)
    // Settle only the first batch: the screen must stay blocked because the
    // second batch is still decoding. Awaiting `first` makes this
    // deterministic — a boolean pending flag would already read false here.
    await act(async () => {
      firstPending.resolve(normalizedFor(firstFile))
      await first
    })
    expect(result.current.pending).toBe(true)
    await act(async () => {
      secondPending.resolve(normalizedFor(secondFile))
      await Promise.all([first, second])
    })
    expect(result.current.pending).toBe(false)
  })
})

describe('usePastedImages.mutationsRef', () => {
  it('starts at seq 0 and does not advance without a mutation', () => {
    const { result } = renderHook(() => usePastedImages())
    expect(result.current.mutationsRef.current.seq).toBe(0)
  })

  it('stamps kind=apply on applyImages (including the empty clear-out)', () => {
    const { result } = renderHook(() => usePastedImages())
    act(() => result.current.applyImages([built('AAAA')]))
    expect(result.current.mutationsRef.current).toMatchObject({ seq: 1, kind: 'apply' })
    act(() => result.current.applyImages([]))
    expect(result.current.mutationsRef.current).toMatchObject({ seq: 2, kind: 'apply' })
  })

  it('stamps kind=remove on removeImage', () => {
    const { result } = renderHook(() => usePastedImages())
    act(() => result.current.applyImages([built('AAAA')]))
    act(() => result.current.removeImage(result.current.images[0].id))
    expect(result.current.mutationsRef.current).toMatchObject({ seq: 2, kind: 'remove' })
  })

  it('stamps kind=clear on clear', () => {
    const { result } = renderHook(() => usePastedImages())
    act(() => result.current.clear())
    expect(result.current.mutationsRef.current).toMatchObject({ seq: 1, kind: 'clear' })
  })

  it('stamps kind=add when an add LANDS, not when it starts — a discarded in-flight paste must not bump', async () => {
    const { result } = renderHook(() => usePastedImages())
    await act(async () => {
      await result.current.addImages([new File(['x'], 'p.png', { type: 'image/png' })])
    })
    // The paste landed: exactly one bump.
    expect(result.current.mutationsRef.current).toMatchObject({ seq: 1, kind: 'add' })

    // Second paste gets cleared mid-decode: the clear bumps, the discarded
    // paste must NOT add a second bump.
    const pending = deferred<NormalizedImage>()
    prepareMock.mockReturnValueOnce(pending.promise)
    const file = new File(['x'], 'p.png', { type: 'image/png' })
    await act(async () => {
      const adding = result.current.addImages([file])
      result.current.clear()
      pending.resolve(normalizedFor(file))
      await adding
    })
    expect(result.current.images).toEqual([])
    expect(result.current.mutationsRef.current).toMatchObject({ seq: 2, kind: 'clear' })
  })
})