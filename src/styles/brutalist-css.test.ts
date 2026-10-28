import { describe, expect, it } from 'vitest'
import { parseBlocks, readCss } from './contrast-test-utils'

describe('brutalist component layer', () => {
  it('glass wash gradient blocks exclude the brutalist skin', () => {
    for (const b of parseBlocks(readCss('glass.css'))) {
      const bg = b.decls['background-image'] ?? ''
      if (bg.includes('linear-gradient')) {
        expect(b.sel, 'wash block must exclude brutalist').toContain(':not([data-skin="brutalist"])')
      }
    }
  })

  it('brutalist.css hardcodes no colors (CLAUDE.md: colors via variables)', () => {
    const css = readCss('brutalist.css')
    expect(css).not.toMatch(/(?:^|[;{\s])(?:color|background|border-color|box-shadow|outline)\s*:[^;}]*#[0-9a-f]{3,8}/i)
  })

  it('sticker rotation uses the rotate property, not transform', () => {
    const css = readCss('brutalist.css')
    expect(css).toContain('rotate:')
    expect(css).not.toMatch(/transform\s*:[^;}]*rotate\(/)
  })

  it('liquid-glass inline blur on .streaming-refraction is flattened with author !important', () => {
    // transcript-chrome.tsx sets `backdrop-filter: blur(2px) url(#…)` inline
    // on the refraction layer; only author !important beats an inline style.
    const blocks = parseBlocks(readCss('brutalist.css')).filter((b) =>
      b.sel.includes('.streaming-refraction'),
    )
    expect(blocks.length).toBeGreaterThan(0)
    for (const b of blocks) {
      expect(b.decls['backdrop-filter'] ?? '').toMatch(/^none\s*!important$/)
      expect(b.decls['-webkit-backdrop-filter'] ?? '').toMatch(/^none\s*!important$/)
    }
  })
})
