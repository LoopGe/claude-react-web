import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent, within } from '@testing-library/react'
import { PermissionDialog } from './PermissionDialog'
import type { PermissionRequest, PermissionMode } from '../types'

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
