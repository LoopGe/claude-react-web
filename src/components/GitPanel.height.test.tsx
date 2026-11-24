// @vitest-environment happy-dom
// Height-animation wiring for the Git panel scroller. The cap math is unit-tested
// in capped-height-measure.test.ts; here the measure is mocked to controlled
// heights so the wiring (observer + key paths, pin release, and the keyed scroll
// box surviving a route swap) is what's under test. Kept separate from
// GitPanel.test.tsx because the behavioral file pins useGitDiff's fetch latch,
// while this one only needs inert data hooks.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import { clearResizeObserverStub, fireResize, stubResizeObserver } from '../test/resize-observer-stub'
import { GitPanel } from './GitPanel'
import type { GitStatus } from '../../shared/git-types'

const { measureMock } = vi.hoisted(() => ({ measureMock: vi.fn() }))
vi.mock('../utils/capped-height-measure', () => ({ measureCappedContentHeight: measureMock }))

vi.mock('../resources/context', () => ({
  useOpenResource: () => vi.fn(),
  useOptionalOpenResource: () => null,
}))

vi.mock('../hooks/useGitStatus', () => ({
  useGitDiff: () => ({ data: null, loading: false, error: null, refresh: () => {} }),
  useGitLog: () => ({ data: [], loading: false, error: null, refresh: () => {} }),
  useGitBranches: () => ({ data: [], loading: false, error: null, refresh: () => {} }),
  useGitStashes: () => ({ data: [], loading: false, error: null, refresh: () => {} }),
  gitDiffQuery: () => '/git/diff',
}))

vi.mock('../hooks/useGitWrite', () => ({
  useGitWrite: () => ({
    busyOps: new Set<string>(),
    stage: vi.fn(), unstage: vi.fn(), discard: vi.fn(), commit: vi.fn(),
    abortMerge: vi.fn(), abortRebase: vi.fn(), stashCreate: vi.fn(), stashPop: vi.fn(),
    stashDrop: vi.fn(), createBranch: vi.fn(), checkout: vi.fn(),
    generateCommitMessage: vi.fn(), pull: vi.fn(), push: vi.fn(),
  }),
}))

vi.mock('../hooks/useToast', () => ({
  useToast: () => ({ error: vi.fn(), success: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() }),
  apiErrorToastOpts: () => undefined,
}))

beforeEach(() => {
  measureMock.mockReset()
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  stubResizeObserver()
  vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(0)
})

afterEach(() => {
  clearResizeObserverStub()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function makeStatus(files = true): GitStatus {
  return {
    isRepo: true,
    repoRoot: '/repo',
    branch: 'main',
    detached: false,
    ahead: 0,
    behind: 0,
    upstream: null,
    state: 'dirty',
    linkedWorktrees: [],
    staged: files ? [{ path: 'src/a.ts', status: 'M', staged: true, unstaged: false }] : [],
    unstaged: [],
    untracked: [],
  }
}

function renderPanel(props: Partial<React.ComponentProps<typeof GitPanel>> = {}) {
  return render(
    <GitPanel
      sessionId="s1"
      cwd="/repo"
      status={makeStatus()}
      loading={false}
      error={null}
      onRefresh={() => {}}
      onClose={() => {}}
      {...props}
    />,
  )
}

function scrollBox(): HTMLElement {
  const el = document.querySelector<HTMLElement>('.git-panel-scroll')
  if (!el) throw new Error('no .git-panel-scroll box')
  return el
}

function scrollContent(): HTMLElement {
  const el = document.querySelector<HTMLElement>('.git-panel-scroll-content')
  if (!el) throw new Error('no .git-panel-scroll-content wrapper')
  return el
}

describe('GitPanel height animation', () => {
  it('tweens the scroller height on a content-driven resize', () => {
    let height = 100
    measureMock.mockImplementation(() => height)
    renderPanel()
    const box = scrollBox()
    const content = scrollContent()
    height = 300
    fireResize(content)
    expect(box.classList.contains('auto-height-animating')).toBe(true)
    expect(box.style.height).toBe('100px')
  })

  it('releases the pin when the tween finishes', () => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { cb(0); return 0 })
    let height = 100
    measureMock.mockImplementation(() => height)
    renderPanel()
    const box = scrollBox()
    const content = scrollContent()
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

  it('keeps the same scroll DOM node across a loading→repo route swap', () => {
    measureMock.mockImplementation(() => 100)
    const { rerender } = renderPanel({ status: null })
    const before = scrollBox()
    rerender(
      <GitPanel
        sessionId="s1"
        cwd="/repo"
        status={makeStatus()}
        loading={false}
        error={null}
        onRefresh={() => {}}
        onClose={() => {}}
      />,
    )
    // The keyed box must be the SAME node (not a remount), or the hook's
    // ResizeObserver would be left watching a detached wrapper.
    expect(scrollBox()).toBe(before)
    expect(before.isConnected).toBe(true)
  })

  it('tweens via the key path on a loading→repo route swap', () => {
    let height = 80
    measureMock.mockImplementation(() => height)
    const { rerender } = renderPanel({ status: null })
    height = 400
    rerender(
      <GitPanel
        sessionId="s1"
        cwd="/repo"
        status={makeStatus()}
        loading={false}
        error={null}
        onRefresh={() => {}}
        onClose={() => {}}
      />,
    )
    const box = scrollBox()
    expect(box.classList.contains('auto-height-animating')).toBe(true)
    expect(box.style.height).toBe('80px')
  })

  it('tweens via the key path when the filter bar mounts', () => {
    let height = 200
    measureMock.mockImplementation(() => height)
    const { rerender } = renderPanel({ status: makeStatus(false) })
    expect(document.querySelector('.git-panel-filter-bar')).toBeNull()
    // A file lands: the filter bar mounts (chrome grows, ceiling shrinks) and
    // the key flips even though the section content height is unchanged.
    height = 150
    rerender(
      <GitPanel
        sessionId="s1"
        cwd="/repo"
        status={makeStatus(true)}
        loading={false}
        error={null}
        onRefresh={() => {}}
        onClose={() => {}}
      />,
    )
    expect(document.querySelector('.git-panel-filter-bar')).not.toBeNull()
    const box = scrollBox()
    expect(box.classList.contains('auto-height-animating')).toBe(true)
    expect(box.style.height).toBe('200px')
  })
})