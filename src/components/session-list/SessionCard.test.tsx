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

  it('shows unread indicator when hasUnread', () => {
    const { container } = render(<SessionCard {...baseProps} hasUnread />)
    const unread = container.querySelector('.session-item-unread')
    expect(unread).not.toBeNull()
  })

  it('renders slot number when isOpen', () => {
    const { container } = render(
      <SessionCard {...baseProps} isOpen slotIdx={1} />,
    )
    const slot = container.querySelector('.session-item-slot')
    expect(slot?.textContent).toBe('2') // slotIdx + 1
  })

  it('applies tinted class when accentStyle is provided', () => {
    const accentStyle = { '--accent': '#ff0000', '--accent-strong': '#cc0000' } as React.CSSProperties
    const { container } = render(<SessionCard {...baseProps} accentStyle={accentStyle} />)
    const card = container.querySelector('.session-item')
    expect(card?.classList.contains('tinted')).toBe(true)
  })
})
