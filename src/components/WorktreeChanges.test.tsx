// @vitest-environment happy-dom
// WorktreeChanges "Open diff preview" entry: each tab maps a row to the right
// diff basis (worktree / staged / range+mergeBase / range+tip).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fireEvent, render, screen, act } from '@testing-library/react'
import { WorktreeChanges } from './WorktreeChanges'
import { parseDiffResource } from '../../shared/resource-address'
import { clearResizeObserverStub, fireResize, stubResizeObserver } from '../test/resize-observer-stub'

const mockOpenResource = vi.hoisted(() => vi.fn())
vi.mock('../resources/context', () => ({
  useOpenResource: () => mockOpenResource,
  useOptionalOpenResource: () => null,
}))

// Height-animation wiring: measure mocked to controlled heights (cap math is
// unit-tested in capped-height-measure.test.ts). With no implementation it
// returns undefined → the hook stands down, so the diff-preview tests are
// unaffected.
const { measureMock } = vi.hoisted(() => ({ measureMock: vi.fn() }))
vi.mock('../utils/capped-height-measure', () => ({ measureCappedContentHeight: measureMock }))

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
  it('uses the shared HoverPopover lifecycle for the Refresh hint', () => {
    vi.useFakeTimers()
    try {
      renderPane()
      fireEvent.pointerEnter(screen.getByRole('button', { name: 'Refresh' }))
      act(() => vi.advanceTimersByTime(200))
      expect(document.querySelector('.hover-pop')?.textContent).toBe('Refresh')
    } finally {
      vi.useRealTimers()
    }
  })

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

describe('WorktreeChanges height animation', () => {
  beforeEach(() => {
    measureMock.mockReset()
    stubResizeObserver()
    vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(0)
  })

  afterEach(() => {
    clearResizeObserverStub()
    vi.restoreAllMocks()
  })

  it('tweens the tab body height on a content-driven resize', () => {
    let height = 100
    measureMock.mockImplementation(() => height)
    renderPane()
    const box = document.querySelector<HTMLElement>('.git-panel-scroll')!
    const content = document.querySelector<HTMLElement>('.git-panel-scroll-content')!
    height = 300
    fireResize(content)
    expect(box.classList.contains('auto-height-animating')).toBe(true)
    expect(box.style.height).toBe('100px')
  })

  it('releases the pin when the tween finishes', () => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { cb(0); return 0 })
    let height = 100
    measureMock.mockImplementation(() => height)
    renderPane()
    const box = document.querySelector<HTMLElement>('.git-panel-scroll')!
    const content = document.querySelector<HTMLElement>('.git-panel-scroll-content')!
    height = 300
    fireResize(content)
    expect(box.style.height).toBe('300px')
    act(() => {
      const evt = new Event('transitionend', { bubbles: true })
      Object.defineProperty(evt, 'propertyName', { value: 'height' })
      box.dispatchEvent(evt)
    })
    expect(box.classList.contains('auto-height-animating')).toBe(false)
    expect(box.style.height).toBe('')
  })
})