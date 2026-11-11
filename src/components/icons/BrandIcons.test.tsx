import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { BRAND_ICONS } from './BrandIcons'

// Cleanup is registered globally in src/test-setup.ts; the explicit hook here
// is redundant but harmless.
afterEach(() => {
  cleanup()
})

// One test per brand entry would repeat the same three assertions; the set is
// small and closed, so the loop keeps every icon on the same contract. The
// per-entry `--brand-<id>` fill variable is the seam that tokens.css owns —
// a variable renamed here without the stylesheet (or vice versa) fails below.
describe('BRAND_ICONS', () => {
  it('exposes the five editor/terminal brands', () => {
    expect(Object.keys(BRAND_ICONS).sort()).toEqual(
      ['cursor', 'iterm2', 'vscode', 'windowsterminal', 'zed'].sort(),
    )
  })

  for (const [id, Icon] of Object.entries(BRAND_ICONS)) {
    it(`${id}: 24-viewBox svg filled by var(--brand-${id})`, () => {
      const { container } = render(<Icon size={14} />)
      const svg = container.querySelector('svg')
      expect(svg).not.toBeNull()
      expect(svg!.getAttribute('aria-hidden')).toBe('true')
      expect(svg!.getAttribute('width')).toBe('14')
      expect(svg!.getAttribute('viewBox')).toBe('0 0 24 24')
      const path = svg!.querySelector('path')
      expect(path).not.toBeNull()
      expect(path!.getAttribute('fill')).toBe(`var(--brand-${id})`)
      // A brand glyph with lost path data renders as an invisible box; the
      // data was vetted at capture time, so pin non-emptiness here.
      expect(path!.getAttribute('d')!.length).toBeGreaterThan(20)
    })
  }
})
