// @vitest-environment node
// Panel-overlay backdrops must never be scroll containers. The overlay-
// scrollbar module appends its track as an absolutely-positioned child of the
// scroller's parent, and a track `top` frozen mid-entrance-animation (a
// transform moves el's rect without resizing its box, so the ResizeObserver
// stays silent) can poke past the backdrop's scroll edge by sub-pixel amounts;
// `overflow-y: auto` there materialised a native scrollbar riding next to the
// overlay thumb — the panel's own bar is hidden by [data-os-native-hidden],
// making the backdrop the only element in the subtree that could show one.
// Mechanism: the canonical comment in src/utils/overlay-scrollbar.ts.
//
// The safety argument has TWO halves, so both are pinned per backdrop:
//   1. the backdrop declares no scrollable overflow, and
//   2. the card child keeps `max-height: 100%` — without that cap a
//      non-scrollable backdrop would silently CLIP unreachable content.
// Pure file reading, so the node environment — same pattern as
// floating-surface-anchor.test.ts.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { standaloneRuleBodies } from './contrast-test-utils'

const read = (...parts: string[]) => readFileSync(join(process.cwd(), ...parts), 'utf8')
const style = (file: string) => read('src/styles', file)

const BACKDROPS = [
  { backdrop: '.tasks-overlay', panel: '.tasks-overlay > .tasks-panel', file: 'tasks-panel.css' },
  { backdrop: '.git-overlay', panel: '.git-overlay > .git-panel', file: 'git-panel.css' },
  { backdrop: '.settings-overlay', panel: '.settings-overlay > .settings-panel', file: 'layout.css' },
  { backdrop: '.panel-overlay', panel: '.panel-overlay > .panel-overlay-card', file: 'overlays.css' },
] as const

// The all-match extractor lives in contrast-test-utils so this guard and
// overlay-width-alignment.test.ts share ONE implementation. Every head is
// returned and asserted: `exec` inspects only the first match, which let a
// violation hide in a later rule while the base rule stayed clean
// (probe-confirmed in review).

describe('overlay backdrops are not scroll containers', () => {
  it.each(BACKDROPS)('$backdrop declares no scrollable overflow, $panel stays height-capped', ({ backdrop, panel, file }) => {
    const css = style(file)
    // standaloneRuleBodies blanks comments before matching, so declaration-
    // shaped text inside a comment can never satisfy or defeat the pin (the
    // canonical comments discuss scrollbars by name).
    // `overflow[a-z-]*` covers the -x/-y shorthands. `overflow: hidden` would
    // also suppress the bar, but a backdrop has nothing to clip either — the
    // invariant pinned here is narrower: never auto/scroll, the values that
    // materialise a scrollbar. EVERY matching head is asserted (base rule,
    // media-query redeclarations, …).
    const backdropBodies = standaloneRuleBodies(css, backdrop)
    expect(backdropBodies.length, `standalone "${backdrop} { … }" rule in ${file}`).toBeGreaterThan(0)
    for (const body of backdropBodies) {
      expect(body).not.toMatch(/overflow[a-z-]*\s*:[^;}]*(auto|scroll)/)
    }

    // Half 2: the card child must stay capped, or the non-scrollable backdrop
    // clips unreachable content.
    const panelBodies = standaloneRuleBodies(css, panel)
    expect(panelBodies.length, `standalone "${panel} { … }" rule in ${file}`).toBeGreaterThan(0)
    for (const body of panelBodies) {
      expect(body).toContain('max-height: 100%')
    }
  })

  it('TasksPanel scrolls in a nested region so the overlay thumb sits on the card', () => {
    // attachOverlayScrollbar appends its track to the scroller's PARENT. When
    // the scroller IS the card, that parent is the full-bleed backdrop and the
    // CSS `right: 0` track lands at the backdrop edge — far from a centered
    // card on a wide panel. The card must therefore stay non-scrolling and the
    // scroll region must be the nested .tasks-panel-scroll (GitPanel's shape).
    const css = style('tasks-panel.css')
    const cardBodies = standaloneRuleBodies(css, '.tasks-overlay > .tasks-panel')
    expect(cardBodies.length, 'standalone ".tasks-overlay > .tasks-panel { … }" rule').toBeGreaterThan(0)
    for (const body of cardBodies) {
      // The shorthand counts too (`overflow: auto` / `overflow: scroll`).
      expect(body).not.toMatch(/overflow(?:-[xy])?\s*:\s*[^;}]*(auto|scroll)/)
    }
    const scrollBodies = standaloneRuleBodies(css, '.tasks-panel-scroll')
    expect(scrollBodies.length, 'standalone ".tasks-panel-scroll { … }" rule').toBeGreaterThan(0)
    for (const body of scrollBodies) {
      expect(body).toMatch(/overflow-y\s*:\s*auto/)
      expect(body).toMatch(/overflow-x\s*:\s*hidden/)
      expect(body).toMatch(/\bflex:\s*1\b/)
      expect(body).toMatch(/\bmin-height:\s*0\b/)
    }
  })

  it('extraction self-test: a violation in a LATER head is visible to the check (exec-only regression)', () => {
    // The helper must surface every matching head, not just the first: this
    // exact shape (clean base rule, violating @media redeclaration after it)
    // is what a naive exec-based extraction silently passes. The violation in
    // the second body must be VISIBLE to the pin's own pattern — i.e. a real
    // stylesheet with this shape fails the invariant instead of passing.
    const css = [
      '.tasks-overlay {',
      '  position: absolute;',
      '}',
      '@media (max-height: 700px) {',
      '  .tasks-overlay {',
      '    overflow-y: auto;',
      '  }',
      '}',
    ].join('\n')
    const bodies = standaloneRuleBodies(css, '.tasks-overlay')
    expect(bodies).toHaveLength(2)
    expect(bodies[0]).not.toMatch(/overflow[a-z-]*\s*:[^;}]*(auto|scroll)/)
    expect(bodies[1]).toMatch(/overflow[a-z-]*\s*:[^;}]*(auto|scroll)/)
  })
})
