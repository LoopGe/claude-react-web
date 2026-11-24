/** PDF page presentation: complete bytes in, lazily rendered selectable pages out.
 *
 * Ported from DSH's pdf.tsx rendering mechanics onto our preview props. The whole
 * PDF engine (pdf.js + worker + inlined assets + text viewer) stays behind the
 * LazyPdfBody dynamic import; this module is the lazy chunk's entry. */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { openPdf } from '../../utils/pdf-runtime'
import { renderPdfPage } from '../../utils/pdf-document'
import { classifyPdfFailure, type PdfFailure } from '../../utils/pdf-errors'
import { pdfTextRenderer, type PdfTextTask } from '../../utils/pdf-text'

export interface PdfBodyProps {
  /** Complete PDF bytes; keep a stable identity across renders (the load keys on it). */
  readonly bytes: Uint8Array
  /** Display title labelling the document region. */
  readonly title: string
  /** 1-based remembered page, pre-requested beside the first. */
  readonly page?: number
  /** Fixed zoom (1 = 100% = 96-DPI page size); absent = fit-width (shrink-only). */
  readonly zoom?: number
  /** Reports the reached page and current render zoom for view-state retention. */
  readonly onViewState?: (state: { page: number; zoom: number }) => void
}

type LoadState =
  | { readonly kind: 'loaded'; readonly bytes: Uint8Array; readonly document: PDFDocumentProxy }
  | { readonly kind: 'failed'; readonly bytes: Uint8Array; readonly failure: PdfFailure }

/** Document gutters (12px padding each side) excluded from fit-width. */
const HORIZONTAL_INSET = 24

/** Shrink-only fit: a page narrower than the viewport stays at actual size. */
function fitWidthZoom(viewportWidth: number, intrinsicWidth: number | undefined): number {
  if (intrinsicWidth === undefined || intrinsicWidth <= 0) return 1
  return Math.min(1, Math.max(1, viewportWidth - HORIZONTAL_INSET) / intrinsicWidth)
}

function failureText(failure: PdfFailure): string {
  switch (failure.kind) {
    case 'worker':
      return 'The PDF rendering process could not continue. Please retry.'
    case 'password':
      return 'This PDF requires a password; password-protected previews are not supported.'
    case 'failed':
      return `Cannot display PDF: ${failure.message}`
  }
}

/**
 * Present a PDF as a continuous vertical page sequence. Every page mounts as a
 * skeleton; only pages near the viewport render (IntersectionObserver lookahead),
 * double-buffered so a redraw never flashes blank. Fit-width is the default;
 * zoom controls and gestures arrive in a later task through the `zoom` seam.
 * @param props - complete bytes, title, remembered page, zoom, and view-state sink.
 * @returns the PDF reader.
 */
export function PdfBody({ bytes, title, page, zoom, onViewState }: PdfBodyProps): ReactNode {
  const [load, setLoad] = useState<LoadState>()
  const [attempt, setAttempt] = useState(0)
  const [pageWidth, setPageWidth] = useState<number>()
  const [containerWidth, setContainerWidth] = useState(0)
  const scroll = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const lifetime = new AbortController()
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a new load or retry must clear the previous document state
    setLoad(undefined)
    const session = openPdf(bytes, lifetime.signal, (failure) => {
      if (!lifetime.signal.aborted) setLoad({ kind: 'failed', bytes, failure })
    })
    void session.document.then(
      (document) => {
        if (!lifetime.signal.aborted) setLoad({ kind: 'loaded', bytes, document })
      },
      (error: unknown) => {
        if (!lifetime.signal.aborted) setLoad({ kind: 'failed', bytes, failure: classifyPdfFailure(error) })
      },
    )
    return () => {
      lifetime.abort()
      void session.dispose()
    }
  }, [bytes, attempt])

  const loaded = load?.kind === 'loaded' && load.bytes === bytes ? load : undefined

  useLayoutEffect(() => {
    const node = scroll.current
    if (node === null) return
    setContainerWidth(node.clientWidth)
    const measure = (): void => {
      setContainerWidth(node.clientWidth)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => {
      observer.disconnect()
    }
  }, [loaded])

  const renderZoom = zoom ?? fitWidthZoom(containerWidth, pageWidth)
  const renderZoomRef = useRef(renderZoom)
  useEffect(() => {
    renderZoomRef.current = renderZoom
  }, [renderZoom])
  const onViewStateRef = useRef(onViewState)
  useEffect(() => {
    onViewStateRef.current = onViewState
  }, [onViewState])
  const pageVisible = useCallback((reached: number): void => {
    onViewStateRef.current?.({ page: reached, zoom: renderZoomRef.current })
  }, [])

  if (load === undefined || load.bytes !== bytes) {
    return (
      <div className="pdf-status pdf-status-center" role="status">
        Rendering document…
      </div>
    )
  }
  if (load.kind === 'failed') {
    return (
      <div className="pdf-status pdf-status-center" role="alert">
        <span>{failureText(load.failure)}</span>
        <button type="button" className="btn btn-sm" onClick={() => setAttempt((value) => value + 1)}>
          Retry
        </button>
      </div>
    )
  }
  return (
    <div ref={scroll} className="pdf-body" data-pdf-preview role="region" aria-label={title}>
      {Array.from({ length: load.document.numPages }, (_, index) => (
        <PdfPage
          key={index}
          document={load.document}
          page={index + 1}
          requested={index === 0 || page === index + 1}
          onVisible={pageVisible}
          onWidth={index === 0 ? setPageWidth : undefined}
          zoom={renderZoom}
        />
      ))}
    </div>
  )
}

/** One page: skeleton until requested, then a double-buffered canvas + text overlay. */
function PdfPage({
  document,
  page,
  requested: initiallyRequested,
  onVisible,
  onWidth,
  zoom,
}: {
  readonly document: PDFDocumentProxy
  readonly page: number
  readonly requested: boolean
  readonly onVisible: (page: number) => void
  readonly onWidth: ((width: number) => void) | undefined
  readonly zoom: number
}): ReactNode {
  const host = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const text = useRef<HTMLDivElement>(null)
  const [requested, setRequested] = useState(initiallyRequested)
  const [visible, setVisible] = useState(initiallyRequested)
  const [state, setState] = useState<'loading' | 'ready'>('loading')
  const [failure, setFailure] = useState<PdfFailure>()
  const [attempt, setAttempt] = useState(0)
  const renderedZoom = useRef<number | null>(null)
  const pendingRender = useRef(Promise.resolve())
  const textTask = useRef<PdfTextTask | null>(null)

  useEffect(() => {
    // A zoomed canvas can remain visible after its narrower page wrapper has
    // scrolled out horizontally. Observe the displayed page once it is ready.
    const node = state === 'ready' ? (canvas.current as HTMLCanvasElement) : (host.current as HTMLDivElement)
    let disposed = false
    const observer = new IntersectionObserver(
      (entries) => {
        if (disposed) return
        const intersects = entries.some((entry) => entry.isIntersecting)
        setVisible(intersects)
        if (!intersects) return
        setRequested(true)
        onVisible(page)
      },
      { rootMargin: '100% 0px' },
    )
    observer.observe(node)
    return () => {
      disposed = true
      observer.disconnect()
    }
  }, [page, onVisible, state])

  useEffect(() => () => textTask.current?.cancel(), [])

  useEffect(() => {
    if (!requested) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a new render request clears the previous failure
    setFailure(undefined)
    if (renderedZoom.current !== null && (!visible || renderedZoom.current === zoom)) return
    const node = canvas.current as HTMLCanvasElement
    const lifetime = new AbortController()
    const renderSignal = lifetime.signal
    let newText: PdfTextTask | undefined
    // PDF.js shares a page proxy across renders; a cancelled task must finish
    // cleanup before the next starts. The displayed bitmap stays intact.
    pendingRender.current = pendingRender.current
      .then(async () => {
        renderSignal.throwIfAborted()
        const pdfPage = await document.getPage(page)
        renderSignal.throwIfAborted()
        const viewport = pdfPage.getViewport({ scale: 96 / 72 })
        const buffer = node.ownerDocument.createElement('canvas')
        let textPromise: Promise<void> | undefined
        if (textTask.current === null) {
          newText = pdfTextRenderer(text.current as HTMLDivElement)
          textPromise = newText.render(pdfPage, viewport)
        }
        try {
          await renderPdfPage(pdfPage, buffer, zoom, renderSignal)
          await textPromise
          renderSignal.throwIfAborted()
          const context = node.getContext('2d')
          if (context === null) throw new Error('PDF canvas has no 2D context')
          node.width = buffer.width
          node.height = buffer.height
          node.style.width = `${viewport.width * zoom}px`
          node.style.height = `${viewport.height * zoom}px`
          context.drawImage(buffer, 0, 0)
          if (newText !== undefined) textTask.current = newText
          newText = undefined
          renderedZoom.current = zoom
          onWidth?.(viewport.width)
          setState('ready')
        } finally {
          buffer.width = buffer.height = 0
          newText?.cancel()
          // Cancelling an unadopted text layer rejects its render promise; drain
          // it so a failed canvas render cannot leave an unhandled rejection.
          await Promise.allSettled([textPromise])
        }
      })
      .catch((error: unknown) => {
        if (!renderSignal.aborted) setFailure(classifyPdfFailure(error))
      })
    return () => {
      lifetime.abort()
      newText?.cancel()
    }
  }, [document, page, requested, visible, zoom, attempt, onWidth])

  return (
    <div ref={host} className="pdf-page" data-pdf-page={page}>
      {failure === undefined && state !== 'ready' && (
        <div
          className="pdf-page-placeholder"
          role={requested ? 'status' : undefined}
          aria-label={requested ? 'Rendering page…' : undefined}
        />
      )}
      {failure !== undefined && (
        <div className="pdf-status" role="alert">
          <span>{failureText(failure)}</span>
          <button type="button" className="btn btn-sm" onClick={() => setAttempt((value) => value + 1)}>
            Retry
          </button>
        </div>
      )}
      <div className="pdf-page-surface" hidden={state !== 'ready'}>
        <canvas ref={canvas} className="pdf-page-canvas" role="img" aria-label={`PDF page ${page}`} />
        <div ref={text} className="pdf-page-text" data-pdf-text />
      </div>
    </div>
  )
}

export default PdfBody
