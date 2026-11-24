// Floating Quote button for select-to-quote (design §2).
//
// A focused selection toolbar — NOT DSH's generic text-interaction plugin
// framework. It listens on the transcript scroll area, reads the browser
// selection through the visible-text projection (utils/text-selection), and
// shows a single portalled Quote button near a valid selection. Clicking it
// hands the projected text to `onQuote` (the host inserts a composer quote chip)
// and dismisses. Placement prefers above the selection, falls below, clamps to
// the visible scroll bounds and avoids the composer; it repositions on
// scroll/resize and dismisses on clear / Escape / pointerdown elsewhere / blur.
//
// Placement geometry is ported from DSH `text-interaction.ts` (visibleBounds +
// place), adapted to a position:fixed body portal so left/top are viewport
// coordinates directly.

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { readTextSelection, selectedText } from '../utils/text-selection'
import { QUOTE_MARK_PATHS, QUOTE_MARK_TRANSFORM, QUOTE_MARK_VIEWBOX } from '../utils/richPromptDom'

interface Props {
  /** The transcript scroll region selection sources live in. */
  rootRef: RefObject<HTMLElement | null>
  /** Insert the projected passage into the composer (host owns the caret). */
  onQuote: (text: string) => void
}

interface Target {
  readonly source: HTMLElement
  readonly range: Range
  readonly text: string
}

interface Bounds { left: number; top: number; right: number; bottom: number }

const GAP = 8

function rectBounds(rect: DOMRect): Bounds {
  return { left: rect.left, top: rect.top, right: rect.left + rect.width, bottom: rect.top + rect.height }
}

function intersects(a: Bounds, b: Bounds): boolean {
  return a.right > b.left && a.left < b.right && a.bottom > b.top && a.top < b.bottom
}

function sameRange(a: Range | null, b: Range | null): boolean {
  return a === b || (a !== null && b !== null && a.startContainer === b.startContainer
    && a.startOffset === b.startOffset && a.endContainer === b.endContainer && a.endOffset === b.endOffset)
}

/** The viewport region a floating button may occupy: the root rect intersected
 *  with the viewport, narrowed by every scroll/clip ancestor of the source, then
 *  capped above the composer so the button never overlaps the input. */
function visibleBounds(root: HTMLElement, source: HTMLElement, view: Window): Bounds {
  const rootRect = rectBounds(root.getBoundingClientRect())
  const bounds: Bounds = {
    left: Math.max(0, rootRect.left),
    right: Math.min(view.innerWidth, rootRect.right),
    top: 0,
    bottom: view.innerHeight,
  }
  for (let node: HTMLElement | null = source; node !== null; node = node.parentElement) {
    const style = view.getComputedStyle(node)
    const rect = rectBounds(node.getBoundingClientRect())
    if (/(auto|scroll|hidden|clip)/u.test(style.overflowX)) {
      bounds.left = Math.max(bounds.left, rect.left)
      bounds.right = Math.min(bounds.right, rect.right)
    }
    if (/(auto|scroll|hidden|clip)/u.test(style.overflowY)) {
      bounds.top = Math.max(bounds.top, rect.top)
      bounds.bottom = Math.min(bounds.bottom, rect.bottom)
    }
  }
  const composer = root.querySelector<HTMLElement>('.chat-composer')?.getBoundingClientRect()
  if (composer !== undefined && composer.height > 0
    && composer.right > bounds.left && composer.left < bounds.right) {
    bounds.bottom = Math.min(bounds.bottom, composer.top)
  }
  return bounds
}

export function QuoteSelectionToolbar({ rootRef, onQuote }: Props) {
  const [target, setTarget] = useState<Target | null>(null)
  const targetRef = useRef<Target | null>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const previousRangeRef = useRef<Range | null>(null)

  const dismiss = useCallback(() => {
    targetRef.current = null
    previousRangeRef.current = null
    setTarget(null)
  }, [])

  const place = useCallback(() => {
    const root = rootRef.current
    const button = buttonRef.current
    const current = targetRef.current
    if (root === null || button === null || current === null) return
    const view = root.ownerDocument.defaultView
    if (view === null) return
    if (!root.contains(current.source)) {
      dismiss()
      return
    }
    const visible = visibleBounds(root, current.source, view)
    const rects = [...current.range.getClientRects()].map(rectBounds)
    const fallback = rectBounds(current.range.getBoundingClientRect())
    const anchor = rects.find(rect => intersects(rect, visible))
      ?? (intersects(fallback, visible) ? fallback : null)
    if (anchor === null || visible.right <= visible.left || visible.bottom <= visible.top) {
      button.style.visibility = 'hidden'
      return
    }
    const size = button.getBoundingClientRect()
    const x = (Math.max(anchor.left, visible.left) + Math.min(anchor.right, visible.right) - size.width) / 2
    const above = anchor.top - GAP - size.height
    const below = anchor.bottom + GAP
    const preferredY = above >= visible.top ? above : below
    const left = Math.max(visible.left, Math.min(x, visible.right - size.width))
    const top = Math.max(visible.top, Math.min(preferredY, visible.bottom - size.height))
    button.style.left = `${left}px`
    button.style.top = `${top}px`
    button.style.visibility = 'visible'
  }, [dismiss, rootRef])

  // Position after the button mounts/changes, before paint.
  useLayoutEffect(place, [target, place])

  useEffect(() => {
    const doc = document
    const view = doc.defaultView
    if (view === null) return
    let pointerSelecting = false
    let keyboardSelecting = false
    let frame: number | undefined

    const schedulePlacement = (): void => {
      if (targetRef.current === null || frame !== undefined) return
      frame = view.requestAnimationFrame(() => {
        frame = undefined
        place()
      })
    }
    const updateSelection = (): void => {
      if (pointerSelecting || keyboardSelecting) return
      const root = rootRef.current
      if (root === null) return
      const selection = readTextSelection(root, doc.getSelection())
      const range = selection?.range ?? null
      if (sameRange(previousRangeRef.current, range)) return
      previousRangeRef.current = range?.cloneRange() ?? null
      if (selection === null) {
        dismiss()
        return
      }
      const text = selectedText(selection)
      if (text === null) {
        dismiss()
        return
      }
      const next: Target = { source: selection.source, range: selection.range.cloneRange(), text }
      targetRef.current = next
      setTarget(next)
    }
    const insideButton = (event: Event): boolean =>
      buttonRef.current !== null && event.composedPath().includes(buttonRef.current)
    const pointerDown = (event: PointerEvent): void => {
      if (insideButton(event)) return
      dismiss()
      const root = rootRef.current
      pointerSelecting = event.button === 0 && root !== null
        && event.target instanceof Node && root.contains(event.target)
    }
    const pointerUp = (): void => {
      if (!pointerSelecting) return
      pointerSelecting = false
      updateSelection()
    }
    const cancel = (): void => {
      pointerSelecting = false
      keyboardSelecting = false
      dismiss()
    }
    const keyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        cancel()
        return
      }
      const root = rootRef.current
      if (insideButton(event) || root === null || !(event.target instanceof Node) || !root.contains(event.target)) return
      if (event.key === 'Shift' || event.shiftKey) {
        keyboardSelecting = true
        dismiss()
      }
    }
    const keyUp = (event: KeyboardEvent): void => {
      if (!keyboardSelecting || (event.key !== 'Shift' && event.shiftKey)) return
      keyboardSelecting = false
      updateSelection()
    }

    doc.addEventListener('selectionchange', updateSelection)
    doc.addEventListener('pointerdown', pointerDown, true)
    doc.addEventListener('pointerup', pointerUp)
    doc.addEventListener('pointercancel', cancel)
    doc.addEventListener('keydown', keyDown)
    doc.addEventListener('keyup', keyUp)
    doc.addEventListener('scroll', schedulePlacement, true)
    view.addEventListener('resize', schedulePlacement)
    view.addEventListener('blur', cancel)
    return () => {
      doc.removeEventListener('selectionchange', updateSelection)
      doc.removeEventListener('pointerdown', pointerDown, true)
      doc.removeEventListener('pointerup', pointerUp)
      doc.removeEventListener('pointercancel', cancel)
      doc.removeEventListener('keydown', keyDown)
      doc.removeEventListener('keyup', keyUp)
      doc.removeEventListener('scroll', schedulePlacement, true)
      view.removeEventListener('resize', schedulePlacement)
      view.removeEventListener('blur', cancel)
      if (frame !== undefined) view.cancelAnimationFrame(frame)
    }
  }, [dismiss, place, rootRef])

  const handleClick = useCallback(() => {
    const current = targetRef.current
    if (current === null) return
    const text = current.text
    document.getSelection()?.removeAllRanges()
    onQuote(text)
    dismiss()
  }, [dismiss, onQuote])

  if (target === null) return null
  return createPortal(
    <button
      ref={buttonRef}
      type="button"
      className="quote-selection-toolbar"
      aria-label="Quote selection"
      // Keep focus (and the transcript selection) on pointerdown so the click
      // reads a stable target; the click handler clears the selection itself.
      onPointerDown={(e) => e.preventDefault()}
      onClick={handleClick}
    >
      <svg className="quote-selection-mark" viewBox={QUOTE_MARK_VIEWBOX} fill="none" aria-hidden="true">
        <g transform={QUOTE_MARK_TRANSFORM}>
          {QUOTE_MARK_PATHS.map((d) => (
            <path key={d} d={d} fill="currentColor" />
          ))}
        </g>
      </svg>
      Quote
    </button>,
    document.body,
  )
}
