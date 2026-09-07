import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render, fireEvent } from '@testing-library/react'
import { SessionCard, type SessionCardProps } from './SessionCard'
import type { SessionInfo } from '../../types'

// jsdom doesn't implement window.matchMedia; usePresenceValue probes it on
// each exit. Report "no reduced motion" so the animate-exit path is exercised
// (matches the stub in SettingsPanel.test.tsx).
vi.stubGlobal('matchMedia', () => ({
  matches: false,
  media: '',
  onchange: null,
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
  dispatchEvent: () => false,
}))

function makeSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: 'abc12345-xxxx',
    title: 'Test Session',
    cwd: '/home/user/project',
    running: true,
    working: false,
    terminated: false,
    error: null,
    model: 'claude-sonnet-4-20250514',
    permissionMode: 'default',
    messageCount: 5,
    subscribers: 1,
    lastActivityAt: Date.now(),
    phase: 'idle',
    ...overrides,
  } as SessionInfo
}

const baseProps: SessionCardProps = {
  session: makeSession(),
  slotIdx: 0,
  isOpen: false,
  isFocused: false,
  isResuming: false,
  hasUnread: false,
  isDragging: false,
  isDeleting: false,
  dropPosition: null,
  isRenaming: false,
  renameDraft: '',
  onSelect: vi.fn(),
  onDelete: vi.fn(),
  onSleep: vi.fn(),
  onContextMenu: vi.fn(),
  onDragStart: vi.fn(),
  onDragEnd: vi.fn(),
  onSetDropHint: vi.fn(),
  onClearDropHint: vi.fn(),
  onCommitRename: vi.fn(),
  onCancelRename: vi.fn(),
  onStartRename: vi.fn(),
  onRenameDraftChange: vi.fn(),
}

describe('SessionCard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders the session title', () => {
    const { container } = render(<SessionCard {...baseProps} />)
    expect(container.textContent).toContain('Test Session')
  })

  it('renders cwd shortened path', () => {
    const { container } = render(<SessionCard {...baseProps} />)
    expect(container.textContent).toContain('project')
  })

  it('renders "live" badge when running and not working', () => {
    const { container } = render(<SessionCard {...baseProps} />)
    expect(container.textContent).toContain('live')
  })

  it('renders "working" badge when running and working', () => {
    const session = makeSession({ running: true, working: true })
    const { container } = render(<SessionCard {...baseProps} session={session} />)
    expect(container.textContent).toContain('working')
  })

  it('renders "waiting" badge when parent turn is done but a background subagent is in flight', () => {
    const session = makeSession({ running: true, working: false, backgroundSubagentCount: 1, phase: 'working' })
    const { container } = render(<SessionCard {...baseProps} session={session} />)
    expect(container.textContent).toContain('waiting')
    // Dot carries the amber 'waiting' class, not the green 'live'.
    const dot = container.querySelector('.session-status-dot')
    expect(dot?.classList.contains('status-waiting')).toBe(true)
    expect(dot?.classList.contains('status-live')).toBe(false)
  })

  it('renders "live" badge when running with zero background subagents', () => {
    const session = makeSession({ running: true, working: false, backgroundSubagentCount: 0 })
    const { container } = render(<SessionCard {...baseProps} session={session} />)
    expect(container.textContent).toContain('live')
    const dot = container.querySelector('.session-status-dot')
    expect(dot?.classList.contains('status-live')).toBe(true)
  })

  it('prefers the "waiting" badge over "err" while a background subagent is in flight', () => {
    // Precedence must match statusClass(): working > waiting > err. A running
    // session with background work is "waiting" even if it also carries an
    // error — the error text still renders in the card body below.
    const session = makeSession({ running: true, working: false, error: 'Something failed', backgroundSubagentCount: 1 })
    const { container } = render(<SessionCard {...baseProps} session={session} />)
    expect(container.textContent).toContain('waiting')
    expect(container.textContent).not.toContain('err')
    const dot = container.querySelector('.session-status-dot')
    expect(dot?.classList.contains('status-waiting')).toBe(true)
  })

  it('surfaces the waiting status label in the badge title tooltip', () => {
    const session = makeSession({ running: true, working: false, backgroundSubagentCount: 1 })
    const { container } = render(<SessionCard {...baseProps} session={session} />)
    const badge = container.querySelector('.session-item-badge')
    expect(badge?.getAttribute('title')).toBe('Waiting for a background subagent')
  })

  it('renders error badge', () => {
    const session = makeSession({ error: 'Something failed' })
    const { container } = render(<SessionCard {...baseProps} session={session} />)
    expect(container.textContent).toContain('err')
  })

  it('renders "ended" badge when terminated', () => {
    const session = makeSession({ running: false, terminated: true })
    const { container } = render(<SessionCard {...baseProps} session={session} />)
    expect(container.textContent).toContain('ended')
  })

  it('sleep button calls onSleep for an idle session', () => {
    const onSleep = vi.fn()
    const session = makeSession({ phase: 'idle' })
    const { container } = render(<SessionCard {...baseProps} session={session} onSleep={onSleep} />)
    const btn = container.querySelector('.session-item-sleep') as HTMLButtonElement
    expect(btn).not.toBeNull()
    expect(btn.disabled).toBe(false)
    fireEvent.click(btn)
    expect(onSleep).toHaveBeenCalledWith(session.id)
  })

  it('sleep button is disabled when the session is working', () => {
    const onSleep = vi.fn()
    const session = makeSession({ running: true, working: true, phase: 'working' })
    const { container } = render(<SessionCard {...baseProps} session={session} onSleep={onSleep} />)
    const btn = container.querySelector('.session-item-sleep') as HTMLButtonElement
    expect(btn).not.toBeNull()
    expect(btn.disabled).toBe(true)
    fireEvent.click(btn)
    expect(onSleep).not.toHaveBeenCalled()
  })

  it('sleep button is hidden for a dormant session', () => {
    const session = makeSession({ running: false, terminated: false, phase: 'dormant' })
    const { container } = render(<SessionCard {...baseProps} session={session} />)
    expect(container.querySelector('.session-item-sleep')).toBeNull()
  })

  it('applies focused class when isFocused', () => {
    const { container } = render(<SessionCard {...baseProps} isFocused />)
    const card = container.querySelector('.session-item')
    expect(card?.classList.contains('focused')).toBe(true)
  })

  it('applies open class when isOpen but not focused', () => {
    const { container } = render(<SessionCard {...baseProps} isOpen isFocused={false} />)
    const card = container.querySelector('.session-item')
    expect(card?.classList.contains('open')).toBe(true)
  })

  it('renders a permission mode badge for default mode without card-level active styling', () => {
    const { container } = render(<SessionCard {...baseProps} />)
    const card = container.querySelector('.session-item')
    const badge = container.querySelector('.session-item-mode-badge')
    expect(card?.classList.contains('mode-default')).toBe(true)
    expect(card?.classList.contains('mode-active')).toBe(false)
    expect(badge).not.toBeNull()
    expect(badge?.getAttribute('aria-label')).toBe('Permission mode: Default (ask)')
  })

  it('calls onSelect when clicked', () => {
    const onSelect = vi.fn()
    const { container } = render(<SessionCard {...baseProps} onSelect={onSelect} />)
    const card = container.querySelector('.session-item')!
    fireEvent.click(card)
    expect(onSelect).toHaveBeenCalledWith('abc12345-xxxx')
  })

  it('does not call onSelect when resuming', () => {
    const onSelect = vi.fn()
    const { container } = render(
      <SessionCard {...baseProps} isResuming onSelect={onSelect} />,
    )
    const card = container.querySelector('.session-item')!
    fireEvent.click(card)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('calls onDelete when delete button is clicked', () => {
    const onDelete = vi.fn()
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const { container } = render(
      <SessionCard {...baseProps} onDelete={onDelete} />,
    )
    const btn = container.querySelector('.session-item-delete')!
    fireEvent.click(btn)
    expect(onDelete).toHaveBeenCalledWith('abc12345-xxxx')
    vi.restoreAllMocks()
  })

  it('applies dragging class when isDragging', () => {
    const { container } = render(<SessionCard {...baseProps} isDragging />)
    const card = container.querySelector('.session-item')
    expect(card?.classList.contains('dragging')).toBe(true)
  })

  it('applies drop-before/drop-after classes', () => {
    const { container: c1 } = render(<SessionCard {...baseProps} dropPosition="before" />)
    expect(c1.querySelector('.drop-before')).not.toBeNull()

    const { container: c2 } = render(<SessionCard {...baseProps} dropPosition="after" />)
    expect(c2.querySelector('.drop-after')).not.toBeNull()
  })

  it('replaces the status chip with an unread dot for an open session', () => {
    // B design: unread collapses the right-hand status chip to a lone accent
    // dot — no "live/working" text. The slot badge keeps its normal look.
    const { container } = render(
      <SessionCard {...baseProps} isOpen hasUnread slotIdx={1} />,
    )
    const slot = container.querySelector('.session-item-slot')
    expect(slot?.textContent).toBe('2') // slotIdx + 1
    expect(slot?.classList.contains('unread')).toBe(false)
    // The leading inline dot is gone; the chip now carries status-unread.
    expect(container.querySelector('.session-item-unread')).toBeNull()
    const badge = container.querySelector('.session-item-badge')
    expect(badge?.classList.contains('status-unread')).toBe(true)
    expect(badge?.classList.contains('status-live')).toBe(false)
    // Status text is hidden while unread; aria still names the state. The
    // badge is role="img" so the aria-label reaches assistive tech (a bare
    // span's generic role would ignore it).
    expect(container.textContent).not.toContain('live')
    expect(badge?.getAttribute('role')).toBe('img')
    expect(badge?.getAttribute('aria-label')).toBe('Unread, live')
  })

  it('replaces the dormant status chip with an unread dot for a closed session', () => {
    const session = makeSession({ running: false }) // dormant
    const { container } = render(<SessionCard {...baseProps} session={session} hasUnread />)
    expect(container.querySelector('.session-item-slot')).toBeNull()
    expect(container.querySelector('.session-item-unread')).toBeNull()
    const badge = container.querySelector('.session-item-badge')
    expect(badge?.classList.contains('status-unread')).toBe(true)
    expect(badge?.classList.contains('status-dormant')).toBe(false)
    expect(container.textContent).not.toContain('dormant')
    expect(badge?.getAttribute('aria-label')).toBe('Unread, dormant')
  })

  it('keeps the status explanation reachable on the unread badge', () => {
    // A waiting (background-subagent) session that is also unread: the visible
    // chip is just the dot, but hover/AT still surface the amber state.
    const session = makeSession({ running: true, working: false, backgroundSubagentCount: 1 })
    const { container } = render(<SessionCard {...baseProps} session={session} hasUnread />)
    const badge = container.querySelector('.session-item-badge')
    expect(badge?.classList.contains('status-unread')).toBe(true)
    expect(badge?.getAttribute('title')).toContain('background subagent')
    expect(badge?.getAttribute('aria-label')).toBe('Unread, waiting on background subagent')
  })

  it('renders slot number when isOpen', () => {
    const { container } = render(
      <SessionCard {...baseProps} isOpen slotIdx={1} />,
    )
    const slot = container.querySelector('.session-item-slot')
    expect(slot?.textContent).toBe('2') // slotIdx + 1
  })

  it('plays the slot entrance only on a closed → open transition', () => {
    const { container, rerender } = render(
      <SessionCard {...baseProps} isOpen={false} slotIdx={0} />,
    )
    expect(container.querySelector('.session-item-slot')).toBeNull()

    rerender(<SessionCard {...baseProps} isOpen slotIdx={0} />)
    const slot = container.querySelector('.session-item-slot')
    expect(slot?.textContent).toBe('1')
    expect(slot?.classList.contains('slot-in')).toBe(true)
  })

  it('does not replay the slot entrance when the card mounts already open (scroll remount / first load)', () => {
    // Virtuoso unmounts off-screen cards and remounts them on scroll; a plain
    // CSS mount animation would replay every time a card scrolls back into
    // view. Only a genuine false→true isOpen transition should pop.
    const { container } = render(
      <SessionCard {...baseProps} isOpen slotIdx={1} />,
    )
    const slot = container.querySelector('.session-item-slot')
    expect(slot).not.toBeNull()
    expect(slot?.classList.contains('slot-in')).toBe(false)
  })

  it('drops the slot entrance class shortly after the pop', () => {
    // `.slot-in` is cleared on a timer so a pending session's infinite amber
    // breathing cue resumes right after the ~180ms entrance (and the fill-mode
    // tail can't linger over later re-renders or suppress the pulse).
    vi.useFakeTimers()
    try {
      const { container, rerender } = render(
        <SessionCard {...baseProps} isOpen={false} slotIdx={0} />,
      )
      rerender(<SessionCard {...baseProps} isOpen slotIdx={0} />)
      const slot = container.querySelector('.session-item-slot')
      expect(slot?.classList.contains('slot-in')).toBe(true)
      act(() => { vi.advanceTimersByTime(300) })
      expect(slot?.classList.contains('slot-in')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the slot pill mounted through the exit, then unmounts it', () => {
    // Closing runs the reverse animation (`.slot-out`) so the pill contracts
    // and pulls the title back instead of vanishing in place; it unmounts
    // only after the exit cycle.
    vi.useFakeTimers()
    try {
      const { container, rerender } = render(
        <SessionCard {...baseProps} isOpen slotIdx={0} />,
      )
      expect(container.querySelector('.session-item-slot')).not.toBeNull()

      rerender(<SessionCard {...baseProps} isOpen={false} slotIdx={0} />)
      const exiting = container.querySelector('.session-item-slot')
      expect(exiting).not.toBeNull()
      expect(exiting?.classList.contains('slot-out')).toBe(true)
      expect(exiting?.classList.contains('slot-in')).toBe(false)

      act(() => { vi.advanceTimersByTime(300) })
      expect(container.querySelector('.session-item-slot')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the last real slot number during the exit', () => {
    // slotIdx drops to -1 the instant the session closes; the exit clone must
    // keep showing the number it had while open, not "0".
    vi.useFakeTimers()
    try {
      const { container, rerender } = render(
        <SessionCard {...baseProps} isOpen slotIdx={1} />,
      )
      expect(container.querySelector('.session-item-slot')?.textContent).toBe('2')

      rerender(<SessionCard {...baseProps} isOpen={false} slotIdx={-1} />)
      const exiting = container.querySelector('.session-item-slot')
      expect(exiting?.classList.contains('slot-out')).toBe(true)
      expect(exiting?.textContent).toBe('2')
    } finally {
      vi.useRealTimers()
    }
  })

  it('folds pending responses into the slot badge when open (no separate count badge)', () => {
    // An open session with a pending count used to render a slot badge AND a
    // visually identical perm-count badge side by side. They're merged into one:
    // the slot badge carries a `pending` modifier (amber + breathing), and the
    // count moves to its accessible label.
    const { container } = render(
      <SessionCard
        {...baseProps}
        isOpen
        slotIdx={1}
        session={makeSession({ pendingPermissionCount: 3 })}
      />,
    )
    const slot = container.querySelector('.session-item-slot')
    expect(slot?.textContent).toBe('2') // slotIdx + 1
    expect(slot?.classList.contains('pending')).toBe(true)
    // No separate count badge alongside.
    expect(container.querySelector('.session-item-perm-badge')).toBeNull()
    // Pending count surfaces in the slot badge's accessible label.
    expect(slot?.getAttribute('aria-label')).toContain('3 requests awaiting your response')
  })

  it('keeps the standalone count badge for a closed session with pending responses', () => {
    // A closed session has no slot badge to carry the pending signal, so the
    // standalone amber count badge is still rendered.
    const { container } = render(
      <SessionCard
        {...baseProps}
        isOpen={false}
        session={makeSession({ pendingPermissionCount: 3 })}
      />,
    )
    const badge = container.querySelector('.session-item-perm-badge')
    expect(badge?.textContent).toBe('3')
    expect(container.querySelector('.session-item-slot')).toBeNull()
  })

  it('folds pending into the slot badge while unread collapses the status chip', () => {
    // Open + pending + unread: pending rides the slot badge (amber); unread
    // collapses the right-hand status chip to the lone accent dot. The two
    // signals live on opposite sides of the title row and don't collide.
    const { container } = render(
      <SessionCard
        {...baseProps}
        isOpen
        slotIdx={1}
        session={makeSession({ pendingPermissionCount: 2 })}
        hasUnread
      />,
    )
    const slot = container.querySelector('.session-item-slot')
    expect(slot?.classList.contains('pending')).toBe(true)
    expect(slot?.classList.contains('unread')).toBe(false)
    expect(container.querySelector('.session-item-perm-badge')).toBeNull()
    expect(container.querySelector('.session-item-unread')).toBeNull()
    expect(container.querySelector('.session-item-badge.status-unread')).not.toBeNull()
  })

  it('keeps the pending amber styling even when the focused slot also has pending', () => {
    const { container } = render(
      <SessionCard
        {...baseProps}
        isOpen
        isFocused
        slotIdx={1}
        session={makeSession({ pendingPermissionCount: 1 })}
      />,
    )
    const slot = container.querySelector('.session-item-slot')
    expect(slot?.classList.contains('pending')).toBe(true)
    expect(slot?.classList.contains('focused')).toBe(true)
  })

  it('applies tinted class when accentStyle is provided', () => {
    const accentStyle = { '--accent': '#ff0000', '--accent-strong': '#cc0000' } as React.CSSProperties
    const { container } = render(<SessionCard {...baseProps} accentStyle={accentStyle} />)
    const card = container.querySelector('.session-item')
    expect(card?.classList.contains('tinted')).toBe(true)
  })
})
