// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { contrast } from './contrast-test-utils'

/** tokens.css with comments blanked — comment prose must not feed a count or a
 *  declaration lookup. */
function tokensCss(): string {
  return readFileSync(join(process.cwd(), 'src/styles/tokens.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
}

// Guard for the P0-5 fix: every skin's --danger must carry an --on-danger ink
// whose WCAG contrast is >= 4.5:1 (AA for normal text). This keeps a future
// skin block from silently shipping a destructive solid button with
// unreadable ink, and stops .btn-danger-solid from regressing to a hardcoded
// color that bypasses the per-skin token.

describe('danger solid-button ink contrast', () => {
  it('every --danger skin token is paired with an --on-danger that meets WCAG AA', () => {
    const css = tokensCss()
    const pairs = [
      ...css.matchAll(/--danger:\s*(#[0-9a-fA-F]{6});\s*\n\s*--on-danger:\s*(#[0-9a-fA-F]{6});/g),
    ].map((m) => [m[1].toLowerCase(), m[2].toLowerCase()])

    // Every --danger definition must have an adjacent --on-danger definition,
    // so a newly added skin can't silently skip the token.
    const dangerCount = (css.match(/--danger:/g) ?? []).length
    expect(pairs.length).toBe(dangerCount)

    for (const [danger, onDanger] of pairs) {
      const ratio = contrast(danger, onDanger)
      expect(
        ratio,
        `${danger} with ${onDanger} = ${ratio.toFixed(2)}:1 (need >= 4.5:1)`,
      ).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('.btn-danger-solid uses the --on-danger token, not a hardcoded ink', () => {
    const css = readFileSync(join(process.cwd(), 'src/styles/controls.css'), 'utf8')
    const rule = css.match(/\.btn-danger-solid\s*\{[^}]*\}/)?.[0] ?? ''
    expect(rule).toContain('color: var(--on-danger)')
    expect(rule).not.toMatch(/color:\s*(#[0-9a-fA-F]+|white|black)/)
  })
})

// Guard for the status-INK tokens. --danger / --warn / --ok are tuned for
// fills, borders and icon glyphs; as text they miss AA on the app's
// darker/lighter surfaces — in the default light theme --danger is 3.27:1 on
// --btn-hover-bg and 3.42:1 on --bg-elev-3, --warn 1.96:1, --ok 2.47:1 — which
// is why copy uses the *-text ink instead. Icon glyphs and decoration keep the
// fill token.
//
// The check resolves the custom-property cascade per skin/theme context rather
// than trusting the block a token is declared in: a skin may override a
// SURFACE only (both [data-skin="glow"] blocks do) and inherit the ink from a
// theme block, so keying off "--danger lives in this block" would skip exactly
// the combinations most likely to drift. Surfaces a rule tints itself with the
// fill token are out of scope — ink alone cannot fix those, so each tinted site
// keeps the tint light enough (or mixes it opaquely with a named surface) to
// stay inside the contract.

const SURFACE_TOKENS = [
  '--bg',
  '--bg-elev',
  '--bg-elev-1',
  '--bg-elev-2',
  '--bg-elev-3',
  '--btn-hover-bg',
  '--code-bg',
]

/** Every skin/theme context danger copy can render in, by name. The assertions
 *  run over the contexts *derived from the file* (see contextsOf), so a skin
 *  can never slip past un-checked; this list exists so a skin that goes missing
 *  — renamed, or its whole [data-skin] block deleted — fails by name instead
 *  of silently shrinking the checked set. */
const NAMED_CONTEXTS = [
  ':root',
  '[data-theme="light"]',
  '[data-skin="hc"]',
  '[data-skin="hc"][data-theme="light"]',
  '[data-skin="soft-hc"]',
  '[data-skin="soft-hc"][data-theme="light"]',
  '[data-skin="glow"]',
  '[data-skin="glow"][data-theme="light"]',
  '[data-skin="anthropic"]',
  '[data-skin="anthropic"][data-theme="light"]',
]

/** The three status families: a fill tuned for tints/borders/glyphs, plus the
 *  copy ink that has to clear AA wherever text renders. */
const INK_FAMILIES = [
  { fill: '--danger', ink: '--danger-text' },
  { fill: '--warn', ink: '--warn-text' },
  { fill: '--ok', ink: '--ok-text' },
]

interface Block {
  sel: string
  /** `[attr="value"]` selectors this block matches on — its specificity parts. */
  attrs: string[]
  tokens: Record<string, string>
}

/** `selector -> declared custom properties` for each rule in tokens.css. */
function parseBlocks(css: string): Block[] {
  const out: Block[] = []
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
    for (const m of css.slice(open + 1, j - 1).matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) {
      tokens[m[1]] = m[2].trim()
    }
    if (sel) out.push({ sel, attrs: [...sel.matchAll(/\[[a-z-]+="[^"]+"\]/g)].map((m) => m[0]), tokens })
    i = j
  }
  return out
}

/** Every context a custom property can resolve in: a bare `:root`, or a pure
 *  attribute-selector block (`[data-skin="hc"][data-theme="light"]`). Derived
 *  rather than listed, so a skin block added to tokens.css is checked even
 *  before anyone remembers to name it above. */
function contextsOf(blocks: Block[]): string[] {
  return [
    ...new Set(
      blocks.filter((b) => b.sel === ':root' || /^(\[[a-z-]+="[^"]+"\])+$/.test(b.sel)).map((b) => b.sel),
    ),
  ]
}

/** The winning *raw* value of `token` for a context: its own declaration, else
 *  the most specific matching ancestor (a compound selector counts one
 *  specificity point per attribute, so it beats a single-attribute block), else
 *  the last :root that declares the token. */
function rawFor(blocks: Block[], sel: string, token: string): string | undefined {
  const matching = blocks.filter((b) => b.sel === sel)
  const ctx = matching[matching.length - 1]
  if (ctx?.tokens[token]) return ctx.tokens[token]
  const own = new Set(ctx?.attrs ?? [])
  const ancestors = blocks.filter(
    (b) =>
      b.attrs.length > 0 && b.attrs.length < own.size && b.attrs.every((a) => own.has(a)) && b.tokens[token],
  )
  if (ancestors.length) return ancestors[ancestors.length - 1].tokens[token]
  return blocks.filter((b) => b.sel === ':root' && b.tokens[token]).pop()?.tokens[token]
}

/** Resolved value for a context, following one level of `var()` indirection so
 *  a theme may write `--danger-text: var(--danger)`. A value the test cannot
 *  read (color-mix, 8-digit hex) is returned verbatim and then rejected by the
 *  hex assertion at the call site — never silently swapped for a ancestor's. */
function effective(blocks: Block[], sel: string, token: string, depth = 0): string | undefined {
  const raw = rawFor(blocks, sel, token)
  if (raw === undefined) return undefined
  const ref = raw.match(/^var\((--[a-z0-9-]+)\)$/)
  if (!ref) return raw
  return depth < 3 ? effective(blocks, sel, ref[1], depth + 1) : undefined
}

const rgbOf = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))

/** `color-mix(in srgb, a pct%, b)` in sRGB. */
function mixHex(top: string, bottom: string, pct: number): string {
  return (
    '#' +
    rgbOf(top)
      .map((c, i) =>
        Math.round(c * pct + rgbOf(bottom)[i] * (1 - pct))
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
  )
}

interface StatusPlate {
  file: string
  sel: string
  /** The family fill token, e.g. `--ok`. */
  fam: string
  alpha: number
  /** The surface token the tint is mixed against. */
  surface: string
}

/** A status plate: `color: var(--X-text)` over an OPAQUE `color-mix(… var(--X) N%, var(--surface))`.
 *  Translucent tints are excluded on purpose — their backdrop is whatever sits
 *  behind them, which a static check cannot know. */
function statusPlates(): StatusPlate[] {
  const out: StatusPlate[] = []
  for (const file of readdirSync(join(process.cwd(), 'src/styles'))) {
    if (!file.endsWith('.css')) continue
    const css = readFileSync(join(process.cwd(), 'src/styles', file), 'utf8')
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const body = m[2]
      const ink = body.match(/color:\s*var\((--(?:danger|warn|ok)-text)\)/)
      if (!ink) continue
      const fam = ink[1].replace('-text', '')
      const bg = body.match(
        new RegExp(
          `background(?:-color)?:\\s*color-mix\\(in srgb,\\s*var\\(${fam}\\)\\s*(\\d+)%,\\s*var\\((--[a-z0-9-]+)\\)\\)`,
        ),
      )
      if (!bg) continue
      out.push({
        file,
        sel: m[1]
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .trim()
          .replace(/\s+/g, ' '),
        fam,
        alpha: Number(bg[1]),
        surface: bg[2],
      })
    }
  }
  return out
}

describe('status ink contrast (danger / warn / ok)', () => {
  const blocks = parseBlocks(tokensCss())
  const contexts = contextsOf(blocks)

  it('pairs every family fill with its copy ink in the same block', () => {
    for (const { fill, ink } of INK_FAMILIES) {
      expect(blocks.filter((b) => b.tokens[fill]).length, `${fill} is declared nowhere`).toBeGreaterThan(0)
      for (const b of blocks) {
        if (!b.tokens[fill]) continue
        expect(b.tokens[ink], `${b.sel} defines ${fill} without ${ink}`).toBeTruthy()
      }
    }
  })

  it('still names every skin/theme context it is expected to cover', () => {
    for (const sel of NAMED_CONTEXTS) {
      expect(contexts, `${sel} is gone from tokens.css`).toContain(sel)
    }
  })

  it('resolves a readable ink for every family in every context', () => {
    for (const { ink } of INK_FAMILIES) {
      for (const sel of contexts) {
        const v = effective(blocks, sel, ink)
        expect(v, `${sel} has no resolvable ${ink}`).toMatch(/^#[0-9a-f]{6}$/i)
      }
    }
  })

  it('each family clears 4.5:1 on every flat surface of every context', () => {
    for (const { ink } of INK_FAMILIES) {
      for (const sel of contexts) {
        const inkValue = effective(blocks, sel, ink)!
        for (const surfaceToken of SURFACE_TOKENS) {
          const surface = effective(blocks, sel, surfaceToken)
          expect(surface, `${sel} declares no ${surfaceToken}`).toMatch(/^#[0-9a-f]{6}$/i)
          const ratio = contrast(inkValue, surface!)
          expect(
            ratio,
            `${sel}: ${ink} (${inkValue}) on ${surfaceToken} ${surface} = ${ratio.toFixed(2)}:1 (need >= 4.5:1)`,
          ).toBeGreaterThanOrEqual(4.5)
        }
      }
    }
  })

  // Status plates are this system's own mechanism (an opaque family tint plus
  // the family ink), so the ink's real backdrop is the mix — not a flat token —
  // and each plate needs its own check. Translucent tints are excluded (see
  // statusPlates): their backdrop is whatever sits behind them.
  it('keeps every opaque status plate above 4.5:1 in every context', () => {
    const plates = statusPlates()
    expect(plates.length, 'no status plates found — the parser or the plates changed').toBeGreaterThan(10)
    for (const plate of plates) {
      const ink = `${plate.fam}-text`
      for (const sel of contexts) {
        const inkValue = effective(blocks, sel, ink)
        const fillValue = effective(blocks, sel, plate.fam)
        const surfaceValue = effective(blocks, sel, plate.surface)
        if (!inkValue || !fillValue || !surfaceValue) continue
        const composite = mixHex(fillValue, surfaceValue, plate.alpha / 100)
        const ratio = contrast(inkValue, composite)
        expect(
          ratio,
          `${plate.file} ${plate.sel}: ${ink} on ${plate.fam} ${plate.alpha}% over ${plate.surface} = ${ratio.toFixed(2)}:1 (need >= 4.5:1)`,
        ).toBeGreaterThanOrEqual(4.5)
      }
    }
  })
})
