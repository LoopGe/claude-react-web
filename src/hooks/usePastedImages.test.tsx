// Tests for usePastedImages.restore — rebuilding live attachments from the
// persisted (base64) shape, with fresh ids and blob URLs. jsdom has no
// implemention of URL.createObjectURL/revokeObjectURL, so both are stubbed.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { usePastedImages } from './usePastedImages'
import type { PersistedImage } from '../state/inputHistoryImages'

function persisted(data = 'AAAA', mediaType: PersistedImage['mediaType'] = 'image/png'): PersistedImage {
  return { data, mediaType, width: 10, height: 20, size: 3 }
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

describe('usePastedImages.restore', () => {
  it('rebuilds live images from the persisted shape (fresh id + blob URL)', () => {
    const { result } = renderHook(() => usePastedImages())
    act(() => result.current.restore([persisted()]))
    expect(result.current.images).toHaveLength(1)
    const img = result.current.images[0]
    expect(img.data).toBe('AAAA')
    expect(img.mediaType).toBe('image/png')
    expect(img.width).toBe(10)
    expect(img.height).toBe(20)
    expect(img.size).toBe(3)
    expect(img.id).toBeTruthy()
    expect(img.previewUrl).toBe('blob:mock-1')
    // The blob handed to createObjectURL carries the media type and the
    // decoded base64 length ('AAAA' = 4 chars, no padding → 3 bytes).
    const blob = createObjectURL.mock.calls[0][0] as Blob
    expect(blob.type).toBe('image/png')
    expect(blob.size).toBe(3)
  })

  it('replaces pending images and revokes their URLs', () => {
    const { result } = renderHook(() => usePastedImages())
    act(() => result.current.restore([persisted()]))
    const first = result.current.images[0]
    act(() => result.current.restore([persisted('BBBB', 'image/jpeg')]))
    expect(result.current.images).toHaveLength(1)
    expect(result.current.images[0].data).toBe('BBBB')
    expect(result.current.images[0].previewUrl).toBe('blob:mock-2')
    expect(result.current.images[0].id).not.toBe(first.id)
    expect(revokeObjectURL).toHaveBeenCalledWith(first.previewUrl)
  })

  it('restore([]) clears (the text-only recall case)', () => {
    const { result } = renderHook(() => usePastedImages())
    act(() => result.current.restore([persisted()]))
    act(() => result.current.restore([]))
    expect(result.current.images).toEqual([])
    expect(revokeObjectURL).toHaveBeenCalledTimes(1)
  })

  it('an in-flight paste survives a restore instead of being dropped', async () => {
    // FileReader is stubbed with a gate so addImage is still decoding when
    // the recall restore runs — the pasted image must land ON TOP of the
    // restored set (its blob URL is still valid), not be discarded.
    class FakeFileReader {
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      result: string | null = null
      readAsDataURL() {
        queueMicrotask(() => {
          this.result = 'data:image/png;base64,ZZZZ'
          this.onload?.()
        })
      }
    }
    // jsdom never loads blob: URLs — stub Image so dimension probing settles.
    class FakeImage {
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      naturalWidth = 10
      naturalHeight = 20
      set src(_v: string) { queueMicrotask(() => this.onload?.()) }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(globalThis as any).FileReader = FakeFileReader
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(globalThis as any).Image = FakeImage
    try {
      const { result } = renderHook(() => usePastedImages())
      const file = new File(['x'], 'paste.png', { type: 'image/png' })
      await act(async () => {
        const adding = result.current.addImage(file)
        // Recall restore runs while addImage is mid-decode.
        result.current.restore([persisted('RESTORED')])
        await adding
      })
      expect(result.current.images.map((i) => i.data)).toEqual(['RESTORED', 'ZZZZ'])
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (globalThis as any).FileReader
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (globalThis as any).Image
    }
  })
})
