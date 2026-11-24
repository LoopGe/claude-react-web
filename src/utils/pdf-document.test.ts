// @vitest-environment happy-dom
/** Page rendering, cancellation, and raster-cap math under controlled pdfjs proxies. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PDFPageProxy } from 'pdfjs-dist'
import { renderPdfPage } from './pdf-document'
import { deferred } from '../test-utils/deferred'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('PDF canvas rendering', () => {
  it('renders at the 96/72 viewport with an identity transform at ratio 1', async () => {
    vi.stubGlobal('devicePixelRatio', 1)
    const viewport = { width: 100, height: 80 }
    const cleanup = vi.fn()
    const render = vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() }))
    const page = { getViewport: vi.fn(() => viewport), render, cleanup } as unknown as PDFPageProxy
    const canvas = document.createElement('canvas')
    await expect(renderPdfPage(page, canvas, 1, new AbortController().signal)).resolves.toBeUndefined()
    expect(page.getViewport).toHaveBeenCalledWith({ scale: 96 / 72 })
    expect(canvas.width).toBe(100)
    expect(canvas.height).toBe(80)
    expect(render).toHaveBeenCalledWith({ canvas, viewport, transform: undefined })
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it('scales the raster by devicePixelRatio × zoom through the render transform', async () => {
    vi.stubGlobal('devicePixelRatio', 2)
    const viewport = { width: 100, height: 80 }
    const render = vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() }))
    const page = { getViewport: () => viewport, render, cleanup: vi.fn() } as unknown as PDFPageProxy
    const canvas = document.createElement('canvas')
    await renderPdfPage(page, canvas, 1.5, new AbortController().signal)
    expect(canvas.width).toBe(300)
    expect(canvas.height).toBe(240)
    expect(render).toHaveBeenCalledWith({ canvas, viewport, transform: [3, 0, 0, 3, 0, 0] })
  })

  it('bounds raster allocation at 2^24 pixels for large zoomed pages', async () => {
    vi.stubGlobal('devicePixelRatio', 2)
    const viewport = { width: 8192, height: 8192 }
    const cleanup = vi.fn()
    const getViewport = vi.fn(() => viewport)
    const render = vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() }))
    const page = { getViewport, render, cleanup } as unknown as PDFPageProxy
    const canvas = document.createElement('canvas')
    await renderPdfPage(page, canvas, 2, new AbortController().signal)
    expect(getViewport).toHaveBeenCalledWith({ scale: 96 / 72 })
    expect(canvas.width * canvas.height).toBe(16_777_216)
    expect(render).toHaveBeenCalledWith({ canvas, viewport, transform: [0.5, 0, 0, 0.5, 0, 0] })
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it('cancels when the owner aborts during the library render call, before the listener attaches', async () => {
    vi.stubGlobal('devicePixelRatio', 1)
    const controller = new AbortController()
    const cancel = vi.fn()
    const cleanup = vi.fn()
    const page = {
      getViewport: () => ({ width: 100, height: 80 }),
      render: () => {
        controller.abort()
        return { cancel, promise: Promise.resolve() }
      },
      cleanup,
    } as unknown as PDFPageProxy
    await expect(
      renderPdfPage(page, document.createElement('canvas'), 1, controller.signal),
    ).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(cancel).toHaveBeenCalledOnce()
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it('cancels an active task and cleans up only after its promise settles', async () => {
    vi.stubGlobal('devicePixelRatio', 1)
    const running = deferred<void>()
    const entered = deferred<void>()
    const controller = new AbortController()
    const cleanup = vi.fn()
    const cancel = vi.fn()
    const page = {
      getViewport: () => ({ width: 100, height: 80 }),
      render: () => {
        entered.resolve(undefined)
        return { promise: running.promise, cancel }
      },
      cleanup,
    } as unknown as PDFPageProxy
    const pending = renderPdfPage(page, document.createElement('canvas'), 2, controller.signal)
    const rejected = expect(pending).rejects.toThrow('cancelled')
    await entered.promise
    controller.abort()
    expect(cancel).toHaveBeenCalledOnce()
    expect(cleanup).not.toHaveBeenCalled()
    running.reject(new Error('cancelled'))
    await rejected
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it('does not touch the page or canvas when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const render = vi.fn()
    const cleanup = vi.fn()
    const page = { getViewport: vi.fn(), render, cleanup } as unknown as PDFPageProxy
    const canvas = document.createElement('canvas')
    await expect(renderPdfPage(page, canvas, 1, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(render).not.toHaveBeenCalled()
    expect(cleanup).not.toHaveBeenCalled()
    expect(canvas.width).toBe(300)
  })

  it('cancels and cleans up when the render task itself fails', async () => {
    vi.stubGlobal('devicePixelRatio', 1)
    const cancel = vi.fn()
    const cleanup = vi.fn()
    const page = {
      getViewport: () => ({ width: 100, height: 80 }),
      render: () => ({ promise: Promise.reject(new Error('render exploded')), cancel }),
      cleanup,
    } as unknown as PDFPageProxy
    await expect(
      renderPdfPage(page, document.createElement('canvas'), 1, new AbortController().signal),
    ).rejects.toThrow('render exploded')
    expect(cancel).toHaveBeenCalledOnce()
    expect(cleanup).toHaveBeenCalledOnce()
  })
})
