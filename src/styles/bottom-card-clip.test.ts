import { describe, expect, it } from 'vitest'
import { parseBlocks, readCss } from './contrast-test-utils'

// Pins the CSS side of the bottom-overlay clip contract: the overflow clip may
// exist ONLY on the exiting variant. Why the clip must be exit-only — see the
// rationale on BottomCardMotion.tsx. (The jsdom component tests can only see
// the `-exiting` class toggle; this test sees the stylesheet.)

describe('bottom-overlay card wrapper clip contract', () => {
  const css = readCss('messages.css')
  const base = parseBlocks(css).filter((b) => b.sel === '.bottom-card-motion')

  it('.bottom-card-motion base rule exists', () => {
    expect(base.length, 'base rule missing from messages.css').toBeGreaterThan(0)
  })

  // Regex scan rather than parseBlocks: an at-rule body (@media …) is
  // attributed to the @media opener by parseBlocks, so an overflow: clip
  // re-added inside a media query would be invisible to it. The regex captures
  // each .bottom-card-motion* rule body directly, at any brace depth.
  it('only the -exiting variant declares overflow (media-query-proof)', () => {
    const offenders = [...css.matchAll(/\.bottom-card-motion([a-z-]*)\s*\{([^}]*)\}/g)]
      .filter((m) => /\boverflow\s*:/.test(m[2]))
      .map((m) => m[1])
    expect(offenders.length, '-exiting clip rule missing from messages.css').toBeGreaterThan(0)
    for (const suffix of offenders) {
      expect(suffix, 'only .bottom-card-motion-exiting may declare overflow').toBe('-exiting')
    }
  })
})
