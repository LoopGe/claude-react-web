// Safe ANSI-to-React renderer.
//
// Uses `ansicolor` to parse ANSI escape codes into structured span objects,
// then renders each as a React <span> — no dangerouslySetInnerHTML, no XSS
// surface. Memoised so parent re-renders (e.g. search keystrokes) don't
// re-parse large tool outputs.
//
// Theme adaptation: `ansicolor` ships fixed RGB values tuned for a LIGHT
// terminal background. Two of them are near-invisible on our dark chat
// background:
//   - dim (SGR 2)        → rgba(0,0,0,0.5)  (black at 50% — invisible on dark)
//   - bright black (90)  → rgba(100,100,100,1) (mid grey — dim on dark)
// Commands emit these constantly for secondary text (git hashes, pytest
// hints, cargo notes), so we override them with theme CSS variables that
// follow the active [data-theme]. Explicit command colours (red/green/yellow
// …) are left untouched — those are intentional distinctions, not the
// default-fg problem. The override is done via CSS variables so NO JS theme
// state is read here; it re-skins automatically when the theme flips.

import { memo, useMemo, type ReactNode } from 'react'
import ansicolor from 'ansicolor'
import { findRanges } from '../search/match.js'

/** Parse a CSS string like "color:rgba(0,204,0,1);font-weight:bold;" into
 *  a React CSSProperties object. Only handles the subset that ansicolor
 *  produces (color, background, font-weight, text-decoration, font-style,
 *  opacity). */
function parseCssToStyle(css: string): Record<string, string> {
  if (!css) return {}
  const style: Record<string, string> = {}
  for (const part of css.split(';')) {
    const idx = part.indexOf(':')
    if (idx < 0) continue
    const key = part.slice(0, idx).trim()
    const val = part.slice(idx + 1).trim()
    if (!key || !val) continue
    // camelCase conversion for React
    const camel = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
    style[camel] = val
  }
  return style
}

/** Structural shape of one parsed span. ansicolor's own `.d.ts` is
 *  incomplete/incorrect about `dim`, so we type the fields we read by
 *  structure. NB: the dim flag lives on the NESTED `color` object
 *  (`color.dim`), NOT on the span's top level — ansicolor's top-level `dim`
 *  is a different field that is reliably false for SGR 2. Reading `color.dim`
 *  is what matches the actual `rgba(0,0,0,0.5)` output. */
interface AnsiSpan {
  css?: string
  color?: { name?: string; dim?: boolean }
}

/** Classify a span whose colour `ansicolor` hardcodes as "invisible on a
 *  dark background". Returns the override tier to apply, or null to leave the
 *  span's own colour untouched. Detection uses the structured `color.dim` /
 *  `color.name` fields (not rgba re-matching), so it stays correct if
 *  ansicolor ever tweaks its palette. */
function invisibleOverride(s: AnsiSpan): 'dim' | 'muted' | null {
  if (s.color?.dim) return 'dim'
  const name = s.color?.name
  // 'darkGray' = SGR 90 (bright black) → rgba(100,100,100).
  // 'black'     = SGR 30 → rgba(0,0,0). Both invisible on dark.
  if (name === 'darkGray' || name === 'black') return 'muted'
  return null
}

export const AnsiText = memo(function AnsiText({
  text,
  searchQuery,
  activeMatchIdx,
}: {
  text: string
  searchQuery?: string
  /** Index of the "active" match within this component's own match list
   *  (0-based). The Nth <mark> gets `search-hl-active`. Undefined means
   *  no match is active (all render at the default highlight colour). */
  activeMatchIdx?: number
}) {
  const spans = useMemo(() => ansicolor.parse(text), [text])
  const q = searchQuery?.trim()
  const ranges = useMemo(() => (q ? findRanges(text, q) : []), [text, q])

  // Pre-compute cumulative character offsets for each ANSI span so
  // highlightSpan can map ranges (in full-plain-text coordinates) to
  // local positions within each span.
  const spanOffsets = useMemo(() => {
    const offsets: number[] = []
    let offset = 0
    for (const s of spans.spans) {
      offsets.push(offset)
      offset += s.text.length
    }
    return offsets
  }, [spans])

  // Fast path: no ANSI codes and no search → raw text, zero overhead.
  if (spans.spans.length === 1 && !spans.spans[0].css && !q) {
    return <>{text}</>
  }

  // Normalise the active-range index (mirrors rehypeHighlightQuery logic).
  const safeActive =
    activeMatchIdx != null && activeMatchIdx >= 0 && activeMatchIdx < ranges.length
      ? activeMatchIdx
      : undefined

  return (
    <>
      {spans.spans.map((s, i) => {
        const style = parseCssToStyle(s.css)
        // Override the invisible-on-dark colours with theme variables. On a
        // light theme these vars resolve to appropriately dark values, so the
        // override is safe in both themes — it only ever replaces
        // black / black@50% / mid-grey, never a real command colour.
        const tier = invisibleOverride(s as AnsiSpan)
        if (tier === 'dim') {
          // SGR 2 (dim): keep the "de-emphasised" intent without going
          // pure-black-transparent. Muted fg + slight opacity reduction.
          style.color = 'var(--ansi-dim, var(--fg-muted))'
          style.opacity = '0.85'
        } else if (tier === 'muted') {
          // SGR 30/90 (black / bright black): muted fg at full opacity —
          // visible but clearly secondary.
          style.color = 'var(--ansi-muted, var(--fg-muted))'
        }
        const hasStyle = Object.keys(style).length > 0
        const children = ranges.length > 0 ? highlightSpan(s.text, ranges, spanOffsets[i], safeActive) : s.text
        return hasStyle
          ? <span key={i} style={style}>{children}</span>
          : <span key={i}>{children}</span>
      })}
    </>
  )
})

/** Wrap portions of `text` that overlap with `ranges` in <mark> elements.
 *  Ranges are in the coordinate space of the full plain-text string (i.e.
 *  the ANSI-stripped version of the entire input).  `text` is one span's
 *  worth of characters starting at `offset` in that full string.  Returns
 *  the original string unchanged when no ranges overlap.
 *
 *  `activeRangeIdx` (optional) marks one range as the navigation target;
 *  its <mark> gets the extra `search-hl-active` class. */
function highlightSpan(
  text: string,
  ranges: Array<{ start: number; end: number }>,
  offset: number,
  activeRangeIdx?: number,
): ReactNode {
  const nodeEnd = offset + text.length
  const overlapping: Array<{ range: { start: number; end: number }; idx: number }> = []
  for (let i = 0; i < ranges.length; i++) {
    const r = ranges[i]
    if (r.end <= offset) continue
    if (r.start >= nodeEnd) break
    overlapping.push({ range: r, idx: i })
  }
  if (overlapping.length === 0) return text

  const parts: ReactNode[] = []
  let cursor = 0
  for (const { range: r, idx } of overlapping) {
    const localStart = Math.max(0, r.start - offset)
    const localEnd = Math.min(text.length, r.end - offset)
    if (localStart > cursor) {
      parts.push(text.slice(cursor, localStart))
    }
    const isActive = activeRangeIdx != null && idx === activeRangeIdx
    parts.push(
      <mark
        key={`hl-${localStart}`}
        className={isActive ? 'search-hl search-hl-active' : 'search-hl'}
      >
        {text.slice(localStart, localEnd)}
      </mark>,
    )
    cursor = localEnd
  }
  if (cursor < text.length) {
    parts.push(text.slice(cursor))
  }
  return <>{parts}</>
}
