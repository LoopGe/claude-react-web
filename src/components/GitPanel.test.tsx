// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { fireEvent, render, waitFor } from '@testing-library/react'
import { GitPanel } from './GitPanel'
import type { GitDiff, GitStatus } from '../../shared/git-types'

// ── hook mocks ──────────────────────────────────────────────────────
// useGitDiff is the one under test's control: a fetch that never settles
// keeps the row in the PENDING window, which is where the second-click
// semantics live. The others are inert.

const diffState: { data: GitDiff | null; loading: boolean; error: string | null } = {
  data: null,
  loading: true,
  error: null,
}

// Every useGitDiff call's `enabled` flag — the fetch latch (FileRow's
// `fetchStarted`) that arms the diff request on the first open attempt and
// must drop again when the row's collapse exit completes.
const enabledLog: boolean[] = []

vi.mock('../hooks/useGitStatus', () => ({
  useGitDiff: (_cwd: string | undefined, _path: string | undefined, _staged: boolean, enabled: boolean) => {
    enabledLog.push(enabled)
    return { ...diffState, refresh: () => {} }
  },
  useGitLog: () => ({ data: [], loading: false, error: null, refresh: () => {} }),
  useGitBranches: () => ({ data: [], loading: false, error: null, refresh: () => {} }),
  useGitStashes: () => ({ data: [], loading: false, error: null, refresh: () => {} }),
  // GitPanel's FullDiffViewer path calls the shared query builder.
  gitDiffQuery: (cwd: string, path: string, staged: boolean) =>
    `/git/diff?cwd=${cwd}&path=${path}&staged=${staged ? '1' : '0'}&full=1`,
}))

/** Distinct `enabled` values in order — the fetch latch's state machine,
 *  immune to extra renders that re-pass the same flag. */
function enabledTransitions(): boolean[] {
  return enabledLog.filter((v, i) => i === 0 || v !== enabledLog[i - 1])
}

vi.mock('../hooks/useGitWrite', () => ({
  useGitWrite: () => ({
    busyOps: new Set<string>(),
    stage: vi.fn(),
    unstage: vi.fn(),
    discard: vi.fn(),
    commit: vi.fn(),
    abortMerge: vi.fn(),
    abortRebase: vi.fn(),
    stashCreate: vi.fn(),
    stashPop: vi.fn(),
    stashDrop: vi.fn(),
    createBranch: vi.fn(),
    checkout: vi.fn(),
    generateCommitMessage: vi.fn(),
    pull: vi.fn(),
    push: vi.fn(),
  }),
}))

vi.mock('../hooks/useToast', () => ({
  useToast: () => ({ error: vi.fn(), success: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() }),
  apiErrorToastOpts: () => undefined,
}))

beforeEach(() => {
  // Overlay / FullDiffViewer / AnimatedCollapse read prefers-reduced-motion.
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  diffState.data = null
  diffState.loading = true
  diffState.error = null
  enabledLog.length = 0
})

afterEach(() => {
  // cleanup() is registered globally in src/test-setup.ts (CLAUDE.md:
  // don't re-add per-file afterEach(cleanup) — it re-opens the unmount
  // teardown race). Only unstub here.
  vi.unstubAllGlobals()
})

function makeStatus(): GitStatus {
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
    staged: [{ path: 'src/a.ts', status: 'M', staged: true, unstaged: false }],
    unstaged: [],
    untracked: [],
  }
}

function renderPanel() {
  return render(
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
}

function toggle(): HTMLElement {
  const el = document.querySelector<HTMLElement>('.git-file-row-toggle')
  if (!el) throw new Error('no file row toggle')
  return el
}

describe('GitPanel file-row expand', () => {
  it('a second click while the fetch is pending OPENS the row instead of cancelling', () => {
    // The bug: the row looks dead while waiting (chevron flips, nothing
    // appears), users click again, and that second click was treated as
    // "cancel" — the row never expanded. It must open immediately with the
    // loading placeholder instead.
    renderPanel()
    fireEvent.click(toggle()) // start the deferred open (fetch still pending)
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggle()) // impatient second click
    expect(toggle().getAttribute('aria-expanded')).toBe('true')
  })

  it('closes on the next click once open', () => {
    renderPanel()
    fireEvent.click(toggle())
    fireEvent.click(toggle()) // force-open
    // Pin the open state first: without this the close assertion passes
    // vacuously under the old cancel-on-second-click code.
    expect(toggle().getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(toggle()) // close
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
  })

  it('still defers the open until the fetch lands when clicked once', () => {
    const { rerender } = renderPanel()
    fireEvent.click(toggle())
    expect(toggle().getAttribute('aria-expanded')).toBe('false')

    // Fetch settles; the mock only reports it on the next render, so force
    // one through the parent — the deferred-open effect then fires without
    // another click.
    diffState.loading = false
    diffState.data = {
      path: 'src/a.ts',
      staged: true,
      truncated: false,
      totalLines: 2,
      text: '@@ -1 +1 @@\n-x\n+y\n',
      isBinary: false,
    }
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
    expect(toggle().getAttribute('aria-expanded')).toBe('true')
  })

  it('close drops the fetch latch so a later reopen re-fetches', async () => {
    // The latch (FileRow's fetchStarted / useGitDiff `enabled`) must reset
    // when the collapse exit completes — otherwise a reopen serves the
    // previously fetched diff and never re-reads the worktree.
    renderPanel()
    fireEvent.click(toggle()) // arm the fetch (deferred open starts)
    expect(enabledTransitions()).toEqual([false, true])
    fireEvent.click(toggle()) // impatient second click — force open
    fireEvent.click(toggle()) // close
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
    // Collapse exit → onFetchReset → the latch drops back to false.
    await waitFor(() => expect(enabledTransitions()).toEqual([false, true, false]))
    fireEvent.click(toggle()) // reopen re-arms the fetch
    expect(enabledTransitions()).toEqual([false, true, false, true])
  })
})
