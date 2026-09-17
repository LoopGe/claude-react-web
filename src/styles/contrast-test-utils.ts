import { readdirSync, readFileSync } from 'node:fs'

/** Shared WCAG contrast math + tokens.css parsing for the token-regression
 *  tests (status-ink-contrast.test.ts, plugin-inactive-contrast.test.ts).
 *  Kept in one place so a fix to the formulas or to the parser doesn't have to
 *  be applied per test file. */

export function linearize(v: number) {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
}

export function luminance(hex: string) {
  const [r, g, b] = rgbOf(hex)
  return 0.2126 * linearize(r / 255) + 0.7152 * linearize(g / 255) + 0.0722 * linearize(b / 255)
}

export function contrast(a: string, b: string) {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (l1 + 0.05) / (l2 + 0.05)
}

export function rgbOf(hex: string): number[] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
}

/** `color-mix(in srgb, top pct%, bottom)` — straight sRGB alpha compositing. */
export function mixHex(top: string, bottom: string, pct: number): string {
  const topRgb = rgbOf(top)
  const bottomRgb = rgbOf(bottom)
  return (
    '#' +
    topRgb
      .map((c, i) =>
        Math.round(c * pct + bottomRgb[i] * (1 - pct))
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
  )
}

export interface CssBlock {
  /** Normalized selector text (`\s+` collapsed; comments stripped with the file). */
  sel: string
  /** `[attr="value"]` selectors this block matches on — its specificity parts. */
  attrs: string[]
  /** Declared custom properties, raw values. */
  tokens: Record<string, string>
  /** Every declaration in the block, custom properties included. */
  decls: Record<string, string>
}

/** A stylesheet's text with comments blanked — comment prose must not feed a
 *  count, a selector or a declaration lookup. Path is resolved relative to this
 *  file, so the suite works regardless of the cwd vitest was invoked from. */
export function readCss(file: string): string {
  const hit = cssCache.get(file)
  if (hit !== undefined) return hit
  const text = readFileSync(new URL(file, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  cssCache.set(file, text)
  return text
}

const cssCache = new Map<string, string>()

/** Every stylesheet in this directory, derived rather than listed, so a new
 *  file is covered by the guards that scan them. */
export function stylesheets(): string[] {
  return readdirSync(new URL('.', import.meta.url))
    .filter((f) => f.endsWith('.css'))
    .sort()
}

/** `selector -> declarations` for each rule in a stylesheet. Brace-depth aware,
 *  so an at-rule body (`@media { … }`) does not truncate the scan. */
export function parseBlocks(css: string): CssBlock[] {
  const out: CssBlock[] = []
  let i = 0
  for (;;) {
    const open = css.indexOf('{', i)
    if (open === -1) break
    const sel = css.slice(i, open).trim().replace(/\s+/g, ' ')
    let depth = 1
    let j = open + 1
    for (; j < css.length && depth > 0; j++) {
      if (css[j] === '{') depth++
      else if (css[j] === '}') depth--
    }
    const tokens: Record<string, string> = {}
    const decls: Record<string, string> = {}
    for (const m of css.slice(open + 1, j - 1).matchAll(/(^|[;{\s])([a-z0-9-]+)\s*:\s*([^;]+);/g)) {
      decls[m[2]] = m[3].trim()
      if (m[2].startsWith('--')) tokens[m[2]] = m[3].trim()
    }
    if (sel)
      out.push({ sel, attrs: [...sel.matchAll(/\[[a-z-]+="[^"]+"\]/g)].map((m) => m[0]), tokens, decls })
    i = j
  }
  return out
}

/** Every context a custom property can resolve in: a bare `:root`, or a pure
 *  attribute-selector block (`[data-skin="hc"][data-theme="light"]`). Derived
 *  from the file rather than listed, so a skin block added to it is checked
 *  even before anyone remembers to name it in a test. */
export function contextsOf(blocks: CssBlock[]): string[] {
  return [
    ...new Set(
      blocks.filter((b) => b.sel === ':root' || /^(\[[a-z-]+="[^"]+"\])+$/.test(b.sel)).map((b) => b.sel),
    ),
  ]
}

/** The winning raw value of `token` for a context: its own (last) declaration,
 *  else the most specific matching ancestor (a compound selector counts one
 *  specificity point per attribute, so it beats a single-attribute block), else
 *  the last :root that declares it — the order the browser applies. */
export function effectiveToken(
  blocks: CssBlock[],
  sel: string,
  token: string,
  depth = 0,
): string | undefined {
  const matching = blocks.filter((b) => b.sel === sel)
  const ctx = matching[matching.length - 1] as CssBlock | undefined
  let raw: string | undefined = ctx?.tokens[token]
  if (raw === undefined) {
    const own = new Set(ctx?.attrs ?? [])
    const ancestors = blocks.filter(
      (b) =>
        b.attrs.length > 0 &&
        b.attrs.length < own.size &&
        b.attrs.every((a) => own.has(a)) &&
        b.tokens[token],
    )
    raw = ancestors.length
      ? ancestors[ancestors.length - 1].tokens[token]
      : blocks.filter((b) => b.sel === ':root' && b.tokens[token]).pop()?.tokens[token]
  }
  if (raw === undefined) return undefined
  // Follow one level of `var()` indirection, so a theme may write
  // `--danger-text: var(--danger)`. A value the caller cannot read (color-mix,
  // 8-digit hex) is returned verbatim — the call site's hex assertion rejects
  // it loudly rather than it resolving to an ancestor's value.
  const ref = raw.match(/^var\((--[a-z0-9-]+)\)$/)
  return ref && depth < 3 ? effectiveToken(blocks, sel, ref[1], depth + 1) : raw
}
