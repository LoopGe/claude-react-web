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

describe('TranscriptWriter.enqueueDispatch (spec §8.1)', () => {
  it('commits enqueue-attempted before the provider call; a sync consumed callback re-enters without deadlock', async () => {
    const order: string[] = []
    const appendBatch = vi.fn(async (rows: object[]) => {
      order.push(`commit:${(rows[0] as { state?: string }).state ?? ''}`)
    })
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
