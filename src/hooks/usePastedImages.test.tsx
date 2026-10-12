// Tests for usePastedImages: live paste management + applyImages (the
// history-recall applier, which receives PREBUILT images from the decode
// cache). All images are composer-owned — the decode cache is a pure Blob
// memo and never owns URLs. jsdom has no implementation of
// URL.createObjectURL/revokeObjectURL, so both are stubbed.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { usePastedImages } from './usePastedImages'
import type { PastedImage } from '../types'

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
        await result.current.addImage(new File(['x'], 'p.png', { type: 'image/png' }))
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
    // Same scenario as the R2-review finding: addImage is still decoding
    // when the recall applies — the paste must land on top.
    const { result } = renderHook(() => usePastedImages())
    stubDecodeGlobals()
    try {
      await act(async () => {
        const adding = result.current.addImage(new File(['x'], 'p.png', { type: 'image/png' }))
        result.current.applyImages([built('RESTORED')])
        await adding
      })
      expect(result.current.images.map((i) => i.data)).toEqual(['RESTORED', 'ZZZZ'])
    } finally {
      unstubDecodeGlobals()
    }
  })
})
