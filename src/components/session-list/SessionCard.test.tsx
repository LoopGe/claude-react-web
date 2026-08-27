import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { SessionCard, type SessionCardProps } from './SessionCard'
import type { SessionInfo } from '../../types'

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

  it('folds unread into the slot badge when open (accent fill, no floating dot)', () => {
    const { container } = render(
      <SessionCard {...baseProps} isOpen hasUnread slotIdx={1} />,
    )
    const slot = container.querySelector('.session-item-slot')
    expect(slot?.classList.contains('unread')).toBe(true)
    expect(slot?.classList.contains('pending')).toBe(false)
    // The old floating 8px dot is gone.
    expect(container.querySelector('.session-item-unread')).toBeNull()
    // Unread surfaces in the accessible label.
    expect(slot?.getAttribute('aria-label')).toContain('unread')
  })

  it('does not render any unread indicator for a closed session', () => {
    // Closed sessions carry no unread signal at all (no dot, no slot badge to
    // fold it into — "nobody's watching a closed session").
    const { container } = render(<SessionCard {...baseProps} hasUnread />)
    expect(container.querySelector('.session-item-slot')).toBeNull()
    expect(container.querySelector('.session-item-unread')).toBeNull()
  })

  it('renders slot number when isOpen', () => {
    const { container } = render(
      <SessionCard {...baseProps} isOpen slotIdx={1} />,
    )
    const slot = container.querySelector('.session-item-slot')
    expect(slot?.textContent).toBe('2') // slotIdx + 1
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

  it('lets pending take precedence over unread when an open session has both', () => {
    // Open + pending + unread: the slot badge shows the pending state (amber),
    // never unread (accent), and there is still exactly one leading badge.
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
