import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { IconSidebar } from './ToolIcons'

// vitest runs with `globals: false`, so @testing-library/react's auto-cleanup
// (via afterEach) doesn't register — rendered DOM would otherwise accumulate
// across tests.
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
