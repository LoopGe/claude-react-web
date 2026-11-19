import { describe, it, expect, vi } from 'vitest'
import { TranscriptWriter, GenerationLedger, type WriterDeps } from './transcript-writer.js'
import { TranscriptStore } from './transcript-store.js'

function makeDeps(over: Partial<WriterDeps> = {}) {
  const store = new TranscriptStore('sid')
  const calls: string[] = []
  const deps: WriterDeps = {
    appendBatch: vi.fn(async () => {
      calls.push('sync')
    }),
    recordSeq: (uuid, msg) => store.record(uuid, msg),
    headSeq: () => store.headSeq,
    publish: vi.fn(() => {
      calls.push('publish')
    }),
    dispatchUser: vi.fn(async () => {
      calls.push('dispatchUser')
    }),
    dispatchSupplement: vi.fn(async () => true),
    dispatchControl: vi.fn(async () => {}),
    isTurnActive: () => false,
    generation: () => store.generation,
    publishQueued: vi.fn(() => {
      calls.push('publishQueued')
    }),
    afterMaterialize: vi.fn(() => {
      calls.push('afterMaterialize')
    }),
    ...over,
  }
  return { deps, store, calls }
}

const userMsg = (uuid: string) => ({ type: 'user', uuid, message: { role: 'user', content: uuid } })

describe('GenerationLedger (spec §8.3)', () => {
  it('is monotonic and a migration exceeds a small client floor', () => {
    const l = new GenerationLedger(0)
    const g1 = l.next('clear')
    const g2 = l.next('ordered-rebuild', 5)
    expect(g2).toBeGreaterThan(g1)
    expect(g2).toBeGreaterThan(5)
    expect(l.next('clear')).toBeGreaterThan(g2)
  })
})

describe('TranscriptWriter.appendDurable (spec §8.1)', () => {
  it('fsyncs before publishing', async () => {
    const { deps, calls } = makeDeps()
    const w = new TranscriptWriter(deps)
    await w.appendDurable(userMsg('a'))
    expect(calls.indexOf('sync')).toBeGreaterThanOrEqual(0)
    expect(calls.indexOf('sync')).toBeLessThan(calls.indexOf('publish'))
    expect(deps.publish).toHaveBeenCalledTimes(1)
  })

  it('a write error rejects and leaves the transcript un-published', async () => {
    const appendBatch = vi.fn(async () => {
      throw new Error('disk full')
    })
    const { deps } = makeDeps({ appendBatch })
    const w = new TranscriptWriter(deps)
    await expect(w.appendDurable(userMsg('a'))).rejects.toThrow('disk full')
    expect(deps.publish).not.toHaveBeenCalled()
  })

  it('rejects in degraded state', async () => {
    const { deps } = makeDeps()
    const w = new TranscriptWriter(deps)
    w.deferOldCommit(userMsg('x'), 0)
    await w.abortRebuild('failed')
    await expect(w.appendDurable(userMsg('a'))).rejects.toThrow(/degraded/)
  })
})

describe('TranscriptWriter.drain (teardown race, R1)', () => {
  const flush = () => new Promise<void>((r) => setImmediate(r))

  it('resolves only after every queued commit has run its appendBatch', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const ran: string[] = []
    const appendBatch = vi.fn(async (rows: object[]) => {
      ran.push((rows[0] as { state?: string }).state ?? '')
      await gate
    })
    const { deps } = makeDeps({ appendBatch })
    const w = new TranscriptWriter(deps)
    // Two serial commits; the first parks inside appendBatch, the second is
    // chained behind it on writerQueue.
    const c1 = w.commitLifecycle('op1', 'consumed')
    const c2 = w.commitLifecycle('op2', 'steered')
    let drained = false
    const d = w.drain().then(() => { drained = true })
    await flush()
    expect(ran).toEqual(['consumed']) // first commit started, second still queued
    expect(drained).toBe(false) // drain must wait for the parked commit
    release()
    await d
    expect(drained).toBe(true)
    await Promise.all([c1, c2])
    expect(ran).toEqual(['consumed', 'steered'])
    expect(appendBatch).toHaveBeenCalledTimes(2)
  })

  it('never rejects even when a queued batch fails (error-swallowed tail)', async () => {
    const appendBatch = vi.fn(async () => { throw new Error('disk full') })
    const { deps } = makeDeps({ appendBatch })
    const w = new TranscriptWriter(deps)
    const c = w.commitLifecycle('op1', 'consumed')
    await expect(c).rejects.toThrow('disk full')
    await expect(w.drain()).resolves.toBeUndefined()
  })

  it('resolves immediately when no commits are queued', async () => {
    const { deps } = makeDeps()
    const w = new TranscriptWriter(deps)
    await expect(w.drain()).resolves.toBeUndefined()
  })
})

describe('TranscriptWriter.quiesce (both chains, R6)', () => {
  const flush = () => new Promise<void>((r) => setImmediate(r))

  it('waits for a commit a dispatch task issues mid-drain (dispatchQueue feeds writerQueue)', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const states: string[] = []
    const appendBatch = vi.fn(async (rows: object[]) => {
      const state = (rows[0] as { state?: string }).state ?? ''
      states.push(state)
      if (state === 'enqueue-not-attempted') await gate
    })
    const { deps } = makeDeps({ appendBatch })
    const w = new TranscriptWriter(deps)
    void w.recordDispatchAttempt({ operationId: 'op1', dispatchOrdinal: 1, kind: 'user', payload: userMsg('a') })
    await flush()
    // The first input commit is parked; the dispatch continuation has NOT yet
    // chained the second commit onto writerQueue.
    expect(states).toEqual(['enqueue-not-attempted'])
    expect(w.hasPendingCommits).toBe(true)
    expect(w.hasPendingDispatch).toBe(true)
    let quiesced = false
    const q = w.quiesce().then(() => { quiesced = true })
    await flush()
    expect(quiesced).toBe(false) // a writer-only snapshot would resolve here
    release()
    await q
    expect(quiesced).toBe(true)
    expect(states).toEqual(['enqueue-not-attempted', 'enqueue-attempted'])
    expect(w.hasPendingWork).toBe(false)
  })

  it('resolves immediately when both chains are idle', async () => {
    const { deps } = makeDeps()
    const w = new TranscriptWriter(deps)
    expect(w.hasPendingWork).toBe(false)
    await expect(w.quiesce()).resolves.toBeUndefined()
  })
})

describe('TranscriptWriter.enqueueDispatch (spec §8.1)', () => {
  it('commits enqueue-attempted before the provider call; a sync consumed callback re-enters without deadlock', async () => {
    const order: string[] = []
    const appendBatch = vi.fn(async (rows: object[]) => {
      order.push(`commit:${(rows[0] as { state?: string }).state ?? ''}`)
    })
    // eslint-disable-next-line prefer-const -- circular init: dispatchUser reads w before deps (and thus w) can be constructed
    let w: TranscriptWriter
    const dispatchUser = vi.fn(async (op: { operationId: string }) => {
      order.push('dispatch')
      await w.commitLifecycle(op.operationId, 'consumed')
    })
    const { deps } = makeDeps({ appendBatch, dispatchUser })
    w = new TranscriptWriter(deps)
    await w.enqueueDispatch({ operationId: 'op1', dispatchOrdinal: 1, kind: 'user', payload: userMsg('a') })
    const attempted = order.indexOf('commit:enqueue-attempted')
    const dispatch = order.indexOf('dispatch')
    expect(attempted).toBeGreaterThanOrEqual(0)
    expect(attempted).toBeLessThan(dispatch)
    expect(order).toContain('commit:consumed')
  })

  it('supplement false commits supplement-rejected + fallback route before the user fallback', async () => {
    const states: string[] = []
    const appendBatch = vi.fn(async (rows: object[]) => {
      states.push((rows[0] as { state?: string }).state ?? '')
    })
    const dispatchSupplement = vi.fn(async () => false)
    const dispatchUser = vi.fn(async () => {})
    const { deps } = makeDeps({ appendBatch, dispatchSupplement, dispatchUser })
    const w = new TranscriptWriter(deps)
    await w.enqueueDispatch({ operationId: 's1', dispatchOrdinal: 1, kind: 'supplement', payload: userMsg('s') })
    expect(states).toContain('supplement-rejected')
    expect(dispatchUser).toHaveBeenCalledTimes(1)
    expect(states.indexOf('supplement-rejected')).toBeLessThan(states.lastIndexOf('enqueue-not-attempted'))
  })

  it('queued root prompt while a turn is active is not published; materializes at turn terminal in order', async () => {
    let turnActive = true
    const { deps, store } = makeDeps({ isTurnActive: () => turnActive })
    const w = new TranscriptWriter(deps)
    await w.appendDurable({ type: 'assistant', uuid: 'A', message: { id: 'rA', content: [], stop_reason: 'end_turn' } })
    await w.appendDurable({ type: 'result', uuid: 'R', subtype: 'success', assistantUuid: 'A', num_turns: 1 })
    await w.enqueueDispatch({ operationId: 'u2', dispatchOrdinal: 2, kind: 'user', payload: userMsg('U') })
    expect(store.headSeq).toBe(2) // U allocated no seq
    expect(deps.publish).toHaveBeenCalledTimes(2) // A, R only
    turnActive = false
    await w.materializeQueued()
    expect(store.headSeq).toBe(3)
    expect(deps.publish).toHaveBeenCalledTimes(3)
    expect(deps.dispatchUser).toHaveBeenCalledTimes(1)
  })

  it('T7b-2 review F1: interrupt drains a prompt mid-materialization; it is not dispatched', async () => {
    // The materialize fsync is held open; during that window the op must remain
    // withdrawable (still in `queued`), and once drained it must NOT dispatch —
    // otherwise Stop silently fails to cancel the about-to-start queued turn.
    let turnActive = true
    let releaseLive!: () => void
    const liveGate = new Promise<void>((r) => { releaseLive = r })
    const appendBatch = vi.fn(async (_rows: object[], commit: object) => {
      if ((commit as { batchType?: string }).batchType === 'live') await liveGate
    })
    const { deps } = makeDeps({ isTurnActive: () => turnActive, appendBatch })
    const w = new TranscriptWriter(deps)
    await w.enqueueDispatch({ operationId: 'u2', dispatchOrdinal: 1, kind: 'user', payload: userMsg('U2') })
    turnActive = false
    const mat = w.materializeQueued()
    // Let the materialize body reach the held live-batch fsync.
    await new Promise<void>((r) => setTimeout(r, 0))
    await new Promise<void>((r) => setTimeout(r, 0))
    const drained = w.drainQueued()
    expect(drained.map((o) => o.operationId)).toEqual(['u2'])
    releaseLive()
    await mat
    expect(deps.dispatchUser).not.toHaveBeenCalled()
    // appendDurable still allocated the seq + broadcast before the drain was
    // observed (the interrupt tombstones that seq downstream); the writer skips
    // only the ring push + provider enqueue. Broadcast-then-withdrawn is the
    // consistent ordering the client's seq-window tombstone guard absorbs.
    expect(deps.publish).toHaveBeenCalledTimes(1)
  })

  it('T7b-2 review F2: a failed materialize leaves the prompt queued for retry (not stranded)', async () => {
    let turnActive = true
    let failLive = true
    const appendBatch = vi.fn(async (_rows: object[], commit: object) => {
      if ((commit as { batchType?: string }).batchType === 'live' && failLive) throw new Error('disk full')
    })
    const { deps } = makeDeps({ isTurnActive: () => turnActive, appendBatch })
    const w = new TranscriptWriter(deps)
    await w.enqueueDispatch({ operationId: 'u2', dispatchOrdinal: 1, kind: 'user', payload: userMsg('U2') })
    turnActive = false
    await expect(w.materializeQueued()).rejects.toThrow('disk full')
    // Incremental materialization: the failed op stays queued (not spliced),
    // so the next turn terminal retries it instead of dropping it live.
    expect(w.queuedCount).toBe(1)
    failLive = false
    expect(await w.materializeQueued()).toBe(1)
    expect(deps.dispatchUser).toHaveBeenCalledTimes(1)
  })

  it('T7b-2 review F8: materialize bounds to the firing terminal — later arrivals wait for the next terminal', async () => {
    // T1 has [A,B]. A materializes + dispatches (turn A starts); B's fsync is
    // held. During the stall D is sent mid-turn-A. D belongs to A's terminal,
    // NOT T1 — materializing it here would interleave D's seq amid turn A's
    // streaming assistant blocks (the A,U,R inversion the plan prevents).
    let turnActive = true
    let liveCount = 0
    let releaseSecond!: () => void
    const secondGate = new Promise<void>((r) => { releaseSecond = r })
    const appendBatch = vi.fn(async (_rows: object[], commit: object) => {
      if ((commit as { batchType?: string }).batchType === 'live') {
        liveCount++
        if (liveCount === 2) await secondGate
      }
    })
    const { deps } = makeDeps({ isTurnActive: () => turnActive, appendBatch })
    const w = new TranscriptWriter(deps)
    await w.enqueueDispatch({ operationId: 'A', dispatchOrdinal: 1, kind: 'user', payload: userMsg('A') })
    await w.enqueueDispatch({ operationId: 'B', dispatchOrdinal: 2, kind: 'user', payload: userMsg('B') })
    turnActive = false
    const mat = w.materializeQueued()
    await new Promise<void>((r) => setTimeout(r, 0))
    await new Promise<void>((r) => setTimeout(r, 0))
    // D arrives during the materialized turn A (fire-and-forget: its durable
    // commit chains behind the in-flight materialize run).
    turnActive = true
    void w.enqueueDispatch({ operationId: 'D', dispatchOrdinal: 3, kind: 'user', payload: userMsg('D') })
    releaseSecond()
    await mat
    expect(deps.dispatchUser).toHaveBeenCalledTimes(2) // A, B only — not D
    expect(w.queuedCount).toBe(1) // D waits for the next terminal
  })
})

describe('TranscriptWriter.abortRebuild (spec §8.1)', () => {
  it('failed publishes deferred old commits in order and retains pendingRebuilds', async () => {
    const { deps } = makeDeps()
    const w = new TranscriptWriter(deps)
    w.deferOldCommit(userMsg('x'), 5)
    w.deferOldCommit(userMsg('y'), 6)
    w.addPendingRebuild({ operationId: 'p1', entry: { occurrenceId: 'uuid:R:result', msg: { type: 'result' }, source: 'result', aliases: [], evicted: false } })
    await w.abortRebuild('failed')
    expect(deps.publish).toHaveBeenCalledTimes(2)
    expect((deps.publish as ReturnType<typeof vi.fn>).mock.calls[0][1]).toBe(5)
    expect((deps.publish as ReturnType<typeof vi.fn>).mock.calls[1][1]).toBe(6)
    expect(w.pendingRebuilds).toHaveLength(1)
    expect(w.degraded).toBe(true)
  })

  it('cancelled releases deferred commits and clears the rebuilding flag', async () => {
    const { deps } = makeDeps()
    const w = new TranscriptWriter(deps)
    w.deferOldCommit(userMsg('x'), 0)
    await w.abortRebuild('cancelled')
    expect(deps.publish).toHaveBeenCalledTimes(1)
    expect(w.degraded).toBe(false)
  })
})

describe('TranscriptWriter.resetGeneration (spec §8.3)', () => {
  it('journal-less reset bumps in-memory epochs and writes a reset batch', async () => {
    const { deps } = makeDeps()
    const w = new TranscriptWriter(deps)
    const gen = await w.resetGeneration('clear')
    expect(gen).toBe(1)
    expect(w.clearEpoch).toBe(1)
    expect(w.rebaseEpoch).toBe(0)
    expect(deps.appendBatch).toHaveBeenCalledTimes(1)
    const commit = vi.mocked(deps.appendBatch).mock.calls[0][1] as { batchType?: string; reason?: string; generation?: number }
    expect(commit).toMatchObject({ batchType: 'reset', reason: 'clear', generation: 1 })
  })

  it('with a journal, commits the journal after the batch and syncs epochs from it', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { ResetJournal } = await import('./reset-journal.js')
    const dir = await mkdtemp(join(tmpdir(), 'crw-writer-journal-'))
    try {
      const journal = new ResetJournal(dir, 'sid')
      await journal.prepare({ generation: 1, reason: 'compact', seedBoundaryUuid: 'b' })
      const order: string[] = []
      const { deps } = makeDeps({ appendBatch: vi.fn(async () => { order.push('batch') }) })
      const origCommit = journal.commit.bind(journal)
      journal.commit = async (g: number) => { order.push('journal-commit'); await origCommit(g) }
      const w = new TranscriptWriter(deps)
      const gen = await w.resetGeneration('compact', undefined, journal)
      expect(gen).toBe(1)
      // batch fsynced BEFORE the journal commit (durable-before-publish)
      expect(order).toEqual(['batch', 'journal-commit'])
      expect(journal.latest?.state).toBe('committed')
      expect(journal.clearEpoch).toBe(1)
      expect(w.clearEpoch).toBe(1)
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })
})

describe('TranscriptWriter.recordDispatchAttempt (T7b Task 1)', () => {
  it('commits not-attempted (with payload) then attempted (no payload duplication)', async () => {
    const batches: Array<{ rows: object[]; commit: { batchType?: string } }> = []
    const { deps } = makeDeps({ appendBatch: vi.fn(async (rows, commit) => { batches.push({ rows, commit: commit as { batchType?: string } }) }) })
    const w = new TranscriptWriter(deps)
    const payload = { type: 'user', uuid: 'u1', message: { role: 'user', content: 'hi' } }
    await w.recordDispatchAttempt({ operationId: 'u1', dispatchOrdinal: w.nextDispatchOrdinal(), kind: 'user', payload })
    const inputBatches = batches.filter((b) => b.commit.batchType === 'input')
    expect(inputBatches).toHaveLength(2)
    const states = inputBatches.map((b) => (b.rows[0] as { state: string }).state)
    expect(states).toEqual(['enqueue-not-attempted', 'enqueue-attempted'])
    // Payload only on the first row (I4: no multi-MB duplication per state).
    expect((inputBatches[0].rows[0] as { payload?: unknown }).payload).toEqual(payload)
    expect((inputBatches[1].rows[0] as { payload?: unknown }).payload).toBeUndefined()
  })

  it('nextDispatchOrdinal is monotonic within a writer', () => {
    const { deps } = makeDeps()
    const w = new TranscriptWriter(deps)
    expect(w.nextDispatchOrdinal()).toBe(1)
    expect(w.nextDispatchOrdinal()).toBe(2)
    expect(w.nextDispatchOrdinal()).toBe(3)
  })

  it('close() fences appendDurable and no-ops in-flight commits (I3)', async () => {
    const appendBatch = vi.fn(async () => {})
    const { deps } = makeDeps({ appendBatch })
    const w = new TranscriptWriter(deps)
    w.close()
    await expect(w.appendDurable({ type: 'user', uuid: 'u' })).rejects.toThrow(/closed/)
    await w.recordDispatchAttempt({ operationId: 'u', dispatchOrdinal: 1, kind: 'user', payload: {} })
    expect(appendBatch).not.toHaveBeenCalled()
  })
})
