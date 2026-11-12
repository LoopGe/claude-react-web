// @vitest-environment node
// Pins the hover card's content-sized width. A short hint on a toolbar button
// must not inherit a fixed minimum and leave empty space beside the text; rich
// cards still wrap at max-width.

import { describe, expect, it } from 'vitest'
import { parseBlocks, readCss } from './contrast-test-utils'

describe('hover popover sizing', () => {
  it('sizes to its text instead of a fixed minimum width', () => {
    const rule = parseBlocks(readCss('hover-popover.css')).find((b) => b.sel === '.hover-pop')
    expect(rule, '.hover-pop must exist').toBeTruthy()
    expect(rule!.decls['min-width']).toBeUndefined()
    expect(rule!.decls['width']).toBe('max-content')
    expect(rule!.decls['max-width']).toBe('320px')
    expect(rule!.decls['overflow-wrap']).toBe('anywhere')
    // Portalled cards must clear a modal (2000) / setup page (10000) owner.
    expect(rule!.decls['z-index']).toBe('var(--z-tooltip)')
  })

  it('keeps the glass treatment on the shared hover portal', () => {
    const css = readCss('glass.css')
    expect(css).toContain('.hover-pop')
    const fallback = css.slice(css.indexOf('@supports not'))
    expect(fallback).toContain('.hover-pop')
  })

  it('has one value-pill class shared by every hover card', () => {
    const rule = parseBlocks(readCss('hover-popover.css')).find(
      (b) => b.sel === '.hover-pop-value',
    )
    expect(rule, '.hover-pop-value must exist').toBeTruthy()
    expect(rule!.decls['font-family']).toBe('var(--mono)')
    // The old tooltip-scoped duplicate must not come back.
    expect(readCss('utilities.css')).not.toContain('.tt-hl')
  })
})