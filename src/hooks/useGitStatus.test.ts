import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import type { WsGitSnapshot } from '../../shared/ws-protocol.js'
import type { GitStatus, GitStatusResponse } from '../../shared/git-types.js'

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
  useGitCommitFiles,
  useGitCommitDiffFile,
  useCachedCommitFiles,
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
})

describe('gitCommitDiffFileQuery', () => {
  it('builds the query string, including full=1', () => {
    expect(gitCommitDiffFileQuery('/repo', 'a'.repeat(40), 'src/x.ts'))
      .toBe(`/git/commit-file?cwd=%2Frepo&hash=${'a'.repeat(40)}&path=src%2Fx.ts`)
    expect(gitCommitDiffFileQuery('/repo', 'a'.repeat(40), 'src/x.ts', { full: true })).toContain('full=1')
  })
})
