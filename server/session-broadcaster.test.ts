import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SessionEventBroadcaster } from './session-broadcaster.js'
import type { Session } from './session-types.js'
import type { WsGitSnapshot } from './ws-protocol.js'
import type { GitStatus } from '../shared/git-types.js'

vi.mock('./git.js', () => {
  const repoStatus = (branch = 'main') => ({
    isRepo: true as const, repoRoot: '/repo', branch, detached: false,
    ahead: 0, behind: 0, upstream: null, state: 'clean' as const,
    linkedWorktrees: [], staged: [], unstaged: [], untracked: [],
  })
  return {
    // Default: honour `partial` field-by-field like the real one, so the
    // opts.snapshot assertions can check what reached the frame.
    getGitSnapshot: vi.fn(async (_cwd: string, partial?: Record<string, unknown>) => ({
      status: partial?.status ?? repoStatus(),
      branches: partial?.branches ?? [{ name: 'main', current: true, upstream: null }],
      stashes: partial?.stashes ?? [],
    })),
  }
})
import { getGitSnapshot, type GitSnapshotPayload } from './git.js'

function repoStatus(branch: string): GitStatus {
  return {
    isRepo: true, repoRoot: '/repo', branch, detached: false,
    ahead: 0, behind: 0, upstream: null, state: 'clean',
    linkedWorktrees: [], staged: [], unstaged: [], untracked: [],
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

/** Queue controllable getGitSnapshot results: call N resolves only when
 *  the test resolves the N-th deferred. */
function queueSnapshots(n: number): Array<{ promise: Promise<GitSnapshotPayload>; resolve: (v: GitSnapshotPayload) => void }> {
  const ds = Array.from({ length: n }, () => deferred<GitSnapshotPayload>())
  for (const d of ds) vi.mocked(getGitSnapshot).mockImplementationOnce(() => d.promise)
  return ds
}

const snap = (branch: string): GitSnapshotPayload => ({ status: repoStatus(branch), branches: [], stashes: [] })

vi.mock('./tasklist-state.js', () => ({
  deriveTaskListForSession: vi.fn(async () => ({ rev: 2, tasks: [{ id: '1', subject: 'S', status: 'in_progress', stale: false }] })),
}))
import { deriveTaskListForSession } from './tasklist-state.js'

function makeSession(id: string, cwd: string, repoRoot?: string): Session {
  return {
    id, cwd, repoRoot,
    gitStatusSubscribers: new Set(),
    tasklistSubscribers: new Set(),
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
      expect(getGitSnapshot).toHaveBeenCalledTimes(1)
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
    await vi.waitFor(() => expect(getGitSnapshot).toHaveBeenCalled())
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
    await vi.waitFor(() => expect(getGitSnapshot).toHaveBeenCalled())
    // The provided status is handed to getGitSnapshot as `partial`, which
    // computes only the missing fields (git-snapshot-spawns.test.ts pins
    // that a provided status spawns no rev-parse / status).
    expect(getGitSnapshot).toHaveBeenCalledTimes(1)
    expect(getGitSnapshot).toHaveBeenCalledWith('/repo', { status: preStatus })
    const frame = await p
    expect(((frame.value as WsGitSnapshot).status as GitStatus).branch).toBe('dev')
    expect((frame.value as WsGitSnapshot).branches).toEqual([{ name: 'main', current: true, upstream: null }])
  })

  it('does not push and does not throw when computation fails', async () => {
    vi.mocked(getGitSnapshot).mockRejectedValueOnce(new Error('git exploded'))
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
    await vi.waitFor(() => expect(getGitSnapshot).toHaveBeenCalled())
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

  it('pushes isRepo:false with empty lists for a non-repo cwd', async () => {
    // (That a non-repo snapshot spawns only the probe is pinned against the
    // real getGitSnapshot in git-snapshot-spawns.test.ts.)
    vi.mocked(getGitSnapshot).mockResolvedValueOnce({ status: { isRepo: false }, branches: [], stashes: [] })
    const a = makeSession('a', '/not-a-repo', undefined)
    const bc = new SessionEventBroadcaster(new Map([['a', a]]))
    const sub = bc.subscribeGitStatus('a')!
    const it = sub.iterable[Symbol.asyncIterator]()
    void it.next() // park waiter
    bc.broadcastGitStatusChanged('a')
    await vi.waitFor(() => expect(getGitSnapshot).toHaveBeenCalled())
    // give the async path time to NOT throw
    await new Promise((r) => setTimeout(r, 20))
    // seed now holds the frame — a fresh subscriber gets it
    const fresh = bc.subscribeGitStatus('a')!
    const first = await fresh.iterable[Symbol.asyncIterator]().next()
    const frame = first.value as { kind: string; status: { isRepo: boolean }; branches: unknown[]; stashes: unknown[] }
    expect(frame.kind).toBe('git-snapshot')
    expect(frame.status.isRepo).toBe(false)
    expect(frame.branches).toEqual([])
    expect(frame.stashes).toEqual([])
  })

  const branchOf = (v: unknown): string | null => ((v as WsGitSnapshot).status as GitStatus).branch

  it('drops an auto compute that resolves after a newer user write: neither pushed nor cached', async () => {
    const a = makeSession('a', '/repo', '/repo')
    const bc = new SessionEventBroadcaster(new Map([['a', a]]))
    const sub = bc.subscribeGitStatus('a')!
    const iter = sub.iterable[Symbol.asyncIterator]()
    const [auto, write] = queueSnapshots(2)

    bc.broadcastGitStatusChanged('a') // auto compute #1 — in flight
    const written = repoStatus('after-write')
    bc.broadcastGitStatusChanged('a', { snapshot: { status: written } }) // user write — starts immediately
    expect(getGitSnapshot).toHaveBeenCalledTimes(2)

    write.resolve({ status: written, branches: [], stashes: [] })
    const first = await iter.next()
    expect(branchOf(first.value)).toBe('after-write')

    // The older compute lands last with pre-write data.
    auto.resolve(snap('stale'))
    await new Promise((r) => setTimeout(r, 20))
    expect(await Promise.race([iter.next(), timeout(50)])).toBe('timeout')

    // The seed cache still holds the write's frame.
    const fresh = bc.subscribeGitStatus('a')!
    const seeded = await fresh.iterable[Symbol.asyncIterator]().next()
    expect(branchOf(seeded.value)).toBe('after-write')
  })

  it('collapses triggers during an in-flight auto compute into exactly one recompute', async () => {
    const a = makeSession('a', '/repo', '/repo')
    const b = makeSession('b', '/repo/sub', '/repo')
    const bc = new SessionEventBroadcaster(new Map([['a', a], ['b', b]]))
    const sub = bc.subscribeGitStatus('a')!
    const iter = sub.iterable[Symbol.asyncIterator]()
    const [one, two] = queueSnapshots(2)

    bc.broadcastGitStatusChanged('a')
    bc.broadcastGitStatusChanged('a') // in flight → dirty
    bc.broadcastGitStatusChanged('b') // same group → dirty, latest origin = b
    expect(getGitSnapshot).toHaveBeenCalledTimes(1)

    one.resolve(snap('one'))
    const f1 = await iter.next()
    expect(branchOf(f1.value)).toBe('one')
    await vi.waitFor(() => expect(getGitSnapshot).toHaveBeenCalledTimes(2))
    // The recompute runs for the latest trigger.
    expect(vi.mocked(getGitSnapshot).mock.calls[1][0]).toBe('/repo/sub')

    two.resolve(snap('two'))
    const f2 = await iter.next()
    expect(branchOf(f2.value)).toBe('two')
    expect((f2.value as WsGitSnapshot).sessionId).toBe('b')

    await new Promise((r) => setTimeout(r, 20))
    expect(getGitSnapshot).toHaveBeenCalledTimes(2) // no further recompute
  })

  it('re-points the dirty recompute to a live peer when the dirty origin unloads mid-compute', async () => {
    const a = makeSession('a', '/repo', '/repo')
    const b = makeSession('b', '/repo/sub', '/repo')
    const sessions = new Map([['a', a], ['b', b]])
    const bc = new SessionEventBroadcaster(sessions)
    const sub = bc.subscribeGitStatus('b')!
    const iter = sub.iterable[Symbol.asyncIterator]()
    const [one, two] = queueSnapshots(2)

    bc.broadcastGitStatusChanged('a')
    bc.broadcastGitStatusChanged('a') // in flight → dirty, origin = a
    sessions.delete('a') // a unloads while the compute runs

    one.resolve(snap('one'))
    expect(branchOf((await iter.next()).value)).toBe('one')
    // The recompute still runs, now on behalf of peer b.
    await vi.waitFor(() => expect(getGitSnapshot).toHaveBeenCalledTimes(2))
    expect(vi.mocked(getGitSnapshot).mock.calls[1][0]).toBe('/repo/sub')

    two.resolve(snap('two'))
    const f2 = await iter.next()
    expect(branchOf(f2.value)).toBe('two')
    expect((f2.value as WsGitSnapshot).sessionId).toBe('b')
  })

  it('drops the dirty recompute when no member of the group is left', async () => {
    const a = makeSession('a', '/repo', '/repo')
    const sessions = new Map([['a', a]])
    const bc = new SessionEventBroadcaster(sessions)
    const [one] = queueSnapshots(1)
    bc.broadcastGitStatusChanged('a')
    bc.broadcastGitStatusChanged('a') // dirty
    sessions.delete('a')
    one.resolve(snap('one'))
    await new Promise((r) => setTimeout(r, 20))
    expect(getGitSnapshot).toHaveBeenCalledTimes(1)
  })

  it('an auto compute that starts after a write supersedes the write if it lands first', async () => {
    const a = makeSession('a', '/repo', '/repo')
    const bc = new SessionEventBroadcaster(new Map([['a', a]]))
    const [write, auto] = queueSnapshots(2)
    bc.broadcastGitStatusChanged('a', { snapshot: { status: repoStatus('write') } }) // seq 1
    bc.broadcastGitStatusChanged('a') // seq 2 — started later, fresher
    auto.resolve(snap('auto'))
    await new Promise((r) => setTimeout(r, 10))
    write.resolve(snap('write'))
    await new Promise((r) => setTimeout(r, 10))
    const fresh = bc.subscribeGitStatus('a')!
    const seeded = await fresh.iterable[Symbol.asyncIterator]().next()
    expect(branchOf(seeded.value)).toBe('auto')
  })
})

describe('SessionEventBroadcaster tasklist-snapshot', () => {
  beforeEach(() => vi.clearAllMocks())

  it('broadcast derives once and pushes the frame to the session subscribers', async () => {
    const s = makeSession('a', '/repo')
    const bc = new SessionEventBroadcaster(new Map([['a', s]]))
    const sub = bc.subscribeTaskList('a')!
    const p = sub.iterable[Symbol.asyncIterator]().next()
    bc.broadcastTaskListChanged('a')
    await vi.waitFor(() => expect(deriveTaskListForSession).toHaveBeenCalledWith('a'))
    const frame = (await Promise.race([p, timeout(500)])) as { value: { kind: string; rev: number } }
    expect(frame.value.kind).toBe('tasklist-snapshot')
    expect(frame.value.rev).toBe(2)
  })

  it('seeds a fresh subscriber with the last frame (subscribe-after-broadcast)', async () => {
    const s = makeSession('a', '/repo')
    const bc = new SessionEventBroadcaster(new Map([['a', s]]))
    bc.broadcastTaskListChanged('a')
    await vi.waitFor(() => expect(deriveTaskListForSession).toHaveBeenCalled())
    const sub = bc.subscribeTaskList('a')!
    const first = await sub.iterable[Symbol.asyncIterator]().next()
    expect((first.value as { kind: string }).kind).toBe('tasklist-snapshot')
  })

  it('returns null for an unknown session', () => {
    const bc = new SessionEventBroadcaster(new Map())
    expect(bc.subscribeTaskList('nope')).toBeNull()
  })

  it('prunes the seed map when the session is removed', async () => {
    const s = makeSession('a', '/repo')
    const sessions = new Map([['a', s]])
    const bc = new SessionEventBroadcaster(sessions)
    bc.broadcastTaskListChanged('a')
    await vi.waitFor(() => expect(deriveTaskListForSession).toHaveBeenCalled())
    sessions.delete('a')
    bc.broadcastTaskListChanged('a') // prune runs inside emit
    await vi.waitFor(() => expect(deriveTaskListForSession).toHaveBeenCalledTimes(2))
    // 无断言崩溃即通过(内部 Map 已剪枝;类型上私有,行为由下一用例钉)
  })

  it('re-seeding after prune derives fresh (no stale resurrection)', async () => {
    const s = makeSession('a', '/repo')
    const sessions = new Map([['a', s]])
    const bc = new SessionEventBroadcaster(sessions)
    bc.broadcastTaskListChanged('a')
    await vi.waitFor(() => expect(deriveTaskListForSession).toHaveBeenCalledTimes(1))
    sessions.delete('a')
    bc.broadcastTaskListChanged('a') // prune runs inside emit
    await vi.waitFor(() => expect(deriveTaskListForSession).toHaveBeenCalledTimes(2))
    // Session returns as a NEW object under the same id; the subscribe-time
    // seed must come from the CURRENT derive, not the frame cached before
    // the prune (stale resurrection would replay the old rev).
    vi.mocked(deriveTaskListForSession).mockResolvedValueOnce({ rev: 7, tasks: [] })
    sessions.set('a', makeSession('a', '/repo'))
    bc.broadcastTaskListChanged('a')
    await vi.waitFor(() => expect(deriveTaskListForSession).toHaveBeenCalledTimes(3))
    const sub = bc.subscribeTaskList('a')!
    const first = await sub.iterable[Symbol.asyncIterator]().next()
    expect((first.value as { kind: string }).kind).toBe('tasklist-snapshot')
    expect((first.value as { rev: number }).rev).toBe(7)
  })
})
