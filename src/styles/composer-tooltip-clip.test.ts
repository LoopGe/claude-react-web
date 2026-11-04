// @vitest-environment node
// Pins the composer control tooltips' width cap against the panel clip.
//
// Every composer session-control chip is wrapped in a Tooltip whose bubble is
// centered over its trigger, and the lane begins close to the panel's left
// edge. A chip that starts a row (the permission chip always; any chip that
// `flex-wrap` moves onto a new row) has its center only ~124px in, while the
// base `.tt-bubble` allowance is 280px — half a bubble then overhangs the edge
// and `.chat-panel{overflow:hidden}` hard-clips the label's leading characters
// ("rmission mode: …"). The rule below caps every chip's bubble below 2 × that
// center distance. Moving bubbles rightward (`align="start"`) is not a fix: in
// narrow multi-panel layouts each panel is a bare 1fr track (`min-width: 0`),
// so the bubble would be clipped on the right instead.
//
// Pure file reading — same pattern as bottom-dock.test.ts.

import { describe, expect, it } from 'vitest'
import { parseBlocks, readCss } from './contrast-test-utils'

/** 2 × the measured ~124px first-column trigger center. A bubble wider than
 *  this overhangs the panel's left edge when the chip starts a row. */
const MAX_FIRST_COLUMN_POPUP_PX = 240

const chatCss = readCss('chat.css')

describe('composer session-control tooltips do not overhang the panel edge', () => {
  it('caps every composer control bubble below 2× its first-column center distance', () => {
    const rules = parseBlocks(chatCss).filter(
      (b) =>
        b.sel.includes('.composer-session-controls') &&
        b.sel.includes('.tt-bubble') &&
        b.decls['max-width'],
    )
    expect(
      rules.length,
      'chat.css must cap the composer session-control tooltip bubbles (centered over a ~124px first-column offset)',
    ).toBeGreaterThan(0)
    for (const rule of rules) {
      const raw = rule.decls['max-width'].trim()
      // `parseFloat` would happily strip `%`/`em`/`vw`; only a px length can be
      // compared against the geometric bound below.
      expect(raw, `max-width is not a px length: ${raw}`).toMatch(/^\d+(\.\d+)?px$/)
      const width = parseFloat(raw)
      expect(width).toBeLessThan(MAX_FIRST_COLUMN_POPUP_PX)
      // The base `.tt-bubble` allowance is 280px; the cap must actually bind.
      expect(width).toBeLessThan(280)
    }
  })
})