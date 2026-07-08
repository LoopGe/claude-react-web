import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { PanelOverlay } from './PanelOverlay'

// Note on interaction testing: the focus trap (useFocusTrap) + jsdom +
// vite-node's source-map handling recurse to a stack overflow when
// `fireEvent.mouseDown` lands on the backdrop (it triggers a synchronous
// focusin → refocus chain that the test tooling chokes on — a test-env
// artifact, not a real bug; the trap works in the browser, same as
// SettingsPanel/GitPanel/ResumeDialog). So backdrop clicks are exercised via
// a native MouseEvent dispatch, and Escape via fireEvent.keyDown on the card
// (matching the PermissionDialog test convention).
describe('PanelOverlay', () => {
  afterEach(() => cleanup())

  it('renders children when open', () => {
    render(
      <PanelOverlay open onClose={() => {}} ariaLabel="Test">
        <button>inside</button>
      </PanelOverlay>,
    )
    expect(screen.getByRole('dialog', { name: 'Test' })).toBeDefined()
    expect(screen.getByText('inside')).toBeDefined()
  })

  it('renders nothing when closed from the start', () => {
    render(
      <PanelOverlay open={false} onClose={() => {}} ariaLabel="Test">
        <button>inside</button>
      </PanelOverlay>,
    )
    expect(screen.queryByText('inside')).toBeNull()
  })

  it('calls onClose on direct backdrop mousedown', () => {
    const onClose = vi.fn()
    render(
      <PanelOverlay open onClose={onClose} ariaLabel="Test">
        <button>inside</button>
      </PanelOverlay>,
    )
    const backdrop = screen.getByRole('dialog', { name: 'Test' }).parentElement!
    backdrop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does NOT call onClose when mousedown bubbles from inside the card', () => {
    const onClose = vi.fn()
    render(
      <PanelOverlay open onClose={onClose} ariaLabel="Test">
        <button>inside</button>
      </PanelOverlay>,
    )
    screen.getByText('inside').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('calls onClose on Escape (keydown on the card)', () => {
    const onClose = vi.fn()
    render(
      <PanelOverlay open onClose={onClose} ariaLabel="Test">
        <button>inside</button>
      </PanelOverlay>,
    )
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Test' }), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
