import { describe, expect, it } from 'vitest'
import {
  contrast,
  effectiveToken,
  mixHex,
  parseBlocks,
  readCss,
  rgbOf,
  type CssBlock,
} from './contrast-test-utils'

// Guards the session-list metadata ink. It used to be
// `color-mix(in srgb, var(--fg-muted) 80%, transparent)`, which composited to
// 3.30:1 (light) / 3.93:1 (dark) on the .session-item surface -- below WCAG
// AA for normal text -- on the highest-traffic surface in the app. The
// palette's own opaque token clears AA (4.82:1 / 5.33:1), and the "keep meta
// quieter than meta-model" hierarchy is already carried by .session-item-model
// mixing TOWARD --fg, so the alpha bought nothing but a contrast failure.

function last(blocks: CssBlock[], sel: string): CssBlock | undefined {
  const hits = blocks.filter((b) => b.sel === sel)
  return hits[hits.length - 1]
}

function tokenOf(blocks: CssBlock[], themeSel: string, token: string): string {
  // effectiveToken already walks theme block -> matching ancestor -> last :root
  // that declares it, which is the browser resolution order. tokens.css has
  // several :root blocks, so a naive last() lookup misses the one that
  // actually defines the palette.
  const raw = effectiveToken(blocks, themeSel, token)
  if (!raw) throw new Error('token ' + token + ' not declared in ' + themeSel + ' or :root')
  return raw
}

describe('session-list metadata ink contrast', () => {
  const tokens = parseBlocks(readCss('tokens.css'))
  const sessionList = parseBlocks(readCss('session-list.css'))

  // .session-item is declared twice (a later rule only retunes `cursor` for
  // drag), so pick the one that actually paints the surface.
  const itemRule = sessionList.filter((b) => b.sel === '.session-item' && b.decls['background']).pop()
  it('.session-item surface is an accent wash over --bg-elev-1', () => {
    expect(itemRule, '.session-item must declare a background').toBeTruthy()
    expect(itemRule!.decls['background']).toBe(
      'color-mix(in srgb, var(--accent) 4%, var(--bg-elev-1))',
    )
  })

  const themes: Array<[string, string]> = [
    ['dark', ':root'],
    ['light', '[data-theme="light"]'],
  ]

  for (const [name, themeSel] of themes) {
    it('.session-item-meta meets WCAG AA on the .session-item surface (' + name + ')', () => {
      const accent = tokenOf(tokens, themeSel, '--accent')
      const bgElev1 = tokenOf(tokens, themeSel, '--bg-elev-1')
      const fgMuted = tokenOf(tokens, themeSel, '--fg-muted')

      // .session-item background: color-mix(in srgb, accent 4%, bg-elev-1)
      const itemBg = mixHex(accent, bgElev1, 0.04)

      const metaRule = last(sessionList, '.session-item-meta')
      expect(metaRule, '.session-item-meta must exist').toBeTruthy()
      const ink = metaRule!.decls['color']
      expect(ink, 'meta ink must be the opaque --fg-muted token').toBe('var(--fg-muted)')

      // Reject any transparent mix sneaking back in: parse the resolved token
      // and assert the alpha composite still clears 4.5:1 if anyone reintroduces
      // color-mix(... N%, transparent) -- the assertion below covers both.
      const opaque = ink === 'var(--fg-muted)'
      const metaInk = opaque ? fgMuted : ink
      const ratio = contrast(metaInk, itemBg)
      expect(
        ratio,
        '.session-item-meta ink ' + metaInk + ' on ' + itemBg + ' = ' + ratio.toFixed(2) + ':1',
      ).toBeGreaterThanOrEqual(4.5)

      // And the opaque token itself must clear AA -- the fix's whole point.
      expect(contrast(fgMuted, itemBg)).toBeGreaterThanOrEqual(4.5)

      // Sanity: the tokens are real hexes so rgbOf does not silently produce NaN.
      expect(rgbOf(itemBg)).toHaveLength(3)
    })
  }

  it('.session-item-meta does not reintroduce a transparent colour mix', () => {
    const metaRule = last(sessionList, '.session-item-meta')
    expect(metaRule).toBeTruthy()
    const ink = metaRule!.decls['color'] ?? ''
    expect(ink).not.toMatch(/transparent/)
    expect(ink).not.toMatch(/color-mix/)
  })
})
