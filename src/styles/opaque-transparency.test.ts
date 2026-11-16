import { describe, expect, it } from 'vitest'
import { parseBlocks, readCss, type CssBlock } from './contrast-test-utils'

const OPAQUE_ROOT = ':root[data-transparency="opaque"]'
const blocks = parseBlocks(readCss('glass.css'))

function ruleFor(selector: string): CssBlock {
  const full = `${OPAQUE_ROOT} ${selector}`
  const rule = blocks.find((block) => block.sel.split(',').some((part) => part.trim() === full))
  if (!rule) throw new Error(`Missing opaque rule for ${selector}`)
  return rule
}

function expectSolid(selector: string, token: '--bg-solid' | '--bg-elev-solid' | '--bg-elev-3-solid' | '--drag-over-bg-solid') {
  const rule = ruleFor(selector)
  expect(rule.decls['background-color'], selector).toBe(`var(${token})`)
  expect(rule.decls['backdrop-filter'], selector).toBe('none')
  expect(rule.decls['-webkit-backdrop-filter'], selector).toBe('none')
}

describe('opaque transparency mode', () => {
  it('pins glass and effective wallpaper tokens without rewriting the raw preferences', () => {
    const root = blocks.find((block) => block.sel === OPAQUE_ROOT)
    expect(root).toBeDefined()
    expect(root!.tokens['--glass-surface-bg']).toBe('var(--bg-elev-solid)')
    expect(root!.tokens['--glass-blur']).toBe('none')
    expect(root!.tokens['--glass-blur-strong']).toBe('none')
    expect(root!.tokens['--glass-edge-highlight']).toBe('0 0 0 0 transparent')
    expect(root!.tokens['--effective-app-chrome-alpha']).toBe('100%')
    expect(root!.tokens['--effective-app-surface-alpha']).toBe('100%')
    expect(root!.tokens['--effective-app-chrome-blur']).toBe('0px')
    expect(root!.tokens['--app-chrome-alpha']).toBeUndefined()
    expect(root!.tokens['--app-surface-alpha']).toBeUndefined()
    expect(root!.tokens['--app-chrome-blur']).toBeUndefined()
  })

  it('uses effective wallpaper tokens in the layout remapping', () => {
    const layout = readCss('layout.css')
    expect(layout).toContain('var(--effective-app-chrome-alpha)')
    expect(layout).toContain('var(--effective-app-surface-alpha)')
    expect(layout).toContain('blur(var(--effective-app-chrome-blur))')
    expect(layout).not.toContain('var(--app-chrome-alpha)')
    expect(layout).not.toContain('var(--app-surface-alpha)')
    expect(layout).not.toContain('blur(var(--app-chrome-blur))')
  })

  it('makes wallpaper chrome solid', () => {
    expectSolid('body.has-bg .sidebar', '--bg-elev-solid')
    expectSolid('body.has-bg .main-header', '--bg-elev-solid')
    expectSolid('body.has-bg .chat-panel', '--bg-solid')
  })

  it.each([
    ['.app-empty-state', '--bg-elev-solid'],
    ['.app-loading-card', '--bg-elev-solid'],
    ['.composer-card', '--bg-elev-solid'],
    ['.streaming-msg', '--bg-solid'],
    ['.streaming-msg.liquid-glass', '--bg-elev-solid'],
    ['.handoff-veil::before', '--bg-elev-solid'],
    ['.working-bar::before', '--bg-elev-solid'],
    ['.pinned-user-message', '--bg-solid'],
    ['.chat-older-float-pill', '--bg-solid'],
    ['.lightbox-toolbar', '--bg-elev-solid'],
    ['.lightbox-nav', '--bg-elev-solid'],
    ['.image-preview-compressed', '--bg-solid'],
    ['.image-preview-remove', '--bg-solid'],
    ['.composer-expanded-tab.active', '--bg-solid'],
    ['.bash-msg-header', '--bg-elev-3-solid'],
  ] as const)('makes the direct translucent surface %s solid', (selector, token) => {
    expectSolid(selector, token)
  })

  it('keeps the Brutalist WorkingBar semantic yellow while removing blur', () => {
    const selector = ':root[data-transparency="opaque"][data-skin="brutalist"] .working-bar::before'
    const rule = blocks.find(block => block.sel === selector)
    expect(rule).toBeDefined()
    expect(rule!.decls['background-color']).toBe('var(--bt-yellow)')
    expect(rule!.decls['backdrop-filter']).toBe('none')
    expect(rule!.decls['-webkit-backdrop-filter']).toBe('none')
  })

  it('preserves the composer drag-over treatment with a solid state fill', () => {
    expectSolid('.chat-composer-drag .composer-card', '--drag-over-bg-solid')
  })

  it('excludes opaque mode from the glass-only interior top-light', () => {
    const washBlocks = blocks.filter(block =>
      block.sel.includes('[data-transparency="off"]') && block.decls['background-image']?.includes('linear-gradient'),
    )
    expect(washBlocks.length).toBeGreaterThan(0)
    for (const block of washBlocks) {
      expect(block.sel).toContain(':not([data-transparency="opaque"])')
    }
  })

  it('disables inline SVG refraction filtering', () => {
    const rule = ruleFor('.streaming-refraction')
    expect(rule.decls['backdrop-filter']).toBe('none !important')
    expect(rule.decls['-webkit-backdrop-filter']).toBe('none !important')
  })
})
