import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { IconLoader, IconSidebar } from './ToolIcons'

// Cleanup is registered globally in src/test-setup.ts; the explicit hook here
// is redundant but harmless.
afterEach(() => {
  cleanup()
})

describe('IconSidebar', () => {
  it('renders an accessible-hidden svg with the panel-left glyph', () => {
    const { container } = render(<IconSidebar size={16} />)
    const svg = container.querySelector('svg')
    expect(svg).not.toBeNull()
    expect(svg!.getAttribute('aria-hidden')).toBe('true')
    expect(svg!.getAttribute('width')).toBe('16')
    // panel-left: an outer rounded rect + a left vertical divider
    expect(svg!.querySelector('rect')).not.toBeNull()
    expect(svg!.querySelector('path')).not.toBeNull()
  })
})

describe('IconLoader', () => {
  // The spinner is rotated by CSS (.tool-status-running .icon-loader et al).
  // The stylesheet targets `.tool-status-running .icon-loader` rather than a
  // bare `svg` so a badge can reuse the running colors without its glyph being
  // rotated. That only holds if the class is unconditional and survives a
  // caller-supplied className.
  //
  // Glyph note: this used to be a hand-drawn full-circle track + highlight arc
  // (rotation-INVARIANT silhouette; a gapped arc pumps its outline 1–2 device
  // px per revolution — see git history for the measurements). The lucide swap
  // made it upstream's loader-circle, which IS a gapped arc; if the wobble
  // reappears, that's the tradeoff — revert to the tracked design from git.
  it('always carries the icon-loader class, merged with a caller className', () => {
    const { container } = render(<IconLoader size={12} />)
    expect(container.querySelector('svg')!.classList.contains('icon-loader')).toBe(true)

    cleanup()
    const withCaller = render(<IconLoader size={12} className="git-panel-spin" />)
    const cls = withCaller.container.querySelector('svg')!.classList
    expect(cls.contains('icon-loader')).toBe(true)
    expect(cls.contains('git-panel-spin')).toBe(true)
  })

  it('renders the lucide loader-circle glyph', () => {
    const { container } = render(<IconLoader size={12} />)
    const svg = container.querySelector('svg')!
    expect(svg.classList.contains('lucide-loader-circle')).toBe(true)
  })
})
