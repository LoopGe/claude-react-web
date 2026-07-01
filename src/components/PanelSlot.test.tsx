import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { PanelSlot } from './PanelSlot'

// vitest runs with `globals: false`, so @testing-library/react's auto-cleanup
// (via afterEach) doesn't register — rendered DOM would otherwise accumulate
// across tests and multiple ".panel-clearing-veil" nodes would collide.
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

  it('does not render a veil when clearingPhase is undefined', () => {
    const { container } = render(
      <PanelSlot>
        <div />
      </PanelSlot>,
    )
    expect(container.querySelector('.panel-clearing-veil')).toBeNull()
  })

  it('renders the veil with data-phase="fading-in"', () => {
    const { container } = render(
      <PanelSlot clearingPhase="fading-in">
        <div />
      </PanelSlot>,
    )
    const veil = container.querySelector('.panel-clearing-veil')
    expect(veil).not.toBeNull()
    expect(veil?.getAttribute('data-phase')).toBe('fading-in')
    expect(veil?.getAttribute('aria-hidden')).toBe('true')
  })

  it('renders the veil with data-phase="fading-out"', () => {
    const { container } = render(
      <PanelSlot clearingPhase="fading-out">
        <div />
      </PanelSlot>,
    )
    const veil = container.querySelector('.panel-clearing-veil')
    expect(veil?.getAttribute('data-phase')).toBe('fading-out')
  })

  it('veil contains a spinner and a Clearing… label', () => {
    render(
      <PanelSlot clearingPhase="fading-in">
        <div />
      </PanelSlot>,
    )
    expect(screen.getByText(/Clearing/i)).not.toBeNull()
  })
})
