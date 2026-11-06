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
  })
})