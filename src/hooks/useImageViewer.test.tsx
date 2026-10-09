// Tests for the ImageViewerProvider — the app-singleton state that the three
// msg-image render sites drive (openViewer) and the Lightbox renders from.
// Runs in happy-dom (renderHook). The provider also mounts the Lightbox, so
// an integration pass (open → image visible → close) lives here too.

import { describe, it, expect, afterEach } from 'vitest'
import { cleanup, renderHook, act } from '@testing-library/react'
import { ImageViewerProvider, useImageViewer } from './useImageViewer'

afterEach(cleanup)

/** Test hook exposing the api and forcing a re-render when it changes. */
function useProbe(): { api: ReturnType<typeof useImageViewer>; version: number } {
  const api = useImageViewer()
  return { api, version: api.state.images.length + (api.state.open ? 100 : 0) + api.state.index }
}

// happy-dom decodes data-URL PNGs; fixtures must be real decodable images.
const PNG_1PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const srcA = `${PNG_1PX}#a`
const srcB = `${PNG_1PX}#b`
describe('ImageViewerProvider', () => {
  it('starts closed and opens at the requested index', () => {
    const { result } = renderHook(useProbe, { wrapper: ImageViewerProvider })
    expect(result.current.api.state.open).toBe(false)
    act(() => {
      result.current.api.openViewer(
        [
          { src: srcA, alt: 'one' },
          { src: srcB, alt: 'two' },
        ],
        1,
      )
    })
    expect(result.current.api.state.open).toBe(true)
    expect(result.current.api.state.index).toBe(1)
    expect(result.current.api.state.images[1]?.alt).toBe('two')
  })

  it('openViewer clamps an out-of-range index', () => {
    const { result } = renderHook(useProbe, { wrapper: ImageViewerProvider })
    act(() => result.current.api.openViewer([{ src: 'a' }], 5))
    expect(result.current.api.state.index).toBe(0)
    act(() => result.current.api.openViewer([{ src: 'a' }, { src: 'b' }], -1))
    expect(result.current.api.state.index).toBe(0)
  })

  it('next/prev navigate with wrap-around', () => {
    const { result } = renderHook(useProbe, { wrapper: ImageViewerProvider })
    act(() =>
      result.current.api.openViewer([{ src: 'a' }, { src: 'b' }, { src: 'c' }]),
    )
    act(() => result.current.api.next())
    expect(result.current.api.state.index).toBe(1)
    act(() => result.current.api.next())
    expect(result.current.api.state.index).toBe(2)
    act(() => result.current.api.next())
    expect(result.current.api.state.index).toBe(0) // wrapped
    act(() => result.current.api.prev())
    expect(result.current.api.state.index).toBe(2) // wrapped backwards
  })

  it('close() hides the viewer but keeps the last images (exit animation may read them)', () => {
    const { result } = renderHook(useProbe, { wrapper: ImageViewerProvider })
    act(() => result.current.api.openViewer([{ src: 'a' }]))
    act(() => result.current.api.close())
    expect(result.current.api.state.open).toBe(false)
    expect(result.current.api.state.images).toHaveLength(1)
  })

  it('useImageViewer outside a provider is a no-op api (does not throw)', () => {
    const { result } = renderHook(useProbe)
    expect(result.current.api.state.open).toBe(false)
    expect(() => act(() => result.current.api.openViewer([{ src: 'a' }]))).not.toThrow()
    expect(result.current.api.state.open).toBe(false)
  })

  it('mounts the Lightbox: openViewer shows the image, close exits via the overlay animation', () => {
    const { result } = renderHook(useProbe, { wrapper: ImageViewerProvider })
    expect(document.body.querySelector('img.lightbox-img')).toBeNull()
    act(() => result.current.api.openViewer([{ src: srcA, alt: 'shot' }]))
    const img = document.body.querySelector('img.lightbox-img')
    expect(img).not.toBeNull()
    expect(img?.getAttribute('src')).toBe(srcA)
    expect(img?.getAttribute('alt')).toBe('shot')
    act(() => result.current.api.close())
    // Exit is animated: the image is still mounted right after close, but the
    // overlay reports the closing state (removed once the ~180ms elapse).
    const backdrop = document.body.querySelector('.lightbox-overlay')
    expect(backdrop?.getAttribute('data-state')).toBe('closing')
  })
})
