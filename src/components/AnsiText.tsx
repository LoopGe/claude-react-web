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

import { memo, useMemo } from 'react'
import ansicolor from 'ansicolor'
export { stripAnsi } from '../utils/text.js'

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

export const AnsiText = memo(function AnsiText({ text }: { text: string }) {
  const spans = useMemo(() => ansicolor.parse(text), [text])

  // Fast path: no ANSI codes → raw text, zero overhead.
  if (spans.spans.length === 1 && !spans.spans[0].css) {
    return <>{text}</>
  }

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
        return Object.keys(style).length > 0
          ? <span key={i} style={style}>{s.text}</span>
          : <span key={i}>{s.text}</span>
      })}
    </>
  )
})
