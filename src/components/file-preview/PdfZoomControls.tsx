/** Floating PDF zoom toolbar: step buttons, a percentage preset menu, fit-width.
 *
 * Rebuilt on our ContextMenu/btn primitives with DSH ZoomControls behavior:
 * the percentage display updates TRANSIENTLY during a gesture (imperative
 * `showZoom`) without re-rendering the document tree, and the committed zoom
 * prop clears the transient. Hover/focus/menu activity is reported upward so
 * the owner's auto-hide logic keeps the panel visible while it is in use. */
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from 'react'
import { ContextMenu, type ContextMenuItem } from '../ContextMenu'
import { IconChevronDown, IconMinus, IconPlus } from '../icons/ToolIcons'
import { PDF_ZOOM, steppedZoom } from './pdf-zoom'

/** Live percentage display updated independently from the document tree. */
export interface PdfZoomControlsHandle {
  /** Show a transient gesture scale until the committed `zoom` prop changes. */
  showZoom: (zoom: number) => void
}

interface Props {
  /** Committed render zoom (1 = 100%). */
  readonly zoom: number
  /** Whether fit-width is the active preference (marks the menu row). */
  readonly fitSelected: boolean
  /** Auto-hide state owned by the viewer frame. */
  readonly visible: boolean
  readonly onZoom: (zoom: number) => void
  readonly onFitWidth: () => void
  /** Hover / focus / open-menu activity — true keeps the panel visible. */
  readonly onActiveChange: (active: boolean) => void
  readonly ref?: Ref<PdfZoomControlsHandle>
}

export function PdfZoomControls({
  zoom,
  fitSelected,
  visible,
  onZoom,
  onFitWidth,
  onActiveChange,
  ref,
}: Props): ReactNode {
  const [committed, setCommitted] = useState(zoom)
  const [transient, setTransient] = useState<number>()
  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null)
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const percentRef = useRef<HTMLButtonElement>(null)
  // "Adjust state when a prop change": a committed zoom clears the gesture
  // transient on the frame it lands (react.dev/learn/you-might-not-need-an-effect).
  if (committed !== zoom) {
    setCommitted(zoom)
    setTransient(undefined)
  }
  const displayZoom = transient ?? zoom
  useImperativeHandle(ref, () => ({ showZoom: setTransient }), [])
  useEffect(() => {
    onActiveChange(open || hovered || focused)
  }, [open, hovered, focused, onActiveChange])

  const closeMenu = useCallback(() => {
    setOpen(false)
    // WAI-ARIA menu button (CreateMenuButton precedent): a dismissal while the
    // menu holds focus returns it to the trigger, not the top of the document.
    const active = document.activeElement
    if (active instanceof Element && active.closest('[role="menu"]')) {
      percentRef.current?.focus({ preventScroll: true })
    }
  }, [])

  const items: ContextMenuItem[] = [
    { label: 'Fit width', icon: fitSelected ? '✓' : undefined, onClick: onFitWidth },
    { label: '' },
    ...PDF_ZOOM.presets.map((value) => ({
      label: `${value * 100}%`,
      icon: !fitSelected && displayZoom === value ? '✓' : undefined,
      onClick: () => onZoom(value),
    })),
  ]

  return (
    <div
      className="pdf-zoom-controls"
      role="toolbar"
      aria-label="Zoom controls"
      data-pdf-zoom-controls
      data-visible={visible || undefined}
      onPointerEnter={(event) => {
        if (event.pointerType !== 'touch') setHovered(true)
      }}
      onPointerLeave={() => setHovered(false)}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false)
      }}
    >
      <button
        type="button"
        className="btn btn-sm pdf-zoom-step"
        aria-label="Zoom out"
        disabled={displayZoom <= PDF_ZOOM.minimum}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => onZoom(steppedZoom(displayZoom, -1))}
      >
        <IconMinus size={14} />
      </button>
      <button
        type="button"
        ref={percentRef}
        className="btn btn-sm pdf-zoom-percent"
        aria-label="Zoom presets"
        aria-haspopup="menu"
        aria-expanded={open}
        onMouseDown={(event) => event.preventDefault()}
        onClick={(event) => {
          if (open) {
            setOpen(false)
            return
          }
          const rect = event.currentTarget.getBoundingClientRect()
          setAnchor({ x: rect.left, y: rect.top - 4 })
          setOpen(true)
        }}
      >
        <span>{Math.round(displayZoom * 100)}%</span>
        <IconChevronDown size={12} />
      </button>
      <button
        type="button"
        className="btn btn-sm pdf-zoom-step"
        aria-label="Zoom in"
        disabled={displayZoom >= PDF_ZOOM.maximum}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => onZoom(steppedZoom(displayZoom, 1))}
      >
        <IconPlus size={14} />
      </button>
      {open && anchor && (
        <ContextMenu
          x={anchor.x}
          y={anchor.y}
          placement="above"
          items={items}
          onClose={closeMenu}
          triggerRef={percentRef}
          autoFocus
          nonPrimary="close"
        />
      )}
    </div>
  )
}
