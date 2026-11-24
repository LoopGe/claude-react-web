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

  constructor(private readonly callback: IntersectionObserverCallback) {
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

  it('reports password protection as unsupported', async () => {
    render(<PdfBody bytes={BYTES} title="report.pdf" />)
    const password = new Error('encrypted')
    password.name = 'PasswordException'
    await act(async () => {
      loads[0]!.deferred.reject(password)
    })
    expect(screen.getByRole('alert').textContent).toContain(
      'This PDF requires a password; password-protected previews are not supported.',
    )
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
    expect(canvas.style.width).toBe('300px')
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
    render(<PdfBody bytes={BYTES} title="report.pdf" />)
    await act(async () => {
      loads[0]!.deferred.resolve(documentOf(1))
    })
    await act(async () => {})
    const canvas = screen.getByRole('img') as HTMLCanvasElement
    // (60 - 24 gutter) / 100 intrinsic = 0.36 fit-width zoom.
    expect(canvas.style.width).toBe('36px')
    expect(engine.render.mock.calls.at(-1)![2]).toBeCloseTo(0.36)
    layout.clientWidth = 500
    await act(async () => {
      resize!([], {} as ResizeObserver)
    })
    // Fit only shrinks: a 500px container keeps the 100px page at actual size.
    expect(canvas.style.width).toBe('100px')
    expect(engine.render.mock.calls.at(-1)![2]).toBe(1)
  })
})
