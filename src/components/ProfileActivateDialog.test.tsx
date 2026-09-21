// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { ProfileActivateDialog } from './ProfileActivateDialog'
import { expectPortaledToBody } from './portal-test-utils'
import type { SessionInfo } from '../types'

afterEach(() => cleanup())

function session(id: string, model?: string): SessionInfo {
  return {
    id,
    title: `Session ${id}`,
    model,
    running: true,
    terminated: false,
    working: false,
    phase: 'idle',
    createdAt: 0,
    lastActivityAt: 0,
    subscribers: 0,
    messageCount: 0,
  }
}

function baseProps(overrides: Partial<React.ComponentProps<typeof ProfileActivateDialog>> = {}) {
  return {
    profileName: 'Work',
    sessions: [session('s1', 'opus'), session('s2')],
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  }
}

describe('ProfileActivateDialog', () => {
  it('renders the profile name and each candidate session, all checked by default', () => {
    const { getByRole, getByText } = render(<ProfileActivateDialog {...baseProps()} />)
    expect(getByRole('dialog', { name: 'Restart sessions' })).toBeTruthy()
    expect(getByText(/Switch profile to “Work”/)).toBeTruthy()
    expect(getByText('Session s1')).toBeTruthy()
    expect(getByText('Session s2')).toBeTruthy()
    // Both boxes checked by default → confirm label shows the count.
    expect(getByText('Restart 2 sessions')).toBeTruthy()
  })

  it('returns the selected session ids on confirm', () => {
    const props = baseProps()
    const { getByText, getByLabelText } = render(<ProfileActivateDialog {...props} />)
    // Uncheck s2 → only s1 should be reported.
    fireEvent.click(getByLabelText(/Session s2/))
    fireEvent.click(getByText('Restart 1 session'))
    expect(props.onConfirm).toHaveBeenCalledWith(['s1'])
  })

  it('disables confirm when every session is unchecked', () => {
    const props = baseProps()
    const { getByLabelText, getByText } = render(<ProfileActivateDialog {...props} />)
    fireEvent.click(getByLabelText(/Session s1/))
    fireEvent.click(getByLabelText(/Session s2/))
    const confirmBtn = getByText('Restart 0 sessions') as HTMLButtonElement
    expect(confirmBtn.disabled).toBe(true)
  })

  it('calls onCancel on Escape', () => {
    const props = baseProps()
    render(<ProfileActivateDialog {...props} />)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(props.onCancel).toHaveBeenCalledOnce()
  })

  // The switcher mounts this dialog from the app header, inside
  // `.profile-switcher` — a `position: relative` box the size of the trigger
  // button. An absolutely-positioned (panel-scoped) backdrop would resolve
  // `inset: 0` against THAT box instead of the viewport: the card gets clipped
  // to a ~150x30 sliver and its focus trap then steals focus back from the rest
  // of the app on every click. Portalling to <body> is the fix, so pin it.
  it('portals to <body> so the header trigger cannot become its containing block', () => {
    const { container } = render(<ProfileActivateDialog {...baseProps()} />)
    expectPortaledToBody(container, '.modal-backdrop')
    // The layout-pinning class has to ride the card, or the width / header
    // guard that compensates for the `modal` layer never matches.
    expect(document.querySelector('.modal.profile-activate-card')).not.toBeNull()
  })

  it('shows "Switch" when there are no sessions and leaves it enabled', () => {
    const props = baseProps({ sessions: [] })
    const { getByText } = render(<ProfileActivateDialog {...props} />)
    const btn = getByText('Switch') as HTMLButtonElement
    expect(btn.disabled).toBe(false)
    fireEvent.click(btn)
    expect(props.onConfirm).toHaveBeenCalledWith([])
  })
})