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

  it('allows a default-only switch when every session is unchecked', () => {
    const props = baseProps()
    const { getByLabelText, getByText } = render(<ProfileActivateDialog {...props} />)
    fireEvent.click(getByLabelText(/Session s1/))
    fireEvent.click(getByLabelText(/Session s2/))
    const confirmBtn = getByText('Restart 0 sessions') as HTMLButtonElement
    expect(confirmBtn.disabled).toBe(false)
    fireEvent.click(confirmBtn)
    expect(props.onConfirm).toHaveBeenCalledWith([])
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

describe('ProfileActivateDialog overlay scrollbar', () => {
  it('attaches the project overlay scrollbar to the session-list scroller', () => {
    render(<ProfileActivateDialog {...baseProps()} />)
    const list = document.querySelector<HTMLElement>('.profile-activate-sessions')!
    expect(list.hasAttribute('data-os-native-hidden')).toBe(true)
    expect(document.querySelector('.profile-activate-card .os-track')).toBeTruthy()
  })

  it('attaches the project overlay scrollbar to the outer modal-section too', () => {
    render(<ProfileActivateDialog {...baseProps()} />)
    // Same contract as the other dialogs: the outer section is a scroll body
    // and carries the unified thumb wherever the card cap lets it overflow.
    const section = document.querySelector<HTMLElement>('.modal-section')!
    expect(section.hasAttribute('data-os-native-hidden')).toBe(true)
  })

  it('parents the session-list track to a non-scrolling wrapper, not the scrolling section', () => {
    render(<ProfileActivateDialog {...baseProps()} />)
    const list = document.querySelector<HTMLElement>('.profile-activate-sessions')!
    // An abspos track inside a scroller scrolls with the content and
    // double-subtracts scrollTop; its parent must be a non-scrolling wrapper
    // (same shape as ProfileCreateDialog's .modal-section-content).
    expect(list.parentElement!.classList.contains('modal-section')).toBe(false)
    expect(list.parentElement!.querySelector(':scope > .os-track')).toBeTruthy()
  })
})