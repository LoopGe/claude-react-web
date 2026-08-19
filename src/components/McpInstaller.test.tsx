// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { McpInstaller } from './McpInstaller'

vi.mock('../hooks/useApi', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn() },
}))

afterEach(() => {
  cleanup()
})

function renderInstaller(overrides: Partial<React.ComponentProps<typeof McpInstaller>> = {}) {
  return render(
    <McpInstaller
      onSave={vi.fn()}
      onClose={vi.fn()}
      {...overrides}
    />,
  )
}

describe('McpInstaller', () => {
  it('closes on a backdrop mousedown, not on a mousedown inside the card', () => {
    const onClose = vi.fn()
    const { container } = renderInstaller({ onClose })

    // The modal is portaled to <body>, so query document.body.
    const backdrop = document.body.querySelector('.modal-backdrop')!
    const card = container.querySelector('.modal') ?? document.body.querySelector('.modal')!

    // mousedown inside the card (target !== backdrop) must NOT close — this
    // is what lets a user select text and release over the backdrop safely.
    fireEvent.mouseDown(card)
    expect(onClose).not.toHaveBeenCalled()

    // mousedown on the backdrop root closes.
    fireEvent.mouseDown(backdrop)
    expect(onClose).toHaveBeenCalledOnce()
  })
})
