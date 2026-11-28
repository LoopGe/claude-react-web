// Pins the truncation contract of the file-tool card title row (the
// click-to-copy path button inside .tool-card-title — the open-in-preview
// eye now rides the right-aligned .tool-card-actions cluster, see
// card-btn-anatomy.test.ts). In a narrow panel the title flexes below its
// content width; the row must then truncate INSIDE the copy button (dir
// suffix first, then the file name with an ellipsis). If the nowrap
// file-name span ever regains its automatic minimum size, it paints outside
// the shrunk copy button into the actions zone (measured live: 21.8px of
// overlap at a 370px card). happy-dom runs no layout, so these declarations
// are pinned textually.
import { describe, expect, it } from 'vitest'
import { readCss, standaloneRuleBodies } from './contrast-test-utils'

const css = readCss('./utilities.css')

/** The single standalone body of `selector`. */
function ruleBody(selector: string): string {
  const bodies = standaloneRuleBodies(css, selector)
  expect(bodies, `exactly one standalone rule: ${selector}`).toHaveLength(1)
  return bodies[0]!
}

/** The full body of an at-rule (brace-matched, so every inner rule counts). */
function atRuleBlock(header: string): string {
  const start = css.indexOf(header)
  expect(start, `missing at-rule: ${header}`).toBeGreaterThan(-1)
  let depth = 0
  for (let i = css.indexOf('{', start); i < css.length; i++) {
    if (css[i] === '{') depth++
    else if (css[i] === '}' && --depth === 0) return css.slice(start, i)
  }
  throw new Error(`unbalanced braces after ${header}`)
}

describe('file-path title truncation', () => {
  it('lets the file name shrink with an ellipsis', () => {
    // Without min-width: 0 the nowrap text's automatic minimum size keeps
    // the span at full width inside a shrunk copy button and the overflow
    // paints across the open-in-preview button.
    const base = ruleBody('.tool-card-filepath-base')
    expect(base).toContain('min-width: 0')
    expect(base).toContain('overflow: clip')
    expect(base).toContain('text-overflow: ellipsis')
  })

  it('sacrifices the dir suffix before the file name ellipsizes', () => {
    expect(ruleBody('.tool-card-filepath-dir')).toContain('flex-shrink: 999')
  })

  it('clips the copy button so no child can paint over the eye button', () => {
    // `clip`, not `hidden`: the button must not become a scroll container
    // (keyboard-scrollable hidden text, persisted scroll offset).
    expect(ruleBody('.tool-card-filepath')).toContain('overflow: clip')
  })

  it('keeps the actions cluster (and the eye inside it) unshrinkable', () => {
    // The cluster is the fixed anchor the truncating title makes room for; a
    // shrinkable cluster would reintroduce a collision from the other side.
    // The eye lost its own `flex: 0 0 auto` with the move to the ghost tier —
    // .icon-btn's flex-shrink: 0 (controls.css) now carries that guarantee.
    expect(ruleBody('.tool-card-actions')).toContain('flex-shrink: 0')
    const controls = readCss('./controls.css')
    expect(standaloneRuleBodies(controls, '.icon-btn')[0]).toContain('flex-shrink: 0')
  })

  it('leaves the file-path title unclipped so the focus ring survives', () => {
    // The copy button's -4px wash bleed reaches exactly the title's edges;
    // the title's base `overflow: hidden` (for text/code titles) would cut
    // both the wash and the :focus-visible ring there. The file-path title
    // clips itself, so it opts out of the outer clip.
    const rule = ruleBody('.tool-card-title:has(.tool-card-filepath)')
    expect(rule).toContain('overflow: visible')
    // …and floors at the eye's width: the eye never shrinks, so a narrower
    // (unclipped) title would let it escape into the actions zone.
    expect(rule).toContain('min-width: 32px')
  })

  it('collapses the action chrome to icons before the title truncates', () => {
    // Dense cards (three-panel splits land at ~350-480px) hide the status /
    // background labels and compact the pill so the reclaimed width goes to
    // the file name.
    const block = atRuleBlock('@container (max-width: 479px)')
    expect(block).toContain('.tool-card-actions .tool-card-bg-btn > span')
    expect(block).toContain('.tool-card-actions .tool-status-label')
    expect(block).toContain('.tool-card-actions .tool-status {')
  })

  it('shares one dense-row pill geometry with .tool-status-compact', () => {
    // The container tier re-declares the compact geometry (no class hook
    // exists inside an at-rule); parity is pinned here so the two dense-row
    // treatments cannot drift apart silently.
    const compact = ruleBody('.tool-status-compact')
    const tier = atRuleBlock('@container (max-width: 479px)')
    const start = tier.indexOf('.tool-card-actions .tool-status {')
    const tierPill = tier.slice(start, tier.indexOf('}', start))
    for (const decl of [
      'padding: var(--space-0-5)',
      'width: var(--size-18px)',
      'height: var(--size-18px)',
      'justify-content: center',
    ]) {
      expect(compact, `compact: ${decl}`).toContain(decl)
      expect(tierPill, `tier: ${decl}`).toContain(decl)
    }
  })
})
