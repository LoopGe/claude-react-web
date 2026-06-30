import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('chat CSS reading inset fallback', () => {
  it('defines a calc fallback before the CSS round() enhancement', () => {
    const css = readFileSync(join(process.cwd(), 'src/styles/chat.css'), 'utf8')

    const fallback = '--chat-reading-inset: max(var(--chat-reading-min-inset), calc((100% - var(--chat-reading-max-width)) / 2));'
    const enhancement = '--chat-reading-inset: max(var(--chat-reading-min-inset), round((100% - var(--chat-reading-max-width)) / 2, 1px));'

    expect(css).toContain(fallback)
    expect(css).toContain('@supports (width: round(1px, 1px))')
    expect(css.indexOf(fallback)).toBeLessThan(css.indexOf('@supports (width: round(1px, 1px))'))
    expect(css.indexOf('@supports (width: round(1px, 1px))')).toBeLessThan(css.indexOf(enhancement))
  })
})
