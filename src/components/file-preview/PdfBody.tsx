/** PDF page presentation: complete bytes in, lazily rendered selectable pages out.
 *
 * Ported from DSH's pdf.tsx rendering mechanics and ZoomViewport zoom UX onto
 * our preview props. The whole PDF engine (pdf.js + worker + inlined assets +
 * text viewer) stays behind the LazyPdfBody dynamic import; this module is the
 * lazy chunk's entry.
 *
 * Zoom layout is CSS-variable-driven: `--pdf-zoom` + `data-pdf-zoom-mode` on
 * the scroll container resize the page surfaces synchronously (file-viewer.css
 * width rules), while the bitmap redraws asynchronously at the settled zoom —
 * only nearby pages redraw, and the old bitmap stays until its replacement is
 * ready. Gestures (Ctrl+wheel / trackpad pinch) anchor at the pointer with
 * scroll compensation and settle after PINCH_SETTLE_MS. */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { openPdf } from '../../utils/pdf-runtime'
import { renderPdfPage } from '../../utils/pdf-document'
import { classifyPdfFailure, type PdfFailure } from '../../utils/pdf-errors'
import { pdfTextRenderer, type PdfTextTask } from '../../utils/pdf-text'
import {
  CONTROLS_HIDE_MS,
  CONTROLS_REVEAL_HEIGHT_PX,
  FIT_WIDTH,
  PINCH_SETTLE_MS,
  applyAnchoredZoom,
  fitWidthZoom,
  gestureZoom,
  wheelZoomDelta,
  type ZoomPreference,
} from './pdf-zoom'
import { PdfZoomControls, type PdfZoomControlsHandle } from './PdfZoomControls'
import { recallPdfViewState, rememberPdfPage, rememberPdfZoom } from './pdf-view-state'

export interface PdfBodyProps {
  /** Complete PDF bytes; keep a stable identity across renders (the load keys on it). */
  readonly bytes: Uint8Array
  /** Display title labelling the document region. */
  readonly title: string
  /** 1-based remembered page, pre-requested beside the first. */
  readonly page?: number
  /** Fixed zoom command (1 = 100% = 96-DPI page size); a change overrides the
   *  gesture preference. Absent = fit-width (shrink-only) until the reader zooms. */
  readonly zoom?: number
  /** Retention key — the (session,file) identity (the file resource address).
   *  With it, page + zoom survive unmount/remount until the owner forgets them. */
  readonly viewStateKey?: string
  /** Reports the reached page and current render zoom for view-state retention. */
  readonly onViewState?: (state: { page: number; zoom: number }) => void
}

type LoadState =
  | { readonly kind: 'loaded'; readonly bytes: Uint8Array; readonly document: PDFDocumentProxy }
  | { readonly kind: 'failed'; readonly bytes: Uint8Array; readonly failure: PdfFailure }

/** Document gutters (12px padding each side) excluded from fit-width. */
const HORIZONTAL_INSET = 24

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
 * skeleton; only pages near the viewport render (IntersectionObserver lookahead
 * rooted at the scroll container), double-buffered so a redraw never flashes
 * blank. Fit-width is the default; floating controls and Ctrl+wheel/pinch
 * gestures select a fixed zoom, and the settled view state is retained per key.
 * @param props - complete bytes, title, remembered page, zoom, retention key, and view-state sink.
 * @returns the PDF reader.
 */
export function PdfBody({ bytes, title, page, zoom, viewStateKey, onViewState }: PdfBodyProps): ReactNode {
  const [load, setLoad] = useState<LoadState>()
  const [attempt, setAttempt] = useState(0)
  const [pageWidth, setPageWidth] = useState<number>()
  const [containerWidth, setContainerWidth] = useState(0)
  const scroll = useRef<HTMLDivElement>(null)

  // Mount-only seed: explicit props command over the retained view state.
  const [seed] = useState(() => (viewStateKey === undefined ? undefined : recallPdfViewState(viewStateKey)))
  const rememberedPage = page ?? seed?.page
  const [preference, setPreference] = useState<ZoomPreference>(() =>
    zoom !== undefined
      ? { kind: 'fixed', scale: zoom }
      : seed?.zoom !== undefined
        ? { kind: 'fixed', scale: seed.zoom }
        : FIT_WIDTH,
  )
  useEffect(() => {
    if (zoom === undefined) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the host's zoom prop is an external command; a change overrides the gesture preference
    setPreference({ kind: 'fixed', scale: zoom })
  }, [zoom])

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

  const fitZoom = fitWidthZoom(containerWidth, pageWidth, HORIZONTAL_INSET)
  const renderZoom = preference.kind === 'fit-width' ? fitZoom : preference.scale

  // ── Zoom machinery ───────────────────────────────────────────────────
  // The live scale rides refs + DOM variables during a gesture (no document
  // re-render per wheel tick); the committed preference re-renders on settle.
  const zoomRef = useRef(renderZoom)
  const pinchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const controlsRef = useRef<PdfZoomControlsHandle>(null)
  const [controlsVisible, setControlsVisible] = useState(false)
  const controlsHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pointerInRevealZone = useRef(false)
  const controlsActive = useRef(false)

  const clearControlsHide = useCallback((): void => {
    if (controlsHideTimer.current !== null) clearTimeout(controlsHideTimer.current)
    controlsHideTimer.current = null
  }, [])
  const showControls = useCallback((): void => {
    clearControlsHide()
    setControlsVisible(true)
  }, [clearControlsHide])
  const scheduleControlsHide = useCallback((): void => {
    clearControlsHide()
    if (pointerInRevealZone.current || controlsActive.current || pinchTimer.current !== null) return
    controlsHideTimer.current = setTimeout(() => {
      controlsHideTimer.current = null
      setControlsVisible(false)
    }, CONTROLS_HIDE_MS)
  }, [clearControlsHide])
  const handleControlsActive = useCallback(
    (active: boolean): void => {
      controlsActive.current = active
      if (active) showControls()
      else scheduleControlsHide()
    },
    [showControls, scheduleControlsHide],
  )
  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      const inRevealZone =
        event.pointerType === 'mouse' &&
        event.clientY >= event.currentTarget.getBoundingClientRect().bottom - CONTROLS_REVEAL_HEIGHT_PX
      pointerInRevealZone.current = inRevealZone
      if (inRevealZone) showControls()
      else scheduleControlsHide()
    },
    [showControls, scheduleControlsHide],
  )
  const handlePointerLeave = useCallback((): void => {
    pointerInRevealZone.current = false
    scheduleControlsHide()
  }, [scheduleControlsHide])
  useEffect(() => () => clearControlsHide(), [clearControlsHide])

  const commitPreference = useCallback(
    (next: ZoomPreference): void => {
      setPreference(next)
      if (viewStateKey !== undefined) {
        rememberPdfZoom(viewStateKey, next.kind === 'fixed' ? next.scale : undefined)
      }
    },
    [viewStateKey],
  )

  /** Preset/step selection: anchor at the scrollport center, commit at once. */
  const setZoom = useCallback(
    (next: number): void => {
      if (pinchTimer.current !== null) clearTimeout(pinchTimer.current)
      pinchTimer.current = null
      const node = scroll.current
      if (node === null) return
      const applied = applyAnchoredZoom(node, zoomRef.current, next)
      zoomRef.current = applied
      commitPreference({ kind: 'fixed', scale: applied })
    },
    [commitPreference],
  )

  const fitWidth = useCallback((): void => {
    if (pinchTimer.current !== null) clearTimeout(pinchTimer.current)
    pinchTimer.current = null
    const node = scroll.current
    if (node !== null) {
      node.setAttribute('data-pdf-zoom-mode', 'fit-width')
      node.style.setProperty('--pdf-zoom', String(fitZoom))
    }
    zoomRef.current = fitZoom
    commitPreference(FIT_WIDTH)
  }, [fitZoom, commitPreference])

  // Committed zoom → live ref + DOM variables + controls display. Skipped while
  // a gesture is pending so an unrelated re-render cannot snap the live layout
  // back to the last settled scale.
  useLayoutEffect(() => {
    if (pinchTimer.current !== null) return
    zoomRef.current = renderZoom
    const node = scroll.current
    if (node !== null) {
      node.setAttribute('data-pdf-zoom-mode', preference.kind)
      node.style.setProperty('--pdf-zoom', String(renderZoom))
    }
    controlsRef.current?.showZoom(renderZoom)
  }, [renderZoom, preference.kind, loaded])

  // Ctrl+wheel / trackpad pinch (browsers synthesize ctrl+wheel for pinch):
  // anchored zoom per tick, committed once the gesture settles.
  useEffect(() => {
    const node = scroll.current
    if (node === null) return
    const wheel = (event: WheelEvent): void => {
      if (!event.ctrlKey) return
      event.preventDefault()
      showControls()
      const delta = wheelZoomDelta(event.deltaY, event.deltaMode, node.clientHeight)
      const next = applyAnchoredZoom(
        node,
        zoomRef.current,
        gestureZoom(zoomRef.current, delta),
        event.clientX,
        event.clientY,
      )
      zoomRef.current = next
      controlsRef.current?.showZoom(next)
      if (pinchTimer.current !== null) clearTimeout(pinchTimer.current)
      pinchTimer.current = setTimeout(() => {
        pinchTimer.current = null
        commitPreference({ kind: 'fixed', scale: zoomRef.current })
        scheduleControlsHide()
      }, PINCH_SETTLE_MS)
    }
    node.addEventListener('wheel', wheel, { passive: false })
    return () => {
      node.removeEventListener('wheel', wheel)
      if (pinchTimer.current !== null) clearTimeout(pinchTimer.current)
      pinchTimer.current = null
    }
  }, [loaded, showControls, scheduleControlsHide, commitPreference])

  // ── View-state reporting ─────────────────────────────────────────────
  const renderZoomRef = useRef(renderZoom)
  useEffect(() => {
    renderZoomRef.current = renderZoom
  }, [renderZoom])
  const onViewStateRef = useRef(onViewState)
  useEffect(() => {
    onViewStateRef.current = onViewState
  }, [onViewState])
  // Mount-time intersections always include page 1 at scroll 0; recording them
  // would clobber the remembered page on every remount. Only a user scroll
  // arms page retention.
  const userScrolled = useRef(false)
  useEffect(() => {
    const node = scroll.current
    if (node === null) return
    const arm = (): void => {
      userScrolled.current = true
    }
    node.addEventListener('scroll', arm, { passive: true, once: true })
    return () => {
      node.removeEventListener('scroll', arm)
    }
  }, [loaded])
  const pageVisible = useCallback(
    (reached: number): void => {
      onViewStateRef.current?.({ page: reached, zoom: renderZoomRef.current })
      if (viewStateKey !== undefined && userScrolled.current) rememberPdfPage(viewStateKey, reached)
    },
    [viewStateKey],
  )

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
        {/* A password failure is terminal: retry re-opens the same bytes and
            can never succeed, so the unsupported notice carries no Retry. */}
        {load.failure.kind !== 'password' && (
          <button type="button" className="btn btn-sm" onClick={() => setAttempt((value) => value + 1)}>
            Retry
          </button>
        )}
      </div>
    )
  }
  return (
    <div className="pdf-frame" onPointerMove={handlePointerMove} onPointerLeave={handlePointerLeave}>
      <div ref={scroll} className="pdf-body" data-pdf-preview role="region" aria-label={title}>
        {Array.from({ length: load.document.numPages }, (_, index) => (
          <PdfPage
            key={index}
            document={load.document}
            page={index + 1}
            requested={index === 0 || rememberedPage === index + 1}
            onVisible={pageVisible}
            onWidth={index === 0 ? setPageWidth : undefined}
            zoom={renderZoom}
            rootRef={scroll}
          />
        ))}
      </div>
      <PdfZoomControls
        ref={controlsRef}
        zoom={renderZoom}
        fitSelected={preference.kind === 'fit-width'}
        visible={controlsVisible}
        onZoom={setZoom}
        onFitWidth={fitWidth}
        onActiveChange={handleControlsActive}
      />
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
  rootRef,
}: {
  readonly document: PDFDocumentProxy
  readonly page: number
  readonly requested: boolean
  readonly onVisible: (page: number) => void
  readonly onWidth: ((width: number) => void) | undefined
  readonly zoom: number
  /** The `.pdf-body` scroll container — the IO root, so the 100% lookahead
   *  expands the CONTAINER's fold (an implicit viewport root is clipped by the
   *  overflow:auto container and defeats the lookahead). */
  readonly rootRef: RefObject<HTMLDivElement | null>
}): ReactNode {
  const host = useRef<HTMLDivElement>(null)
  const surface = useRef<HTMLDivElement>(null)
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
      { root: rootRef.current, rootMargin: '100% 0px' },
    )
    observer.observe(node)
    return () => {
      disposed = true
      observer.disconnect()
    }
  }, [page, onVisible, state, rootRef])

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
          context.drawImage(buffer, 0, 0)
          // The surface carries the intrinsic 96-DPI width; the CSS width rules
          // compose it with the live --pdf-zoom variable, so gestures resize the
          // layout synchronously while this bitmap is still the old resolution.
          ;(surface.current as HTMLDivElement).style.setProperty('--pdf-page-width', `${viewport.width}px`)
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
      <div ref={surface} className="pdf-page-surface" data-pdf-zoom-surface hidden={state !== 'ready'}>
        <canvas ref={canvas} className="pdf-page-canvas" role="img" aria-label={`PDF page ${page}`} />
        <div ref={text} className="pdf-page-text" data-pdf-text />
      </div>
    </div>
  )
}

export default PdfBody
