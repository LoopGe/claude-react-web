import { useContext, useEffect, useRef, useState } from 'react'
import {
  ImageViewerActionsContext,
  ImageViewerStateContext,
  type ViewerImage,
} from '../hooks/image-viewer-context'
import { useImageZoom } from '../hooks/useImageZoom'
import { Overlay } from './Overlay'
import { IconChevronLeft, IconChevronRight, IconDownload, IconMinus, IconPlus, IconRotateCcw, IconX } from './icons/ToolIcons'

/** Per-step zoom factor for the toolbar buttons and the wheel. */
const ZOOM_STEP = 1.25

/**
 * Full-screen image viewer, mounted exactly once by ImageViewerProvider.
 *
 * Two components by design:
 *  - Lightbox (always mounted) owns the load state — `natural` PERSISTS across
 *    close/reopen and image switches, so a newly opened or navigated image
 *    renders with the previous fit style until its own decode lands (no
 *    intrinsic-size flash at the stage's top-left corner). It also owns the
 *    viewing-session key: loadFailed resets when a NEW session starts (open
 *    flips true, possibly on the same image) or the image changes.
 *  - LightboxStage (inside the Overlay, so it unmounts with the viewer) owns
 *    the zoom/pan machinery via useImageZoom — its resize listener and zoom
 *    state live only while the viewer is open, and each open starts from the
 *    centered fit.
 *
 * Chrome ownership is delegated to <Overlay variant="lightbox"> (Escape via
 * the escape stack, focus trap, portal, exit animation). The card IS the
 * full-viewport stage: backdrop clicks can never reach the backdrop element,
 * so the stage closes on its own empty-area mousedown (target ===
 * currentTarget — the same guard Overlay uses), while mousedown on the image
 * starts a pan instead.
 */
export function Lightbox() {
  const actions = useContext(ImageViewerActionsContext)
  const { open, images, index } = useContext(ImageViewerStateContext)
  const current = images[index]

  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)

  // Viewing-session key, adjusted during render (the documented derived-state
  // pattern — no effect, no cascading render). loadFailed resets only when a
  // NEW session starts or the image changes; natural is intentionally NOT
  // reset — see the component doc comment.
  const [session, setSession] = useState('closed')
  const nextSession = open ? `open:${current?.src ?? ''}` : 'closed'
  if (session !== nextSession) {
    setSession(nextSession)
    if (open) setLoadFailed(false)
  }

  if (!current) return null

  // A decoded image reporting zero natural size (e.g. a dimensionless SVG
  // data URL) would render as an invisible zero-size element with a NaN zoom
  // bound — treat it exactly like a decode failure instead. loadFailed also
  // gates `loaded`: the persisted natural of the PREVIOUS image must not keep
  // the zoom/pan chrome live over an error card.
  const loaded = !loadFailed && natural != null && natural.w > 0

  return (
    <Overlay variant="lightbox" open={open} onClose={actions.close} ariaLabel="Image preview">
      <LightboxStage
        current={current}
        natural={natural}
        loaded={loaded}
        loadFailed={loadFailed}
        active={open}
        multi={images.length > 1}
        onLoaded={setNatural}
        onFailed={() => setLoadFailed(true)}
        onClose={actions.close}
        onNext={actions.next}
        onPrev={actions.prev}
      />
    </Overlay>
  )
}

/** The interactive full-viewport stage: image surface + nav arrows + toolbar.
 *  Lives inside the Overlay, so all of its hooks (resize listener, zoom state,
 *  arrow-key listener) exist only while the viewer is open.
 *
 *  Pan guard: pointerdowns starting on the toolbar/nav buttons are ignored —
 *  capturing the pointer there would retarget the browser's derived click at
 *  the stage (nearest common ancestor of the pressed button and the captured
 *  pointerup target), killing the buttons' onClick.
 *
 *  Arrow keys use a document-level listener because the focus trap holds
 *  focus on the backdrop container, whose keydown never traverses this child;
 *  the listener dies with the stage on close. Escape keeps going through the
 *  Overlay's escape stack, which already resolves overlay nesting correctly. */
function LightboxStage({
  current,
  natural,
  loaded,
  loadFailed,
  active,
  multi,
  onLoaded,
  onFailed,
  onClose,
  onNext,
  onPrev,
}: {
  current: ViewerImage
  natural: { w: number; h: number } | null
  loaded: boolean
  loadFailed: boolean
  /** Whether the viewer session is live — gates the arrow-key listener so it
   *  detaches the moment the viewer starts closing (focus returns to the app;
   *  the ~180ms exit window must not swallow the app's arrow keys). */
  active: boolean
  multi: boolean
  onLoaded: (natural: { w: number; h: number }) => void
  onFailed: () => void
  onClose: () => void
  onNext: () => void
  onPrev: () => void
}) {
  const zoom = useImageZoom({ naturalWidth: natural?.w ?? 0, naturalHeight: natural?.h ?? 0, resetKey: current.src })
  const { zoomAtPoint, zoomStep, reset } = zoom
  const stageRef = useRef<HTMLDivElement>(null)

  // Wheel zoom needs a non-passive native listener: React registers wheel
  // passively at the root, so preventDefault (stopping the page behind the
  // lightbox from scrolling) is only possible here. Attached from mount — not
  // gated on `loaded` — so the pre-decode window (and an error card) can't
  // leak wheel events to the page behind the fixed backdrop; zoom itself
  // still needs a decoded image.
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      if (loaded) zoomAtPoint(e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP, e.clientX, e.clientY)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [loaded, zoomAtPoint])

  useEffect(() => {
    if (!multi || !active) return
    const onKey = (e: KeyboardEvent) => {
      // Modified arrows belong to the browser/app (Alt+←/→ = history); text
      // fields keep their cursor movement.
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
      const target = e.target as HTMLElement
      if (target.closest?.('input, textarea, select') || target.isContentEditable) return
      if (e.key === 'ArrowRight') {
        e.preventDefault()
        onNext()
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        onPrev()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [multi, active, onNext, onPrev])

  const onStagePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!loaded) return
    // Chrome must not start a pan: capturing the pointer there retargets the
    // browser's derived click at the stage and kills the control's onClick.
    // Toolbar padding and the error card count as chrome too.
    if ((e.target as Element).closest?.('button, a, .lightbox-toolbar, .lightbox-error')) return
    zoom.handlers.onPointerDown(e.nativeEvent, e.currentTarget)
  }

  const atFit = zoom.state.scale <= 1.0001
  const atMax = zoom.state.scale >= zoom.max - 0.0001

  return (
    <div
      className={`lightbox-stage${zoom.isPanning ? ' panning' : ''}`}
      ref={stageRef}
      tabIndex={-1}
      onDoubleClick={loaded ? zoom.handlers.onDoubleClick : undefined}
      onPointerDown={onStagePointerDown}
      onPointerMove={(e) => zoom.handlers.onPointerMove(e.nativeEvent)}
      onPointerUp={(e) => zoom.handlers.onPointerUp(e.nativeEvent)}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      {loadFailed ? (
        <div className="lightbox-error">Image failed to load</div>
      ) : (
        <img
          className="lightbox-img"
          src={current.src}
          alt={current.alt ?? ''}
          draggable={false}
          style={
            loaded
              ? {
                  width: zoom.fit.w,
                  height: zoom.fit.h,
                  transform: `translate(${zoom.state.tx}px, ${zoom.state.ty}px) scale(${zoom.state.scale})`,
                }
              : undefined
          }
          onLoad={(e) => {
            const w = e.currentTarget.naturalWidth
            const h = e.currentTarget.naturalHeight
            if (!w) {
              onFailed()
              return
            }
            onLoaded({ w, h })
          }}
          onError={onFailed}
        />
      )}
      {multi && (
        <button type="button" className="lightbox-nav lightbox-nav-prev" aria-label="Previous image" onClick={onPrev}>
          <IconChevronLeft size={20} />
        </button>
      )}
      {multi && (
        <button type="button" className="lightbox-nav lightbox-nav-next" aria-label="Next image" onClick={onNext}>
          <IconChevronRight size={20} />
        </button>
      )}
      <div className="lightbox-toolbar">
        <button type="button" className="lightbox-tool" aria-label="Zoom out" disabled={!loaded || atFit} onClick={() => zoomStep(1 / ZOOM_STEP)}>
          <IconMinus size={16} />
        </button>
        <button type="button" className="lightbox-tool" aria-label="Zoom in" disabled={!loaded || atMax} onClick={() => zoomStep(ZOOM_STEP)}>
          <IconPlus size={16} />
        </button>
        <button type="button" className="lightbox-tool" aria-label="Reset zoom" disabled={!loaded} onClick={reset}>
          <IconRotateCcw size={16} />
        </button>
        {/* download is honored for data: URLs (the common case); cross-origin
            http(s) URLs ignore it, so target=_blank keeps that path from
            navigating the whole app away — it opens a tab instead. */}
        <a className="lightbox-tool lightbox-download" aria-label="Download image" href={current.src} download="image" target="_blank" rel="noopener noreferrer">
          <IconDownload size={16} />
        </a>
        <button type="button" className="lightbox-tool" aria-label="Close" onClick={onClose}>
          <IconX size={16} />
        </button>
      </div>
    </div>
  )
}
