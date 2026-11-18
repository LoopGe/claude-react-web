// @vitest-environment node
// The overlay thumb must fill its track on the CROSS axis. updateAxis sizes
// only the drag axis inline (height for vertical, width for horizontal); the
// cross axis relies on CSS. Block layout makes width:auto fill the track, but
// height:auto on the empty thumb div collapses to 0 — the horizontal thumb
// rendered as just its 2px transparent border, too thin to grab (measured
// live in the GitPanel diff preview: 2px tall vs the vertical thumb's 6px).
// Pure file reading, same pattern as overlay-backdrop-scroll.test.ts.

import { describe, expect, it } from 'vitest'
import { readCss, standaloneRuleBodies } from './contrast-test-utils'

describe('overlay scrollbar thumb cross-axis sizing', () => {
  it('horizontal thumb fills the track height instead of collapsing to its border', () => {
    const css = readCss('overlay-scrollbar.css')
    const bodies = standaloneRuleBodies(css, '.os-track-horizontal .os-thumb')
    expect(bodies.length, 'standalone ".os-track-horizontal .os-thumb { … }" rule').toBeGreaterThan(0)
    for (const body of bodies) {
      // Anchored like overlay-width-alignment.test.ts: an unanchored
      // /height: 100%/ would also match max-height or line-height, neither
      // of which forces a height on the empty thumb div.
      expect(body).toMatch(/(?:^|\n)\s*height:\s*100%;/)
    }
  })
})
