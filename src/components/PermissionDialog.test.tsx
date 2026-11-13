import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, fireEvent, within, cleanup, screen } from '@testing-library/react'
import { PermissionDialog } from './PermissionDialog'
import type { PermissionRequest } from '../types'

// Cleanup is registered globally in src/test-setup.ts. It matters here: before
// any of this, each test's <PermissionDialog> — and its `useFocusTrap`
// `document`-level `focusin` listener — stayed mounted and accumulated across
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

describe('PermissionDialog plan approval', () => {
  it.each([
    ['default', 'default'],
    ['acceptEdits', 'acceptEdits'],
    ['bypassPermissions', 'bypassPermissions'],
    ['plan', 'default'],
    ['auto', 'default'],
    ['dontAsk', 'default'],
    [undefined, 'default'],
  ] as const)('maps current mode %s to plan target %s', (currentMode, planTargetMode) => {
    const onDecide = vi.fn()
    const { container } = render(
      <PermissionDialog request={planRequest()} onDecide={onDecide} currentMode={currentMode} />,
    )
    const approve = within(container).getByRole('button', { name: 'Approve plan' })
    expect(approve.className).toContain('btn-primary')
    fireEvent.click(approve)
    expect(onDecide).toHaveBeenCalledWith({
      behavior: 'allow',
      persistForSession: false,
      planTargetMode,
    })
  })

  it('describes the review-each fallback without claiming to preserve the current mode', () => {
    const { container } = render(
      <PermissionDialog request={planRequest()} onDecide={vi.fn()} currentMode={'auto'} />,
    )
    expect(container.textContent).toContain('Approval exits plan mode and continues in review-each mode.')
    expect(container.textContent).not.toContain('Approval continues in your current permission mode.')
  })

  it('offers one approval action without execution-mode choices', () => {
    const { container } = render(
      <PermissionDialog request={planRequest()} onDecide={vi.fn()} currentMode={'default'} />,
    )
    expect(within(container).getAllByRole('button', { name: 'Approve plan' })).toHaveLength(1)
    expect(within(container).queryByRole('button', { name: /Approve & auto-accept edits/ })).toBeNull()
    expect(within(container).queryByRole('button', { name: /Approve & review each/ })).toBeNull()
    expect(within(container).queryByRole('button', { name: /Approve & bypass/ })).toBeNull()
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

  it('keeps feedback hidden until Request changes is selected', () => {
    const { container } = render(
      <PermissionDialog request={planRequest()} onDecide={vi.fn()} currentMode={'default'} />,
    )
    expect(within(container).queryByRole('textbox', { name: 'Plan feedback' })).toBeNull()
    fireEvent.click(within(container).getByRole('button', { name: 'Request changes' }))
    const input = within(container).getByRole('textbox', { name: 'Plan feedback' })
    expect(document.activeElement).toBe(input)
  })

  it('Back returns to review without deciding and preserves the feedback draft', () => {
    const onDecide = vi.fn()
    const { container } = render(
      <PermissionDialog request={planRequest()} onDecide={onDecide} currentMode={'default'} />,
    )
    fireEvent.click(within(container).getByRole('button', { name: 'Request changes' }))
    const input = within(container).getByRole('textbox', { name: 'Plan feedback' })
    fireEvent.change(input, { target: { value: 'add more tests' } })
    fireEvent.click(within(container).getByRole('button', { name: 'Back' }))
    expect(onDecide).not.toHaveBeenCalled()
    expect(within(container).queryByRole('textbox', { name: 'Plan feedback' })).toBeNull()
    const requestChanges = within(container).getByRole('button', { name: 'Request changes' })
    expect(document.activeElement).toBe(requestChanges)
    fireEvent.click(requestChanges)
    expect((within(container).getByRole('textbox', { name: 'Plan feedback' }) as HTMLTextAreaElement).value).toBe('add more tests')
  })

  it('disables Send feedback for empty and whitespace-only input', () => {
    const { container } = render(
      <PermissionDialog request={planRequest()} onDecide={vi.fn()} currentMode={'default'} />,
    )
    fireEvent.click(within(container).getByRole('button', { name: 'Request changes' }))
    const btn = within(container).getByRole('button', { name: /Send feedback/i }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    fireEvent.change(within(container).getByRole('textbox', { name: 'Plan feedback' }), { target: { value: '   ' } })
    expect(btn.disabled).toBe(true)
  })

  it('Send feedback emits deny with message and no interrupt', () => {
    const onDecide = vi.fn()
    const { container } = render(
      <PermissionDialog request={planRequest()} onDecide={onDecide} currentMode={'default'} />,
    )
    fireEvent.click(within(container).getByRole('button', { name: 'Request changes' }))
    const input = within(container).getByRole('textbox', { name: 'Plan feedback' })
    fireEvent.change(input, { target: { value: 'add more tests' } })
    fireEvent.click(within(container).getByRole('button', { name: /Send feedback/i }))
    expect(onDecide).toHaveBeenCalledWith({
      behavior: 'deny',
      message: 'Plan denied by user. Feedback: add more tests',
    })
  })

  it('does not submit feedback through Ctrl+Enter or Meta+Enter', () => {
    const onDecide = vi.fn()
    const { container } = render(
      <PermissionDialog request={planRequest()} onDecide={onDecide} currentMode={'default'} />,
    )
    fireEvent.click(within(container).getByRole('button', { name: 'Request changes' }))
    const input = within(container).getByRole('textbox', { name: 'Plan feedback' })
    fireEvent.change(input, { target: { value: 'add more tests' } })
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true })
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true })
    expect(onDecide).not.toHaveBeenCalled()
  })

  it('moves plan raw input and Stop into More options', () => {
    const { container } = render(
      <PermissionDialog request={planRequest()} onDecide={vi.fn()} currentMode={'default'} />,
    )
    expect(within(container).queryByRole('button', { name: 'Show raw input' })).toBeNull()
    expect(within(container).queryByRole('button', { name: /Stop & take over/i })).toBeNull()
    fireEvent.click(within(container).getByRole('button', { name: 'More options' }))
    expect(screen.getByRole('menuitem', { name: 'Show raw input' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: /Stop & take over/i })).toBeTruthy()
  })

  it.each([
    ['Approve & review each', 'default'],
    ['Approve & auto-accept edits', 'acceptEdits'],
    ['Approve & bypass', 'bypassPermissions'],
  ] as const)('approves from More options with %s', (label, planTargetMode) => {
    const onDecide = vi.fn()
    const { container } = render(
      <PermissionDialog request={planRequest()} onDecide={onDecide} currentMode={'default'} />,
    )
    fireEvent.click(within(container).getByRole('button', { name: 'More options' }))
    fireEvent.click(screen.getByRole('menuitem', { name: label }))
    expect(onDecide).toHaveBeenCalledWith({
      behavior: 'allow',
      persistForSession: false,
      planTargetMode,
    })
  })

  it('toggles formatted raw input from the portaled More menu', () => {
    const { container } = render(
      <PermissionDialog request={planRequest()} onDecide={vi.fn()} currentMode={'default'} />,
    )
    fireEvent.click(within(container).getByRole('button', { name: 'More options' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Show raw input' }))
    expect(container.querySelector('.perm-raw')?.textContent).toContain('"plan": "Build the thing"')
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.click(within(container).getByRole('button', { name: 'More options' }))
    expect(screen.getByRole('menuitem', { name: 'Hide raw input' })).toBeTruthy()
  })

  it('closes More options on the first Esc and stops only on the second Esc', () => {
    const onDecide = vi.fn()
    const { container } = render(
      <PermissionDialog request={planRequest()} onDecide={onDecide} currentMode={'default'} />,
    )
    const trigger = within(container).getByRole('button', { name: 'More options' })
    fireEvent.click(trigger)
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(onDecide).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(trigger)
    fireEvent.keyDown(trigger, { key: 'Escape' })
    expect(onDecide).toHaveBeenCalledWith({
      behavior: 'deny',
      message: 'Plan denied by user — stopping the turn.',
      interrupt: true,
    })
  })

  it('keeps raw input inline for ordinary tool permissions', () => {
    const { container } = render(
      <PermissionDialog request={toolRequest()} onDecide={vi.fn()} currentMode={'default'} />,
    )
    expect(within(container).getByRole('button', { name: 'Show raw input' })).toBeTruthy()
    expect(within(container).queryByRole('button', { name: 'More options' })).toBeNull()
  })

  it('Stop & take over emits deny with interrupt:true and a stop message', () => {
    const onDecide = vi.fn()
    const { container } = render(
      <PermissionDialog request={planRequest()} onDecide={onDecide} currentMode={'default'} />,
    )
    fireEvent.click(within(container).getByRole('button', { name: 'More options' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Stop & take over/i }))
    expect(onDecide).toHaveBeenCalledWith({
      behavior: 'deny',
      message: 'Plan denied by user — stopping the turn.',
      interrupt: true,
    })
  })

  it('Esc on a plan dialog denies with interrupt:true', () => {
    const onDecide = vi.fn()
    const { container } = render(
      <PermissionDialog request={planRequest()} onDecide={onDecide} currentMode={'default'} />,
    )
    const dialog = container.querySelector('.perm-card') as HTMLElement
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(onDecide).toHaveBeenCalledWith({
      behavior: 'deny',
      message: 'Plan denied by user — stopping the turn.',
      interrupt: true,
    })
  })
})

describe('PermissionDialog overlay scrollbar', () => {
  it('attaches the project overlay scrollbar to the modal-section scroll region (hides the native one)', () => {
    const { container } = render(
      <PermissionDialog request={planRequest()} onDecide={vi.fn()} currentMode={'default'} />,
    )
    const section = container.querySelector('.modal-section') as HTMLElement | null
    expect(section).toBeTruthy()
    // The overlay scrollbar hides the native scrollbar on the scroller it
    // attaches to — this is the contract that replaces the native 10px bar
    // with the project's self-built overlay thumb (matches the StreamingFooter
    // scrollbar test in transcript-chrome.test.tsx).
    expect(section!.hasAttribute('data-os-native-hidden')).toBe(true)
    // And it appends an overlay track as a sibling of the scroller inside the
    // .perm-card, floating the thumb over the plan card body.
    const card = container.querySelector('.perm-card')
    expect(card?.querySelector('.os-track')).toBeTruthy()
  })
})

describe('PermissionDialog Esc', () => {
  it('Esc on a plain tool dialog denies without interrupt (regression)', () => {
    const onDecide = vi.fn()
    const { container } = render(
      <PermissionDialog request={toolRequest()} onDecide={onDecide} currentMode={'default'} />,
    )
    const dialog = container.querySelector('.perm-card') as HTMLElement
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(onDecide).toHaveBeenCalledWith({ behavior: 'deny' })
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

describe('PermissionDialog security hints', () => {
  it('hides the session-wide allow when suppressAlwaysAllowRule is set', () => {
    const { container } = render(
      <PermissionDialog
        request={{ ...toolRequest(), suggestions: [{ type: 'addRules', rules: [] }], suppressAlwaysAllowRule: true }}
        onDecide={vi.fn()}
      />,
    )
    expect(within(container).queryByRole('button', { name: 'Allow for session' })).toBeNull()
    expect(container.textContent).toContain("isn't offered")
  })

  it('still offers the session-wide allow when suggestions are present and not suppressed', () => {
    const { container } = render(
      <PermissionDialog
        request={{ ...toolRequest(), suggestions: [{ type: 'addRules', rules: [] }] }}
        onDecide={vi.fn()}
      />,
    )
    expect(within(container).getByRole('button', { name: 'Allow for session' })).toBeTruthy()
  })

  it('opens on the decline option when defaultToNo is set', () => {
    const { container } = render(
      <PermissionDialog request={{ ...toolRequest(), defaultToNo: true }} onDecide={vi.fn()} />,
    )
    const deny = within(container).getByRole('button', { name: 'Deny' })
    expect(document.activeElement).toBe(deny)
  })

  it('shows the MCP server provenance when the request carries one', () => {
    const { container } = render(
      <PermissionDialog
        request={{ ...toolRequest(), mcpServer: { name: 'linear', source: 'project' } }}
        onDecide={vi.fn()}
      />,
    )
    expect(container.textContent).toContain('via linear')
    expect(container.textContent).toContain('(project)')
  })
})
