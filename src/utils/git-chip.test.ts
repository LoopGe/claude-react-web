import { describe, it, expect } from 'vitest'
import { gitChipText } from './git-chip'
import type { GitFileEntry, GitStatus } from '../../shared/git-types'

function makeStatus(overrides: Partial<GitStatus> = {}): GitStatus {
  return {
    isRepo: true,
    branch: 'main',
    detached: false,
    ahead: 0,
    behind: 0,
    upstream: null,
    state: 'clean',
    staged: [],
    unstaged: [],
    untracked: [],
    ...overrides,
  }
}

function file(status: GitFileEntry['status'], staged: boolean, unstaged: boolean): GitFileEntry {
  return { path: 'a.ts', status, staged, unstaged }
}

describe('gitChipText', () => {
  it('shows only the branch name for a clean repo', () => {
    expect(gitChipText(makeStatus())).toBe('main')
  })

  it('compacts ahead count to ↑N', () => {
    expect(gitChipText(makeStatus({ ahead: 1 }))).toBe('main ↑1')
  })

  it('compacts behind count to ↓N', () => {
    expect(gitChipText(makeStatus({ behind: 2 }))).toBe('main ↓2')
  })

  it('compacts dirty count to ●N (staged + unstaged)', () => {
    const staged = file('M', true, false)
    const unstaged = file('M', false, true)
    expect(gitChipText(makeStatus({ staged: [staged], unstaged: [unstaged] }))).toBe('main ●2')
  })

  it('compacts untracked count to ?N', () => {
    const untracked = file('?', false, false)
    expect(gitChipText(makeStatus({ untracked: [untracked] }))).toBe('main ?1')
  })

  it('keeps a stable order for a full combination', () => {
    const changed = file('M', false, true)
    const untracked = file('?', false, false)
    const s = makeStatus({ ahead: 2, behind: 1, unstaged: [changed], untracked: [untracked] })
    expect(gitChipText(s)).toBe('main ↑2 ↓1 ●1 ?1')
  })

  it('shows "detached" for a detached HEAD', () => {
    expect(gitChipText(makeStatus({ detached: true, branch: null }))).toBe('detached')
  })

  it('falls back to "?" when the branch name is unknown', () => {
    expect(gitChipText(makeStatus({ branch: null }))).toBe('?')
  })
})
