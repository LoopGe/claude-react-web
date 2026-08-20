import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { __resetForTests, getEscapeStackCount } from '../hooks/useEscapeStack'
import { SubagentOverlay } from './SubagentOverlay'
import type { ActiveSubagent } from '../session-store/types'

// MessageList is a heavy virtualized transcript — irrelevant to the Escape
// wiring under test. Stub it so the overlay's own contract is what's exercised.
vi.mock('./MessageList', () => ({
  MessageList: () => <div data-testid="mock-message-list" />,
}))

const subagent = (id: string, over: Partial<ActiveSubagent> = {}): ActiveSubagent => ({
  toolUseId: id,
  label: `subagent ${id}`,
  status: 'running',
  toolCount: 0,
  ...over,
})

afterEach(() => {
  cleanup()
  __resetForTests()
})

function renderSubagent(opts: {
  stack?: string[]
  isExiting?: boolean
  onClose?: ReturnType<typeof vi.fn>
  onPop?: ReturnType<typeof vi.fn>
} = {}) {
  const stack = opts.stack ?? ['a']
  const index = new Map(stack.map((id) => [id, subagent(id)]))
  const onClose = opts.onClose ?? vi.fn()
  const onPop = opts.onPop ?? vi.fn()
  render(
    <SubagentOverlay
      stack={stack}
      items={[]}
      index={index}
      onClose={onClose}
      onPop={onPop}
      isExiting={opts.isExiting ?? false}
    />,
  )
  return { onClose, onPop }
}

describe('SubagentOverlay escape stack', () => {
  it('registers in the escape stack while mounted and unregisters on unmount', () => {
    const { unmount } = render(<SubagentOverlay
      stack={['a']}
      items={[]}
      index={new Map([['a', subagent('a')]])}
      onClose={vi.fn()}
      onPop={vi.fn()}
    />)
    expect(getEscapeStackCount()).toBe(1)
    unmount()
    expect(getEscapeStackCount()).toBe(0)
  })

  it('Esc with focus inside the overlay closes it (containment wins)', () => {
    const { onClose, onPop } = renderSubagent()
    const closeBtn = screen.getByRole('button', { name: 'Close' })
    closeBtn.focus()
    fireEvent.keyDown(closeBtn, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onPop).not.toHaveBeenCalled()
  })

  it('Esc with focus outside still closes the overlay (stack consumes topmost)', () => {
    const { onClose, onPop } = renderSubagent()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onPop).not.toHaveBeenCalled()
  })

  it('Esc pops one level when nested instead of closing', () => {
    const { onClose, onPop } = renderSubagent({ stack: ['a', 'b'] })
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(onPop).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('swallows Esc during the exit window (isExiting) without acting', () => {
    const { onClose, onPop } = renderSubagent({ isExiting: true })
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
    expect(onPop).not.toHaveBeenCalled()
  })

  it('does not fall through to bubble-phase listeners (App interrupt chain)', () => {
    const onBubble = vi.fn()
    window.addEventListener('keydown', onBubble)
    renderSubagent()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(onBubble).not.toHaveBeenCalled()
    window.removeEventListener('keydown', onBubble)
  })
})
