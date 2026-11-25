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

import { makeCommitV2, makeRebuildPendingRow, type GenerationRecord } from './transcript-sidecar.js'
import type { PendingOperation } from './transcript-reconcile.js'
import type { ResetJournal } from './reset-journal.js'

export interface DispatchOp {
  operationId: string
  dispatchOrdinal: number
  kind: 'user' | 'supplement' | 'control'
  /** Public wire payload — what the ring/broadcast publishes (D1). */
  payload: unknown
  /** Resolved provider payload (forSdk) the provider enqueue uses; falls back
   *  to `payload` when absent (plain-text sends). Distinct from `payload` for
   *  multimodal sends whose provider blocks are resolved neutral blocks (D2). */
  providerPayload?: unknown
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
  /** Signal a queued-not-published prompt to other tabs (WsMessageQueued, no
   *  seq) — the sending tab uses its optimistic placeholder (spec §8.1). */
  publishQueued: (op: DispatchOp) => void
  /** Ring push + lifecycle bookkeeping for a materialized prompt, AFTER its
   *  appendDurable fsync (durable-before-publish, D1). */
  afterMaterialize: (msg: unknown) => void
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
  private pendingCommits = 0
  private dispatchQueue: Promise<void> = Promise.resolve()
  private pendingDispatch = 0
  private queued: DispatchOp[] = []
  private deferred: Array<{ msg: unknown; seq: number }> = []
  private pending: PendingOperation[] = []
  private degradedFlag = false
  private rebuildingFlag = false
  private closedFlag = false
  readonly ledger: GenerationLedger
  clearEpoch = 0
  rebaseEpoch = 0
  private dispatchOrdinalCounter = 0

  constructor(
    private deps: WriterDeps,
    initialGeneration = 0,
  ) {
    this.ledger = new GenerationLedger(initialGeneration)
  }

  /** A writer scoped to generation RESETS only (spec §8.3 clear/compact):
   *  resetGeneration uses just `appendBatch` + the ledger, so the live-append
   *  deps (record/publish/dispatch) are not wired here and fail LOUDLY if
   *  called — live durable append through the writer is the T7b follow-up.
   *  Initialized to the holder's current generation so ledger.next yields the
   *  same `prev + 1` the caller prepared in the journal. */
  static forReset(appendBatch: WriterDeps['appendBatch'], initialGeneration: number): TranscriptWriter {
    const notWired = (): never => {
      throw new Error('reset-only writer: live append/dispatch not wired (T7b)')
    }
    return new TranscriptWriter(
      {
        appendBatch,
        recordSeq: notWired,
        headSeq: () => initialGeneration,
        publish: notWired,
        dispatchUser: async () => { notWired() },
        dispatchSupplement: async () => notWired(),
        dispatchControl: async () => { notWired() },
        isTurnActive: () => false,
        generation: () => initialGeneration,
        publishQueued: notWired,
        afterMaterialize: notWired,
      },
      initialGeneration,
    )
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
   *  the error propagates to the caller (durable-before-publish barrier). A
   *  closed writer no-ops: an in-flight commit queued before unload/discard
   *  must not resurrect a fresh holder/sidecar after teardown (I3). */
  private commit(rows: object[], commit: object): Promise<void> {
    const run = this.writerQueue.then(() => {
      if (this.closedFlag) return
      return this.deps.appendBatch(rows, commit)
    })
    this.pendingCommits++
    this.writerQueue = run.catch(() => {}).finally(() => { this.pendingCommits-- })
    return run
  }

  /** Fence the writer on teardown (unload/discard/retry): in-flight commits
   *  no-op instead of re-resolving a fresh holder and appending after close. */
  close(): void {
    this.closedFlag = true
  }

  /** Whether any durable commit is still queued or in flight on writerQueue.
   *  Teardown drains CONDITIONALLY on this: an unconditional `await drain()`
   *  yields a microtask even when the queue is idle, which would break unload's
   *  synchronous writeStore contract for fire-and-forget callers (e.g. setCwd
   *  reads the persisted meta right after `void unload()`). Mirrors the
   *  conditional eviction drain. */
  get hasPendingCommits(): boolean {
    return this.pendingCommits > 0
  }

  /** Resolve once every queued commit has run its appendBatch (submitted the
   *  batch to the sidecar). Returns the error-swallowed queue tail, so awaiting
   *  it never rejects. Teardown awaits this BEFORE dropping the transcript holder
   *  so a pending commit's appendBatch resolves the ORIGINAL sidecar via the
   *  dynamic holder() dep — not a re-created one whose recoverTail would truncate
   *  the landed v1 suffix. */
  drain(): Promise<void> {
    return this.writerQueue
  }

  /** Whether a dispatchQueue task is still queued or in flight. dispatchQueue
   *  FEEDS writerQueue (recordDispatchAttempt / enqueueDispatch chain inputCommit
   *  → commit), so a task running during a writer-only drain can issue a NEW
   *  commit after the drain snapshots the tail — that commit would then run after
   *  teardown drops the holder and re-create the sidecar. Teardown quiesces BOTH
   *  chains; this indicator (with hasPendingCommits) gates the conditional
   *  fast-path so an idle writer never yields. */
  get hasPendingDispatch(): boolean {
    return this.pendingDispatch > 0
  }

  /** True when either chain has pending work — the teardown fast-path gate. */
  get hasPendingWork(): boolean {
    return this.pendingCommits > 0 || this.pendingDispatch > 0
  }

  /** Quiesce BOTH serial chains before teardown drops the holder: let
   *  dispatchQueue issue its commits, then writerQueue run them, repeating until
   *  neither has pending work. Convergence is guaranteed and hang-free — the feed
   *  is one-directional (dispatchQueue → writerQueue; a commit never re-enters
   *  dispatch), each dispatch task issues a finite number of commits, dispatchUser
   *  is a synchronous provider enqueue (no turn await), and external input stops
   *  once the session leaves the live map. Returns the error-swallowed tails, so
   *  this never rejects. */
  async quiesce(): Promise<void> {
    while (this.hasPendingWork) {
      await this.dispatchQueue
      await this.writerQueue
    }
  }

  /** Per-session monotonic dispatch ordinal (D6): orders queued prompts at
   *  materialization and recovery. */
  nextDispatchOrdinal(): number {
    return ++this.dispatchOrdinalCounter
  }

  /** Raise the dispatch-ordinal floor past a recovered/replayed max WITHOUT
   *  enqueuing (the drained bucket replays straight to the provider, never the
   *  queued queue — final review #3, RF5). Bump-only: a lower ordinal never
   *  lowers the floor. */
  seedDispatchOrdinal(ordinal: number): void {
    if (ordinal > this.dispatchOrdinalCounter) this.dispatchOrdinalCounter = ordinal
  }

  /** Record the durable dispatch states (enqueue-not-attempted → enqueue-
   *  attempted) for a prompt the manager dispatches synchronously (T7b Task 1).
   *  Fire-and-forget from the send path so synchronous dispatch timing is
   *  preserved; the states feed crash recovery (Task 6). The full durable-
   *  before-publish async dispatch (enqueueDispatch) is Task 2. */
  recordDispatchAttempt(op: DispatchOp): Promise<void> {
    const run = this.dispatchQueue.then(async () => {
      await this.inputCommit(op, 'enqueue-not-attempted')
      await this.inputCommit(op, 'enqueue-attempted')
    })
    this.pendingDispatch++
    this.dispatchQueue = run.catch(() => {}).finally(() => { this.pendingDispatch-- })
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
      // Carry the payload only on the FIRST state row per operationId (and on
      // queued-not-published) so crash recovery can re-materialize (D7) without
      // duplicating multi-MB image payloads on every state row (I4: the sidecar
      // is append-only and fully parsed on every reconcile). The classifier
      // joins back to the first row for the payload; the terminal/progress
      // states (enqueue-attempted, withdrawn) omit it.
      ...(state !== 'enqueue-attempted' && state !== 'withdrawn' ? { payload: op.payload } : {}),
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
    if (this.closedFlag) throw new Error('closed: transcript writer fenced')
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
    // Decide the queued route at CALL time and reserve the slot synchronously,
    // so a turn terminal that races the fire-and-forget commit still sees the
    // pending op (materializeQueued drains only after the commit, below). The
    // durable queued-not-published row + publishQueued still happen in order on
    // dispatchQueue.
    const willQueue = op.kind === 'user' && this.deps.isTurnActive()
    if (willQueue) this.queued.push(op)
    const run = this.dispatchQueue.then(async () => {
      if (willQueue) {
        await this.inputCommit(op, 'queued-not-published')
        this.deps.publishQueued(op)
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
    this.pendingDispatch++
    this.dispatchQueue = run.catch(() => {}).finally(() => { this.pendingDispatch-- })
    return run
  }

  /** Materialize queued-not-published root prompts at the prior turn terminal:
   *  allocate seq + publish + dispatch, in dispatchOrdinal order (spec §8.1).
   *  Chained on dispatchQueue so it waits for any in-flight enqueueDispatch
   *  (a mid-turn send fired fire-and-forget) to commit its queued-not-published
   *  row BEFORE draining — otherwise a turn ending before the commit lands
   *  would strand the prompt. appendDurable allocates the seq BEFORE
   *  dispatchUser enqueues, so the prompt seq precedes its assistant turn. */
  materializeQueued(): Promise<number> {
    // Common case (no mid-turn send this turn): nothing to materialize. Return
    // an already-resolved promise WITHOUT touching dispatchQueue, so the pump's
    // result processing is not delayed by unrelated in-flight dispatch-state
    // fsyncs (the working-state clear must stay synchronous-ish for idle turns).
    if (this.queued.length === 0) return Promise.resolve(0)
    const run = this.dispatchQueue.then(async () => {
      // Snapshot the ops present when this terminal's run starts. Later
      // arrivals — prompts queued DURING a materialized turn — belong to that
      // turn's terminal, not this one; materializing them here would interleave
      // their seq amid the materialized turn's still-streaming assistant blocks
      // (F8: the A,U,R inversion this feature exists to prevent).
      const targets = [...this.queued]
      let count = 0
      // Incremental: each op stays in `queued` until it is dispatched, so a
      // concurrent interrupt(cancelQueued) can still drain it mid-fsync (F1 —
      // a spliced-up-front op lives in neither queue and Stop would miss it),
      // and a failed appendDurable leaves it AND the rest queued for the next
      // terminal to retry rather than stranding already-spliced ops (F2).
      for (const op of targets) {
        if (!this.queued.includes(op)) break // withdrawn by an interrupt
        await this.appendDurable(op.payload) // seq allocation + broadcast
        // The interrupt may have drained this op during the fsync: it is now
        // withdrawn (the interrupt tombstones its seq), so skip the ring push
        // and the provider enqueue — Stop must cancel the about-to-start turn.
        if (!this.queued.includes(op)) break
        this.deps.afterMaterialize(op.payload)
        await this.deps.dispatchUser(op)
        this.queued = this.queued.filter((o) => o !== op)
        count++
      }
      return count
    })
    this.pendingDispatch++
    this.dispatchQueue = run.then(() => {}, () => {}).finally(() => { this.pendingDispatch-- })
    return run
  }

  /** Number of queued-not-published ops awaiting materialization. Read
   *  synchronously by the turn-terminal hook so the pump's working-state
   *  decision accounts for next-turn work WITHOUT blocking on the materialize
   *  fsync (the dispatch itself runs fire-and-forget on dispatchQueue). */
  get queuedCount(): number {
    return this.queued.length
  }

  /** Read-only view of the queued-not-published ops awaiting materialization.
   *  Seeds a fresh msgstat subscriber with `message-queued` frames so a tab
   *  reconnecting/reloading during the queue window recovers the pending bubble
   *  (the live `publishQueued` frame is fired once and never re-served). Each op
   *  carries the full public payload + clientOperationId. */
  get queuedOps(): readonly DispatchOp[] {
    return this.queued
  }

  /** Remove + return queued-not-published ops (withdrawal on interrupt, Task 5). */
  drainQueued(): DispatchOp[] {
    return this.queued.splice(0)
  }

  /** Seed crash-recovered ops (Task 6) into the queue for materialization at the
   *  prior turn terminal. The caller follows with materializeQueued(). Restored
   *  ops keep their pre-crash ordinals, so the counter resumes past the recovered
   *  max — a new send restarting at 1 would sort BEFORE them and invert the
   *  recovery materialization order across crashes. */
  enqueueRecovered(ops: readonly DispatchOp[]): void {
    for (const op of ops) {
      if (op.dispatchOrdinal > this.dispatchOrdinalCounter) this.dispatchOrdinalCounter = op.dispatchOrdinal
    }
    this.queued.push(...ops)
  }

  /** Commit a durable `withdrawn` input state per drained op (interrupt
   *  cancelQueued success path), chained on dispatchQueue so it lands AFTER any
   *  in-flight queued-not-published commit — crash recovery then sees
   *  `withdrawn` as the last state and never re-materializes the prompt (§7.3).
   *  The ops were already removed from `queued` by drainQueued (so the turn
   *  terminal cannot materialize them). */
  commitWithdrawnStates(ops: readonly DispatchOp[]): Promise<void> {
    if (ops.length === 0) return Promise.resolve()
    const run = this.dispatchQueue.then(async () => {
      for (const op of ops) await this.inputCommit(op, 'withdrawn')
    })
    this.pendingDispatch++
    this.dispatchQueue = run.catch(() => {}).finally(() => { this.pendingDispatch-- })
    return run
  }

  /** Restore drained queued-not-published ops after a FAILED interrupt so they
   *  are not silently lost — they materialize at the next turn terminal in
   *  their original dispatch order. */
  restoreQueued(ops: readonly DispatchOp[]): void {
    this.queued.unshift(...ops)
  }

  /** Persist a rebuild-quiesce drain as `drained-to-pending` (spec §8.1 step 3,
   *  Task 5): ONE input batch carrying every preserved entry's public payload,
   *  queueEntryId (operationId), kind and global dispatchOrdinal. This is NOT a
   *  withdrawal — classifyPendingInputs routes these to the read-only
   *  drainedToPending bucket (no auto re-dispatch); only the rebuild executor's
   *  explicit resume replay consumes them. Chained on dispatchQueue so the
   *  batch lands AFTER any in-flight queued-not-published / dispatch-state
   *  commit (the drained state must be the LAST input state per operationId).
   *  The provider payload is deliberately NOT stored: replay re-resolves
   *  attachment file blocks through the send-path resolver (spec §10), exactly
   *  as crash recovery does, so the sidecar never holds resolved native paths. */
  drainToPending(ops: readonly DispatchOp[]): Promise<void> {
    if (ops.length === 0) return Promise.resolve()
    const run = this.dispatchQueue.then(async () => {
      const batchId = nextBatchId()
      const rows = ops.map((op) => ({
        v: 2,
        batchId,
        operationId: op.operationId,
        dispatchOrdinal: op.dispatchOrdinal,
        state: 'drained-to-pending',
        inputKind: op.kind,
        payload: op.payload,
      }))
      await this.commit(
        rows,
        makeCommitV2({ batchId, batchType: 'input', generation: this.deps.generation(), reason: 'initial', contentPolicy: 'preserve', rows }),
      )
    })
    this.pendingDispatch++
    this.dispatchQueue = run.catch(() => {}).finally(() => { this.pendingDispatch-- })
    return run
  }

  /** Advance preserved entries past `drained-to-pending` once the resume replay
   *  has dispatched them (spec §8.1 step 6): commit `enqueue-attempted` per op
   *  so a crash mid-replay classifies them as dispatch-unknown (manual recovery,
   *  never auto re-dispatched) rather than stranding them in the read-only
   *  drained bucket. The materialized prompt row / consumed lifecycle resolves
   *  them on the next reconcile. */
  markDrainedDispatched(ops: readonly DispatchOp[]): Promise<void> {
    if (ops.length === 0) return Promise.resolve()
    const run = this.dispatchQueue.then(async () => {
      for (const op of ops) await this.inputCommit(op, 'enqueue-attempted')
    })
    this.pendingDispatch++
    this.dispatchQueue = run.catch(() => {}).finally(() => { this.pendingDispatch-- })
    return run
  }

  deferOldCommit(msg: unknown, seq: number): void {
    this.deferred.push({ msg, seq })
  }
  addPendingRebuild(op: PendingOperation): void {
    this.pending.push(op)
  }

  /** Initiate an ordered rebuild for one pending operation (spec §8.1/§8.3,
   *  Task 1): set the rebuilding flag, durably append a non-public `recovery`
   *  batch carrying the full rebuild-pending payload + entry identity (fsync
   *  BEFORE resolve), THEN add the op to pendingRebuilds. No seq, no ring, no
   *  WS frame — this record is the only write allowed before capability upgrade
   *  and never advances a client cursor.
   *
   *  All-or-nothing postcondition: on resolve the op is durable AND pending AND
   *  rebuilding is set; on rejection NOTHING is left behind — a closed writer
   *  rejects up front (mirrors appendDurable's fence, so a no-op commit can never
   *  smuggle a non-durable op into pendingRebuilds), and a write failure resets
   *  the flag and rethrows (durable-before-publish barrier), leaving
   *  pendingRebuilds empty and rebuilding false. Degraded-state admission is a
   *  Task 2 retry-semantics decision and is deliberately NOT fenced here. */
  async beginRebuild(op: PendingOperation): Promise<void> {
    if (this.closedFlag) throw new Error('closed: transcript writer fenced')
    this.rebuildingFlag = true
    const batchId = nextBatchId()
    const row = makeRebuildPendingRow(op, batchId, this.nextDispatchOrdinal())
    try {
      await this.commit(
        [row],
        makeCommitV2({ batchId, batchType: 'recovery', generation: this.deps.generation(), reason: 'initial', contentPolicy: 'preserve', rows: [row] }),
      )
    } catch (err) {
      this.rebuildingFlag = false
      throw err
    }
    this.addPendingRebuild(op)
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
