import { describe, expect, it } from 'vitest'
import { contrast, luminance, parseBlocks, readCss } from './contrast-test-utils'

// Guard for the inactive status-dot ink: every --plugin-inactive token must
// carry at least 3:1 WCAG contrast (1.4.11, non-text UI) against every
// background it can render on. The dots appear in SettingsPanel's PluginCard,
// GlobalSettingsModal's McpCard and MarketplaceTab, so the relevant surfaces
// are the theme's --bg / --bg-elev / --bg-elev-2 — including per-skin
// overrides (glow, anthropic, soft-hc, hc), which is why the test collects
// bg hexes from the whole file rather than just the two base theme blocks.
//
// Theme polarity is derived from the selector the token is defined in (a
// `data-theme="light"` block is light), NOT from the ink's own lightness —
// both themes' inactive inks are mid-greys with nearly identical luminance,
// so a luminance threshold would misclassify them.
//
// History: dark #636873 was ~2.9:1 on --bg-elev-2 and light #9e9e9e was
// ~2.6:1 on white — both under the 3:1 floor.

describe('plugin inactive status-dot contrast', () => {
  it('every --plugin-inactive token meets WCAG 1.4.11 (3:1) on its theme surfaces', () => {
    // readCss blanks comments first: a block's captured selector otherwise
    // absorbs the preceding comment text, and comments reference selectors
    // (e.g. the hc block's comment mentions `[data-theme="light"]`) which would
    // corrupt the polarity classification below.
    const blocks = parseBlocks(readCss('tokens.css'))
    const hex = (v: string | undefined) => (v && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : undefined)

    const inactiveDefs = blocks
      .map((b) => ({ selector: b.sel, ink: hex(b.tokens['--plugin-inactive']) }))
      .filter((b): b is { selector: string; ink: string } => b.ink != null)
    expect(inactiveDefs.length).toBeGreaterThanOrEqual(2) // :root + light at minimum

    const surfaces = blocks.flatMap((b) =>
      ['--bg', '--bg-elev', '--bg-elev-2']
        .map((name) => hex(b.tokens[name]))
        .filter((h): h is string => h != null),
    )
    expect(surfaces.length).toBeGreaterThanOrEqual(6)

    // A dark-skin block can override --bg without redefining the ink, so the
    // ink must pass on every surface of its own polarity.
    const darkSurfaces = surfaces.filter((h) => luminance(h) < 0.35)
    const lightSurfaces = surfaces.filter((h) => luminance(h) >= 0.35)
    expect(darkSurfaces.length).toBeGreaterThan(0)
    expect(lightSurfaces.length).toBeGreaterThan(0)

    for (const { selector, ink } of inactiveDefs) {
      const isLightBlock = selector.includes('data-theme="light"')
      const targets = isLightBlock ? lightSurfaces : darkSurfaces
      for (const surface of targets) {
        const ratio = contrast(ink, surface)
        expect(
          ratio,
          `--plugin-inactive ${ink} (${selector.trim()}) on ${surface} = ${ratio.toFixed(2)}:1 (need >= 3:1)`,
        ).toBeGreaterThanOrEqual(3)
      }
    }
  })
})
