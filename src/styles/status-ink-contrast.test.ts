import { describe, expect, it } from 'vitest'
import {
  contrast,
  contextsOf,
  effectiveToken,
  mixHex,
  parseBlocks,
  readCss,
  stylesheets,
  type CssBlock,
} from './contrast-test-utils'

// Guard for the P0-5 fix: every skin's --danger must carry an --on-danger ink
// whose WCAG contrast is >= 4.5:1 (AA for normal text). This keeps a future
// skin block from silently shipping a destructive solid button with
// unreadable ink, and stops .btn-danger-solid from regressing to a hardcoded
// color that bypasses the per-skin token.

describe('danger solid-button ink contrast', () => {
  it('every --danger skin token is paired with an --on-danger that meets WCAG AA', () => {
    const css = readCss('tokens.css')
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
    const rule = readCss('controls.css').match(/\.btn-danger-solid\s*\{[^}]*\}/)?.[0] ?? ''
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
// the combinations most likely to drift.

const SURFACE_TOKENS = [
  '--bg',
  '--bg-elev',
  '--bg-elev-1',
  '--bg-elev-2',
  '--bg-elev-3',
  '--btn-hover-bg',
  '--code-bg',
]

/** Every skin/theme context status copy can render in, by name. The assertions
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

/** The four status families: a fill tuned for tints/borders/glyphs, plus the
 *  copy ink that has to clear AA wherever text renders. */
const INK_FAMILIES = [
  { fill: '--danger', ink: '--danger-text' },
  { fill: '--warn', ink: '--warn-text' },
  { fill: '--ok', ink: '--ok-text' },
  { fill: '--accent', ink: '--accent-text' },
]

interface StatusPlate {
  file: string
  sel: string
  /** The family fill token, e.g. `--ok`. */
  fam: string
  alpha: number
  /** The surface token the tint is mixed against. */
  surface: string
}

/** A status plate: `color: var(--X-text)` over an OPAQUE
 *  `color-mix(… var(--X) N%, var(--surface))`. Translucent tints are excluded
 *  on purpose — their backdrop is whatever sits behind them, which a static
 *  check cannot know. */
function statusPlates(): StatusPlate[] {
  const out: StatusPlate[] = []
  for (const file of stylesheets()) {
    const css = readCss(file)
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const body = m[2]
      const ink = body.match(/color:\s*var\((--(?:danger|warn|ok|accent)-text)\)/)
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
        sel: m[1].replace(/\s+/g, ' ').trim(),
        fam,
        alpha: Number(bg[1]),
        surface: bg[2],
      })
    }
  }
  return out
}

describe('status ink contrast', () => {
  const blocks: CssBlock[] = parseBlocks(readCss('tokens.css'))
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
        const v = effectiveToken(blocks, sel, ink)
        expect(v, `${sel} has no resolvable ${ink}`).toMatch(/^#[0-9a-f]{6}$/i)
      }
    }
  })

  it('each family clears 4.5:1 on every flat surface of every context', () => {
    for (const { ink } of INK_FAMILIES) {
      for (const sel of contexts) {
        const inkValue = effectiveToken(blocks, sel, ink)!
        for (const surfaceToken of SURFACE_TOKENS) {
          const surface = effectiveToken(blocks, sel, surfaceToken)
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
  // and each plate needs its own check: a hand-tuned alpha and a retuned ink
  // are otherwise locked together with no regression coverage.
  it('keeps every opaque status plate above 4.5:1 in every context', () => {
    const plates = statusPlates()
    expect(plates.length, 'no status plates found — the parser or the plates changed').toBeGreaterThan(10)
    for (const plate of plates) {
      const ink = `${plate.fam}-text`
      for (const sel of contexts) {
        const inkValue = effectiveToken(blocks, sel, ink)
        const fillValue = effectiveToken(blocks, sel, plate.fam)
        const surfaceValue = effectiveToken(blocks, sel, plate.surface)
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

  // The mode badges are accent washes with a per-mode ink rather than a plate,
  // so their ink's backdrop is a two-level composite (the badge wash over the
  // header's own wash) that only these declarations describe. Asserting it here
  // is what keeps a retuned wash or a new mode from shipping unreadable copy.
  it('keeps the chat mode badge readable on its wash in every context', () => {
    const layout = readCss('layout.css')
    const badgeWashMatch = layout.match(
      /\.chat-panel-mode-badge \{[^}]*background: color-mix\(in srgb, var\(--accent\) (\d+)%/,
    )
    const headerWashMatch = layout.match(
      /\.chat-panel-header \{[^}]*background: color-mix\(in srgb, var\(--accent\) (\d+)%/,
    )
    expect(badgeWashMatch, 'the badge wash declaration moved or was reshaped').not.toBeNull()
    expect(headerWashMatch, 'the header wash declaration moved or was reshaped').not.toBeNull()
    const badgeWash = Number(badgeWashMatch![1])
    const headerWash = Number(headerWashMatch![1])
    const MODES: Array<[string, string]> = [
      ['default', '--fg'],
      ['plan', '--warn-text'],
      ['bypassPermissions', '--danger-text'],
      ['dontAsk', '--danger-text'],
      ['acceptEdits', '--accent-text'],
      ['auto', '--accent-text'],
    ]
    // Derived counterpart, like NAMED_CONTEXTS: every `.mode-*` rule layout.css
    // declares must be listed above, so a new mode cannot ship un-checked.
    // (`mode-slide-in/out` are animation helpers, not modes.)
    const declaredModes = new Set(
      [...layout.matchAll(/\.chat-panel-mode-badge\.mode-([A-Za-z-]+)/g)]
        .map((m) => m[1])
        .filter((m) => !m.startsWith('slide-') && m !== 'expanded'),
    )
    expect([...declaredModes].sort()).toEqual(MODES.map(([m]) => m).sort())
    // The hover must not deepen the wash: 10% is already the AA cap for every
    // per-mode ink, so the cue is the label brightening instead.
    const hoverRule = parseBlocks(layout).filter(
      (b) => b.sel === '.chat-panel-mode-badge:hover:not(:disabled)',
    )
    expect(hoverRule.length, 'the badge hover rule is gone').toBeGreaterThan(0)
    expect(
      hoverRule[0].decls['background'],
      'the badge hover deepens the wash past the AA cap',
    ).toBeUndefined()
    expect(hoverRule[0].decls['color'], 'the badge hover should brighten the label').toBe('var(--fg)')
    for (const [mode, ink] of MODES) {
      // The RESTING rule only: the selector list is split so a `:hover` or
      // `.mode-expanded` variant can never stand in for it.
      const rule = parseBlocks(layout).filter((b) =>
        b.sel
          .split(',')
          .map((s) => s.trim())
          .includes(`.chat-panel-mode-badge.mode-${mode}`),
      )
      expect(rule.length, `no rule colours .chat-panel-mode-badge.mode-${mode}`).toBeGreaterThan(0)
      expect(rule.map((b) => b.decls['color'] ?? '').join(' '), `mode-${mode} should use ${ink}`).toMatch(
        new RegExp(`var\\(${ink}\\)`),
      )
      for (const sel of contexts) {
        const accent = effectiveToken(blocks, sel, '--accent')
        const base = effectiveToken(blocks, sel, '--bg-elev')
        const inkValue = effectiveToken(blocks, sel, ink)
        if (!accent || !base || !inkValue) continue
        const header = mixHex(accent, base, headerWash / 100)
        const badge = mixHex(accent, header, badgeWash / 100)
        const ratio = contrast(inkValue, badge)
        expect(
          ratio,
          `${sel}: mode-${mode} ${ink} on the badge wash ${badge} = ${ratio.toFixed(2)}:1 (need >= 4.5:1)`,
        ).toBeGreaterThanOrEqual(4.5)
      }
    }
  })
})
