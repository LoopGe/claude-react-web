import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, act, fireEvent } from '@testing-library/react'
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
  isRenaming: false,
  renameDraft: '',
  onSelect: vi.fn(),
  onContextMenu: vi.fn(),
  onCommitRename: vi.fn(),
  onCancelRename: vi.fn(),
  onStartRename: vi.fn(),
  onRenameDraftChange: vi.fn(),
}

function statusDot(container: HTMLElement): HTMLElement | null {
  return container.querySelector('.session-status-dot')
}

/** Hover the card long enough for HoverPopover's dwell. */
function openHoverCard(container: HTMLElement): void {
  vi.useFakeTimers()
  try {
    fireEvent.pointerEnter(container.querySelector('.session-item')!)
    act(() => {
      vi.advanceTimersByTime(200)
    })
  } finally {
    vi.useRealTimers()
  }
}

describe('SessionCard single-line layout', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders the session title', () => {
    const { container } = render(<SessionCard {...baseProps} />)
    expect(container.textContent).toContain('Test Session')
  })

  it('does not render the cwd, model, message count, or viewer count', () => {
    const { container } = render(<SessionCard {...baseProps} />)
    expect(container.textContent).not.toContain('project')
    expect(container.textContent).not.toContain('sonnet')
    expect(container.textContent).not.toContain('msgs')
    expect(container.textContent).not.toContain('viewers')
    expect(container.querySelector('.session-item-cwd')).toBeNull()
    expect(container.querySelector('.session-item-meta')).toBeNull()
  })

  it('shows the hidden metadata in the hover card', () => {
    vi.useFakeTimers()
    try {
      const { container } = render(<SessionCard {...baseProps} />)
      const card = container.querySelector('.session-item') as HTMLElement
      card.getBoundingClientRect = () => ({
        left: 100,
        top: 100,
        width: 200,
        height: 32,
        right: 300,
        bottom: 132,
        x: 100,
        y: 100,
        toJSON: () => ({}),
      } as DOMRect)
      fireEvent.pointerEnter(card)
      act(() => {
        vi.advanceTimersByTime(200)
      })
      const hover = document.querySelector<HTMLElement>('.hover-pop')
      expect(hover?.style.visibility).not.toBe('hidden')
      expect(hover?.style.left).toBe('306px')
      expect(hover?.style.top).toBe('100px')
      expect(hover?.textContent).toContain('/home/user/project')
      expect(hover?.textContent).toContain('sonnet-4')
      expect(hover?.textContent).toContain('5 msgs')
      expect(hover?.textContent).toContain('1 viewer')
      // Each meta value is a pill (model · messages · viewers).
      expect(hover?.querySelectorAll('.hover-pop-value')).toHaveLength(3)
      expect(hover?.textContent).toContain('Live')
      // The row itself no longer carries the native title.
      expect(container.querySelector('.session-item-title > span[title]')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('dismisses the hover card when the focused session changes', () => {
    vi.useFakeTimers()
    try {
      const { container, rerender } = render(<SessionCard {...baseProps} focusKey="s1" />)
      fireEvent.pointerEnter(container.querySelector('.session-item')!)
      act(() => {
        vi.advanceTimersByTime(200)
      })
      expect(document.querySelector('.hover-pop')).not.toBeNull()
      rerender(<SessionCard {...baseProps} focusKey="s2" />)
      expect(document.querySelector('.hover-pop')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not render the hover sleep or delete buttons', () => {
    const { container } = render(<SessionCard {...baseProps} />)
    expect(container.querySelector('.session-item-sleep')).toBeNull()
    expect(container.querySelector('.session-item-delete')).toBeNull()
    expect(container.querySelector('.session-item-actions')).toBeNull()
  })

  it('does not render status wording in the row', () => {
    const { container } = render(<SessionCard {...baseProps} />)
    for (const word of ['live', 'working', 'waiting', 'dormant', 'ended', 'err', 'resuming']) {
      expect(container.textContent?.toLowerCase()).not.toContain(word)
    }
    expect(container.querySelector('.session-item-status-label')).toBeNull()
  })

  it('keeps the permission mode badge', () => {
    const { container } = render(<SessionCard {...baseProps} />)
    const badge = container.querySelector('.session-item-mode-badge')
    expect(badge).not.toBeNull()
    expect(badge?.getAttribute('aria-label')).toBe('Permission mode: Default (ask)')
  })
})

describe('SessionCard status dot matches the header fold', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders no dot for a plain live session', () => {
    const { container } = render(<SessionCard {...baseProps} />)
    expect(statusDot(container)).toBeNull()
  })

  it('renders the working dot for an active turn', () => {
    const { container } = render(
      <SessionCard {...baseProps} session={makeSession({ working: true })} />,
    )
    expect(statusDot(container)?.classList.contains('status-working')).toBe(true)
  })

  it('renders the waiting dot when a background subagent is still running', () => {
    const { container } = render(
      <SessionCard
        {...baseProps}
        session={makeSession({ working: false, backgroundSubagentCount: 1 })}
      />,
    )
    expect(statusDot(container)?.classList.contains('status-waiting')).toBe(true)
  })

  it('renders the err dot for a running session that errored', () => {
    const { container } = render(
      <SessionCard {...baseProps} session={makeSession({ error: 'Something failed' })} />,
    )
    expect(statusDot(container)?.classList.contains('status-err')).toBe(true)
  })

  it('renders the ended dot for a terminated session', () => {
    const { container } = render(
      <SessionCard {...baseProps} session={makeSession({ running: false, terminated: true })} />,
    )
    expect(statusDot(container)?.classList.contains('status-ended')).toBe(true)
  })

  it('renders the dormant ring for a session that is not running', () => {
    const { container } = render(
      <SessionCard {...baseProps} session={makeSession({ running: false })} />,
    )
    expect(statusDot(container)?.classList.contains('status-dormant')).toBe(true)
  })

  it('renders the working dot while a resume is in flight', () => {
    const { container } = render(
      <SessionCard {...baseProps} session={makeSession({ running: false })} isResuming />,
    )
    expect(statusDot(container)?.classList.contains('status-working')).toBe(true)
  })

  it('folds crash recovery into the working dot', () => {
    const { container } = render(
      <SessionCard {...baseProps} session={makeSession({ recovering: true })} />,
    )
    expect(statusDot(container)?.classList.contains('status-working')).toBe(true)
  })
})

describe('SessionCard unread and status precedence', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows the unread dot instead of the live state', () => {
    const { container } = render(<SessionCard {...baseProps} hasUnread />)
    expect(statusDot(container)?.classList.contains('status-unread')).toBe(true)
  })

  it('lets working win over unread', () => {
    const { container } = render(
      <SessionCard {...baseProps} hasUnread session={makeSession({ working: true })} />,
    )
    expect(statusDot(container)?.classList.contains('status-working')).toBe(true)
    expect(statusDot(container)?.classList.contains('status-unread')).toBe(false)
  })

  it('shows the unread dot instead of a dormant ring', () => {
    const { container } = render(
      <SessionCard {...baseProps} hasUnread session={makeSession({ running: false })} />,
    )
    expect(statusDot(container)?.classList.contains('status-unread')).toBe(true)
    expect(statusDot(container)?.classList.contains('status-dormant')).toBe(false)
  })
})

describe('SessionCard status tooltip', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('carries the error text in the hover card instead of a row', () => {
    const { container } = render(
      <SessionCard {...baseProps} session={makeSession({ error: 'Something failed' })} />,
    )
    expect(container.textContent).not.toContain('Something failed')
    openHoverCard(container)
    // The error IS the status here (a running errored session), so it lives on
    // the status line; the separate error line is only for the outranked case.
    expect(document.querySelector('.hover-pop-status')?.textContent).toContain('Something failed')
  })

  it('keeps the error reachable when waiting takes the dot', () => {
    const { container } = render(
      <SessionCard
        {...baseProps}
        session={makeSession({ working: false, backgroundSubagentCount: 1, error: 'Something failed' })}
      />,
    )
    expect(statusDot(container)?.classList.contains('status-waiting')).toBe(true)
    openHoverCard(container)
    expect(document.querySelector('.hover-pop-status')?.textContent).toContain('background subagent')
    expect(document.querySelector('.hover-pop-error')?.textContent).toContain('Something failed')
  })

  it('explains the dormant state and its stale error in the hover card', () => {
    const { container } = render(
      <SessionCard
        {...baseProps}
        session={makeSession({ running: false, error: 'spawn failed' })}
      />,
    )
    expect(statusDot(container)?.classList.contains('status-dormant')).toBe(true)
    openHoverCard(container)
    const status = document.querySelector('.hover-pop-status')?.textContent ?? ''
    expect(status).toContain('Resume failed')
    expect(status).toContain('spawn failed')
    // The status text already carries the error, so no duplicate error line.
    expect(document.querySelector('.hover-pop-error')).toBeNull()
  })

  it('names unread alongside the state', () => {
    const { container } = render(<SessionCard {...baseProps} hasUnread />)
    expect(statusDot(container)?.getAttribute('aria-label')).toBe('Unread, Live')
  })

  it('says resuming while a resume is in flight', () => {
    const { container } = render(
      <SessionCard {...baseProps} session={makeSession({ running: false })} isResuming />,
    )
    expect(statusDot(container)?.getAttribute('aria-label')).toBe('Resuming…')
  })

  it('keeps the resuming wording in the hover card', () => {
    const { container } = render(
      <SessionCard {...baseProps} session={makeSession({ running: false })} isResuming />,
    )
    openHoverCard(container)
    const status = document.querySelector('.hover-pop-status')?.textContent ?? ''
    expect(status.startsWith('Resuming…')).toBe(true)
    expect(status).not.toContain('Dormant')
  })
})

describe('SessionCard interactions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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

  it('does not call onSelect while resuming', () => {
    const onSelect = vi.fn()
    const { container } = render(
      <SessionCard {...baseProps} isResuming onSelect={onSelect} />,
    )
    const card = container.querySelector('.session-item')!
    fireEvent.click(card)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('opens the context menu on right click', () => {
    const onContextMenu = vi.fn()
    const { container } = render(<SessionCard {...baseProps} onContextMenu={onContextMenu} />)
    fireEvent.contextMenu(container.querySelector('.session-item')!)
    expect(onContextMenu).toHaveBeenCalled()
  })

  it('applies dragging class when isDragging', () => {
    const { container } = render(<SessionCard {...baseProps} isDragging />)
    const card = container.querySelector('.session-item')
    expect(card?.classList.contains('dragging')).toBe(true)
  })
})

describe('SessionCard open slot and pending badge', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders the slot number when isOpen', () => {
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

  it('does not replay the slot entrance when the card mounts already open', () => {
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

  it('folds pending responses into the slot badge when open', () => {
    const { container } = render(
      <SessionCard
        {...baseProps}
        isOpen
        slotIdx={1}
        session={makeSession({ pendingPermissionCount: 3 })}
      />,
    )
    const slot = container.querySelector('.session-item-slot')
    expect(slot?.textContent).toBe('2')
    expect(slot?.classList.contains('pending')).toBe(true)
    expect(container.querySelector('.session-item-perm-badge')).toBeNull()
    expect(slot?.getAttribute('aria-label')).toContain('3 requests awaiting your response')
  })

  it('keeps the standalone count badge for a closed session with pending responses', () => {
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
})