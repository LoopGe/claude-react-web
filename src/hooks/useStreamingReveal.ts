/** Geometry + driver for the live-text reveal.
 *
 *  The reveal is a spatial CSS mask on the element that holds the streaming
 *  markdown. It must not touch the markdown DOM — so instead of wrapping text
 *  runs, it measures the caret (the last rendered glyph) and sweeps a soft edge
 *  over the newly arrived horizontal span. chat.css supplies three unioned
 *  mask layers:
 *    - a vertical layer that keeps every line above the tail fully visible;
 *    - a horizontal layer whose width is animated from the previous caret to
 *      the new one, revealing the tail line left-to-right;
 *    - a narrow always-opaque strip at the caret, so the blinking cursor (a
 *      `::after` inside the masked subtree) leads the ink instead of being
 *      swallowed by the reveal.
 *  The width animation runs through the Web Animations API, which restarts
 *  cleanly per flush without the forced reflow an `animation: none` toggle
 *  would add (the repo already uses WAAPI for the transcript entrance sweep).
 */

import { useLayoutEffect, useRef, type RefObject } from 'react'
import type { StreamSegment } from '../utils/stream-segments'
import { prefersReducedMotion } from '../utils/reduced-motion'
import { revealDurationMs } from '../utils/reveal-duration'

/** Where the previous flush left the caret, in the masked element's own
 *  coordinate space (relative to its border box). */
export interface StreamingRevealPoint {
  x: number
  y: number
  textLength: number
}

export interface StreamingRevealMeasure {
  /** The last rendered glyph's rect, in viewport coordinates. */
  caret: { right: number; top: number; height: number }
  /** The masked element's rect, in viewport coordinates. */
  box: { left: number; top: number; width: number; height: number }
  /** Character count of the text being revealed (growth discriminator). */
  textLength: number
}

/** The animated window, all in the masked element's coordinate space. */
export interface StreamingRevealWindow {
  /** Horizontal width the reveal edge starts at (previous caret / line start). */
  fromW: number
  /** Horizontal width it ends at (new caret). */
  toW: number
  /** Top of the tail line, where the vertical mask stops being opaque. */
  lineTop: number
}

/**
 * Resolve one flush's reveal window, or null when there is nothing to
 * animate: no measurable layout (hidden panel / test DOM), no text growth
 * (a plain re-render or a reset), or no horizontal advance on the tail line.
 *
 * A line change restarts the sweep at the line's left edge; a same-line append
 * starts wherever the previous caret stopped. Sub-half-line y jitter counts as
 * the same line so a bold/italic run's different font metrics cannot fake a
 * wrap.
 */
export function computeStreamingReveal(
  prev: StreamingRevealPoint | null,
  measure: StreamingRevealMeasure,
): StreamingRevealWindow | null {
  const { caret, box, textLength } = measure
  if (box.width <= 0 || box.height <= 0) return null
  if (caret.height <= 0) return null
  if (prev != null && textLength <= prev.textLength) return null

  const x = caret.right - box.left
  const rawY = caret.top - box.top
  if (x <= 0 || rawY < -caret.height) return null
  // Half-leading can put the line box top a fraction of a pixel above the
  // masked element's top for a first-line caret; clamp it so the first line of
  // every block still reveals. A caret more than a line above the box is a
  // genuinely offscreen measurement and is rejected above.
  const y = Math.max(0, rawY)

  const sameLine = prev != null && Math.abs(y - prev.y) < caret.height / 2
  const fromW = sameLine ? prev.x : 0
  // No horizontal advance: a zero-width glyph (space/newline) or a wrap that
  // already measured at the line start. Nothing to sweep.
  if (x - fromW < 0.5) return null

  return { fromW, toW: x, lineTop: y }
}

/**
 * The last non-whitespace glyph as UTF-16 offsets. Backs up over a low
 * surrogate so an emoji tail measures the whole code point, not half of one
 * (browsers return an empty rect for an unpaired surrogate).
 */
export function lastGlyphSpan(data: string): { start: number; end: number } | null {
  let i = data.length - 1
  while (i >= 0 && /\s/.test(data[i]!)) i--
  if (i < 0) return null
  const code = data.charCodeAt(i)
  if (code >= 0xdc00 && code <= 0xdfff && i > 0) {
    const high = data.charCodeAt(i - 1)
    if (high >= 0xd800 && high <= 0xdbff) return { start: i - 1, end: i + 1 }
  }
  return { start: i, end: i + 1 }
}

/**
 * Top of the tail line's line box. The caret glyph's rect starts below the
 * line box by half the leading; anchoring the vertical mask to the glyph top
 * would leave that leading band opaque, so taller inline content on the same
 * line (a KaTeX formula is 1.21em) could peek through before the sweep reaches
 * it. Falls back to the glyph top when line-height is `normal`/unknown.
 */
export function lineBoxTop(caretTop: number, caretHeight: number, lineHeight: number): number {
  if (!Number.isFinite(lineHeight) || lineHeight <= caretHeight) return caretTop
  return caretTop - (lineHeight - caretHeight) / 2
}

/**
 * Whether a tail segment is safe to sweep. The spatial mask can only reveal
 * the horizontal span it measures, so block-level content that renders after
 * the caret (fences, tables, images, rules, display math) would be clipped;
 * such tails appear whole instead. Kept here (not at the call sites) so the
 * inline draft card and the overlay bubble cannot drift.
 */
export function isRevealableTail(segment: StreamSegment | null | undefined): boolean {
  if (!segment || segment.type === 'code') return false
  const content = segment.content
  if (content.trim() === '') return false
  if (/!\[/.test(content)) return false
  if (/(^|\n)\s*\|/.test(content)) return false
  if (/(^|\n)\s*(?:-{3,}|\*{3,}|_{3,})\s*(?:\n|$)/.test(content)) return false
  if (/(^|\n)\s*\$\$/.test(content)) return false
  return true
}

const REVEAL_CLASS = 'stream-reveal'
const FALLBACK_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)'

/** The last non-whitespace text node in render order. Walks backwards from
 *  the element's final child, so the cost is O(depth at the tail), not O(tree). */
function lastTextNode(root: Node): Text | null {
  let node: Node | null = root.lastChild
  while (node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node as Text
      if (text.data.trim().length > 0) return text
      node = text.previousSibling
      continue
    }
    if (node.nodeType === Node.ELEMENT_NODE) {
      const found = lastTextNode(node)
      if (found) return found
    }
    node = node.previousSibling
  }
  return null
}

/** Viewport rect of the last rendered glyph (the caret's leading edge).
 *  `lineHeight` is the masked element's cached computed value (px, or NaN for
 *  `normal`). */
function measureCaret(
  root: HTMLElement,
  lineHeight: number,
): { right: number; top: number; height: number } | null {
  const text = lastTextNode(root)
  if (!text) return null
  const span = lastGlyphSpan(text.data)
  if (!span) return null
  const range = document.createRange()
  range.setStart(text, span.start)
  range.setEnd(text, span.end)
  // Range.getBoundingClientRect is absent in some DOM implementations (and all
  // of happy-dom's are zero-sized); both cases simply skip the reveal.
  const rect = typeof range.getBoundingClientRect === 'function' ? range.getBoundingClientRect() : null
  if (!rect) return null
  return {
    right: rect.right,
    top: lineBoxTop(rect.top, rect.height, lineHeight),
    height: rect.height,
  }
}

/** Motion tokens + line-height are per-element values; cache them across
 *  flushes so the streaming path does not pay a `getComputedStyle` per tick. */
function readTiming(el: HTMLElement): {
  el: HTMLElement
  duration: number
  easing: string
  lineHeight: number
} {
  const style = getComputedStyle(el)
  return {
    el,
    // Shared CSS↔JS mirror: retuning --motion-duration-moderate flows through.
    duration: revealDurationMs(),
    easing: style.getPropertyValue('--motion-ease-standard').trim() || FALLBACK_EASING,
    lineHeight: Number.parseFloat(style.lineHeight),
  }
}

/**
 * Reveal the live streaming text left-to-right without touching the markdown
 * DOM. Call it with a ref to the element holding the streaming markdown and
 * the currently rendered text; each growth flushes a soft mask sweep over the
 * newly arrived horizontal span.
 *
 * Markdown-safe by construction: the mask is spatial, so block structure,
 * inline formatting, code fences and link colours are untouched. Only the tail
 * line is animated; block-level tails opt out via isRevealableTail.
 *
 * Cost: two rect reads (Range + container) and one cached style read on the
 * 80 ms flush path. The first read forces the layout the browser would perform
 * before paint anyway; both share that one layout pass.
 */
export function useStreamingReveal(ref: RefObject<HTMLElement | null>, text: string): void {
  const prevRef = useRef<StreamingRevealPoint | null>(null)
  const prevTextRef = useRef<string | null>(null)
  const elRef = useRef<HTMLElement | null>(null)
  const timingRef = useRef<ReturnType<typeof readTiming> | null>(null)
  const animationRef = useRef<Animation | null>(null)
  // False between a cleanup and the next effect run. A microtask distinguishes
  // StrictMode's cleanup-then-re-run (alive again before the microtask) from a
  // real unmount, without canceling the sweep StrictMode is re-running.
  const aliveRef = useRef(false)

  useLayoutEffect(() => {
    aliveRef.current = true
    const el = ref.current
    if (!el) return
    const previousEl = elRef.current
    if (previousEl !== el) {
      // The tail moved to another block: cancel the outgoing element's sweep
      // and strip its class (React may or may not rewrite that className).
      animationRef.current?.cancel()
      animationRef.current = null
      previousEl?.classList.remove(REVEAL_CLASS)
      elRef.current = el
      prevRef.current = null
      prevTextRef.current = null
      timingRef.current = null
    }
    const clear = () => {
      animationRef.current?.cancel()
      animationRef.current = null
      el.classList.remove(REVEAL_CLASS)
    }
    const dispose = () => {
      aliveRef.current = false
      queueMicrotask(() => {
        if (aliveRef.current || elRef.current !== el) return
        clear()
      })
    }

    if (!text || prefersReducedMotion()) {
      clear()
      prevRef.current = null
      prevTextRef.current = text
      return dispose
    }
    if (timingRef.current?.el !== el) timingRef.current = readTiming(el)
    const timing = timingRef.current
    const caret = measureCaret(el, timing.lineHeight)
    if (!caret) {
      clear()
      prevRef.current = null
      prevTextRef.current = text
      return dispose
    }
    const box = el.getBoundingClientRect()
    const reveal = computeStreamingReveal(prevRef.current, {
      caret,
      box,
      textLength: text.length,
    })
    if (!reveal) {
      // StrictMode re-runs the mount effect with the same text; leave the
      // sweep that the first run started alone.
      if (prevTextRef.current === text) return dispose
      // A rewrite moved the caret back (supersede / reset): drop the stale
      // mask. Growth without horizontal advance (trailing space, newline,
      // a closing marker) has nothing new to sweep but must NOT truncate the
      // sweep already in flight.
      const shrank = prevRef.current != null && text.length < prevRef.current.textLength
      if (shrank) clear()
      prevTextRef.current = text
      const x = caret.right - box.left
      const y = Math.max(0, caret.top - box.top)
      prevRef.current = x > 0 ? { x, y, textLength: text.length } : null
      return dispose
    }

    // Layers 1 and 3 read these; the animated width is passed to WAAPI below.
    el.style.setProperty('--stream-reveal-to', `${reveal.toW}px`)
    el.style.setProperty('--stream-reveal-line-top', `${reveal.lineTop}px`)
    el.classList.add(REVEAL_CLASS)
    animationRef.current?.cancel()
    // Standard `mask-size` plus the -webkit alias. Both are alpha-only; the
    // final frame is the same geometry the base class would compute, so a
    // browser that ignores one alias still ends fully revealed.
    const from = `100% 100%, ${reveal.fromW}px 100%, 100% 100%`
    const to = `100% 100%, ${reveal.toW}px 100%, 100% 100%`
    const animation = el.animate(
      [
        { maskSize: from, webkitMaskSize: from } as unknown as Keyframe,
        { maskSize: to, webkitMaskSize: to } as unknown as Keyframe,
      ],
      { duration: timing.duration, easing: timing.easing, fill: 'both' },
    )
    animationRef.current = animation
    animation.onfinish = () => {
      if (animationRef.current !== animation) return
      animationRef.current = null
      el.classList.remove(REVEAL_CLASS)
    }

    prevRef.current = { x: reveal.toW, y: reveal.lineTop, textLength: text.length }
    prevTextRef.current = text
    return dispose
  }, [text, ref])
}