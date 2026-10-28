import { describe, expect, it } from 'vitest'
import { contextsOf, effectiveToken, parseBlocks, readCss } from './contrast-test-utils'

const DARK = '[data-skin="brutalist"]'
const LIGHT = '[data-skin="brutalist"][data-theme="light"]'

describe('brutalist token blocks', () => {
  const blocks = parseBlocks(readCss('tokens.css'))
  const contexts = contextsOf(blocks)

  it('declares both brutalist contexts', () => {
    expect(contexts).toContain(DARK)
    expect(contexts).toContain(LIGHT)
  })

  it('zeroes every radius token in both contexts (spec: 圆角全部归零)', () => {
    for (const sel of [DARK, LIGHT]) {
      for (const t of ['--radius-3xs','--radius-2xs','--radius-xs','--radius-sm','--radius-md','--radius-lg','--radius-xl','--radius-2xl','--radius-3xl','--radius-pill','--radius-circle']) {
        expect(effectiveToken(blocks, sel, t), `${sel} ${t}`).toBe('0')
      }
    }
  })

  it('kills glass, gradients and glow in both contexts', () => {
    for (const sel of [DARK, LIGHT]) {
      expect(effectiveToken(blocks, sel, '--glass-blur')).toBe('none')
      expect(effectiveToken(blocks, sel, '--glass-blur-strong')).toBe('none')
      expect(effectiveToken(blocks, sel, '--glass-edge-highlight')).toBe('none')
      expect(effectiveToken(blocks, sel, '--surface-gradient')).toBe('none')
      expect(effectiveToken(blocks, sel, '--accent-glow')).toBe('none')
      expect(effectiveToken(blocks, sel, '--focus-glow')).toBe('none')
      expect(effectiveToken(blocks, sel, '--dot-glow')).toBe('none')
    }
  })

  it('pins the spec palette', () => {
    expect(effectiveToken(blocks, LIGHT, '--bg')).toBe('#f5f1e6')
    expect(effectiveToken(blocks, LIGHT, '--bg-elev')).toBe('#ffffff')
    expect(effectiveToken(blocks, LIGHT, '--border')).toBe('#111111')
    expect(effectiveToken(blocks, LIGHT, '--fg')).toBe('#111111')
    expect(effectiveToken(blocks, DARK, '--bg')).toBe('#141312')
    expect(effectiveToken(blocks, DARK, '--bg-elev')).toBe('#1e1c19')
    expect(effectiveToken(blocks, DARK, '--border')).toBe('#f2ede0')
    expect(effectiveToken(blocks, DARK, '--fg')).toBe('#f2ede0')
    for (const sel of [DARK, LIGHT]) {
      expect(effectiveToken(blocks, sel, '--bt-yellow')).toBe('#ffe600')
      expect(effectiveToken(blocks, sel, '--bt-orange')).toBe('#ff4d00')
      expect(effectiveToken(blocks, sel, '--bt-blue')).toBe('#3b5bff')
      expect(effectiveToken(blocks, sel, '--msg-user-bg')).toBe('#3b5bff')
      expect(effectiveToken(blocks, sel, '--msg-user-fg')).toBe('#ffffff')
    }
    // tool card inversion (spec §7): light = ink bg + yellow text, dark = cream bg + ink text
    expect(effectiveToken(blocks, LIGHT, '--msg-tool-bg')).toBe('#111111')
    expect(effectiveToken(blocks, LIGHT, '--msg-tool-fg')).toBe('#ffe600')
    expect(effectiveToken(blocks, DARK, '--msg-tool-bg')).toBe('#f2ede0')
    expect(effectiveToken(blocks, DARK, '--msg-tool-fg')).toBe('#141312')
  })

  it('uses only hard offset shadows (no blur, no rgba)', () => {
    for (const sel of [DARK, LIGHT]) {
      for (const t of ['--card-shadow','--modal-shadow','--overlay-shadow','--toast-shadow','--tooltip-shadow']) {
        expect(effectiveToken(blocks, sel, t), `${sel} ${t}`).toMatch(/^\d+px \d+px 0 #([0-9a-f]{6})$/i)
      }
    }
  })

  it('keeps CJK fallbacks in the display stack', () => {
    for (const sel of [DARK, LIGHT]) {
      const v = effectiveToken(blocks, sel, '--bt-display')!
      expect(v).toContain('PingFang SC')
      expect(v).toContain('Microsoft YaHei')
      expect(v.indexOf('PingFang SC')).toBeGreaterThan(v.indexOf('Arial'))
    }
  })
})
