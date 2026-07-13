import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { PanelSlot } from './PanelSlot'

// vitest runs with `globals: false`, so @testing-library/react's auto-cleanup
// (via afterEach) doesn't register — rendered DOM would otherwise accumulate
// across tests.
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
