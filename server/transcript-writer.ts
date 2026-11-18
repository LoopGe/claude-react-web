/**
 * transcript-writer — per-session durable writer + dispatch queue + generation
 * ledger (spec §8.1–§8.3).
 *
 * Two serial chains: `writerQueue` orders durable commits (append/reconcile/
 * eviction/reset/input/lifecycle); `dispatchQueue` orders provider dispatch by
 * dispatchOrdinal. The provider call NEVER holds writerQueue, so a synchronous
 * direct hand-off `onUserMessageConsumed` can re-enter the writer to commit
 * lifecycle metadata without deadlock. Durable-before-publish: a frame is
 * published only after its batch commit record is fsynced (appendBatch).
 *
 * Dependencies are injected so the state machine is unit-testable without fs;
 * SessionManager wires the real sidecar/store/provider in Tasks 6–7.
 */

import { makeCommitV2, type GenerationRecord } from './transcript-sidecar.js'
import type { PendingOperation } from './transcript-reconcile.js'
import type { ResetJournal } from './reset-journal.js'

export interface DispatchOp {
  operationId: string
  dispatchOrdinal: number
  kind: 'user' | 'supplement' | 'control'
  payload: unknown
  clientOperationId?: string
}

export interface WriterDeps {
  appendBatch: (rows: object[], commit: object) => Promise<void>
  recordSeq: (uuid: string | null, msg: unknown) => number
  headSeq: () => number
  publish: (msg: unknown, seq: number) => void
  dispatchUser: (op: DispatchOp) => Promise<void>
  dispatchSupplement: (op: DispatchOp) => Promise<boolean>
  dispatchControl: (op: DispatchOp) => Promise<void>
  isTurnActive: () => boolean
  generation: () => number
}

/** Per-session monotonic uint53 generation (spec §8.3). No state-dir lock —
 *  the session writer serializes allocation. A migration (clientFloor given)
 *  jumps past max(Date.now(), previous+1, clientFloor+1) so an old tab's small
 *  floor can never exceed it. */
export class GenerationLedger {
  private current: number
  constructor(initial: number) {
    this.current = initial
  }
  get value(): number {
    return this.current
  }
  next(reason: GenerationRecord['reason'], clientFloor?: number): number {
    const isMigration = reason === 'recovery' || reason === 'ordered-rebuild'
    const next =
      isMigration && clientFloor !== undefined
        ? Math.max(Date.now(), this.current + 1, clientFloor + 1)
        : this.current + 1
    this.current = next
    return next
  }
}

let batchCounter = 0
const nextBatchId = (): string => `b${++batchCounter}`

export class TranscriptWriter {
  private writerQueue: Promise<void> = Promise.resolve()
  private dispatchQueue: Promise<void> = Promise.resolve()
  private queued: DispatchOp[] = []
  private deferred: Array<{ msg: unknown; seq: number }> = []
  private pending: PendingOperation[] = []
  private degradedFlag = false
  private rebuildingFlag = false
  readonly ledger: GenerationLedger
  clearEpoch = 0
  rebaseEpoch = 0

  constructor(
    private deps: WriterDeps,
    initialGeneration = 0,
  ) {
    this.ledger = new GenerationLedger(initialGeneration)
  }

  get degraded(): boolean {
    return this.degradedFlag
  }
  get rebuilding(): boolean {
    return this.rebuildingFlag
  }
  get pendingRebuilds(): PendingOperation[] {
    return this.pending
  }

  /** Serial durable commit; the chain stays alive even if one batch fails, but
   *  the error propagates to the caller (durable-before-publish barrier). */
  private commit(rows: object[], commit: object): Promise<void> {
    const run = this.writerQueue.then(() => this.deps.appendBatch(rows, commit))
    this.writerQueue = run.catch(() => {})
    return run
  }

  private inputCommit(op: DispatchOp, state: string, route?: string): Promise<void> {
    const batchId = nextBatchId()
    const row = {
      v: 2,
      batchId,
      operationId: op.operationId,
      dispatchOrdinal: op.dispatchOrdinal,
      state,
      ...(route ? { route } : {}),
    }
    return this.commit(
      [row],
      makeCommitV2({ batchId, batchType: 'input', generation: this.deps.generation(), reason: 'initial', contentPolicy: 'preserve', rows: [row] }),
    )
  }

  /** Allocate seq, fsync the batch+commit, THEN publish (spec §8.1). Rejects in
   *  degraded state and on write failure (nothing published). */
  async appendDurable(msg: unknown): Promise<{ seq: number } | null> {
    if (this.degradedFlag) throw new Error('degraded: transcript writer fenced')
    const uuid = typeof (msg as { uuid?: unknown })?.uuid === 'string' ? (msg as { uuid: string }).uuid : null
    const seq = this.deps.recordSeq(uuid, msg)
    const batchId = nextBatchId()
    const m = msg as { type?: unknown; subtype?: unknown }
    const row = { v: 2, batchId, seq, uuid, type: m.type, subtype: m.subtype, msg }
    await this.commit(
      [row],
      makeCommitV2({ batchId, batchType: 'live', generation: this.deps.generation(), reason: 'initial', contentPolicy: 'preserve', rows: [row] }),
    )
    this.deps.publish(msg, seq)
    return { seq }
  }

  /** Re-entrant lifecycle metadata commit (consumed/steered/requeued). Safe to
   *  call from a synchronous provider hand-off because writerQueue is free
   *  during dispatch. */
  async commitLifecycle(operationId: string, state: string): Promise<void> {
    const batchId = nextBatchId()
    const row = { v: 2, batchId, operationId, state }
    await this.commit(
      [row],
      makeCommitV2({ batchId, batchType: 'lifecycle', generation: this.deps.generation(), reason: 'initial', contentPolicy: 'preserve', rows: [row] }),
    )
  }

  /** Serial provider dispatch. Commits enqueue-not-attempted → enqueue-attempted
   *  BEFORE the provider call, then releases the writer across the call. A
   *  queued root prompt during an active turn is committed queued-not-published
   *  (no seq, no ring) and materialized later (spec §8.1). */
  enqueueDispatch(op: DispatchOp): Promise<void> {
    const run = this.dispatchQueue.then(async () => {
      if (op.kind === 'user' && this.deps.isTurnActive()) {
        await this.inputCommit(op, 'queued-not-published')
        this.queued.push(op)
        return
      }
      await this.inputCommit(op, 'enqueue-not-attempted')
      await this.inputCommit(op, 'enqueue-attempted')
      if (op.kind === 'supplement') {
        const ok = await this.deps.dispatchSupplement(op)
        if (!ok) {
          // Synchronous admission rejection: persist the rejection + fallback
          // route before the user-message fallback (not dispatch-unknown).
          await this.inputCommit(op, 'supplement-rejected', 'user-message')
          const fallback: DispatchOp = { ...op, kind: 'user' }
          await this.inputCommit(fallback, 'enqueue-not-attempted')
          await this.deps.dispatchUser(fallback)
        }
      } else if (op.kind === 'control') {
        await this.deps.dispatchControl(op)
      } else {
        await this.deps.dispatchUser(op)
      }
    })
    this.dispatchQueue = run.catch(() => {})
    return run
  }

  /** Materialize queued-not-published root prompts at the prior turn terminal:
   *  allocate seq + publish + dispatch, in dispatchOrdinal order (spec §8.1). */
  async materializeQueued(): Promise<void> {
    const ops = this.queued.splice(0)
    for (const op of ops) {
      await this.appendDurable(op.payload)
      await this.deps.dispatchUser(op)
    }
  }

  deferOldCommit(msg: unknown, seq: number): void {
    this.deferred.push({ msg, seq })
  }
  addPendingRebuild(op: PendingOperation): void {
    this.pending.push(op)
  }

  /** Release deferred old-generation commits in order; retain pendingRebuilds
   *  for retry. 'failed' fences the writer; 'cancelled' restores it (spec §8.1). */
  async abortRebuild(outcome: 'cancelled' | 'failed'): Promise<void> {
    const deferred = this.deferred.splice(0)
    for (const d of deferred) this.deps.publish(d.msg, d.seq)
    if (outcome === 'failed') this.degradedFlag = true
    this.rebuildingFlag = false
  }

  /** Write a reset generation batch (empty for clear) + commit + fsync, bump the
   *  matching epoch (spec §8.3). The sidecar is NOT deleted.
   *
   *  Two-phase with a journal: the caller `prepare`s the journal BEFORE the
   *  provider op, then calls this (batch + fsync), then this `commit`s the
   *  journal AFTER the batch is durable — the journal commit is the publication
   *  marker. Epochs then live in the journal (persisted); the writer's epoch
   *  fields sync from it. Journal-less callers keep the in-memory bump. */
  async resetGeneration(reason: GenerationRecord['reason'], clientFloor?: number, journal?: ResetJournal): Promise<number> {
    const gen = this.ledger.next(reason, clientFloor)
    const batchId = nextBatchId()
    const commit = makeCommitV2({
      batchId,
      batchType: 'reset',
      generation: gen,
      reason,
      contentPolicy: reason === 'clear' ? 'replace' : 'preserve',
      rows: [],
    })
    await this.commit([], commit)
    if (journal) {
      await journal.commit(gen)
      this.clearEpoch = journal.clearEpoch
      this.rebaseEpoch = journal.rebaseEpoch
    } else if (reason === 'clear' || reason === 'compact') {
      this.clearEpoch++
    } else {
      this.rebaseEpoch++
    }
    return gen
  }
}
