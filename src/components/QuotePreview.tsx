/**
 * Compact quote-excerpt presentation shared by the composer chip and sent
 * messages (DSH QuotePreview parity).
 *
 * The composer's atomic chip is plain DOM built by `renderTokens` because the
 * DOM→text bridge must stay React-free: `renderTokens` runs inside a layout effect
 * and is rebuilt on every reconcile, so mounting React roots there is the wrong
 * architecture. That — NOT any overflow clipping — is the binding reason; a
 * `HoverPopover` portals to `document.body`, so an ancestor's `overflow: hidden`
 * would not clip it. This React component is therefore the SENT-message
 * presentation and the canonical removable/inert variants. Both draw the identical
 * mark and share the `.quote-chip*` classes; the decoded excerpt comes from
 * `quoteTextOf` in both, so a hand-typed blockquote and a selection-inserted quote
 * look alike.
 *
 * The composer chip currently exposes its full text through a native `title` (a
 * UX choice accepted for now, not a technical necessity); a future delegated-hover
 * popover at the editor level is not foreclosed. This sent variant opens a
 * portalled `HoverPopover` with the full decoded text when the excerpt is clipped.
 */

import { useLayoutEffect, useRef, useState, type JSX } from 'react'
import { HoverPopover } from './HoverPopover'
import { quoteTextOf } from '../utils/quote-text'
import {
  QUOTE_CHIP_CLASS,
  QUOTE_MARK_PATHS,
  QUOTE_MARK_TRANSFORM,
  QUOTE_MARK_VIEWBOX,
} from '../utils/richPromptDom'

/** The shared quote-mark SVG (same geometry the composer chip draws). */
function QuoteMark({ className }: { className?: string }): JSX.Element {
  return (
    <svg viewBox={QUOTE_MARK_VIEWBOX} fill="none" aria-hidden className={className}>
      <g transform={QUOTE_MARK_TRANSFORM}>
        {QUOTE_MARK_PATHS.map((d) => (
          <path key={d} d={d} fill="currentColor" />
        ))}
      </g>
    </svg>
  )
}

/** Whole-quote removal action supplied by an editable owner; omit for inert sent quotes. */
export interface QuotePreviewRemoval {
  /** Accessible name for the removal button. */
  label: string
  /** Remove the complete owning quote. */
  onRemove: () => void
}

export interface QuotePreviewProps {
  /** The EXACT blockquote run (`> …`); the displayed excerpt is decoded from it. */
  text: string
  /** Composer-only removal; omit for an inert sent quote. */
  removal?: QuotePreviewRemoval
}

/**
 * Render one width-capped quote excerpt. A clipped excerpt opens a full-text
 * hover popover; an unclipped one does not. The removable variant swaps the
 * quote mark for a × on hover/focus and calls `removal.onRemove` on click.
 */
export function QuotePreview({ text, removal }: QuotePreviewProps): JSX.Element {
  const excerpt = quoteTextOf(text)
  const triggerRef = useRef<HTMLSpanElement>(null)
  const sourceRef = useRef<HTMLSpanElement>(null)
  const [clipped, setClipped] = useState(false)

  useLayoutEffect(() => {
    const source = sourceRef.current
    if (source === null) return
    const measure = () => setClipped(source.scrollWidth > source.clientWidth)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(source)
    return () => observer.disconnect()
  }, [excerpt])

  const preview = (
    <span
      ref={triggerRef}
      className={QUOTE_CHIP_CLASS}
      data-quote-preview=""
      data-removable={removal === undefined ? undefined : ''}
    >
      {removal === undefined ? (
        <span className="quote-chip-marker" aria-hidden>
          <QuoteMark className="quote-chip-mark" />
        </span>
      ) : (
        <button
          type="button"
          className="quote-chip-remove"
          aria-label={removal.label}
          onPointerDown={(e) => {
            e.preventDefault()
            e.stopPropagation()
          }}
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            removal.onRemove()
          }}
        >
          <QuoteMark className="quote-chip-mark" />
          <span className="quote-chip-close" aria-hidden>
            ×
          </span>
        </button>
      )}
      <span ref={sourceRef} className="quote-chip-text">
        {excerpt}
      </span>
    </span>
  )

  return (
    <>
      {preview}
      <HoverPopover triggerRef={triggerRef} side="top" delayMs={0} disabled={!clipped}>
        <span className="quote-chip-popover">{excerpt}</span>
      </HoverPopover>
    </>
  )
}
