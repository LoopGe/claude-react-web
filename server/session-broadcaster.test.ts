import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SessionEventBroadcaster } from './session-broadcaster.js'
import type { Session } from './session-types.js'
import type { WsGitSnapshot } from './ws-protocol.js'
import type { GitStatus } from '../shared/git-types.js'

vi.mock('./git.js', () => ({
  getStatus: vi.fn(async () => ({
    isRepo: true as const, repoRoot: '/repo', branch: 'main', detached: false,
    ahead: 0, behind: 0, upstream: null, state: 'clean' as const,
    linkedWorktrees: [], staged: [], unstaged: [], untracked: [],
  })),
  listBranches: vi.fn(async () => [{ name: 'main', current: true, upstream: null }]),
  listStashes: vi.fn(async () => []),
}))
import { getStatus, listBranches, listStashes } from './git.js'

function makeSession(id: string, cwd: string, repoRoot?: string): Session {
  return {
    id, cwd, repoRoot,
    gitStatusSubscribers: new Set(),
    terminated: false,
  } as unknown as Session
}

/** Promise that resolves to `'timeout'` after `ms` milliseconds —
 *  used in `Promise.race` to assert that a pushable `next()` does NOT
 *  resolve within a bounded window (proving no frame was pushed). */
function timeout(ms: number): Promise<'timeout'> {
  return new Promise((r) => setTimeout(() => r('timeout'), ms))
}

describe('SessionEventBroadcaster git-snapshot', () => {
  beforeEach(() => vi.clearAllMocks())

  it('computes status+branches+stashes once and fans out to all sessions sharing repoRoot', async () => {
    const a = makeSession('a', '/repo', '/repo')
    const b = makeSession('b', '/repo/sub', '/repo') // subdirectory cwd, same repoRoot
    const c = makeSession('c', '/other', '/other')    // different repo — should NOT receive
    const sessions = new Map([['a', a], ['b', b], ['c', c]])
    const bc = new SessionEventBroadcaster(sessions)
    const subA = bc.subscribeGitStatus('a')!
    const subB = bc.subscribeGitStatus('b')!
    const subC = bc.subscribeGitStatus('c')!
    // Park a waiter on each subscriber BEFORE broadcasting so the
    // pushable's direct hand-off path delivers the frame deterministically.
    const pA = subA.iterable[Symbol.asyncIterator]().next()
    const pB = subB.iterable[Symbol.asyncIterator]().next()
    const pC = subC.iterable[Symbol.asyncIterator]().next()

    bc.broadcastGitStatusChanged('a')
    // Wait for the compute to land (fire-and-forget async).
    await vi.waitFor(() => {
      expect(getStatus).toHaveBeenCalledTimes(1)
      expect(listBranches).toHaveBeenCalledTimes(1)
      expect(listStashes).toHaveBeenCalledTimes(1)
    })

    const rA = await pA
    const rB = await pB
    expect((rA.value as WsGitSnapshot).kind).toBe('git-snapshot')
    expect((rA.value as WsGitSnapshot).repoRoot).toBe('/repo')
    expect((rA.value as WsGitSnapshot).branches).toEqual([{ name: 'main', current: true, upstream: null }])
    // b is in the same group and receives the same frame.
    expect((rB.value as WsGitSnapshot).kind).toBe('git-snapshot')
    expect((rB.value as WsGitSnapshot).repoRoot).toBe('/repo')

    // c is in a different group — its pushable should NOT deliver.
    const rC = await Promise.race([pC, timeout(50)])
    expect(rC).toBe('timeout')
  })

  it('falls back to cwd grouping when repoRoot is undefined', async () => {
    const a = makeSession('a', '/same', undefined)
    const b = makeSession('b', '/same', undefined)
    const sessions = new Map([['a', a], ['b', b]])
    const bc = new SessionEventBroadcaster(sessions)
    const subB = bc.subscribeGitStatus('b')!
    const pB = subB.iterable[Symbol.asyncIterator]().next()
    bc.broadcastGitStatusChanged('a')
    await vi.waitFor(() => expect(getStatus).toHaveBeenCalled())
    const frame = await pB
    expect((frame.value as WsGitSnapshot).repoRoot).toBe('/same')
  })

  it('reuses opts.snapshot fields and only computes the missing ones', async () => {
    const a = makeSession('a', '/repo', '/repo')
    const bc = new SessionEventBroadcaster(new Map([['a', a]]))
    const sub = bc.subscribeGitStatus('a')!
    const p = sub.iterable[Symbol.asyncIterator]().next()
    const preStatus = {
      isRepo: true as const, repoRoot: '/repo', branch: 'dev', detached: false,
      ahead: 1, behind: 0, upstream: null, state: 'clean' as const,
      linkedWorktrees: [], staged: [], unstaged: [], untracked: [],
    }
    bc.broadcastGitStatusChanged('a', { snapshot: { status: preStatus } })
    await vi.waitFor(() => expect(listBranches).toHaveBeenCalled())
    expect(getStatus).not.toHaveBeenCalled() // status was provided via opts — not recomputed
    const frame = await p
    expect(((frame.value as WsGitSnapshot).status as GitStatus).branch).toBe('dev')
    expect((frame.value as WsGitSnapshot).branches).toEqual([{ name: 'main', current: true, upstream: null }])
  })

  it('does not push and does not throw when computation fails', async () => {
    vi.mocked(getStatus).mockRejectedValueOnce(new Error('git exploded'))
    const a = makeSession('a', '/repo', '/repo')
    const bc = new SessionEventBroadcaster(new Map([['a', a]]))
    const sub = bc.subscribeGitStatus('a')!
    const it = sub.iterable[Symbol.asyncIterator]()
    // Fire-and-forget: the sync call must not throw.
    expect(() => bc.broadcastGitStatusChanged('a')).not.toThrow()
    // Give the async path time to settle.
    await new Promise((r) => setTimeout(r, 20))
    // No frame should arrive.
    const result = await Promise.race([it.next(), timeout(50)])
    expect(result).toBe('timeout')
  })

  it('seeds a fresh subscriber with the cached snapshot frame', async () => {
    const a = makeSession('a', '/repo', '/repo')
    const bc = new SessionEventBroadcaster(new Map([['a', a]]))
    // First broadcast populates the cache.
    bc.broadcastGitStatusChanged('a')
    await vi.waitFor(() => expect(getStatus).toHaveBeenCalled())
    // Let the async fire-and-forget path settle.
    await new Promise((r) => setTimeout(r, 20))
    // A NEW subscriber (late tab) should be seeded with the cached frame
    // — no second compute needed.
    const fresh = bc.subscribeGitStatus('a')!
    const it = fresh.iterable[Symbol.asyncIterator]()
    const first = await it.next()
    expect((first.value as WsGitSnapshot).kind).toBe('git-snapshot')
    expect((first.value as WsGitSnapshot).repoRoot).toBe('/repo')
  })

  it('gitGroupKeyOf returns the group key or null for unknown sessions', () => {
    const a = makeSession('a', '/repo', '/repo')
    const b = makeSession('b', '/repo/sub', '/repo')
    const bc = new SessionEventBroadcaster(new Map([['a', a], ['b', b]]))
    expect(bc.gitGroupKeyOf('a')).toBe('/repo')
    expect(bc.gitGroupKeyOf('b')).toBe('/repo')
    expect(bc.gitGroupKeyOf('nonexistent')).toBeNull()
  })

  it('gitGroupLivePeer returns another session sharing the key, null when alone', () => {
    const a = makeSession('a', '/repo', '/repo')
    const b = makeSession('b', '/repo/sub', '/repo')
    const bc = new SessionEventBroadcaster(new Map([['a', a], ['b', b]]))
    expect(bc.gitGroupLivePeer('a')).toBe('b')
    const alone = makeSession('x', '/solo', '/solo')
    const bc2 = new SessionEventBroadcaster(new Map([['x', alone]]))
    expect(bc2.gitGroupLivePeer('x')).toBeNull()
  })

  it('pushes isRepo:false with empty lists for a non-repo cwd without calling listBranches/listStashes', async () => {
    vi.mocked(getStatus).mockResolvedValueOnce({ isRepo: false } as unknown as Awaited<ReturnType<typeof getStatus>>)
    const a = makeSession('a', '/not-a-repo', undefined)
    const bc = new SessionEventBroadcaster(new Map([['a', a]]))
    const sub = bc.subscribeGitStatus('a')!
    const it = sub.iterable[Symbol.asyncIterator]()
    void it.next() // park waiter
    bc.broadcastGitStatusChanged('a')
    await vi.waitFor(() => expect(getStatus).toHaveBeenCalled())
    // give the async path time to NOT throw
    await new Promise((r) => setTimeout(r, 20))
    expect(listBranches).not.toHaveBeenCalled()
    expect(listStashes).not.toHaveBeenCalled()
    // seed now holds the frame — a fresh subscriber gets it
    const fresh = bc.subscribeGitStatus('a')!
    const first = await fresh.iterable[Symbol.asyncIterator]().next()
    const frame = first.value as { kind: string; status: { isRepo: boolean }; branches: unknown[]; stashes: unknown[] }
    expect(frame.kind).toBe('git-snapshot')
    expect(frame.status.isRepo).toBe(false)
    expect(frame.branches).toEqual([])
    expect(frame.stashes).toEqual([])
  })
})
