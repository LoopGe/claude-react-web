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

  it('adds the cached class when hidden, keeping children mounted', () => {
    render(
      <PanelSlot hidden>
        <div data-testid="child">hi</div>
      </PanelSlot>,
    )
    const slot = document.querySelector('.panel-slot') as HTMLElement
    expect(slot.className).toBe('panel-slot panel-slot-cached')
    // 子树保持挂载——keep-alive 的全部意义
    expect(screen.getByTestId('child').textContent).toBe('hi')
  })

  it('stays a plain panel-slot when not hidden', () => {
    render(<PanelSlot><span /></PanelSlot>)
    const slot = document.querySelector('.panel-slot') as HTMLElement
    expect(slot.className).toBe('panel-slot')
  })
})
