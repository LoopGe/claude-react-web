import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TranscriptDrawerShell } from './TranscriptDrawerShell'
import { __resetForTests } from '../hooks/useEscapeStack'

interface ShellOptions {
  variant?: 'subagent' | 'workflow'
  isExiting?: boolean
  onClose?: () => void
  onEscape?: () => void
  onExited?: () => void
  header?: React.ReactNode
  children?: React.ReactNode
}

function Shell({
  variant = 'subagent',
  isExiting = false,
  onClose = () => {},
  onEscape = () => {},
  onExited = () => {},
  header = <div>Drawer header</div>,
  children = <div>Drawer body</div>,
}: ShellOptions) {
  return (
    <TranscriptDrawerShell
      variant={variant}
      ariaLabel="Drawer details"
      isExiting={isExiting}
      onClose={onClose}
      onEscape={onEscape}
      onExited={onExited}
      header={header}
    >
      {children}
    </TranscriptDrawerShell>
  )
}

function renderShell(options: ShellOptions = {}) {
  const onClose = vi.fn()
  const onEscape = vi.fn()
  const onExited = vi.fn()
  const utils = render(<Shell {...options} onClose={onClose} onEscape={onEscape} onExited={onExited} />)
  const root = document.querySelector(`.${options.variant ?? 'subagent'}-overlay`) as HTMLElement
  return { ...utils, root, onClose, onEscape, onExited }
}

afterEach(() => {
  __resetForTests()
})

describe('TranscriptDrawerShell structure and dismissal', () => {
  it('renders both variants with the same root > scrim + panel structure', () => {
    const first = renderShell({ variant: 'subagent' })
    expect(first.root.getAttribute('role')).toBe('dialog')
    expect(first.root.getAttribute('aria-modal')).toBe('false')
    expect(first.root.getAttribute('aria-label')).toBe('Drawer details')
    expect(screen.getByText('Drawer header')).toBeTruthy()
    expect(screen.getByText('Drawer body')).toBeTruthy()
    const subagentScrim = first.root.querySelector('.subagent-overlay-scrim')!
    const subagentPanel = first.root.querySelector('.subagent-overlay-panel')!
    expect(subagentScrim.parentElement).toBe(first.root)
    expect(subagentPanel.parentElement).toBe(first.root)
    expect(subagentScrim.contains(subagentPanel)).toBe(false)
    first.unmount()

    const second = renderShell({ variant: 'workflow' })
    expect(second.root.querySelector('.workflow-overlay-scrim')).not.toBeNull()
    expect(second.root.querySelector('.workflow-overlay-panel')).not.toBeNull()
  })

  it('closes only for direct root or scrim presses, not panel content or while exiting', () => {
    const { root, onClose } = renderShell()
    fireEvent.mouseDown(root.querySelector('.subagent-overlay-panel')!)
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.mouseDown(root.querySelector('.subagent-overlay-scrim')!)
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.mouseDown(root)
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('ignores root and scrim presses while exiting', () => {
    const { root, onClose } = renderShell({ isExiting: true })
    fireEvent.mouseDown(root.querySelector('.subagent-overlay-scrim')!)
    fireEvent.mouseDown(root)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('delegates Escape separately and swallows it during exit without acting', () => {
    const { onClose, onEscape } = renderShell({ isExiting: true })
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(onEscape).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('uses the caller Escape policy instead of conflating it with scrim close', () => {
    const { onClose, onEscape } = renderShell()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(onEscape).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('TranscriptDrawerShell focus and exit', () => {
  it('focuses the root on mount and preserves it across children updates', () => {
    const { root, rerender } = renderShell()
    expect(document.activeElement).toBe(root)

    rerender(
      <Shell header={<div>New header</div>}>
        <div>New body</div>
      </Shell>,
    )
    expect(document.querySelector('.subagent-overlay')).toBe(root)
    expect(document.activeElement).toBe(root)
    expect(screen.getByText('New header')).toBeTruthy()
    expect(screen.getByText('New body')).toBeTruthy()
  })

  it('restores the previously focused element on unmount', () => {
    const previous = document.createElement('button')
    document.body.appendChild(previous)
    previous.focus()
    const { unmount, root } = renderShell()
    expect(document.activeElement).toBe(root)

    unmount()
    expect(document.activeElement).toBe(previous)
    previous.remove()
  })

  it('accepts only the matching scrim exit animation', () => {
    const { root, onExited } = renderShell({ isExiting: true })
    const scrim = root.querySelector('.subagent-overlay-scrim')!

    fireEvent(scrim, new AnimationEvent('animationend', { animationName: 'other-animation', bubbles: true }))
    expect(onExited).not.toHaveBeenCalled()
    fireEvent(
      scrim,
      new AnimationEvent('animationend', { animationName: 'overlay-backdrop-out', bubbles: true }),
    )
    expect(onExited).toHaveBeenCalledTimes(1)
  })
})
