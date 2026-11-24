// @vitest-environment happy-dom
/** PDF viewer states and stale-completion guards under controlled document loads and renders. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import type { PDFDocumentProxy, PDFPageProxy, PageViewport } from 'pdfjs-dist'
import type { openPdf } from '../../utils/pdf-runtime'
import type { renderPdfPage } from '../../utils/pdf-document'
import { PdfWorkerFailure, type PdfFailure } from '../../utils/pdf-errors'

const engine = vi.hoisted(() => ({
  open: vi.fn<typeof openPdf>(),
  render: vi.fn<typeof renderPdfPage>(),
}))
const overlay = vi.hoisted(() => ({ create: vi.fn(), render: vi.fn(), cancel: vi.fn() }))
vi.mock('../../utils/pdf-runtime', () => ({ openPdf: engine.open }))
vi.mock('../../utils/pdf-document', () => ({ renderPdfPage: engine.render }))
vi.mock('../../utils/pdf-text', () => ({
  pdfTextRenderer: (host: HTMLElement) => {
    overlay.create(host)
    return { render: overlay.render, cancel: overlay.cancel }
  },
}))
import { PdfBody } from './PdfBody'
import { forgetPdfViewState, recallPdfViewState, rememberPdfPage, rememberPdfZoom } from './pdf-view-state'

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

const loads: Array<{
  deferred: ReturnType<typeof deferred<PDFDocumentProxy>>
  dispose: ReturnType<typeof vi.fn>
  reportFailure: (failure: PdfFailure) => void
}> = []

const layout = vi.hoisted(() => ({ clientWidth: 124 }))
const viewport = { width: 100, height: 100, scale: 96 / 72, userUnit: 1, rotation: 0 } as PageViewport
const pageProxies = new Map<number, PDFPageProxy>()
const pageProxy = (pageNumber: number): PDFPageProxy => {
  let proxy = pageProxies.get(pageNumber)
  if (proxy === undefined) {
    proxy = { pageNumber, getViewport: () => viewport } as unknown as PDFPageProxy
    pageProxies.set(pageNumber, proxy)
  }
  return proxy
}
const documentOf = (numPages = 3): PDFDocumentProxy =>
  ({ numPages, getPage: vi.fn(async (n: number) => pageProxy(n)) }) as unknown as PDFDocumentProxy
const renderedPages = (): number[] =>
  engine.render.mock.calls.map(([page]) => (page as unknown as { pageNumber: number }).pageNumber)
const BYTES = new TextEncoder().encode('pdf-bytes')

beforeEach(() => {
  // Keep the 100px fixture pages at actual size inside the 24px document gutters.
  layout.clientWidth = 124
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => layout.clientWidth)
  pageProxies.clear()
  const context: Pick<CanvasRenderingContext2D, 'drawImage'> = { drawImage: () => {} }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as CanvasRenderingContext2D)
  loads.length = 0
  engine.open.mockReset().mockImplementation((_bytes, _signal, reportFailure) => {
    const d = deferred<PDFDocumentProxy>()
    const dispose = vi.fn(async () => {})
    loads.push({ deferred: d, dispose, reportFailure })
    return { document: d.promise, dispose }
  })
  engine.render.mockReset().mockImplementation(async (_page, canvas, zoom) => {
    canvas.width = canvas.height = Math.floor(100 * zoom)
  })
  overlay.create.mockReset()
  overlay.render.mockReset().mockResolvedValue(undefined)
  overlay.cancel.mockReset()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

class IntersectionObserverStub {
  static instances: IntersectionObserverStub[] = []
  readonly observed = new Set<Element>()
  disconnected = false

  constructor(
    private readonly callback: IntersectionObserverCallback,
    readonly options?: IntersectionObserverInit,
  ) {
    IntersectionObserverStub.instances.push(this)
  }

  observe(element: Element): void {
    this.observed.add(element)
  }
  unobserve(element: Element): void {
    this.observed.delete(element)
  }
  disconnect(): void {
    this.disconnected = true
    this.observed.clear()
  }
  takeRecords(): IntersectionObserverEntry[] {
    return []
  }
  intersect(element: Element, isIntersecting: boolean): void {
    this.callback(
      [{ target: element, isIntersecting } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    )
  }
}

describe('PdfBody', () => {
  it('shows loading, then mounts every page with only the first pre-rendered', async () => {
    const view = render(<PdfBody bytes={BYTES} title="report.pdf" />)
    expect(screen.getByRole('status').textContent).toBe('Rendering document…')
    await act(async () => {
      loads[0]!.deferred.resolve(documentOf(3))
    })
    await act(async () => {})
    expect(
      [...view.container.querySelectorAll('[data-pdf-page]')].map((page) =>
        page.getAttribute('data-pdf-page'),
      ),
    ).toEqual(['1', '2', '3'])
    expect(renderedPages()).toEqual([1])
    expect(screen.getByRole('img', { name: 'PDF page 1' })).toBeTruthy()
    expect(view.container.querySelectorAll('.pdf-page-placeholder')).toHaveLength(2)
    expect(view.container.querySelector('[data-pdf-page="1"] .pdf-page-placeholder')).toBeNull()
  })

  it('pre-requests the remembered page beside the first', async () => {
    render(<PdfBody bytes={BYTES} title="report.pdf" page={3} />)
    await act(async () => {
      loads[0]!.deferred.resolve(documentOf(3))
    })
    await act(async () => {})
    expect(renderedPages()).toEqual([1, 3])
  })

  it('shows a load failure and retries without replacing the bytes', async () => {
    render(<PdfBody bytes={BYTES} title="report.pdf" />)
    await act(async () => {
      loads[0]!.deferred.reject(new Error('invalid PDF'))
    })
    expect(screen.getByRole('alert').textContent).toContain('Cannot display PDF: invalid PDF')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await act(async () => {
      loads[1]!.deferred.resolve(documentOf(1))
    })
    await act(async () => {})
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('img', { name: 'PDF page 1' })).toBeTruthy()
    expect(engine.open.mock.calls.map(([bytes]) => new TextDecoder().decode(bytes))).toEqual([
      'pdf-bytes',
      'pdf-bytes',
    ])
  })

  it('reports password protection as unsupported, with no Retry', async () => {
    render(<PdfBody bytes={BYTES} title="report.pdf" />)
    const password = new Error('encrypted')
    password.name = 'PasswordException'
    await act(async () => {
      loads[0]!.deferred.reject(password)
    })
    expect(screen.getByRole('alert').textContent).toContain(
      'This PDF requires a password; password-protected previews are not supported.',
    )
    // Retry would re-open the same bytes and can never succeed.
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  })

  it('reports a post-load worker failure and retries', async () => {
    render(<PdfBody bytes={BYTES} title="report.pdf" />)
    await act(async () => {
      loads[0]!.deferred.resolve(documentOf(1))
    })
    act(() => {
      loads[0]!.reportFailure({ kind: 'worker' })
    })
    expect(screen.getByRole('alert').textContent).toContain(
      'The PDF rendering process could not continue. Please retry.',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await act(async () => {
      loads[1]!.deferred.resolve(documentOf(1))
    })
    await act(async () => {})
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('img', { name: 'PDF page 1' })).toBeTruthy()
  })

  it('classifies a worker rejection through the same message', async () => {
    render(<PdfBody bytes={BYTES} title="report.pdf" />)
    await act(async () => {
      loads[0]!.deferred.reject(new PdfWorkerFailure(new Event('error')))
    })
    expect(screen.getByRole('alert').textContent).toContain(
      'The PDF rendering process could not continue. Please retry.',
    )
  })

  it('renders later pages only when they approach the viewport and records the reached page', async () => {
    IntersectionObserverStub.instances = []
    vi.stubGlobal('IntersectionObserver', IntersectionObserverStub)
    const onViewState = vi.fn()
    const view = render(<PdfBody bytes={BYTES} title="report.pdf" onViewState={onViewState} />)
    await act(async () => {
      loads[0]!.deferred.resolve(documentOf(3))
    })
    await act(async () => {})
    expect(renderedPages()).toEqual([1])
    const second = view.container.querySelector('[data-pdf-page="2"]') as HTMLElement
    const observer = IntersectionObserverStub.instances.find((instance) => instance.observed.has(second))!
    act(() => {
      observer.intersect(second, false)
    })
    expect(renderedPages()).toEqual([1])
    await act(async () => {
      observer.intersect(second, true)
    })
    expect(renderedPages()).toEqual([1, 2])
    expect(onViewState).toHaveBeenCalledWith({ page: 2, zoom: 1 })
    expect(screen.getByRole('img', { name: 'PDF page 2' })).toBeTruthy()
    view.unmount()
    expect(IntersectionObserverStub.instances.every((instance) => instance.disconnected)).toBe(true)
    act(() => {
      observer.intersect(second, true)
    })
    expect(renderedPages()).toEqual([1, 2])
  })

  it('retains the displayed bitmap while cancelling and joining superseded zoom renders', async () => {
    const view = render(<PdfBody bytes={BYTES} title="report.pdf" />)
    await act(async () => {
      loads[0]!.deferred.resolve(documentOf(1))
    })
    await act(async () => {})
    const canvas = screen.getByRole('img') as HTMLCanvasElement
    expect(canvas.width).toBe(100)
    const obsolete = deferred<void>()
    const latest = deferred<void>()
    engine.render
      .mockImplementationOnce(async (_page, buffer) => {
        buffer.width = buffer.height = 200
        return obsolete.promise
      })
      .mockImplementationOnce(async (_page, buffer) => {
        buffer.width = buffer.height = 300
        return latest.promise
      })
    view.rerender(<PdfBody bytes={BYTES} title="report.pdf" zoom={2} />)
    await act(async () => {})
    expect(canvas.width).toBe(100)
    expect(screen.getByRole('img')).toBe(canvas)
    view.rerender(<PdfBody bytes={BYTES} title="report.pdf" zoom={3} />)
    await act(async () => {})
    expect(engine.render.mock.calls[1]![3].aborted).toBe(true)
    expect(engine.render).toHaveBeenCalledTimes(2)
    await act(async () => {
      obsolete.resolve(undefined)
    })
    expect(engine.render).toHaveBeenCalledTimes(3)
    expect(canvas.width).toBe(100)
    await act(async () => {
      latest.resolve(undefined)
    })
    expect(canvas.width).toBe(300)
    const body = view.container.querySelector('.pdf-body') as HTMLElement
    expect(body.style.getPropertyValue('--pdf-zoom')).toBe('3')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows a page render failure and retries that page', async () => {
    engine.render.mockRejectedValueOnce(new Error('render exploded'))
    render(<PdfBody bytes={BYTES} title="report.pdf" />)
    await act(async () => {
      loads[0]!.deferred.resolve(documentOf(1))
    })
    await act(async () => {})
    expect(screen.getByRole('alert').textContent).toContain('Cannot display PDF: render exploded')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await act(async () => {})
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('img', { name: 'PDF page 1' })).toBeTruthy()
  })

  it('stringifies a foreign render rejection', async () => {
    engine.render.mockRejectedValueOnce('foreign rendering failure')
    render(<PdfBody bytes={BYTES} title="report.pdf" />)
    await act(async () => {
      loads[0]!.deferred.resolve(documentOf(1))
    })
    await act(async () => {})
    expect(screen.getByRole('alert').textContent).toContain('Cannot display PDF: foreign rendering failure')
  })

  it('cancels a pending text layer when the canvas render fails', async () => {
    // The canvas render fails while the text layer is still laying out: the page
    // must cancel the unadopted text layer and surface the failure. (The real
    // TextLayerBuilder rejects its render promise on cancel — pdf.mjs
    // TextLayer.cancel — so PdfBody also drains it; vitest shields mock-returned
    // promise rejections, so that drain is pinned by library source, not here.)
    const textRendered = deferred<void>()
    overlay.render.mockReturnValueOnce(textRendered.promise)
    overlay.cancel.mockImplementationOnce(() => {
      textRendered.reject(new Error('text cancelled'))
    })
    engine.render.mockRejectedValueOnce(new Error('render exploded'))
    render(<PdfBody bytes={BYTES} title="report.pdf" />)
    await act(async () => {
      loads[0]!.deferred.resolve(documentOf(1))
    })
    await act(async () => {})
    expect(screen.getByRole('alert').textContent).toContain('Cannot display PDF: render exploded')
    expect(overlay.cancel).toHaveBeenCalled()
  })

  it('keeps the previous bitmap when canvas allocation fails and retries the zoom', async () => {
    const view = render(<PdfBody bytes={BYTES} title="report.pdf" />)
    await act(async () => {
      loads[0]!.deferred.resolve(documentOf(1))
    })
    await act(async () => {})
    const canvas = screen.getByRole('img') as HTMLCanvasElement
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValueOnce(null)
    view.rerender(<PdfBody bytes={BYTES} title="report.pdf" zoom={2} />)
    await act(async () => {})
    expect(canvas.width).toBe(100)
    expect(screen.getByRole('img')).toBe(canvas)
    expect(screen.getByRole('alert').textContent).toContain('PDF canvas has no 2D context')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await act(async () => {})
    expect(canvas.width).toBe(200)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('mounts selectable text with the page and cancels it when the body unmounts', async () => {
    const view = render(<PdfBody bytes={BYTES} title="report.pdf" />)
    await act(async () => {
      loads[0]!.deferred.resolve(documentOf(1))
    })
    await act(async () => {})
    expect(overlay.create).toHaveBeenCalledExactlyOnceWith(view.container.querySelector('[data-pdf-text]'))
    expect(overlay.render).toHaveBeenCalledExactlyOnceWith(pageProxy(1), viewport)
    expect(overlay.cancel).not.toHaveBeenCalled()
    view.rerender(<PdfBody bytes={BYTES} title="report.pdf" zoom={2} />)
    await act(async () => {})
    expect(overlay.render).toHaveBeenCalledOnce()
    expect(overlay.cancel).not.toHaveBeenCalled()
    view.unmount()
    expect(overlay.cancel).toHaveBeenCalledOnce()
  })

  it('keeps the replacement document when the previous load settles late', async () => {
    const view = render(<PdfBody bytes={BYTES} title="report.pdf" />)
    const replacement = new TextEncoder().encode('replacement')
    view.rerender(<PdfBody bytes={replacement} title="report.pdf" />)
    expect(loads[0]!.dispose).toHaveBeenCalledOnce()
    await act(async () => {
      loads[1]!.deferred.resolve(documentOf(2))
    })
    await act(async () => {
      loads[0]!.deferred.resolve(documentOf(99))
    })
    expect(view.container.querySelectorAll('[data-pdf-page]')).toHaveLength(2)
  })

  it('ignores a previous document rejection after its bytes are replaced', async () => {
    const view = render(<PdfBody bytes={BYTES} title="report.pdf" />)
    const replacement = new TextEncoder().encode('replacement')
    view.rerender(<PdfBody bytes={replacement} title="report.pdf" />)
    await act(async () => {
      loads[1]!.deferred.resolve(documentOf(2))
    })
    await act(async () => {
      loads[0]!.deferred.reject(new Error('late parsing error'))
      loads[0]!.reportFailure({ kind: 'worker' })
    })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(view.container.querySelectorAll('[data-pdf-page]')).toHaveLength(2)
  })

  it('fits wide pages to the container, shrinks only, and tracks resizes', async () => {
    layout.clientWidth = 60
    let resize: ResizeObserverCallback | undefined
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          resize = callback
        }
        observe = vi.fn()
        disconnect = vi.fn()
      },
    )
    const view = render(<PdfBody bytes={BYTES} title="report.pdf" />)
    await act(async () => {
      loads[0]!.deferred.resolve(documentOf(1))
    })
    await act(async () => {})
    const body = view.container.querySelector('.pdf-body') as HTMLElement
    const surface = view.container.querySelector('.pdf-page-surface') as HTMLElement
    // The surface carries the intrinsic 96-DPI width; the fit zoom (60 - 24
    // gutter) / 100 = 0.36 rides the body variable the CSS width rule reads.
    expect(surface.style.getPropertyValue('--pdf-page-width')).toBe('100px')
    expect(body.getAttribute('data-pdf-zoom-mode')).toBe('fit-width')
    expect(body.style.getPropertyValue('--pdf-zoom')).toBe('0.36')
    expect(engine.render.mock.calls.at(-1)![2]).toBeCloseTo(0.36)
    layout.clientWidth = 500
    await act(async () => {
      resize!([], {} as ResizeObserver)
    })
    // Fit only shrinks: a 500px container keeps the 100px page at actual size.
    expect(body.style.getPropertyValue('--pdf-zoom')).toBe('1')
    expect(engine.render.mock.calls.at(-1)![2]).toBe(1)
  })
})

describe('PdfBody zoom UX', () => {
  const KEY = 'crw-resource://file/s1/repo/report.pdf'

  beforeEach(() => {
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(null)
  })

  afterEach(() => {
    forgetPdfViewState(KEY)
  })

  async function loadedBody(props: Partial<Parameters<typeof PdfBody>[0]> = {}) {
    const view = render(<PdfBody bytes={BYTES} title="report.pdf" {...props} />)
    await act(async () => {
      loads.at(-1)!.deferred.resolve(documentOf(3))
    })
    await act(async () => {})
    const body = view.container.querySelector('.pdf-body') as HTMLElement
    const frame = view.container.querySelector('.pdf-frame') as HTMLElement
    return { view, body, frame }
  }

  function stubFrameRect(frame: HTMLElement, bottom: number) {
    vi.spyOn(frame, 'getBoundingClientRect').mockReturnValue({ bottom } as DOMRect)
  }

  /** happy-dom's WheelEvent extends UIEvent — it carries no modifier keys or
   *  pointer coordinates (real browsers derive it from MouseEvent). A MouseEvent
   *  typed 'wheel' with the delta fields defined carries the full shape the
   *  gesture handler reads. Returns false when the handler prevented default. */
  function wheel(
    node: Element,
    init: { ctrlKey?: boolean; deltaY: number; clientX?: number; clientY?: number },
  ): boolean {
    const event = new MouseEvent('wheel', {
      bubbles: true,
      cancelable: true,
      ctrlKey: init.ctrlKey ?? false,
      clientX: init.clientX ?? 0,
      clientY: init.clientY ?? 0,
    })
    Object.defineProperty(event, 'deltaY', { value: init.deltaY })
    Object.defineProperty(event, 'deltaMode', { value: 0 })
    return node.dispatchEvent(event)
  }

  /** The live observer for a page: once ready, the page observes its canvas. */
  function intersectPage(pageEl: HTMLElement, isIntersecting: boolean) {
    const observer = [...IntersectionObserverStub.instances]
      .reverse()
      .find((instance) => !instance.disconnected && [...instance.observed].some((el) => pageEl.contains(el)))!
    const target = [...observer.observed].find((el) => pageEl.contains(el))!
    act(() => {
      observer.intersect(target, isIntersecting)
    })
  }

  it('observes pages against the scroll container so the lookahead pre-renders ahead of its fold', async () => {
    IntersectionObserverStub.instances = []
    vi.stubGlobal('IntersectionObserver', IntersectionObserverStub)
    const { body } = await loadedBody()
    const observers = IntersectionObserverStub.instances.filter((instance) => instance.observed.size > 0)
    expect(observers.length).toBeGreaterThan(0)
    for (const observer of observers) {
      expect(observer.options?.root).toBe(body)
      expect(observer.options?.rootMargin).toBe('100% 0px')
    }
  })

  it('ctrl+wheel zooms anchored at the pointer and compensates scroll; plain wheel scrolls', async () => {
    const { body } = await loadedBody()
    vi.spyOn(body, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0 } as DOMRect)
    Object.defineProperty(body, 'clientHeight', { value: 100, configurable: true })
    body.scrollTop = 10
    const rendersBefore = engine.render.mock.calls.length
    // Plain wheel: no zoom, default not prevented.
    expect(wheel(body, { deltaY: -100 })).toBe(true)
    expect(body.style.getPropertyValue('--pdf-zoom')).toBe('1')
    expect(wheel(body, { ctrlKey: true, deltaY: -40, clientX: 100, clientY: 50 })).toBe(false)
    const factor = Math.exp(0.4)
    expect(body.getAttribute('data-pdf-zoom-mode')).toBe('fixed')
    expect(Number(body.style.getPropertyValue('--pdf-zoom'))).toBeCloseTo(factor)
    // Pointer offset y = 50 stays fixed: (10 + 50) * factor - 50.
    expect(body.scrollTop).toBeCloseTo((10 + 50) * factor - 50)
    // The gesture has not settled: no page redraw yet.
    expect(engine.render.mock.calls.length).toBe(rendersBefore)
  })

  it('redraws nearby pages only after the gesture settles, and persists the settled zoom', async () => {
    vi.useFakeTimers()
    try {
      const { body } = await loadedBody({ viewStateKey: KEY })
      vi.spyOn(body, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0 } as DOMRect)
      wheel(body, { ctrlKey: true, deltaY: -40 })
      const factor = Math.exp(0.4)
      expect(engine.render).toHaveBeenCalledTimes(1)
      // A second gesture tick restarts the settle window.
      act(() => {
        vi.advanceTimersByTime(60)
      })
      wheel(body, { ctrlKey: true, deltaY: 0 })
      act(() => {
        vi.advanceTimersByTime(60)
      })
      expect(engine.render).toHaveBeenCalledTimes(1)
      expect(recallPdfViewState(KEY)).toBeUndefined()
      await act(async () => {
        vi.advanceTimersByTime(60)
      })
      expect(engine.render).toHaveBeenCalledTimes(2)
      expect(engine.render.mock.calls.at(-1)![2]).toBeCloseTo(factor)
      expect(recallPdfViewState(KEY)?.zoom).toBeCloseTo(factor)
    } finally {
      vi.useRealTimers()
    }
  })

  it('zooms to a preset from the floating controls and redraws only nearby pages', async () => {
    IntersectionObserverStub.instances = []
    vi.stubGlobal('IntersectionObserver', IntersectionObserverStub)
    const { view } = await loadedBody()
    fireEvent.click(screen.getByRole('button', { name: 'Zoom presets' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: '200%' }))
    })
    // Only the rendered page 1 redraws; the skeletons stay untouched.
    expect(renderedPages()).toEqual([1, 1])
    expect(engine.render.mock.calls.at(-1)![2]).toBe(2)
    const second = view.container.querySelector('[data-pdf-page="2"]') as HTMLElement
    await act(async () => {
      intersectPage(second, true)
    })
    // The approaching page renders at the settled zoom, not the old one.
    expect(renderedPages()).toEqual([1, 1, 2])
    expect(engine.render.mock.calls.at(-1)![2]).toBe(2)
  })

  it('does not redraw an offscreen rendered page until it approaches again', async () => {
    IntersectionObserverStub.instances = []
    vi.stubGlobal('IntersectionObserver', IntersectionObserverStub)
    const { view } = await loadedBody()
    const second = view.container.querySelector('[data-pdf-page="2"]') as HTMLElement
    await act(async () => {
      intersectPage(second, true)
    })
    expect(renderedPages()).toEqual([1, 2])
    intersectPage(second, false)
    fireEvent.click(screen.getByRole('button', { name: 'Zoom presets' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: '200%' }))
    })
    expect(renderedPages()).toEqual([1, 2, 1])
    await act(async () => {
      intersectPage(second, true)
    })
    expect(renderedPages()).toEqual([1, 2, 1, 2])
    expect(engine.render.mock.calls.at(-1)![2]).toBe(2)
  })

  it('returns to fit-width from the menu and keeps tracking resizes', async () => {
    const { body } = await loadedBody({ viewStateKey: KEY })
    fireEvent.click(screen.getByRole('button', { name: 'Zoom presets' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: '200%' }))
    })
    expect(body.getAttribute('data-pdf-zoom-mode')).toBe('fixed')
    expect(recallPdfViewState(KEY)?.zoom).toBe(2)
    fireEvent.click(screen.getByRole('button', { name: 'Zoom presets' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Fit width' }))
    })
    expect(body.getAttribute('data-pdf-zoom-mode')).toBe('fit-width')
    expect(engine.render.mock.calls.at(-1)![2]).toBe(1)
    expect(recallPdfViewState(KEY)).toEqual({ page: 1 })
  })

  it('reveals the controls near the bottom edge and hides them after the delay', async () => {
    vi.useFakeTimers()
    try {
      const { frame } = await loadedBody()
      stubFrameRect(frame, 500)
      const toolbar = screen.getByRole('toolbar')
      expect(toolbar.getAttribute('data-visible')).toBeNull()
      fireEvent.pointerMove(frame, { pointerType: 'mouse', clientY: 480 })
      expect(toolbar.getAttribute('data-visible')).toBe('true')
      fireEvent.pointerMove(frame, { pointerType: 'mouse', clientY: 100 })
      act(() => {
        vi.advanceTimersByTime(419)
      })
      expect(toolbar.getAttribute('data-visible')).toBe('true')
      act(() => {
        vi.advanceTimersByTime(1)
      })
      expect(toolbar.getAttribute('data-visible')).toBeNull()
      // Leaving the frame hides too.
      fireEvent.pointerMove(frame, { pointerType: 'mouse', clientY: 490 })
      expect(toolbar.getAttribute('data-visible')).toBe('true')
      fireEvent.pointerLeave(frame)
      act(() => {
        vi.advanceTimersByTime(420)
      })
      expect(toolbar.getAttribute('data-visible')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the controls visible while hovered or mid-gesture', async () => {
    vi.useFakeTimers()
    try {
      const { body, frame } = await loadedBody()
      stubFrameRect(frame, 500)
      vi.spyOn(body, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0 } as DOMRect)
      const toolbar = screen.getByRole('toolbar')
      fireEvent.pointerMove(frame, { pointerType: 'mouse', clientY: 480 })
      fireEvent.pointerEnter(toolbar, { pointerType: 'mouse' })
      fireEvent.pointerMove(frame, { pointerType: 'mouse', clientY: 100 })
      act(() => {
        vi.advanceTimersByTime(420)
      })
      expect(toolbar.getAttribute('data-visible')).toBe('true')
      fireEvent.pointerLeave(toolbar)
      act(() => {
        vi.advanceTimersByTime(420)
      })
      expect(toolbar.getAttribute('data-visible')).toBeNull()
      // A gesture reveals the controls and holds them until it settles.
      act(() => {
        wheel(body, { ctrlKey: true, deltaY: -10 })
      })
      expect(toolbar.getAttribute('data-visible')).toBe('true')
      fireEvent.pointerLeave(frame)
      act(() => {
        vi.advanceTimersByTime(120 + 420)
      })
      expect(toolbar.getAttribute('data-visible')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('retains page and zoom across unmount/remount and forgets them on close', async () => {
    IntersectionObserverStub.instances = []
    vi.stubGlobal('IntersectionObserver', IntersectionObserverStub)
    const first = await loadedBody({ viewStateKey: KEY })
    // Mount-time intersections must not clobber the remembered page: only a
    // user scroll arms page retention.
    const second = first.view.container.querySelector('[data-pdf-page="2"]') as HTMLElement
    await act(async () => {
      intersectPage(second, true)
    })
    expect(recallPdfViewState(KEY)).toBeUndefined()
    fireEvent.scroll(first.body)
    intersectPage(second, false)
    await act(async () => {
      intersectPage(second, true)
    })
    expect(recallPdfViewState(KEY)?.page).toBe(2)
    fireEvent.click(screen.getByRole('button', { name: 'Zoom presets' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: '150%' }))
    })
    expect(recallPdfViewState(KEY)).toEqual({ page: 2, zoom: 1.5 })
    first.view.unmount()

    // Remount (panel switch back): the remembered page pre-renders beside the
    // first and the settled zoom drives the raster.
    engine.render.mockClear()
    const again = await loadedBody({ viewStateKey: KEY })
    expect(renderedPages()).toEqual([1, 2])
    expect(engine.render.mock.calls.at(-1)![2]).toBe(1.5)
    expect(again.body.getAttribute('data-pdf-zoom-mode')).toBe('fixed')
    again.view.unmount()

    // Closing the tab forgets the view state: a fresh open starts at fit-width.
    forgetPdfViewState(KEY)
    engine.render.mockClear()
    const fresh = await loadedBody({ viewStateKey: KEY })
    expect(renderedPages()).toEqual([1])
    expect(fresh.body.getAttribute('data-pdf-zoom-mode')).toBe('fit-width')
  })

  it('seeds the remembered page and zoom from the store on mount', async () => {
    rememberPdfPage(KEY, 3)
    rememberPdfZoom(KEY, 0.5)
    const { body } = await loadedBody({ viewStateKey: KEY })
    expect(renderedPages()).toEqual([1, 3])
    expect(engine.render.mock.calls.at(-1)![2]).toBe(0.5)
    expect(body.getAttribute('data-pdf-zoom-mode')).toBe('fixed')
  })
})
