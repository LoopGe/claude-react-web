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

/** Browser File with a declared size but no real bytes: the hook only reads
 *  size/type/name, and both decode globals are stubbed below. */
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

let urlCounter = 0
const createObjectURL = vi.fn(() => `blob:mock-${++urlCounter}`)
const revokeObjectURL = vi.fn()

beforeEach(() => {
  urlCounter = 0
  createObjectURL.mockClear()
  revokeObjectURL.mockClear()
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

class FakeFileReader {
  onload: (() => void) | null = null
  result: string | null = null
  readAsDataURL() {
    queueMicrotask(() => {
      this.result = 'data:image/png;base64,ZZZZ'
      this.onload?.()
    })
  }
}
class FakeImage {
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  naturalWidth = 10
  naturalHeight = 20
  set src(_v: string) { queueMicrotask(() => this.onload?.()) }
}

/** FileReader that stays pending until the test flushes it. */
class ManualFileReader {
  onload: (() => void) | null = null
  result: string | null = null
  readAsDataURL() { manualReaders.push(this) }
}
let manualReaders: ManualFileReader[] = []

function stubManualDecode() {
  manualReaders = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(globalThis as any).FileReader = ManualFileReader
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(globalThis as any).Image = FakeImage
}

function flushOneReader() {
  const reader = manualReaders.shift()
  if (reader === undefined) return
  reader.result = 'data:image/png;base64,ZZZZ'
  reader.onload?.()
}

function flushManualReaders() {
  while (manualReaders.length > 0) flushOneReader()
}

function stubDecodeGlobals() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(globalThis as any).FileReader = FakeFileReader
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(globalThis as any).Image = FakeImage
}

function unstubDecodeGlobals() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any).FileReader
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any).Image
}

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
    stubDecodeGlobals()
    try {
      await act(async () => {
        await result.current.addImages([new File(['x'], 'p.png', { type: 'image/png' })])
      })
      const live = result.current.images[0]
      expect(live.previewUrl).toBe('blob:mock-1')
      act(() => result.current.applyImages([built('AAAA')]))
      expect(revokeObjectURL).toHaveBeenCalledWith(live.previewUrl)
      act(() => result.current.applyImages([built('BBBB')]))
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:built-AAAA')
    } finally {
      unstubDecodeGlobals()
    }
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
    // Same scenario as the R2-review finding: the add is still decoding
    // when the recall applies — the paste must land on top.
    const { result } = renderHook(() => usePastedImages())
    stubDecodeGlobals()
    try {
      await act(async () => {
        const adding = result.current.addImages([new File(['x'], 'p.png', { type: 'image/png' })])
        result.current.applyImages([built('RESTORED')])
        await adding
      })
      expect(result.current.images.map((i) => i.data)).toEqual(['RESTORED', 'ZZZZ'])
    } finally {
      unstubDecodeGlobals()
    }
  })
})

describe('usePastedImages.addImages', () => {
  it('adds every supported image in source order, one add bump per landed image', async () => {
    const { result } = renderHook(() => usePastedImages())
    stubDecodeGlobals()
    try {
      await act(async () => {
        await result.current.addImages([
          new File(['a'], 'a.png', { type: 'image/png' }),
          new File(['b'], 'b.jpg', { type: 'image/jpeg' }),
        ])
      })
      expect(result.current.images).toHaveLength(2)
      expect(result.current.error).toBeNull()
      expect(result.current.mutationsRef.current).toMatchObject({ seq: 2, kind: 'add' })
    } finally {
      unstubDecodeGlobals()
    }
  })

  it('counts the whole batch against the total limit instead of checking each file alone', async () => {
    const maxTotal = getMaxPastedImageBytes()
    // Three files that each fit the per-image limit but together exceed the
    // configured total; the third must be refused.
    const each = Math.floor(maxTotal / 3) + 1
    const { result } = renderHook(() => usePastedImages())
    stubDecodeGlobals()
    try {
      await act(async () => {
        await result.current.addImages([
          sizedFile('image/png', each, 'big-0.png'),
          sizedFile('image/png', each, 'big-1.png'),
          sizedFile('image/png', each, 'big-2.png'),
        ])
      })
      expect(result.current.images).toHaveLength(2)
      expect(result.current.error).toMatch(/Total image size too large/)
    } finally {
      unstubDecodeGlobals()
    }
  })

  it('skips an oversized image without dropping the rest of the batch', async () => {
    const { result } = renderHook(() => usePastedImages())
    stubDecodeGlobals()
    try {
      await act(async () => {
        await result.current.addImages([
          sizedFile('image/png', 10 * 1024 * 1024 + 1, 'too-big.png'),
          new File(['x'], 'ok.png', { type: 'image/png' }),
        ])
      })
      expect(result.current.images).toHaveLength(1)
      expect(result.current.error).toMatch(/Image too large/)
    } finally {
      unstubDecodeGlobals()
    }
  })

  it('skips an unsupported image type without dropping the rest of the batch', async () => {
    const { result } = renderHook(() => usePastedImages())
    stubDecodeGlobals()
    try {
      await act(async () => {
        await result.current.addImages([
          new File(['<svg/>'], 'vector.svg', { type: 'image/svg+xml' }),
          new File(['x'], 'ok.png', { type: 'image/png' }),
        ])
      })
      expect(result.current.images).toHaveLength(1)
      expect(result.current.error).toMatch(/Unsupported image type/)
    } finally {
      unstubDecodeGlobals()
    }
  })

  it('does not stamp a mutation when every file is refused', async () => {
    const { result } = renderHook(() => usePastedImages())
    try {
      await act(async () => {
        await result.current.addImages([sizedFile('image/png', 10 * 1024 * 1024 + 1)])
      })
      expect(result.current.images).toEqual([])
      expect(result.current.mutationsRef.current).toMatchObject({ seq: 0, kind: 'apply' })
    } finally {
      unstubDecodeGlobals()
    }
  })

  it('returns null when the whole batch lands', async () => {
    const { result } = renderHook(() => usePastedImages())
    stubDecodeGlobals()
    try {
      const error = await result.current.addImages([
        new File(['a'], 'a.png', { type: 'image/png' }),
      ])
      expect(error).toBeNull()
    } finally {
      unstubDecodeGlobals()
    }
  })

  it('returns the refusal message on every call so a caller can surface it again', async () => {
    const { result } = renderHook(() => usePastedImages())
    const tooBig = () => sizedFile('image/png', 10 * 1024 * 1024 + 1, 'too-big.png')
    const first = await result.current.addImages([tooBig()])
    const second = await result.current.addImages([tooBig()])
    expect(first).toMatch(/Image too large/)
    expect(second).toBe(first)
  })

  it('reserves accepted bytes across overlapping batches', async () => {
    const { result } = renderHook(() => usePastedImages())
    stubDecodeGlobals()
    try {
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
    } finally {
      unstubDecodeGlobals()
    }
  })

  it('counts a resolved batch against the next call in the same task', async () => {
    const { result } = renderHook(() => usePastedImages())
    stubDecodeGlobals()
    try {
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
    } finally {
      unstubDecodeGlobals()
    }
  })

  it('discards the whole in-flight batch when the draft is cleared during decoding', async () => {
    const { result } = renderHook(() => usePastedImages())
    stubDecodeGlobals()
    try {
      await act(async () => {
        const adding = result.current.addImages([
          new File(['a'], 'a.png', { type: 'image/png' }),
          new File(['b'], 'b.png', { type: 'image/png' }),
        ])
        result.current.clear()
        await adding
      })
      expect(result.current.images).toEqual([])
      expect(result.current.mutationsRef.current).toMatchObject({ seq: 1, kind: 'clear' })
    } finally {
      unstubDecodeGlobals()
    }
  })
})

describe('usePastedImages.pending', () => {
  it('is true while a batch decodes and false once it settles', async () => {
    const { result } = renderHook(() => usePastedImages())
    stubManualDecode()
    try {
      let adding!: Promise<string | null>
      act(() => {
        adding = result.current.addImages([new File(['a'], 'a.png', { type: 'image/png' })])
      })
      expect(result.current.pending).toBe(true)
      await act(async () => {
        flushManualReaders()
        await adding
      })
      expect(result.current.pending).toBe(false)
    } finally {
      unstubDecodeGlobals()
    }
  })

  it('stays pending until every overlapping batch settles', async () => {
    const { result } = renderHook(() => usePastedImages())
    stubManualDecode()
    try {
      let first!: Promise<string | null>
      let second!: Promise<string | null>
      act(() => {
        first = result.current.addImages([new File(['a'], 'a.png', { type: 'image/png' })])
        second = result.current.addImages([new File(['b'], 'b.png', { type: 'image/png' })])
      })
      expect(result.current.pending).toBe(true)
      // Settle only the first batch: the screen must stay blocked because the
      // second batch is still decoding. Awaiting `first` makes this
      // deterministic — a boolean pending flag would already read false here.
      await act(async () => {
        flushOneReader()
        await first
      })
      expect(result.current.pending).toBe(true)
      await act(async () => {
        flushOneReader()
        await Promise.all([first, second])
      })
      expect(result.current.pending).toBe(false)
    } finally {
      unstubDecodeGlobals()
    }
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
    stubDecodeGlobals()
    try {
      await act(async () => {
        await result.current.addImages([new File(['x'], 'p.png', { type: 'image/png' })])
      })
      // The paste landed: exactly one bump.
      expect(result.current.mutationsRef.current).toMatchObject({ seq: 1, kind: 'add' })

      // Second paste gets cleared mid-decode: the clear bumps, the discarded
      // paste must NOT add a second bump.
      await act(async () => {
        const adding = result.current.addImages([new File(['x'], 'p.png', { type: 'image/png' })])
        result.current.clear()
        await adding
      })
      expect(result.current.images).toEqual([])
      expect(result.current.mutationsRef.current).toMatchObject({ seq: 2, kind: 'clear' })
    } finally {
      unstubDecodeGlobals()
    }
  })
})
