import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { WorktreeIsolationBadge } from './WorktreeIsolationBadge'
import type { WorktreeInfo } from '../../shared/session-info'

// Cleanup is registered globally in src/test-setup.ts — do not re-add a
// per-file afterEach(cleanup) (CLAUDE.md).

const wt: WorktreeInfo = {
  mainRepoPath: '/home/user/main-repo',
  branch: 'crw/abc12345',
  baseSha: 'deadbeef',
}

describe('WorktreeIsolationBadge', () => {
  it('renders the worktree label with the full isolation metadata in its tooltip', () => {
    const { container } = render(<WorktreeIsolationBadge worktree={wt} />)
    const badge = container.querySelector('.chat-panel-worktree-badge')!
    expect(badge.textContent).toBe('worktree')
    // Tooltip bubble is always in the DOM (hidden via CSS until hover).
    const tooltip = container.querySelector('[role="tooltip"]')!
    expect(tooltip.textContent).toContain('Isolated worktree')
    expect(tooltip.textContent).toContain('Main repo: /home/user/main-repo')
    expect(tooltip.textContent).toContain('Branch: crw/abc12345')
  })
})
