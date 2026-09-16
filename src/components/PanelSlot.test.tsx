import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { PanelSlot } from './PanelSlot'

// Cleanup is registered globally in src/test-setup.ts; the explicit hook here
// is redundant but harmless.
afterEach(() => {
  cleanup()
})

describe('PanelSlot', () => {
  it('renders children', () => {
    render(
      <PanelSlot>
        <div data-testid="child">hi</div>
      </PanelSlot>,
    )
    expect(screen.getByTestId('child').textContent).toBe('hi')
  })
})
