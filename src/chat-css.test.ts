// @vitest-environment node
// No DOM anywhere in this file. `src/**` otherwise maps to happy-dom (see
// vitest.config.ts) as the safe default; opting out skips that env boot.
import { describe, expect, it } from 'vitest'
import { readCss } from './styles/contrast-test-utils'

describe('chat CSS reading inset fallback', () => {
  it('defines a calc fallback before the CSS round() enhancement', () => {
    const css = readCss('chat.css')

    const fallback =
      '--chat-reading-inset: max(var(--chat-reading-min-inset), calc((100% - var(--chat-reading-max-width)) / 2));'
    const enhancement =
      '--chat-reading-inset: max(var(--chat-reading-min-inset), round((100% - var(--chat-reading-max-width)) / 2, 1px));'

    expect(css).toContain(fallback)
    expect(css).toContain('@supports (width: round(1px, 1px))')
    expect(css.indexOf(fallback)).toBeLessThan(css.indexOf('@supports (width: round(1px, 1px))'))
    expect(css.indexOf('@supports (width: round(1px, 1px))')).toBeLessThan(css.indexOf(enhancement))
  })
})
