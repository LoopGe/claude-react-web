import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { __resetForTests, getEscapeStackCount } from '../hooks/useEscapeStack'
import { WorkflowOverlay } from './WorkflowOverlay'
import type { WorkflowRecord } from '../session-store/types'

// MessageList is a heavy virtualized transcript — irrelevant to the Escape
// wiring under test. Stub it so the overlay's own contract is what's exercised.
vi.mock('./MessageList', () => ({
  MessageList: () => <div data-testid="mock-message-list" />,
}))

const record = (over: Partial<WorkflowRecord> = {}): WorkflowRecord => ({
  toolUseId: 'wf-1',
  label: 'Test Workflow',
  status: 'running',
  phases: [],
  childAgents: [],
  ...over,
})

afterEach(() => {
  cleanup()
  __resetForTests()
})

describe('WorkflowOverlay escape stack', () => {
  it('registers in the escape stack while mounted and unregisters on unmount', () => {
    const { unmount } = render(<WorkflowOverlay record={record()} items={[]} onClose={vi.fn()} />)
    expect(getEscapeStackCount()).toBe(1)
    unmount()
    expect(getEscapeStackCount()).toBe(0)
  })

  it('Esc closes the workflow when no child is focused', () => {
    const onClose = vi.fn()
    render(<WorkflowOverlay record={record()} items={[]} onClose={onClose} />)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('Esc first unfocuses a drilled-in child, then closes on the next press', () => {
    const onClose = vi.fn()
    const rec = record({
      childAgents: [
        { toolUseId: 'child-1', label: 'Child', toolName: 'agent', phase: null, status: 'running', toolCount: 0 },
      ],
    })
    render(<WorkflowOverlay record={rec} items={[]} onClose={onClose} />)

    // Drill into the child (the phase-tree row toggles focus).
    fireEvent.click(screen.getByRole('button', { name: /Child/ }))

    // First Esc: unfocus the child, keep the workflow open.
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()

    // Second Esc: now nothing is focused → close.
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('swallows Esc during the exit window (isExiting) without acting', () => {
    const onClose = vi.fn()
    render(<WorkflowOverlay record={record()} items={[]} onClose={onClose} isExiting />)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('does not fall through to bubble-phase listeners (App interrupt chain)', () => {
    const onBubble = vi.fn()
    window.addEventListener('keydown', onBubble)
    render(<WorkflowOverlay record={record()} items={[]} onClose={vi.fn()} />)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(onBubble).not.toHaveBeenCalled()
    window.removeEventListener('keydown', onBubble)
  })
})
