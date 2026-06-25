import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, fireEvent, within, cleanup } from '@testing-library/react'
import { PermissionDialog } from './PermissionDialog'
import type { PermissionRequest, PermissionMode } from '../types'

// vitest runs with `globals: false`, so @testing-library/react's auto-cleanup
// (which keys off a global `afterEach`) never registers. Without this explicit
// cleanup, each test's <PermissionDialog> — and its `useFocusTrap`
// `document`-level `focusin` listener — stays mounted and accumulates across
// tests. By the second test the leaked DOM + listeners produce an error with a
// deep stack that overflows vite-node's recursive `prepareStackTrace`
// source-map rewrite (the `/file:\/\/\/(\w:)?/` regex blows the stack), which
// cascades into unbounded unhandled rejections and an OOM that hangs the whole
// `vitest run`. Tearing down between tests keeps the stack shallow.
afterEach(() => {
  cleanup()
})

function planRequest(): Extract<PermissionRequest, { kind: 'permission' }> {
  return {
    kind: 'permission',
    id: 'p1',
    toolName: 'ExitPlanMode',
    input: { plan: 'Build the thing' },
    toolUseID: 'tu1',
    createdAt: 0,
  }
}

function toolRequest(): Extract<PermissionRequest, { kind: 'permission' }> {
  return {
    kind: 'permission',
    id: 'p2',
    toolName: 'Bash',
    input: { command: 'ls' },
    toolUseID: 'tu2',
    createdAt: 0,
  }
}

/** Text of every footer button, in DOM order. */
function buttonLabels(container: HTMLElement): string[] {
  return within(container)
    .getAllByRole('button')
    .map((b) => b.textContent?.trim() ?? '')
    // Drop the "Show raw input" toggle which also lives in the card.
    .filter((t) => t.startsWith('Approve') || t === 'Keep planning')
}

describe('PermissionDialog plan approval', () => {
  it('promotes the option matching the current mode to the primary (first) button', () => {
    const { container } = render(
      <PermissionDialog request={planRequest()} onDecide={vi.fn()} currentMode={'bypassPermissions'} />,
    )
    const labels = buttonLabels(container)
    // bypass option floated to front and marked (current).
    expect(labels[0]).toBe('Approve & bypass (current)')
    // The primary button carries btn-primary.
    const primary = within(container).getByRole('button', { name: /Approve & bypass/ })
    expect(primary.className).toContain('btn-primary')
  })

  it('marks acceptEdits as current when that is the session mode', () => {
    const { container } = render(
      <PermissionDialog request={planRequest()} onDecide={vi.fn()} currentMode={'acceptEdits'} />,
    )
    expect(buttonLabels(container)[0]).toBe('Approve & auto-accept edits (current)')
  })

  it('falls back to the default ordering when current mode has no plan option (e.g. plan/dontAsk)', () => {
    const { container } = render(
      <PermissionDialog request={planRequest()} onDecide={vi.fn()} currentMode={'plan' as PermissionMode} />,
    )
    // No option equals 'plan', so original order is preserved; first is acceptEdits.
    const labels = buttonLabels(container)
    expect(labels[0]).toBe('Approve & auto-accept edits')
    expect(labels.some((l) => l.includes('(current)'))).toBe(false)
  })

  it('passes the chosen execution mode through onDecide', () => {
    const onDecide = vi.fn()
    const { container } = render(
      <PermissionDialog request={planRequest()} onDecide={onDecide} currentMode={'default'} />,
    )
    fireEvent.click(within(container).getByRole('button', { name: /Approve & bypass/ }))
    expect(onDecide).toHaveBeenCalledWith({
      behavior: 'allow',
      persistForSession: false,
      planTargetMode: 'bypassPermissions',
    })
  })

  it('non-plan requests are unaffected (Allow once / Deny)', () => {
    const { container } = render(
      <PermissionDialog request={toolRequest()} onDecide={vi.fn()} currentMode={'bypassPermissions'} />,
    )
    const labels = within(container)
      .getAllByRole('button')
      .map((b) => b.textContent?.trim() ?? '')
    expect(labels).toContain('Allow once')
    expect(labels).toContain('Deny')
    expect(labels.some((l) => l.startsWith('Approve'))).toBe(false)
  })
})

describe('PermissionDialog minimize button', () => {
  it('renders a Minimize button for a non-plan request when onMinimize is provided', () => {
    const onMinimize = vi.fn()
    const { container } = render(
      <PermissionDialog request={toolRequest()} onDecide={vi.fn()} onMinimize={onMinimize} />,
    )
    const btn = within(container).getByRole('button', { name: 'Minimize' })
    expect(btn).toBeTruthy()
  })

  it('does not render a Minimize button when onMinimize is not provided', () => {
    const { container } = render(
      <PermissionDialog request={toolRequest()} onDecide={vi.fn()} />,
    )
    expect(within(container).queryByRole('button', { name: 'Minimize' })).toBeNull()
  })

  it('clicking the Minimize button calls onMinimize', () => {
    const onMinimize = vi.fn()
    const { container } = render(
      <PermissionDialog request={toolRequest()} onDecide={vi.fn()} onMinimize={onMinimize} />,
    )
    fireEvent.click(within(container).getByRole('button', { name: 'Minimize' }))
    expect(onMinimize).toHaveBeenCalledTimes(1)
  })

  it('still renders a Minimize button for a plan request when onMinimize is provided (regression)', () => {
    const onMinimize = vi.fn()
    const { container } = render(
      <PermissionDialog request={planRequest()} onDecide={vi.fn()} onMinimize={onMinimize} />,
    )
    expect(within(container).getByRole('button', { name: 'Minimize' })).toBeTruthy()
  })
})
