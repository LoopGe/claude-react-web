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

const read = (...parts: string[]) => readFileSync(join(process.cwd(), ...parts), 'utf8')
const style = (file: string) => read('src/styles', file)

const BACKDROPS = [
  { backdrop: '.tasks-overlay', panel: '.tasks-overlay > .tasks-panel', file: 'tasks-panel.css' },
  { backdrop: '.git-overlay', panel: '.git-overlay > .git-panel', file: 'git-panel.css' },
  { backdrop: '.settings-overlay', panel: '.settings-overlay > .settings-panel', file: 'layout.css' },
  { backdrop: '.panel-overlay', panel: '.panel-overlay > .panel-overlay-card', file: 'overlays.css' },
] as const

/** Bodies of EVERY standalone rule whose head is exactly `selector` (at any
 *  indent, so a media-query redeclaration is matched too — the natural way to
 *  re-introduce backdrop scrolling on short viewports must not escape the
 *  pin), each captured to its next line-start `}` so a `}` mid-comment can
 *  only truncate a body when it sits at column 0 — the one residual blind
 *  spot; if a future rule needs more, extend THIS extraction rather than
 *  loosening the assertions below. Grouped heads (`a, b { … }`) are
 *  intentionally NOT matched — the invariant is about the standalone rule.
 *  Every head is returned and asserted: `exec` inspects only the first match,
 *  which let a violation hide in a later rule while the base rule stayed
 *  clean (probe-confirmed in review). */
function standaloneRuleBodies(css: string, selector: string, file: string): string[] {
  const head = new RegExp(`(?:^|\n)[ \t]*${selector.replace(/[.>]/g, '\\$&')} \\{([\\s\\S]*?)\n\\}`, 'g')
  const bodies = [...css.matchAll(head)].map((m) => m[1])
  expect(bodies.length, `standalone "${selector} { … }" rule in ${file}`).toBeGreaterThan(0)
  return bodies
}

describe('overlay backdrops are not scroll containers', () => {
  it.each(BACKDROPS)('$backdrop declares no scrollable overflow, $panel stays height-capped', ({ backdrop, panel, file }) => {
    const css = style(file)
    // Comments are stripped BEFORE matching so declaration-shaped text inside
    // a comment can never satisfy or defeat the pin (the canonical comments
    // and their descendants discuss scrollbars by name).
    const strip = (body: string) => body.replace(/\/\*[\s\S]*?\*\//g, '')
    // `overflow[a-z-]*` covers the -x/-y shorthands. `overflow: hidden` would
    // also suppress the bar, but a backdrop has nothing to clip either — the
    // invariant pinned here is narrower: never auto/scroll, the values that
    // materialise a scrollbar. EVERY matching head is asserted (base rule,
    // media-query redeclarations, …).
    for (const body of standaloneRuleBodies(css, backdrop, file)) {
      expect(strip(body)).not.toMatch(/overflow[a-z-]*\s*:[^;}]*(auto|scroll)/)
    }

    // Half 2: the card child must stay capped, or the non-scrollable backdrop
    // clips unreachable content.
    for (const body of standaloneRuleBodies(css, panel, file)) {
      expect(strip(body)).toContain('max-height: 100%')
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
    const bodies = standaloneRuleBodies(css, '.tasks-overlay', 'synthetic.css')
    expect(bodies).toHaveLength(2)
    const strip = (body: string) => body.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(strip(bodies[0])).not.toMatch(/overflow[a-z-]*\s*:[^;}]*(auto|scroll)/)
    expect(strip(bodies[1])).toMatch(/overflow[a-z-]*\s*:[^;}]*(auto|scroll)/)
  })
})
