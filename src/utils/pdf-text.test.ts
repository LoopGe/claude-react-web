// @vitest-environment happy-dom
/** Text overlay resources follow page ownership; resize only aligns selection with the existing canvas. */
import { afterEach, expect, it, vi } from 'vitest'
import type { PageViewport, PDFPageProxy } from 'pdfjs-dist'

const api = vi.hoisted(() => ({ render: vi.fn(), cancel: vi.fn(), create: vi.fn() }))
vi.mock('pdfjs-dist', () => ({}))
vi.mock('pdfjs-dist/web/pdf_viewer.mjs', () => ({
  TextLayerBuilder: class {
    div = document.createElement('div')
    #onAppend: (div: HTMLDivElement) => void
    constructor(options: { onAppend: (div: HTMLDivElement) => void }) {
      api.create(options)
      this.#onAppend = options.onAppend
    }
    // Like PDF.js, the builder hands its layer to onAppend only after the text is laid out.
    render = async (params: unknown) => {
      await api.render(params)
      this.#onAppend(this.div)
    }
    cancel = api.cancel
  },
}))
import { pdfTextRenderer } from './pdf-text'

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

it('attaches the text layer only after rendering finishes', async () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn()
      disconnect = vi.fn()
    },
  )
  const rendered = deferred<undefined>()
  api.render.mockReturnValueOnce(rendered.promise)
  const host = document.createElement('div')
  const task = pdfTextRenderer(host)
  const pending = task.render({} as PDFPageProxy, { width: 400, scale: 1, userUnit: 1 } as PageViewport)
  expect(host.childElementCount).toBe(0)
  rendered.resolve(undefined)
  await pending
  expect(host.childElementCount).toBe(1)
  task.cancel()
})

it('keeps a layer cancelled after its text finished out of the host', async () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn()
      disconnect = vi.fn()
    },
  )
  const rendered = deferred<undefined>()
  api.render.mockReturnValueOnce(rendered.promise)
  const host = document.createElement('div')
  const task = pdfTextRenderer(host)
  const pending = task.render({} as PDFPageProxy, { width: 400, scale: 1, userUnit: 1 } as PageViewport)
  rendered.resolve(undefined)
  task.cancel()
  await pending
  expect(host.childElementCount).toBe(0)
  // Once from the cancelled onAppend branch, once from the explicit cancel.
  expect(api.cancel).toHaveBeenCalledTimes(2)
})

it('aligns selectable text to the displayed width and removes its observer and DOM on cancellation', async () => {
  let resize: ResizeObserverCallback | undefined
  const observe = vi.fn()
  const disconnect = vi.fn()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: ResizeObserverCallback) {
        resize = callback
      }
      observe = observe
      disconnect = disconnect
    },
  )
  api.render.mockResolvedValue(undefined)
  const host = document.createElement('div')
  let width = 200
  vi.spyOn(host, 'getBoundingClientRect').mockImplementation(() => ({ width }) as DOMRect)
  const viewport = { width: 400, scale: 4 / 3, userUnit: 1 } as PageViewport
  const page = {} as PDFPageProxy
  const task = pdfTextRenderer(host)
  await task.render(page, viewport)
  expect(api.create).toHaveBeenCalledWith(expect.objectContaining({ pdfPage: page }))
  expect(api.render).toHaveBeenCalledWith({ viewport })
  expect(observe).toHaveBeenCalledWith(host)
  const container = host.firstElementChild as HTMLElement
  expect(container.style.getPropertyValue('--total-scale-factor')).toBe(String(4 / 3))
  expect(container.style.scale).toBe('0.5')
  width = 100
  resize!([], {} as ResizeObserver)
  expect(container.style.scale).toBe('0.25')
  task.cancel()
  expect(disconnect).toHaveBeenCalledOnce()
  expect(api.cancel).toHaveBeenCalledOnce()
  expect(host.childElementCount).toBe(0)
})

it('folds userUnit into the scale factor so large-unit pages select at the right size', async () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn()
      disconnect = vi.fn()
    },
  )
  api.render.mockResolvedValue(undefined)
  const host = document.createElement('div')
  vi.spyOn(host, 'getBoundingClientRect').mockImplementation(() => ({ width: 400 }) as DOMRect)
  const task = pdfTextRenderer(host)
  await task.render({} as PDFPageProxy, { width: 400, scale: 4 / 3, userUnit: 2 } as PageViewport)
  const container = host.firstElementChild as HTMLElement
  expect(container.style.getPropertyValue('--total-scale-factor')).toBe(String((4 / 3) * 2))
  expect(container.style.scale).toBe('1')
  task.cancel()
})
