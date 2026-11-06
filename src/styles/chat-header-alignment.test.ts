// @vitest-environment node
// Pins the git chip's right alignment in the chat panel header.
//
// The chip used to be wrapped in Tooltip's `.tt-wrap` inline-flex span, and
// the auto margin lived on that wrapper (`.chat-panel-header-row2 >
// .tt-wrap:has(> .chat-panel-git-badge)`). Moving the hover into the portalled
// HoverPopover removed the wrapper, so the badge button became the direct flex
// item; without moving the auto margin onto it the chip drifts left, next to
// the cwd path. Caught after that migration shipped.

import { describe, expect, it } from 'vitest'
import { parseBlocks, readCss } from './contrast-test-utils'

describe('chat panel header row 2 alignment', () => {
  it('right-aligns the git badge as the direct flex item', () => {
    const rule = parseBlocks(readCss('layout.css'))
      .filter((b) => b.sel === '.chat-panel-header-row2 > .chat-panel-git-badge')
      .pop()
    expect(rule, 'the direct-child git badge rule must exist').toBeTruthy()
    expect(rule!.decls['margin-left']).toBe('auto')
  })
})