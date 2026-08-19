// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { AnimatePresence } from 'motion/react'
import { ConfirmDialog } from './ConfirmDialog'

afterEach(() => {
  cleanup()
})

function baseProps(overrides: Partial<React.ComponentProps<typeof ConfirmDialog>> = {}) {
  return {
    title: 'Delete session?',
    message: 'This cannot be undone.',
    confirmLabel: 'Delete',
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  }
}

describe('ConfirmDialog', () => {
  it('renders the title, message, and confirm label', () => {
    const { getByRole, getByText } = render(<ConfirmDialog {...baseProps()} />)
    expect(getByRole('dialog', { name: 'Delete session?' })).toBeTruthy()
    expect(getByText('This cannot be undone.')).toBeTruthy()
    expect(getByText('Delete')).toBeTruthy()
  })

  it('fires onCancel on Escape', () => {
    const onCancel = vi.fn()
    render(<ConfirmDialog {...baseProps({ onCancel })} />)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledOnce()
  })

  it('fires onCancel on backdrop mousedown but not on card mousedown', () => {
    const onCancel = vi.fn()
    const { container } = render(<ConfirmDialog {...baseProps({ onCancel })} />)
    // Clicking the card should NOT cancel (e.target !== e.currentTarget).
    fireEvent.mouseDown(container.querySelector('.perm-card')!)
    expect(onCancel).not.toHaveBeenCalled()
    // Clicking the backdrop root cancels.
    fireEvent.mouseDown(container.querySelector('.perm-overlay')!)
    expect(onCancel).toHaveBeenCalledOnce()
  })

  it('disables Esc, backdrop, and the confirm button while busy', () => {
    const onCancel = vi.fn()
    const onConfirm = vi.fn()
    const { container, getByText } = render(
      <ConfirmDialog {...baseProps({ busy: true, onCancel, onConfirm })} />,
    )
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(onCancel).not.toHaveBeenCalled()
    fireEvent.mouseDown(container.querySelector('.perm-overlay')!)
    expect(onCancel).not.toHaveBeenCalled()
    const confirmBtn = getByText('Working...') as HTMLButtonElement
    expect(confirmBtn.disabled).toBe(true)
  })

  it('auto-focuses Cancel for destructive dialogs, Confirm otherwise', () => {
    // Non-destructive: the confirm button gets initial focus so Enter confirms.
    const first = render(<ConfirmDialog {...baseProps()} />)
    expect(document.activeElement).toBe(first.getByText('Delete'))
    first.unmount()

    // Destructive: the cancel button gets initial focus so a reflexive Enter
    // can't fire the destructive action ("Discard", "Drop stash", "Abort", …).
    const second = render(<ConfirmDialog {...baseProps({ destructive: true })} />)
    expect(document.activeElement).toBe(second.getByText('Cancel'))
  })

  it('keeps the dialog mounted through the exit animation, then unmounts (AnimatePresence)', async () => {
    const props = baseProps()
    function Harness({ open }: { open: boolean }) {
      return (
        <AnimatePresence>
          {open && <ConfirmDialog key="c" {...props} />}
        </AnimatePresence>
      )
    }
    const { container, rerender } = render(<Harness open={true} />)
    expect(container.querySelector('.perm-overlay')).not.toBeNull()

    rerender(<Harness open={false} />)
    // AnimatePresence retains the node while exiting (guards against motion
    // short-circuiting the exit in jsdom and unmounting instantly).
    expect(container.querySelector('.perm-overlay')).not.toBeNull()

    await waitFor(() => {
      expect(container.querySelector('.perm-overlay')).toBeNull()
    })
  })
})
