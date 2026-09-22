// Controlled fold wrapper for a long real-user message body.
//
// Measurement, not character count: the clamp threshold is a pixel height
// compared against the MEASUREMENT element's scrollHeight, so images, code
// blocks, font scaling and panel narrowing all factor in automatically.
//
// Two-element split (review finding): the OUTER box owns clipping — inline
// max-height + `overflow: clip` + the fade mask — while the INNER
// `.fold-measure` box owns measurement. The inner box carries no
// max-height of its own (the parent's clamp clips painting, not the
// child's layout box), so its scrollHeight is the natural content height
// in every state. Measuring the clamp box itself would be wrong under
// `overflow: clip`: a clip box is not a scroll container, and reads
// against it are browser-dependent once the parent caps the height.
// `overflow: clip` (not `hidden`) on the outer box is what makes
// Tab-triggered focus scrolling impossible — `hidden` boxes remain
// programmatically scrollable, which would slide the content against the
// fixed fade mask with no way to scroll back.
//
// State is controlled: expansion lives in a Set<foldKey> lifted to
// MessageList so a Virtuoso scroll-away unmount cannot lose it. forceOpen
// bypasses both the clamp AND the toggle — the search-hit rule (mirrors
// ToolGroupCard's hasSearchHit override): a folded body would hide the
// <mark> the user navigated to.
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { IconChevronDown } from '../icons/ToolIcons'
import { FOLD_MAX_PX } from './fold-key'

interface Props {
  /** Controlled expansion — owned by the parent (MessageList's per-foldKey Set). */
  expanded: boolean
  /** Search hit in this message: render fully open with no toggle. */
  forceOpen?: boolean
  /** Toggle callback — parent flips its lifted state; no local copy here. */
  onToggle: () => void
  children: ReactNode
}

export function FoldableBody({ expanded, forceOpen = false, onToggle, children }: Props) {
  const measureRef = useRef<HTMLDivElement>(null)
  const [overflows, setOverflows] = useState(false)
  // Stable, page-unique id for the clipped region, so the toggle can point
  // aria-controls at it (mirrors ToolGroupCard's bodyId pattern; multiple
  // folded user bodies can coexist in one transcript).
  const regionId = useId()

  const measure = useCallback(() => {
    const el = measureRef.current
    if (!el) return
    // scrollHeight of the INNER box: never clamped, never clipped, so it
    // always reports the natural content height (the parent's max-height
    // clips painting only — it does not shrink this child's layout box).
    // +1 absorbs sub-pixel rounding so a body exactly at the threshold
    // stays unfolded.
    setOverflows(el.scrollHeight > FOLD_MAX_PX + 1)
  }, [])

  // Measure before paint so an over-long body never flashes unclamped.
  useLayoutEffect(() => {
    measure()
  }, [measure])

  // Content can grow past the threshold after mount (image load, late font,
  // panel resize). happy-dom and older test envs may lack ResizeObserver —
  // skip silently; the initial measure already ran.
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return
    const el = measureRef.current
    if (!el) return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [measure])

  const clamped = overflows && !expanded && !forceOpen
  const showToggle = overflows && !forceOpen

  return (
    <>
      <div
        id={regionId}
        className={clamped ? 'fold-content fold-clamped' : 'fold-content'}
        style={clamped ? { maxHeight: FOLD_MAX_PX } : undefined}
      >
        <div ref={measureRef} className="fold-measure">{children}</div>
      </div>
      {showToggle && (
        <div className="fold-toggle-row">
          <button
            type="button"
            className="fold-toggle"
            aria-expanded={expanded}
            aria-controls={regionId}
            onClick={onToggle}
          >
            <IconChevronDown size={12} className={expanded ? 'fold-toggle-chev open' : 'fold-toggle-chev'} />
            {expanded ? 'Show less' : 'Show more'}
          </button>
        </div>
      )}
    </>
  )
}
