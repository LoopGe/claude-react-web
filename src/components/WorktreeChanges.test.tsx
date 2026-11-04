// @vitest-environment happy-dom
// WorktreeChanges "Open diff preview" entry: each tab maps a row to the right
// diff basis (worktree / staged / range+mergeBase / range+tip).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { WorktreeChanges } from './WorktreeChanges'
import { parseDiffResource } from '../../shared/resource-address'

const mockOpenResource = vi.hoisted(() => vi.fn())
vi.mock('../resources/context', () => ({
  useOpenResource: () => mockOpenResource,
  useOptionalOpenResource: () => null,
}))

const statusState = {
  data: {
    isRepo: true,
    repoRoot: '/repo',
    branch: 'feat',
    detached: false,
    ahead: 0,
    behind: 0,
    upstream: null,
    state: 'dirty',
    linkedWorktrees: [],
    staged: [{ path: 'src/a.ts', status: 'M', staged: true, unstaged: false }],
    unstaged: [{ path: 'src/b.ts', status: 'M', staged: false, unstaged: true }],
    untracked: [],
  },
  loading: false,
  error: null,
  refresh: () => {},
}

const rangeState = {
  data: {
    from: 'main',
    to: 'feat',
    files: [{ path: 'src/a.ts', status: 'M', insertions: 1, deletions: 1 }],
  },
  loading: false,
  error: null,
  refresh: () => {},
}

vi.mock('../hooks/useGitStatus', () => ({
  useGitStatus: () => statusState,
  useGitDiff: () => ({ data: null, loading: true, error: null, refresh: () => {} }),
  useGitRangeDiff: () => rangeState,
  useGitRangeDiffFile: () => ({ data: null, loading: true, error: null, refresh: () => {} }),
  gitDiffQuery: () => '/git/diff',
  gitRangeDiffFileQuery: () => '/git/diff-range-file',
}))

function renderPane() {
  return render(
    <WorktreeChanges
      sessionId="s1"
      cwd="/repo"
      branchName="feat"
      baseRef="main"
      displayName="worktree"
      onClose={() => {}}
    />,
  )
}

function openRowAndDiff(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Toggle diff for src/a.ts' }))
  fireEvent.click(screen.getByRole('button', { name: /open diff preview/i }))
}

beforeEach(() => {
  mockOpenResource.mockClear()
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('WorktreeChanges diff preview entry', () => {
  it('maps an uncommitted staged row to the staged basis', () => {
    renderPane()
    openRowAndDiff()
    expect(parseDiffResource(mockOpenResource.mock.calls[0][1])).toEqual({
      sessionId: 's1',
      cwd: '/repo',
      path: 'src/a.ts',
      basis: { type: 'staged' },
    })
  })

  it('maps an uncommitted unstaged row to the worktree basis', () => {
    renderPane()
    fireEvent.click(screen.getByRole('button', { name: 'Toggle diff for src/b.ts' }))
    fireEvent.click(screen.getByRole('button', { name: /open diff preview/i }))
    expect(parseDiffResource(mockOpenResource.mock.calls[0][1])).toEqual({
      sessionId: 's1',
      cwd: '/repo',
      path: 'src/b.ts',
      basis: { type: 'worktree' },
    })
  })

  it('maps the branch tab to a merge-base range', () => {
    renderPane()
    fireEvent.click(screen.getByRole('tab', { name: 'Branch' }))
    openRowAndDiff()
    expect(parseDiffResource(mockOpenResource.mock.calls[0][1])).toEqual({
      sessionId: 's1',
      cwd: '/repo',
      path: 'src/a.ts',
      basis: { type: 'range', from: 'main', to: 'feat', mergeBase: true },
    })
  })

  it('maps the vs-base tab to a tip range', () => {
    renderPane()
    fireEvent.click(screen.getByRole('tab', { name: 'vs base' }))
    openRowAndDiff()
    expect(parseDiffResource(mockOpenResource.mock.calls[0][1])).toEqual({
      sessionId: 's1',
      cwd: '/repo',
      path: 'src/a.ts',
      basis: { type: 'range', from: 'main', to: 'feat', mergeBase: false },
    })
  })
})