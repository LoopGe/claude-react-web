// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { AnimatePresence } from 'motion/react'
import { PromptDialog } from './PromptDialog'

afterEach(() => {
  cleanup()
})

function baseProps(overrides: Partial<React.ComponentProps<typeof PromptDialog>> = {}) {
  return {
    title: 'Rename group',
    message: 'Enter a new name.',
    defaultValue: 'old',
    confirmLabel: 'Rename',
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  }
}

describe('PromptDialog', () => {
  it('disables confirm until the value differs from the default', () => {
    const onConfirm = vi.fn()
    const { getByRole } = render(<PromptDialog {...baseProps({ onConfirm })} />)
    const input = getByRole('textbox') as HTMLInputElement
    const confirmBtn = getByRole('button', { name: 'Rename' }) as HTMLButtonElement
    // Same value as default -> canSubmit false.
    expect(confirmBtn.disabled).toBe(true)
    fireEvent.change(input, { target: { value: 'new name' } })
    expect(confirmBtn.disabled).toBe(false)
  })

  it('submits the trimmed value on Enter', () => {
    const onConfirm = vi.fn()
    const { getByRole } = render(<PromptDialog {...baseProps({ onConfirm })} />)
    const input = getByRole('textbox') as HTMLInputElement
    fireEvent.change(input, { target: { value: '  new name  ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onConfirm).toHaveBeenCalledWith('new name')
  })

  it('keeps the dialog mounted through the exit animation, then unmounts (AnimatePresence)', async () => {
    const props = baseProps()
    function Harness({ open }: { open: boolean }) {
      return (
        <AnimatePresence>
          {open && <PromptDialog key="p" {...props} />}
        </AnimatePresence>
      )
    }
    const { container, rerender } = render(<Harness open={true} />)
    expect(container.querySelector('.perm-overlay')).not.toBeNull()

    rerender(<Harness open={false} />)
    expect(container.querySelector('.perm-overlay')).not.toBeNull()

    await waitFor(() => {
      expect(container.querySelector('.perm-overlay')).toBeNull()
    })
  })
})
