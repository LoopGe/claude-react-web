import { describe, it, expect, vi } from 'vitest'
import { act, fireEvent, render } from '@testing-library/react'
import { ChatPanelGitChip } from './ChatPanelGitChip'
import { ChatPanelWorktreeChip } from './ChatPanelWorktreeChip'
import type { GitLinkedWorktree, GitStatus } from '../../shared/git-types'

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

const status: GitStatus = {
  isRepo: true,
  repoRoot: '/home/user/project',
  branch: 'main',
  detached: false,
  ahead: 1,
  behind: 2,
  upstream: 'origin/main',
  state: 'dirty',
  linkedWorktrees: [],
  staged: [{ path: 'a.ts', status: 'M', staged: true, unstaged: false, insertions: 1, deletions: 0 }],
  unstaged: [{ path: 'b.ts', status: 'M', staged: false, unstaged: true, insertions: 2, deletions: 1 }],
  untracked: [{ path: 'c.ts', status: '?', staged: false, unstaged: true }],
}

const worktree: GitLinkedWorktree = {
  path: '/repo/.claude/worktrees/x',
  branch: 'worktree-x',
  locked: false,
  lockMessage: null,
}

function hover(trigger: HTMLElement): void {
  vi.useFakeTimers()
  try {
    fireEvent.pointerEnter(trigger)
    act(() => {
      vi.advanceTimersByTime(200)
    })
  } finally {
    vi.useRealTimers()
  }
}

describe('ChatPanelGitChip', () => {
  it('renders the compact chip and shows the full breakdown on hover', () => {
    const onOpen = vi.fn()
    const { container } = render(<ChatPanelGitChip status={status} onOpen={onOpen} />)
    const chip = container.querySelector('.chat-panel-git-badge') as HTMLElement
    expect(chip.textContent).toBe('main ↑1 ↓2 ●2 ?1')
    expect(chip.getAttribute('title')).toBeNull()

    hover(chip)
    const pop = document.querySelector('.hover-pop')!
    expect(pop.getAttribute('role')).toBe('tooltip')
    expect(pop.textContent).toContain('Branch: main')
    expect(pop.textContent).toContain('Upstream: origin/main')
    expect(pop.textContent).toContain('Sync: 1 ahead, 2 behind')
    expect(pop.textContent).toContain('State: dirty')

    fireEvent.click(chip)
    expect(onOpen).toHaveBeenCalledTimes(1)
  })
})

describe('ChatPanelWorktreeChip', () => {
  it('shows the worktree path and branch on hover', () => {
    const onOpen = vi.fn()
    const { container } = render(
      <ChatPanelWorktreeChip name="x" match={worktree} onOpen={onOpen} />,
    )
    const chip = container.querySelector('.chat-panel-worktree-badge') as HTMLElement
    expect(chip.textContent).toBe('x')
    expect(chip.getAttribute('title')).toBeNull()

    hover(chip)
    const pop = document.querySelector('.hover-pop')!
    expect(pop.textContent).toContain('Agent isolated in worktree')
    expect(pop.textContent).toContain('Worktree: /repo/.claude/worktrees/x')
    expect(pop.textContent).toContain('Branch: worktree-x')

    fireEvent.click(chip)
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('explains an unconfirmed worktree', () => {
    const { container } = render(
      <ChatPanelWorktreeChip name="x" match={null} onOpen={vi.fn()} />,
    )
    const chip = container.querySelector('.chat-panel-worktree-badge') as HTMLElement
    expect(chip.classList.contains('unconfirmed')).toBe(true)
    hover(chip)
    expect(document.querySelector('.hover-pop')?.textContent).toContain('Git worktree not yet confirmed')
  })
})