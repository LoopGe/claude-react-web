import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import type { WsGitSnapshot } from '../../shared/ws-protocol.js'
import type {
  GitDiff,
  GitCommit,
  GitCommitResponse,
  GitRangeDiffResponse,
  GitStatus,
  GitStatusResponse,
} from '../../shared/git-types.js'

const mockGet = vi.fn()
vi.mock('./useApi', () => ({
  api: { get: (...args: unknown[]) => mockGet(...args), post: vi.fn() },
}))

// WS hub mock: capture the session listener so tests can emit frames.
let sessionListener: ((frame: unknown) => void) | null = null
const subscribe = vi.fn(() => () => {})
vi.mock('./useWsHub', () => ({
  useWsHub: () => ({
    subscribe,
    addSessionListener: (_id: string, fn: (frame: unknown) => void) => {
      sessionListener = fn
      return () => { sessionListener = null }
    },
  }),
}))

import {
  useGitStatus,
  useGitBranches,
  useGitStashes,
  useGitDiff,
  useGitRangeDiff,
  useGitRangeDiffFile,
  useGitLog,
  useGitCommitFiles,
  useGitCommitDiffFile,
  useCachedCommitFiles,
  gitDiffQuery,
  gitRangeDiffFileQuery,
  gitCommitDiffFileQuery,
} from './useGitStatus'

function makeStatus(repoRoot = '/repo'): GitStatusResponse {
  return {
    isRepo: true, repoRoot, branch: 'main', detached: false, ahead: 0, behind: 0,
    upstream: null, state: 'clean', linkedWorktrees: [], staged: [], unstaged: [], untracked: [],
  }
}

function makeFrame(repoRoot = '/repo', cwd = '/repo'): WsGitSnapshot {
  return {
    kind: 'git-snapshot', sessionId: 's1', cwd, repoRoot,
    status: makeStatus(repoRoot), branches: [{ name: 'main', current: true, upstream: null }], stashes: [],
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  sessionListener = null
  mockGet.mockResolvedValue(makeStatus())
})
afterEach(() => vi.restoreAllMocks())

describe('useGitStatus', () => {
  it('fetches once on mount, then applies git-snapshot frames with zero refetch', async () => {
    const { result } = renderHook(() => useGitStatus('/repo', 's1'))
    await waitFor(() => expect(result.current.data?.isRepo).toBe(true))
    expect(mockGet).toHaveBeenCalledTimes(1)
    expect(mockGet).toHaveBeenCalledWith('/git/status?cwd=%2Frepo', expect.anything())

    const next = makeFrame()
    ;(next.status as { branch: string }).branch = 'dev'
    act(() => { sessionListener?.(next) })
    await waitFor(() => expect((result.current.data as GitStatus).branch).toBe('dev'))
    expect(mockGet).toHaveBeenCalledTimes(1) // zero refetch
  })

  it('drops frames whose repoRoot mismatches once repo data is authoritative', async () => {
    const { result } = renderHook(() => useGitStatus('/repo', 's1'))
    await waitFor(() => expect(result.current.data?.isRepo).toBe(true))
    act(() => { sessionListener?.(makeFrame('/elsewhere')) })
    await new Promise((r) => setTimeout(r, 10))
    expect((result.current.data as GitStatus).repoRoot).toBe('/repo') // not overwritten
  })

  it('pre-first-fetch: applies only when frame cwd or repoRoot matches', async () => {
    let resolveGet: (v: GitStatusResponse) => void = () => {}
    mockGet.mockReturnValue(new Promise((r) => { resolveGet = r }))
    const { result } = renderHook(() => useGitStatus('/repo', 's1'))
    // Frame arrives before mount fetch completes: cwd mismatch -> dropped
    act(() => { sessionListener?.(makeFrame('/other', '/other')) })
    await new Promise((r) => setTimeout(r, 10))
    expect(result.current.data).toBeNull()
    // Matching frame -> applied
    act(() => { sessionListener?.(makeFrame('/repo', '/repo')) })
    await waitFor(() => expect(result.current.data?.isRepo).toBe(true))
    resolveGet(makeStatus())
  })

  it('manual refresh still hits HTTP', async () => {
    const { result } = renderHook(() => useGitStatus('/repo', 's1'))
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(1))
    act(() => { result.current.refresh() })
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(2))
  })

  it('does nothing without cwd or when disabled', async () => {
    renderHook(() => useGitStatus(undefined, 's1'))
    renderHook(() => useGitStatus('/repo', 's1', { enabled: false }))
    await new Promise((r) => setTimeout(r, 10))
    expect(mockGet).not.toHaveBeenCalled()
  })
})

describe('useGitBranches / useGitStashes', () => {
  it('branches: fetches via cwd route on enable, applies frames without guard', async () => {
    mockGet.mockResolvedValueOnce({ branches: [] })
    const { result } = renderHook(() => useGitBranches('/repo', 's1', true))
    await waitFor(() => expect(result.current.data).toEqual([]))
    expect(mockGet).toHaveBeenCalledWith('/git/branches?cwd=%2Frepo', expect.anything())
    act(() => { sessionListener?.(makeFrame('/elsewhere')) }) // no guard: direct replace
    await waitFor(() => expect(result.current.data).toHaveLength(1))
  })

  it('stashes: fetches via cwd route on enable', async () => {
    mockGet.mockResolvedValueOnce({ stashes: [] })
    const { result } = renderHook(() => useGitStashes('/repo', 's1', true))
    await waitFor(() => expect(result.current.data).toEqual([]))
    expect(mockGet).toHaveBeenCalledWith('/git/stashes?cwd=%2Frepo', expect.anything())
  })

  it('branches: disabled -> no fetch', async () => {
    renderHook(() => useGitBranches('/repo', 's1', false))
    await new Promise((r) => setTimeout(r, 10))
    expect(mockGet).not.toHaveBeenCalled()
  })
})

// ── Pure HTTP adapters: diff, range-diff, range-diff-file, log ───────
//
// These four have no WS channel; callers invoke refresh() imperatively
// (e.g. accordion expand). The disabled / missing-input contract is
// unified: data=null, error=null, loading=false — including when the
// switch happens mid-flight. useGitDiff and useGitLog's old disabled
// path omitted setLoading(false), so their mid-flight tests FAIL on the
// old implementation — the intended TDD trigger for the core migration.

describe('useGitDiff', () => {
  const diffPayload: GitDiff = {
    path: 'src/x.ts', staged: false, truncated: false, totalLines: 2,
    text: '@@ -1 +1 @@\n-x\n+y\n', isBinary: false,
  }

  it('fetches /git/diff with cwd/path/staged=0', async () => {
    mockGet.mockResolvedValue(diffPayload)
    const { result } = renderHook(() => useGitDiff('/repo', 'src/x.ts', false, true))
    await waitFor(() => expect(result.current.data).toEqual(diffPayload))
    expect(mockGet).toHaveBeenCalledWith(
      '/git/diff?cwd=%2Frepo&path=src%2Fx.ts&staged=0', expect.anything(),
    )
  })

  it('staged=true sends staged=1', async () => {
    mockGet.mockResolvedValue({ ...diffPayload, staged: true })
    renderHook(() => useGitDiff('/repo', 'src/x.ts', true, true))
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith(
      '/git/diff?cwd=%2Frepo&path=src%2Fx.ts&staged=1', expect.anything(),
    ))
  })

  it('disabled from start: no fetch, {data:null, loading:false, error:null}', () => {
    const { result } = renderHook(() => useGitDiff('/repo', 'src/x.ts', false, false))
    expect(result.current.data).toBeNull()
    expect(result.current.loading).toBe(false)
    expect(result.current.error).toBeNull()
    expect(mockGet).not.toHaveBeenCalled()
  })

  it('disabled mid-flight: loading clears and late response is a no-op', async () => {
    // Catches the lingering-loading bug: the old disabled path did NOT
    // call setLoading(false), so loading stayed true after a mid-flight
    // disable. The unified contract requires loading=false.
    let resolveGet!: (v: GitDiff) => void
    mockGet.mockReturnValue(new Promise<GitDiff>((r) => { resolveGet = r }))
    const { result, rerender } = renderHook(
      ({ e }) => useGitDiff('/repo', 'src/x.ts', false, e),
      { initialProps: { e: true } },
    )
    await waitFor(() => expect(result.current.loading).toBe(true))
    rerender({ e: false })
    expect(result.current.data).toBeNull()
    expect(result.current.loading).toBe(false)
    expect(result.current.error).toBeNull()
    await act(async () => { resolveGet(diffPayload); await Promise.resolve() })
    expect(result.current.data).toBeNull()
    expect(result.current.loading).toBe(false)
  })

  it('path change retains old data while the new path loads', async () => {
    mockGet.mockResolvedValue(diffPayload)
    const { result, rerender } = renderHook(
      ({ p }) => useGitDiff('/repo', p, false, true),
      { initialProps: { p: 'src/x.ts' } },
    )
    await waitFor(() => expect(result.current.data).toEqual(diffPayload))
    const diffB = { ...diffPayload, path: 'src/y.ts', text: '@@ -1 +1 @@\n-a\n+b\n' }
    mockGet.mockResolvedValue(diffB)
    rerender({ p: 'src/y.ts' })
    expect(result.current.data).toEqual(diffPayload)
    expect(mockGet).toHaveBeenCalledTimes(2)
    await waitFor(() => expect(result.current.data).toEqual(diffB))
  })

  it('refresh retains old data and bumps request count', async () => {
    mockGet.mockResolvedValue(diffPayload)
    const { result } = renderHook(() => useGitDiff('/repo', 'src/x.ts', false, true))
    await waitFor(() => expect(result.current.data).toEqual(diffPayload))
    act(() => result.current.refresh())
    expect(result.current.data).toEqual(diffPayload)
    expect(mockGet).toHaveBeenCalledTimes(2)
  })

  it('failure sets error, clears data and loading', async () => {
    mockGet.mockRejectedValue(new Error('diff boom'))
    const { result } = renderHook(() => useGitDiff('/repo', 'src/x.ts', false, true))
    await waitFor(() => expect(result.current.error).toBe('diff boom'))
    expect(result.current.data).toBeNull()
    expect(result.current.loading).toBe(false)
  })

  it('does not expose applyExternal', () => {
    const { result } = renderHook(() => useGitDiff('/repo', 'src/x.ts', false, false))
    expect('applyExternal' in result.current).toBe(false)
  })
})

describe('useGitRangeDiff', () => {
  const rangePayload: GitRangeDiffResponse = {
    from: 'main', to: 'feature', files: [],
  }

  it('fetches /git/diff-range with cwd/from/to', async () => {
    mockGet.mockResolvedValue(rangePayload)
    const { result } = renderHook(() => useGitRangeDiff('/repo', 'main', 'feature', false, true))
    await waitFor(() => expect(result.current.data).toEqual(rangePayload))
    expect(mockGet).toHaveBeenCalledWith(
      '/git/diff-range?cwd=%2Frepo&from=main&to=feature', expect.anything(),
    )
  })

  it('mergeBase=true adds mode=mergeBase', async () => {
    mockGet.mockResolvedValue(rangePayload)
    renderHook(() => useGitRangeDiff('/repo', 'main', 'feature', true, true))
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith(
      '/git/diff-range?cwd=%2Frepo&from=main&to=feature&mode=mergeBase', expect.anything(),
    ))
  })

  it('disabled from start: no fetch, all null/false', () => {
    const { result } = renderHook(() => useGitRangeDiff('/repo', 'main', 'feature', false, false))
    expect(result.current.data).toBeNull()
    expect(result.current.loading).toBe(false)
    expect(result.current.error).toBeNull()
    expect(mockGet).not.toHaveBeenCalled()
  })

  it('disabled mid-flight: loading clears and late response is a no-op', async () => {
    let resolveGet!: (v: GitRangeDiffResponse) => void
    mockGet.mockReturnValue(new Promise<GitRangeDiffResponse>((r) => { resolveGet = r }))
    const { result, rerender } = renderHook(
      ({ e }) => useGitRangeDiff('/repo', 'main', 'feature', false, e),
      { initialProps: { e: true } },
    )
    await waitFor(() => expect(result.current.loading).toBe(true))
    rerender({ e: false })
    expect(result.current.data).toBeNull()
    expect(result.current.loading).toBe(false)
    expect(result.current.error).toBeNull()
    await act(async () => { resolveGet(rangePayload); await Promise.resolve() })
    expect(result.current.data).toBeNull()
  })

  it('from/to change retains old data while the new range loads', async () => {
    mockGet.mockResolvedValue(rangePayload)
    const { result, rerender } = renderHook(
      ({ f }) => useGitRangeDiff('/repo', f, 'feature', false, true),
      { initialProps: { f: 'main' } },
    )
    await waitFor(() => expect(result.current.data).toEqual(rangePayload))
    const rangeB = { ...rangePayload, from: 'dev' }
    mockGet.mockResolvedValue(rangeB)
    rerender({ f: 'dev' })
    expect(result.current.data).toEqual(rangePayload)
    expect(mockGet).toHaveBeenCalledTimes(2)
    await waitFor(() => expect(result.current.data).toEqual(rangeB))
  })

  it('refresh retains old data and bumps request count', async () => {
    mockGet.mockResolvedValue(rangePayload)
    const { result } = renderHook(() => useGitRangeDiff('/repo', 'main', 'feature', false, true))
    await waitFor(() => expect(result.current.data).toEqual(rangePayload))
    act(() => result.current.refresh())
    expect(result.current.data).toEqual(rangePayload)
    expect(mockGet).toHaveBeenCalledTimes(2)
  })

  it('failure sets error, clears data and loading', async () => {
    mockGet.mockRejectedValue(new Error('range boom'))
    const { result } = renderHook(() => useGitRangeDiff('/repo', 'main', 'feature', false, true))
    await waitFor(() => expect(result.current.error).toBe('range boom'))
    expect(result.current.data).toBeNull()
    expect(result.current.loading).toBe(false)
  })

  it('does not expose applyExternal', () => {
    const { result } = renderHook(() => useGitRangeDiff('/repo', 'main', 'feature', false, false))
    expect('applyExternal' in result.current).toBe(false)
  })
})

describe('useGitRangeDiffFile', () => {
  const diffPayload: GitDiff = {
    path: 'src/x.ts', staged: false, truncated: false, totalLines: 2,
    text: '@@ -1 +1 @@\n-x\n+y\n', isBinary: false,
  }

  it('fetches /git/diff-range-file with cwd/from/to/path', async () => {
    mockGet.mockResolvedValue(diffPayload)
    const { result } = renderHook(() =>
      useGitRangeDiffFile('/repo', 'main', 'feature', false, 'src/x.ts', true),
    )
    await waitFor(() => expect(result.current.data).toEqual(diffPayload))
    expect(mockGet).toHaveBeenCalledWith(
      '/git/diff-range-file?cwd=%2Frepo&from=main&to=feature&path=src%2Fx.ts', expect.anything(),
    )
  })

  it('mergeBase=true adds mode=mergeBase', async () => {
    mockGet.mockResolvedValue(diffPayload)
    renderHook(() => useGitRangeDiffFile('/repo', 'main', 'feature', true, 'src/x.ts', true))
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith(
      '/git/diff-range-file?cwd=%2Frepo&from=main&to=feature&path=src%2Fx.ts&mode=mergeBase',
      expect.anything(),
    ))
  })

  it('disabled from start: no fetch, all null/false', () => {
    const { result } = renderHook(() =>
      useGitRangeDiffFile('/repo', 'main', 'feature', false, 'src/x.ts', false),
    )
    expect(result.current.data).toBeNull()
    expect(result.current.loading).toBe(false)
    expect(result.current.error).toBeNull()
    expect(mockGet).not.toHaveBeenCalled()
  })

  it('disabled mid-flight: loading clears and late response is a no-op', async () => {
    let resolveGet!: (v: GitDiff) => void
    mockGet.mockReturnValue(new Promise<GitDiff>((r) => { resolveGet = r }))
    const { result, rerender } = renderHook(
      ({ e }) => useGitRangeDiffFile('/repo', 'main', 'feature', false, 'src/x.ts', e),
      { initialProps: { e: true } },
    )
    await waitFor(() => expect(result.current.loading).toBe(true))
    rerender({ e: false })
    expect(result.current.data).toBeNull()
    expect(result.current.loading).toBe(false)
    expect(result.current.error).toBeNull()
    await act(async () => { resolveGet(diffPayload); await Promise.resolve() })
    expect(result.current.data).toBeNull()
  })

  it('path change retains old data while the new file loads', async () => {
    mockGet.mockResolvedValue(diffPayload)
    const { result, rerender } = renderHook(
      ({ p }) => useGitRangeDiffFile('/repo', 'main', 'feature', false, p, true),
      { initialProps: { p: 'src/x.ts' } },
    )
    await waitFor(() => expect(result.current.data).toEqual(diffPayload))
    const diffB = { ...diffPayload, path: 'src/y.ts', text: '@@ -1 +1 @@\n-a\n+b\n' }
    mockGet.mockResolvedValue(diffB)
    rerender({ p: 'src/y.ts' })
    expect(result.current.data).toEqual(diffPayload)
    expect(mockGet).toHaveBeenCalledTimes(2)
    await waitFor(() => expect(result.current.data).toEqual(diffB))
  })

  it('refresh retains old data and bumps request count', async () => {
    mockGet.mockResolvedValue(diffPayload)
    const { result } = renderHook(() =>
      useGitRangeDiffFile('/repo', 'main', 'feature', false, 'src/x.ts', true),
    )
    await waitFor(() => expect(result.current.data).toEqual(diffPayload))
    act(() => result.current.refresh())
    expect(result.current.data).toEqual(diffPayload)
    expect(mockGet).toHaveBeenCalledTimes(2)
  })

  it('failure sets error, clears data and loading', async () => {
    mockGet.mockRejectedValue(new Error('range-file boom'))
    const { result } = renderHook(() =>
      useGitRangeDiffFile('/repo', 'main', 'feature', false, 'src/x.ts', true),
    )
    await waitFor(() => expect(result.current.error).toBe('range-file boom'))
    expect(result.current.data).toBeNull()
    expect(result.current.loading).toBe(false)
  })

  it('does not expose applyExternal', () => {
    const { result } = renderHook(() =>
      useGitRangeDiffFile('/repo', 'main', 'feature', false, 'src/x.ts', false),
    )
    expect('applyExternal' in result.current).toBe(false)
  })
})

describe('useGitLog', () => {
  const commitsPayload: GitCommit[] = [
    { hash: 'a'.repeat(40), shortHash: 'aaaaaaa', author: 'T', date: 1, subject: 'first' },
  ]

  it('fetches /git/log with cwd/limit and unwraps res.commits', async () => {
    mockGet.mockResolvedValue({ commits: commitsPayload })
    const { result } = renderHook(() => useGitLog('/repo', 10, true))
    await waitFor(() => expect(result.current.data).toEqual(commitsPayload))
    expect(mockGet).toHaveBeenCalledWith(
      '/git/log?cwd=%2Frepo&limit=10', expect.anything(),
    )
  })

  it('disabled from start: no fetch, all null/false', () => {
    const { result } = renderHook(() => useGitLog('/repo', 10, false))
    expect(result.current.data).toBeNull()
    expect(result.current.loading).toBe(false)
    expect(result.current.error).toBeNull()
    expect(mockGet).not.toHaveBeenCalled()
  })

  it('disabled mid-flight: loading clears and late response is a no-op', async () => {
    // Catches the lingering-loading bug: the old disabled path did NOT
    // call setLoading(false), so loading stayed true after a mid-flight
    // disable.
    let resolveGet!: (v: { commits: GitCommit[] }) => void
    mockGet.mockReturnValue(new Promise<{ commits: GitCommit[] }>((r) => { resolveGet = r }))
    const { result, rerender } = renderHook(
      ({ e }) => useGitLog('/repo', 10, e),
      { initialProps: { e: true } },
    )
    await waitFor(() => expect(result.current.loading).toBe(true))
    rerender({ e: false })
    expect(result.current.data).toBeNull()
    expect(result.current.loading).toBe(false)
    expect(result.current.error).toBeNull()
    await act(async () => { resolveGet({ commits: commitsPayload }); await Promise.resolve() })
    expect(result.current.data).toBeNull()
    expect(result.current.loading).toBe(false)
  })

  it('limit change retains old data while the new limit loads', async () => {
    mockGet.mockResolvedValue({ commits: commitsPayload })
    const { result, rerender } = renderHook(
      ({ n }) => useGitLog('/repo', n, true),
      { initialProps: { n: 10 } },
    )
    await waitFor(() => expect(result.current.data).toEqual(commitsPayload))
    const commitsB = [
      ...commitsPayload,
      { hash: 'b'.repeat(40), shortHash: 'bbbbbbb', author: 'T', date: 2, subject: 'second' },
    ]
    mockGet.mockResolvedValue({ commits: commitsB })
    rerender({ n: 20 })
    expect(result.current.data).toEqual(commitsPayload)
    expect(mockGet).toHaveBeenCalledTimes(2)
    await waitFor(() => expect(result.current.data).toEqual(commitsB))
  })

  it('refresh retains old data and bumps request count', async () => {
    mockGet.mockResolvedValue({ commits: commitsPayload })
    const { result } = renderHook(() => useGitLog('/repo', 10, true))
    await waitFor(() => expect(result.current.data).toEqual(commitsPayload))
    act(() => result.current.refresh())
    expect(result.current.data).toEqual(commitsPayload)
    expect(mockGet).toHaveBeenCalledTimes(2)
  })

  it('failure sets error, clears data and loading', async () => {
    mockGet.mockRejectedValue(new Error('log boom'))
    const { result } = renderHook(() => useGitLog('/repo', 10, true))
    await waitFor(() => expect(result.current.error).toBe('log boom'))
    expect(result.current.data).toBeNull()
    expect(result.current.loading).toBe(false)
  })

  it('does not expose applyExternal', () => {
    const { result } = renderHook(() => useGitLog('/repo', 10, false))
    expect('applyExternal' in result.current).toBe(false)
  })
})

describe('useGitCommitFiles', () => {
  it('fetches when enabled, resets when disabled', async () => {
    const payload = { commit: { hash: 'a'.repeat(40), shortHash: 'aaaaaaa', author: 'T', date: 1, subject: 's', body: '' }, files: [] }
    mockGet.mockResolvedValue(payload)
    const { result, rerender } = renderHook(({ e }) => useGitCommitFiles('/repo', 'a'.repeat(40), e), { initialProps: { e: true } })
    await waitFor(() => expect(result.current.data).toEqual(payload))
    rerender({ e: false })
    expect(result.current.data).toBeNull()
    rerender({ e: true })
    await waitFor(() => expect(result.current.data).toEqual(payload))
    expect(mockGet).toHaveBeenCalledTimes(2)
  })

  it('does not fetch when disabled', () => {
    const { result } = renderHook(() => useGitCommitFiles('/repo', 'a'.repeat(40), false))
    expect(result.current.data).toBeNull()
    expect(mockGet).not.toHaveBeenCalled()
  })

  it('disabled mid-flight: loading clears and late response is a no-op', async () => {
    let resolveGet!: (v: GitCommitResponse) => void
    mockGet.mockReturnValue(new Promise<GitCommitResponse>((r) => { resolveGet = r }))
    const { result, rerender } = renderHook(
      ({ e }) => useGitCommitFiles('/repo', 'a'.repeat(40), e),
      { initialProps: { e: true } },
    )
    await waitFor(() => expect(result.current.loading).toBe(true))
    rerender({ e: false })
    expect(result.current.data).toBeNull()
    expect(result.current.loading).toBe(false)
    expect(result.current.error).toBeNull()
    const payload = { commit: { hash: 'a'.repeat(40), shortHash: 'aaaaaaa', author: 'T', date: 1, subject: 's', body: '' }, files: [] }
    await act(async () => { resolveGet(payload); await Promise.resolve() })
    expect(result.current.data).toBeNull()
  })

  it('hash change retains old data while the new hash loads', async () => {
    const payloadA = { commit: { hash: 'a'.repeat(40), shortHash: 'aaaaaaa', author: 'T', date: 1, subject: 'A', body: '' }, files: [] }
    const payloadB = { commit: { hash: 'b'.repeat(40), shortHash: 'bbbbbbb', author: 'T', date: 2, subject: 'B', body: '' }, files: [] }
    mockGet.mockResolvedValue(payloadA)
    const { result, rerender } = renderHook(
      ({ h }) => useGitCommitFiles('/repo', h, true),
      { initialProps: { h: 'a'.repeat(40) } },
    )
    await waitFor(() => expect(result.current.data).toEqual(payloadA))
    mockGet.mockResolvedValue(payloadB)
    rerender({ h: 'b'.repeat(40) })
    expect(result.current.data).toEqual(payloadA)
    expect(mockGet).toHaveBeenCalledTimes(2)
    await waitFor(() => expect(result.current.data).toEqual(payloadB))
  })

  it('refresh retains old data and bumps request count', async () => {
    const payload = { commit: { hash: 'a'.repeat(40), shortHash: 'aaaaaaa', author: 'T', date: 1, subject: 's', body: '' }, files: [] }
    mockGet.mockResolvedValue(payload)
    const { result } = renderHook(() => useGitCommitFiles('/repo', 'a'.repeat(40), true))
    await waitFor(() => expect(result.current.data).toEqual(payload))
    act(() => result.current.refresh())
    expect(result.current.data).toEqual(payload)
    expect(mockGet).toHaveBeenCalledTimes(2)
  })

  it('failure sets error, clears data and loading', async () => {
    mockGet.mockRejectedValue(new Error('commit boom'))
    const { result } = renderHook(() => useGitCommitFiles('/repo', 'a'.repeat(40), true))
    await waitFor(() => expect(result.current.error).toBe('commit boom'))
    expect(result.current.data).toBeNull()
    expect(result.current.loading).toBe(false)
  })

  it('does not expose applyExternal', () => {
    const { result } = renderHook(() => useGitCommitFiles('/repo', 'a'.repeat(40), false))
    expect('applyExternal' in result.current).toBe(false)
  })
})

describe('useGitCommitDiffFile', () => {
  it('fetches the file diff when enabled, resets when disabled', async () => {
    const payload = { path: 'src/x.ts', staged: true, truncated: false, totalLines: 1, text: 'diff', isBinary: false }
    mockGet.mockResolvedValue(payload)
    const { result, rerender } = renderHook(
      ({ e }) => useGitCommitDiffFile('/repo', 'a'.repeat(40), 'src/x.ts', e),
      { initialProps: { e: true } },
    )
    await waitFor(() => expect(result.current.data).toEqual(payload))
    expect(mockGet).toHaveBeenCalledWith(
      `/git/commit-file?cwd=%2Frepo&hash=${'a'.repeat(40)}&path=src%2Fx.ts`,
      expect.anything(),
    )
    rerender({ e: false })
    expect(result.current.data).toBeNull()
  })

  it('does not fetch when disabled', () => {
    const { result } = renderHook(() => useGitCommitDiffFile('/repo', 'a'.repeat(40), 'src/x.ts', false))
    expect(result.current.data).toBeNull()
    expect(mockGet).not.toHaveBeenCalled()
  })

  it('disabled mid-flight: loading clears and late response is a no-op', async () => {
    let resolveGet!: (v: GitDiff) => void
    mockGet.mockReturnValue(new Promise<GitDiff>((r) => { resolveGet = r }))
    const { result, rerender } = renderHook(
      ({ e }) => useGitCommitDiffFile('/repo', 'a'.repeat(40), 'src/x.ts', e),
      { initialProps: { e: true } },
    )
    await waitFor(() => expect(result.current.loading).toBe(true))
    rerender({ e: false })
    expect(result.current.data).toBeNull()
    expect(result.current.loading).toBe(false)
    expect(result.current.error).toBeNull()
    const payload = { path: 'src/x.ts', staged: true, truncated: false, totalLines: 1, text: 'diff', isBinary: false }
    await act(async () => { resolveGet(payload); await Promise.resolve() })
    expect(result.current.data).toBeNull()
  })

  it('path change retains old data while the new path loads', async () => {
    const payloadA = { path: 'src/x.ts', staged: true, truncated: false, totalLines: 1, text: 'diff-a', isBinary: false }
    const payloadB = { path: 'src/y.ts', staged: true, truncated: false, totalLines: 1, text: 'diff-b', isBinary: false }
    mockGet.mockResolvedValue(payloadA)
    const { result, rerender } = renderHook(
      ({ p }) => useGitCommitDiffFile('/repo', 'a'.repeat(40), p, true),
      { initialProps: { p: 'src/x.ts' } },
    )
    await waitFor(() => expect(result.current.data).toEqual(payloadA))
    mockGet.mockResolvedValue(payloadB)
    rerender({ p: 'src/y.ts' })
    expect(result.current.data).toEqual(payloadA)
    expect(mockGet).toHaveBeenCalledTimes(2)
    await waitFor(() => expect(result.current.data).toEqual(payloadB))
  })

  it('refresh retains old data and bumps request count', async () => {
    const payload = { path: 'src/x.ts', staged: true, truncated: false, totalLines: 1, text: 'diff', isBinary: false }
    mockGet.mockResolvedValue(payload)
    const { result } = renderHook(() => useGitCommitDiffFile('/repo', 'a'.repeat(40), 'src/x.ts', true))
    await waitFor(() => expect(result.current.data).toEqual(payload))
    act(() => result.current.refresh())
    expect(result.current.data).toEqual(payload)
    expect(mockGet).toHaveBeenCalledTimes(2)
  })

  it('failure sets error, clears data and loading', async () => {
    mockGet.mockRejectedValue(new Error('commit-file boom'))
    const { result } = renderHook(() => useGitCommitDiffFile('/repo', 'a'.repeat(40), 'src/x.ts', true))
    await waitFor(() => expect(result.current.error).toBe('commit-file boom'))
    expect(result.current.data).toBeNull()
    expect(result.current.loading).toBe(false)
  })

  it('does not expose applyExternal', () => {
    const { result } = renderHook(() => useGitCommitDiffFile('/repo', 'a'.repeat(40), 'src/x.ts', false))
    expect('applyExternal' in result.current).toBe(false)
  })
})

describe('useCachedCommitFiles', () => {
  it('cache survives a disable/enable cycle', async () => {
    const cache = new Map()
    const payload = { commit: { hash: 'a'.repeat(40), shortHash: 'aaaaaaa', author: 'T', date: 1, subject: 's', body: '' }, files: [] }
    mockGet.mockResolvedValue(payload)
    const { result, rerender } = renderHook(({ e }) => useCachedCommitFiles('/repo', 'a'.repeat(40), e, cache), { initialProps: { e: true } })
    await waitFor(() => expect(result.current.data).toEqual(payload))
    expect(cache.size).toBe(1)
    rerender({ e: false })   // collapse
    expect(result.current.data).toEqual(payload)  // served from cache
    rerender({ e: true })    // re-expand
    expect(result.current.data).toEqual(payload)
    expect(mockGet).toHaveBeenCalledTimes(1)        // no refetch
  })

  it('hash undefined -> all-null, no fetch', () => {
    const cache = new Map()
    const { result } = renderHook(() => useCachedCommitFiles('/repo', undefined, true, cache))
    expect(result.current.data).toBeNull()
    expect(result.current.loading).toBe(false)
    expect(result.current.error).toBeNull()
    expect(mockGet).not.toHaveBeenCalled()
  })

  it('a response fetched for one hash is never cached under another', async () => {
    // Regression: fetch A's response can be delivered after the request
    // hash has already moved to B (promise resolution beats the inner
    // hook's abort effect). The write-through must attribute by the
    // response's own commit.hash, so cache[B] must end up with B's
    // payload — never A's.
    const hashA = 'a'.repeat(40)
    const hashB = 'b'.repeat(40)
    const payloadA = { commit: { hash: hashA, shortHash: 'aaaaaaa', author: 'T', date: 1, subject: 'A', body: '' }, files: [] }
    const payloadB = { commit: { hash: hashB, shortHash: 'bbbbbbb', author: 'T', date: 2, subject: 'B', body: '' }, files: [] }
    let resolveA!: (v: typeof payloadA) => void
    mockGet.mockImplementation((url: string) => {
      if (url.includes(hashA)) return new Promise((r) => { resolveA = r })
      return Promise.resolve(payloadB)
    })
    const cache = new Map()
    const { result, rerender } = renderHook(
      ({ h }) => useCachedCommitFiles('/repo', h, true, cache),
      { initialProps: { h: hashA } },
    )
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(1))
    await act(async () => {
      resolveA(payloadA)       // A's response is delivered...
      await Promise.resolve()  // ...before the abort effect can run
      rerender({ h: hashB })   // the request hash has already moved to B
    })
    await waitFor(() => expect(result.current.data).toEqual(payloadB))
    expect(cache.get(hashB)).toEqual(payloadB) // B's payload under B — never A's
  })
})

describe('gitDiffQuery', () => {
  it('builds the query string, including full=1', () => {
    expect(gitDiffQuery('/repo', 'src/x.ts', false))
      .toBe('/git/diff?cwd=%2Frepo&path=src%2Fx.ts&staged=0')
    expect(gitDiffQuery('/repo', 'src/x.ts', true, { full: true })).toContain('full=1')
  })
})

describe('gitRangeDiffFileQuery', () => {
  it('builds the query string, including full=1', () => {
    expect(gitRangeDiffFileQuery('/repo', 'main', 'feature', false, 'src/x.ts'))
      .toBe('/git/diff-range-file?cwd=%2Frepo&from=main&to=feature&path=src%2Fx.ts')
    expect(gitRangeDiffFileQuery('/repo', 'main', 'feature', true, 'src/x.ts', { full: true })).toContain('full=1')
  })
})

describe('gitCommitDiffFileQuery', () => {
  it('builds the query string, including full=1', () => {
    expect(gitCommitDiffFileQuery('/repo', 'a'.repeat(40), 'src/x.ts'))
      .toBe(`/git/commit-file?cwd=%2Frepo&hash=${'a'.repeat(40)}&path=src%2Fx.ts`)
    expect(gitCommitDiffFileQuery('/repo', 'a'.repeat(40), 'src/x.ts', { full: true })).toContain('full=1')
  })
})
