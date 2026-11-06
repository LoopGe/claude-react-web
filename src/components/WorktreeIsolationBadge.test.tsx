import { describe, it, expect, vi } from 'vitest'
import { act, fireEvent, render } from '@testing-library/react'
import { WorktreeIsolationBadge } from './WorktreeIsolationBadge'
import type { WorktreeInfo } from '../../shared/session-info'

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

// Cleanup is registered globally in src/test-setup.ts — do not re-add a
// per-file afterEach(cleanup) (CLAUDE.md).

const wt: WorktreeInfo = {
  mainRepoPath: '/home/user/main-repo',
  branch: 'crw/abc12345',
  baseSha: 'deadbeef',
}

describe('WorktreeIsolationBadge', () => {
  it('renders the worktree label and shows the isolation metadata on hover', () => {
    vi.useFakeTimers()
    try {
      const { container } = render(<WorktreeIsolationBadge worktree={wt} />)
      const badge = container.querySelector('.chat-panel-worktree-badge')!
      expect(badge.textContent).toBe('worktree')
      fireEvent.pointerEnter(badge)
      act(() => {
        vi.advanceTimersByTime(200)
      })
      const pop = document.querySelector('.hover-pop')!
      expect(pop.getAttribute('role')).toBe('tooltip')
      expect(pop.textContent).toContain('Isolated worktree')
      expect(pop.textContent).toContain('Main repo: /home/user/main-repo')
      expect(pop.textContent).toContain('Branch: crw/abc12345')
    } finally {
      vi.useRealTimers()
    }
  })
})