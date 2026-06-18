// Safe ANSI-to-React renderer.
//
// Uses `ansicolor` to parse ANSI escape codes into structured span objects,
// then renders each as a React <span> — no dangerouslySetInnerHTML, no XSS
// surface. Memoised so parent re-renders (e.g. search keystrokes) don't
// re-parse large tool outputs.

import { memo, useMemo } from 'react'
import ansicolor from 'ansicolor'
export { stripAnsi } from '../utils/text.js'

/** Parse a CSS string like "color:rgba(0,204,0,1);font-weight:bold;" into
 *  a React CSSProperties object. Only handles the subset that ansicolor
 *  produces (color, background, font-weight, text-decoration, font-style,
 *  opacity). */
function parseCssToStyle(css: string): React.CSSProperties | undefined {
  if (!css) return undefined
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
  return Object.keys(style).length > 0 ? (style as React.CSSProperties) : undefined
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
        return style
          ? <span key={i} style={style}>{s.text}</span>
          : <span key={i}>{s.text}</span>
      })}
    </>
  )
})
