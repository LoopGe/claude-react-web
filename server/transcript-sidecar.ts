/**
 * TranscriptSidecar — ndjson persistence for one session's transcript seq
 * store (the seq authority; the SDK's JSONL stays the raw message truth).
 *
 * One append-only file per session under <stateDir>/transcripts/<id>.ndjson.
 * Row shapes (spec §2):
 *   - message row:  { seq, uuid, type, subtype, msg }   (msg = the live wire
 *     shape — the same object the ring/replay carries, post tool_result trim)
 *   - tombstone row:{ seq, evicted: true }
 * Rows are appended in seq order by the pump path; tombstones may also be
 * appended when a message is evicted after the fact (foldSidecarRows folds
 * them back onto the base row at load time).
 *
 * Crash safety: appends go through a per-instance serial promise queue onto
 * a single reused file handle opened in append mode — the pump fires
 * recordTranscriptMessage fire-and-forget, so back-to-back ingests must not
 * interleave half-written lines. A torn final line (crash mid-write) is
 * tolerated at load: the unparseable line is skipped with a warning.
 *
 * This is the ONLY node:fs touchpoint of the transcript seq subsystem —
 * TranscriptStore (seq bookkeeping) and the reconcile/fold helpers below are
 * pure or fs-free, so they stay unit-testable without a temp dir.
 */

import { mkdir, open, readFile, unlink, truncate } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { dirname, basename, join } from 'node:path'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { createLogger } from './log.js'
import { assistantMessageShapeOf } from '../shared/assistant-message.js'
import type { HydrateRow, TranscriptStore } from './transcript-store.js'
import type { PendingOperation } from './transcript-reconcile.js'
import { isRenderableSdkMessage } from './history-utils.js'

const log = createLogger('transcript')

/** One raw ndjson line as loaded from disk (shape validated by consumers). */
export type SidecarRow = Record<string, unknown>

/** Structural shape the shared renderability predicate reads (loose so the
 *  seq path stays SDK-type-free — live SDKMessages and disk RawLines both
 *  satisfy it). */
type RenderableCheck = Parameters<typeof isRenderableSdkMessage>[0]

/** Shared shape of the per-session seq-store state SessionManager keeps.
 *  `reconciled` flips once the store has been hydrated from the sidecar and
 *  back-filled against the on-disk JSONL (see SessionManager's reconcile);
 *  until then the store may be missing pre-restart history. */
export interface TranscriptHolder {
  store: TranscriptStore
  sidecar: TranscriptSidecar
  reconciled: boolean
  /** True when reconcile swallowed a read failure: the store keeps whatever
   *  hydrated/appended before the failure and is still usable, but may be
   *  missing pre-restart history. Session search reports this as
   *  `indexStatus: 'degraded'`. */
  degraded: boolean
  /** Set when an ordered-rebuild was refused because an incapable browser
   *  subscriber is attached (spec §8.3). Distinct from `degraded`: the old
   *  projection is intact and append-only reads/writes continue; only the
   *  rebuild waits for the legacy tab to reload. Cleared by a successful
   *  retry (which re-reconciles from a fresh holder). */
  rebuildBlocked?: 'client-upgrade-required'
  /** True once the session's committed generation history contains an
   *  ordered-rebuild (spec §8.3): subsequent subscribes must declare
   *  orderedRebaseV1. Derived from the sidecar fold on hydrate, so it
   *  survives restarts. */
  hasOrderedRebuild?: boolean
  /** Committed generation/reset history (spec §8.3), cached from the sidecar
   *  fold on hydrate and extended on rebuild. Source for the client-facing
   *  epochs (clearEpoch/rebaseEpoch) and lastFullResetGeneration. */
  generationHistory?: GenerationRecord[]
  /** Crash-recovery classification of the durable dispatch states (spec §7.2,
   *  T7b Task 6), computed from the sidecar input batches on reconcile. The
   *  resume path materializes/re-dispatches `queued`/`notAttempted` and surfaces
   *  `dispatchUnknown` for manual recovery. Undefined until reconciled. */
  pendingRecovery?: PendingInputView
  /** Set while a rebuild-pending operation awaits its committed generation
   *  (spec §8.1): transcript-mutation admission is closed — send / scheduled
   *  fire / fork / discard / Side Chat pre-seed answer 409 REBUILD_REQUIRED.
   *  Distinct from `degraded` (the projection is intact, not broken) and from
   *  `rebuildBlocked` (a capability refusal of the rebuild itself). OWNED BY
   *  THE MANAGER: the writer's abortRebuild manages writer state only; the
   *  manager's beginTranscriptRebuild / abortTranscriptRebuild / reconcile
   *  paths are the flag's writers. Cleared when the pending operation enters
   *  a committed generation, or on abortTranscriptRebuild(id, 'cancelled'). */
  rebuildAdmissionPending?: boolean
}

export class TranscriptSidecar {
  private readonly file: string | null
  private handle: FileHandle | null = null
  private removed = false
  private closed = false
  /** Serial queue: every append (and remove's fd close) chains onto the tail
   *  so concurrent appends land in call order without interleaved writes. */
  private queue: Promise<void> = Promise.resolve()

  constructor(
    dir: string | undefined,
    private readonly sessionId: string,
  ) {
    // Tolerate an absent state dir (standalone buildApp / unit tests that
    // never hit the manager): the sidecar no-ops rather than crashing
    // path.join on undefined — same pattern as TurnAnchorStore.
    this.file = dir ? join(dir, 'transcripts', `${basename(sessionId)}.ndjson`) : null
  }

  /** Load every row from the ndjson file. A torn/corrupt line (crash mid-
   *  append) is skipped with a warning. A torn tail WITHOUT a trailing newline
   *  also fuses with the next append's first row, so the loss is not confined
   *  to the last row: recoverTail clips the incomplete physical tail before
   *  the next write (byte-exact), and a committed batch left row-short by a
   *  buried tear is demoted by the fold and rebuilt from the provider log —
   *  never a fatal degrade. ENOENT (no sidecar yet) is an empty load. */
  async load(): Promise<SidecarRow[]> {
    if (!this.file) return []
    let raw: string
    try {
      raw = await readFile(this.file, 'utf8')
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return []
      log.warn(`[session ${this.sessionId}] sidecar load failed: ${(err as Error).message ?? err}`)
      return []
    }
    const rows: SidecarRow[] = []
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        rows.push(JSON.parse(trimmed) as SidecarRow)
      } catch {
        log.warn(`[session ${this.sessionId}] sidecar: skipping torn line (parse failed)`)
      }
    }
    return rows
  }

  /** Append one row. Fire-and-forget safe: the returned promise resolves
   *  when THIS row's write has landed, but callers on the pump path don't
   *  need to await it — the internal queue still orders the writes. */
  async appendRow(row: object): Promise<void> {
    if (!this.file || this.removed || this.closed) return
    this.queue = this.queue
      .then(async () => {
        if (this.removed) return
        const handle = await this.ensureHandle()
        await handle.writeFile(JSON.stringify(row) + '\n')
      })
      .catch(async (err) => {
        // Swallow so one failed write doesn't poison the chain. Release the
        // failed descriptor before dropping it so a later close/remove cannot
        // inherit an untracked open handle (especially fatal on Windows).
        const failedHandle = this.handle
        this.handle = null
        if (failedHandle) {
          try {
            await failedHandle.close()
          } catch (closeErr) {
            log.warn(`[session ${this.sessionId}] sidecar failed-handle close failed: ${(closeErr as Error).message ?? closeErr}`)
          }
        }
        log.warn(`[session ${this.sessionId}] sidecar append failed: ${(err as Error).message ?? err}`)
      })
    await this.queue
  }

  /** Prevent any later append from reopening the file after deletion. */
  tombstone(): void {
    this.removed = true
  }

  /** Stop appends, drain the queue, and close the fd while preserving the
   *  file for a later resume. */
  async close(opts?: { strict?: boolean }): Promise<void> {
    if (!this.file) return
    this.closed = true
    await this.queue.catch(() => {})
    if (this.handle) {
      try {
        await this.handle.close()
      } catch (err) {
        if (opts?.strict) throw err
        log.warn(`[session ${this.sessionId}] sidecar close failed: ${(err as Error).message ?? err}`)
      }
      this.handle = null
    }
  }

  /** Remove the sidecar file: drain pending appends, close the fd, then
   *  unlink. ENOENT counts as success (nothing to remove). */
  async remove(opts?: { strict?: boolean }): Promise<void> {
    if (!this.file) return
    this.tombstone()
    await this.close(opts)
    try {
      await unlink(this.file)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') {
        if (opts?.strict) throw err
        log.warn(`[session ${this.sessionId}] sidecar remove failed: ${(err as Error).message ?? err}`)
      }
    }
  }

  private async ensureHandle(): Promise<FileHandle> {
    if (!this.handle) {
      // mkdir before open: the transcripts/ dir is created on first append,
      // not at construction (a manager with zero seq-assigned messages
      // shouldn't leave an empty tree behind).
      await mkdir(dirname(this.file!), { recursive: true })
      // Recover a crash tail before appending so a torn partial line is never
      // concatenated onto (spec §8.2/§9). Runs once per handle open.
      await this.recoverTail()
      this.handle = await open(this.file!, 'a')
    }
    return this.handle
  }

  /** Drop only an incomplete physical tail (a crash mid-write leaves a final
   *  line WITHOUT a trailing newline) so the next append never concatenates
   *  onto it. Keeps every complete line — including the committed v1 suffix
   *  that legitimately follows the last v2 generation commit (the fold replays
   *  it, spec §8.2); truncating to the last commit instead would discard the
   *  final turn's rows. Uncommitted v2 batches left intact are ignored by the
   *  fold, and a corrupt committed batch is demoted there — neither needs
   *  physical truncation. Byte-exact (UTF-8), so a multibyte row is never
   *  clipped mid-character. No-op for an empty/missing/clean file. */
  private async recoverTail(): Promise<void> {
    if (!this.file) return
    let raw: string
    try {
      raw = await readFile(this.file, 'utf8')
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return
      throw err
    }
    if (raw.length === 0) return
    const lastNl = raw.lastIndexOf('\n')
    const prefix = lastNl >= 0 ? raw.slice(0, lastNl + 1) : ''
    const prefixBytes = Buffer.byteLength(prefix, 'utf8')
    if (prefixBytes < Buffer.byteLength(raw, 'utf8')) {
      await truncate(this.file, prefixBytes)
      const h = await open(this.file, 'r+')
      try {
        await h.sync()
      } finally {
        await h.close()
      }
    }
  }

  /** Durable batch append (spec §8.1/§8.2): write all rows + the commit record,
   *  then fsync BEFORE resolving. Unlike appendRow this PROPAGATES write/sync
   *  errors (the durable-before-publish barrier must not swallow a failure).
   *  The serial chain stays alive for later appends even if this batch fails. */
  async appendBatch(rows: readonly object[], commit: object): Promise<void> {
    if (!this.file || this.removed || this.closed) return
    const payload = [...rows, commit].map((r) => JSON.stringify(r)).join('\n') + '\n'
    const run = this.queue.then(async () => {
      if (this.removed) return
      const handle = await this.ensureHandle()
      try {
        await handle.writeFile(payload)
        await handle.sync()
      } catch (err) {
        // Release the failed descriptor so a later close/remove cannot inherit
        // an untracked open handle (fatal on Windows); surface the error.
        this.handle = null
        try {
          await handle.close()
        } catch {
          /* best-effort release */
        }
        throw err
      }
    })
    this.queue = run.catch(() => {})
    await run
  }

  private baselinePath(): string | null {
    return this.file ? this.file.replace(/\.ndjson$/, '.v1baseline.json') : null
  }

  /** Persist the v1→v2 migration recovery baseline (spec §9): the original v1
   *  byte length + sha256, fsynced, so a pre-commit crash can restore the v1
   *  prefix instead of leaving an unrecoverable mixed file. */
  async writeV1Baseline(b: V1MigrationBaseline): Promise<void> {
    const p = this.baselinePath()
    if (!p) return
    await mkdir(dirname(p), { recursive: true })
    const handle = await open(p, 'w')
    try {
      await handle.writeFile(JSON.stringify(b))
      await handle.sync()
    } finally {
      await handle.close()
    }
  }

  async readV1Baseline(): Promise<V1MigrationBaseline | null> {
    const p = this.baselinePath()
    if (!p) return null
    try {
      const raw = await readFile(p, 'utf8')
      const parsed = JSON.parse(raw) as V1MigrationBaseline
      if (typeof parsed.sourceByteLength !== 'number' || typeof parsed.sourceSha256 !== 'string') return null
      return parsed
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return null
      throw err
    }
  }
}

/** One committed generation's reset metadata (spec §8.3/§9). */
export interface GenerationRecord {
  generation: number
  reason: 'initial' | 'ordered-rebuild' | 'clear' | 'compact' | 'recovery'
  contentPolicy: 'preserve' | 'replace'
}

/** v1→v2 migration recovery baseline (spec §9). */
export interface V1MigrationBaseline {
  sourceByteLength: number
  sourceSha256: string
}

/** Stable sha256 over a batch's row payloads (canonical JSON array). */
export function batchChecksum(rows: readonly object[]): string {
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex')
}

/** Build a v2 commit record for a batch (count + checksum over its rows). */
export function makeCommitV2(opts: {
  batchId: string
  batchType: 'generation' | 'live' | 'recovery' | 'lifecycle' | 'input' | 'reset'
  generation: number
  reason: GenerationRecord['reason']
  contentPolicy: GenerationRecord['contentPolicy']
  rows: readonly object[]
}): SidecarRow {
  return {
    v: 2,
    commit: true,
    batchId: opts.batchId,
    batchType: opts.batchType,
    generation: opts.generation,
    reason: opts.reason,
    contentPolicy: opts.contentPolicy,
    count: opts.rows.length,
    checksum: batchChecksum(opts.rows),
  }
}

/** Durable row for one rebuild-pending operation (spec §8.1/§8.3), appended in
 *  a non-public `recovery` batch. Carries the full wire payload (`op.entry.msg`)
 *  PLUS the entry identity (occurrenceId/source/aliases/evicted): the pure
 *  reader cannot re-derive the composition layer's disambiguated occurrenceId
 *  (a content-hash ctx, see SessionManager.reconcileOrdered), so persisting it
 *  is what makes crash recovery reconstruct the EXACT PendingOperation and the
 *  rebuild include it exactly once. `dispatchOrdinal` orders recovered ops. */
export function makeRebuildPendingRow(op: PendingOperation, batchId: string, dispatchOrdinal: number): SidecarRow {
  return {
    v: 2,
    batchId,
    kind: 'rebuild-pending',
    operationId: op.operationId,
    dispatchOrdinal,
    payload: op.entry.msg,
    occurrenceId: op.entry.occurrenceId,
    source: op.entry.source,
    aliases: op.entry.aliases,
    evicted: op.entry.evicted,
  }
}

interface ParsedBatch {
  batchId: string
  rows: SidecarRow[]
  commit: SidecarRow | null
}

/** Validate a complete commit record. Returns the corruption reason, or null
 *  when valid. A count/checksum mismatch is crash damage (a torn tail ate a
 *  row), NOT a fatal state — the caller demotes the batch and rebuilds from
 *  the authoritative provider log rather than permanently degrading. */
function validateCommit(b: ParsedBatch): string | null {
  const c = b.commit!
  if (typeof c.count !== 'number' || c.count !== b.rows.length) {
    return `batch ${b.batchId} count mismatch`
  }
  if (batchChecksum(b.rows) !== c.checksum) {
    return `batch ${b.batchId} checksum mismatch`
  }
  return null
}

/** Group v2 rows into batches in file order; a commit record closes its batch.
 *  A complete-but-INVALID commit is demoted: its batch (and rows) are excluded
 *  from `batches` and reported in `corrupt` — the fold then adopts the latest
 *  VALID committed generation (or falls back to v1), and reconcile rebuilds.
 *  Trailing batches with no commit record are returned uncommitted
 *  (commit:null). v1 rows are skipped. */
/** A demoted corrupt commit: its batch id, the validation reason, its
 *  generation (when declared), and the commit ROW itself (identity, so a
 *  later valid re-commit reusing the same batch id is not mistaken for it). */
export interface CorruptBatch {
  batchId: string
  reason: string
  generation?: number
  commit: SidecarRow
}

function parseBatches(rows: readonly SidecarRow[]): {
  batches: ParsedBatch[]
  corrupt: CorruptBatch[]
} {
  const committed: ParsedBatch[] = []
  const corrupt: CorruptBatch[] = []
  const open = new Map<string, ParsedBatch>()
  for (const row of rows) {
    if (row.v !== 2) continue
    const batchId = typeof row.batchId === 'string' ? row.batchId : null
    if (batchId === null) continue
    if (row.commit === true) {
      const b = open.get(batchId) ?? { batchId, rows: [], commit: null }
      b.commit = row
      const reason = validateCommit(b)
      if (reason !== null) {
        // Demote: drop the batch and its rows entirely (the fold's
        // committedBatchIds gate would exclude them anyway).
        corrupt.push({
          batchId,
          reason,
          generation: typeof row.generation === 'number' ? row.generation : undefined,
          commit: row,
        })
      } else {
        committed.push(b)
      }
      open.delete(batchId)
    } else {
      const b = open.get(batchId) ?? { batchId, rows: [], commit: null }
      b.rows.push(row)
      open.set(batchId, b)
    }
  }
  return { batches: [...committed, ...open.values()], corrupt }
}

/** The corrupt batches that still affect the adopted projection — i.e. not
 *  superseded by a valid committed generation at or above their own. After a
 *  successful rebuild the corrupt batch is superseded, so this returns empty
 *  and the caller does not re-warn on every reconcile (a permanent false
 *  alarm would mask genuine new corruption). With no committed generation,
 *  every corrupt batch is active (the v1 fallback discarded them all). */
export function unsupersededCorrupt(folded: {
  corrupt: CorruptBatch[]
  generation: number
  hasCommittedGeneration: boolean
}): CorruptBatch[] {
  if (!folded.hasCommittedGeneration) return folded.corrupt
  return folded.corrupt.filter((c) => (c.generation ?? Number.MAX_SAFE_INTEGER) > folded.generation)
}

/** Fold v2 rows: adopt the latest committed generation, then replay every row
 *  AFTER that generation's commit record in file order — both committed v2
 *  live/recovery/lifecycle/input batches AND the v1 suffix that live ingest /
 *  eviction still append after a rebuild (spec §8.2). The pre-migration v1
 *  prefix and any superseded earlier generations are ignored. Uncommitted
 *  trailing batches are ignored. Complete-invalid commits are demoted (their
 *  rows excluded, reported in `corrupt`) — the caller rebuilds from the
 *  provider log rather than degrading to an empty window.
 *
 *  `hasCommittedGeneration` is false when no v2 generation has committed yet
 *  (e.g. a crash before the first commit) — the caller must then fall back to
 *  the intact v1 projection rather than an empty v2 one. `aliases` carries
 *  coverage alias→covering-seq mappings for the store to register. */
export function foldSidecarRowsV2(rows: readonly SidecarRow[]): {
  entries: HydrateRow[]
  generation: number
  history: GenerationRecord[]
  hasCommittedGeneration: boolean
  aliases: Array<{ uuid: string; seq: number }>
  corrupt: CorruptBatch[]
} {
  const { batches, corrupt } = parseBatches(rows)
  const committed = batches.filter((b) => b.commit !== null)
  const genBatches = committed.filter(
    (b) => b.commit!.batchType === 'generation' || b.commit!.batchType === 'reset',
  )
  const bySeq = new Map<number, HydrateRow>()
  const occToSeq = new Map<string, number>()
  const aliases: Array<{ uuid: string; seq: number }> = []
  // Gen-0 mixed files interleave v1 pump-ingest/eviction rows with the writer's
  // v2 live batches (no generation/reset batch yet). The v1 segment must keep
  // the v1 fold's guarantees (I1): tombstone-before-base stickiness, a
  // duplicate-base-seq throw, and the duplicate-assistant heal. Enabled only
  // in the gen-0 branch below; the post-rebuild path keeps pure v2 semantics.
  let v1Stickiness = false
  const baseSeen = new Set<number>()
  const isTombstoneOnly = (row: SidecarRow): boolean => row.evicted === true && row.msg === undefined
  const applyMsg = (row: SidecarRow): void => {
    if (typeof row.seq !== 'number') return
    if (v1Stickiness) {
      if (!Number.isInteger(row.seq) || row.seq < 0) return
      // Two distinct BASE rows sharing one seq is corruption (spec §9): a
      // Map last-wins would silently hide the overwritten occurrence.
      if (baseSeen.has(row.seq)) throw new Error(`duplicate-seq: ${row.seq}`)
      baseSeen.add(row.seq)
    }
    bySeq.set(row.seq, {
      seq: row.seq,
      uuid: typeof row.uuid === 'string' ? row.uuid : null,
      msg: row.msg,
      // Preserve a tombstone that preceded this base row (v1 stickiness).
      evicted: row.evicted === true ? true : (v1Stickiness ? bySeq.get(row.seq)?.evicted : undefined),
    })
    if (typeof row.occurrenceId === 'string') occToSeq.set(row.occurrenceId, row.seq)
    if (Array.isArray(row.aliases)) {
      for (const a of row.aliases) if (typeof a === 'string') aliases.push({ uuid: a, seq: row.seq })
    }
  }
  const applyTomb = (row: SidecarRow): void => {
    // v1 tombstone keys by seq; v2 tombstone keys by occurrenceId.
    if (typeof row.seq === 'number') {
      const e = bySeq.get(row.seq)
      if (e) e.evicted = true
      else if (v1Stickiness) bySeq.set(row.seq, { seq: row.seq, uuid: null, evicted: true })
      return
    }
    const occ = typeof row.occurrenceId === 'string' ? row.occurrenceId : null
    const seq = occ !== null ? occToSeq.get(occ) : undefined
    if (seq !== undefined) {
      const e = bySeq.get(seq)
      if (e) e.evicted = true
    }
  }
  const applyRow = (row: SidecarRow): void => (isTombstoneOnly(row) ? applyTomb(row) : applyMsg(row))

  let generation: number
  let history: GenerationRecord[]
  let latestBatchId: string | null
  if (genBatches.length > 0) {
    const latest = genBatches.reduce((a, b) => (Number(b.commit!.generation) > Number(a.commit!.generation) ? b : a))
    generation = Number(latest.commit!.generation)
    history = genBatches.map((b) => ({
      generation: Number(b.commit!.generation),
      reason: b.commit!.reason as GenerationRecord['reason'],
      contentPolicy: b.commit!.contentPolicy as GenerationRecord['contentPolicy'],
    }))
    latestBatchId = latest.batchId
    for (const row of latest.rows) applyRow(row)
  } else {
    // No generation/reset batch: a fresh session's durable user-prompt appends
    // (T7b writer) commit v2 LIVE batches at gen 0. Fold them as a gen-0
    // projection rather than falling back to v1 (which would drop the v2 rows
    // mixed with the pump's v1 ingest). Only input/lifecycle batches (no message
    // rows) or a pure v1 prefix still fall back to v1 (hasCommittedGeneration
    // false) — the crash-before-first-commit case.
    const hasV2Messages = committed.some(
      (b) => b.commit!.batchType !== 'input' && b.commit!.batchType !== 'lifecycle'
        && b.rows.some((r) => typeof r.seq === 'number' && r.msg !== undefined),
    )
    if (!hasV2Messages) {
      return { entries: [], generation: 0, history: [], hasCommittedGeneration: false, aliases: [], corrupt }
    }
    generation = 0
    history = []
    latestBatchId = null // no anchor: replay committed v2 batches from the start
    v1Stickiness = true // mixed v1/v2 file: keep v1-fold guarantees for v1 rows
  }

  // Replay everything after the latest generation's commit record (or from the
  // start for a gen-0 live projection), in file order.
  const committedBatchIds = new Set(committed.map((b) => b.batchId))
  const openBatches = new Map<string, SidecarRow[]>()
  let passedLatest = latestBatchId === null
  for (const row of rows) {
    if (!passedLatest) {
      if (row.v === 2 && row.commit === true && row.batchId === latestBatchId) passedLatest = true
      continue
    }
    if (row.v === 2) {
      const batchId = typeof row.batchId === 'string' ? row.batchId : null
      if (batchId === null) continue
      if (row.commit === true) {
        const acc = openBatches.get(batchId) ?? []
        if (committedBatchIds.has(batchId)) for (const r of acc) applyRow(r)
        openBatches.delete(batchId)
      } else {
        const acc = openBatches.get(batchId) ?? []
        acc.push(row)
        openBatches.set(batchId, acc)
      }
    } else {
      // v1 suffix row appended by live ingest / eviction.
      applyRow(row)
    }
  }
  const entries = [...bySeq.values()].sort((a, b) => a.seq - b.seq)
  // The gen-0 mixed file can carry a reconcile-back-filled whole-message
  // assistant duplicate; heal it exactly as the v1 fold does (I1).
  if (v1Stickiness) healDuplicateAssistantRows(entries)
  return { entries, generation, history, hasCommittedGeneration: true, aliases, corrupt }
}

/** One recoverable dispatch operation parsed from the durable input batches. */
export interface PendingInputOp {
  operationId: string
  dispatchOrdinal: number
  /** The public wire payload stored on the first input row (D7); the
   *  materialize/re-dispatch path publishes + enqueues it. */
  payload: unknown
  /** Dispatch route (spec §8.1 drain-preserve-replay). Only the
   *  `drained-to-pending` bucket carries a non-user kind: a preserved
   *  supplement replays as a normal queued user turn, a preserved control
   *  seed replays via sendControlMessage. Defaults to 'user' when absent. */
  kind?: 'user' | 'supplement' | 'control'
}

/** Crash-recovery classification of the durable dispatch states (spec §7.2/§8.1,
 *  T7b Task 6). Per operationId the LAST committed input/lifecycle state decides:
 *  - `queued`: queued-not-published, never materialized → materialize at the prior
 *    turn terminal + dispatch (the prompt never reached the provider; safe).
 *  - `notAttempted`: enqueue-not-attempted, no dispatch evidence → auto-retry.
 *  - `dispatchUnknown`: enqueue-attempted, NO evidence the provider took it →
 *    surface for manual recovery, NEVER auto re-dispatch (§7.2).
 *  - `drainedToPending`: drained-to-pending (spec §8.1 quiesce drain-preserve) →
 *    a rebuild quiesce preserved this entry's payload/ordinal/kind. It is a
 *    READ-ONLY view: the generic crash-recovery path must NOT auto re-dispatch
 *    it (the original batch is not a re-dispatch source); only the rebuild
 *    executor's explicit resume replay consumes it, in dispatchOrdinal order.
 *  - `withdrawn`: a durable withdrawn state → exclude (already retracted).
 *  Evidence that resolves an op to dispatched (excluded from every pending list):
 *  a consumed lifecycle row, the prompt's own materialized message row, or its
 *  uuid in the canonical provider log. */
export interface PendingInputView {
  queued: PendingInputOp[]
  notAttempted: PendingInputOp[]
  dispatchUnknown: PendingInputOp[]
  drainedToPending: PendingInputOp[]
  withdrawn: string[]
}

export function classifyPendingInputs(
  rows: readonly SidecarRow[],
  canonicalUuids: ReadonlySet<string> = new Set(),
): PendingInputView {
  // Only COMMITTED v2 batches feed the state machine; an uncommitted crash tail
  // is ignored (its states never landed). v1 message rows are durable appends.
  const committedV2 = parseBatches(rows).batches.filter((b) => b.commit !== null).flatMap((b) => b.rows)
  const materializedUuids = new Set<string>()
  const collectMsgUuid = (r: SidecarRow): void => {
    const m = r.msg as { type?: unknown; uuid?: unknown } | undefined
    if (m && m.type === 'user' && typeof m.uuid === 'string') materializedUuids.add(m.uuid)
  }
  for (const r of committedV2) if (r.msg !== undefined) collectMsgUuid(r)
  for (const r of rows) if (r.v !== 2 && r.msg !== undefined) collectMsgUuid(r)

  interface Acc {
    dispatchOrdinal: number
    payload: unknown
    inputState?: string
    lifecycleState?: string
    inputKind?: string
  }
  const byOp = new Map<string, Acc>()
  const accOf = (op: string, ordinal: number): Acc => {
    let a = byOp.get(op)
    if (!a) { a = { dispatchOrdinal: ordinal, payload: undefined }; byOp.set(op, a) }
    return a
  }
  for (const r of committedV2) {
    const op = typeof r.operationId === 'string' ? r.operationId : null
    if (op === null) continue
    const state = typeof r.state === 'string' ? r.state : null
    if (state === null) continue
    if (typeof r.dispatchOrdinal === 'number') {
      // Input row: carries dispatchOrdinal (+ payload on the first state row).
      const a = accOf(op, r.dispatchOrdinal)
      a.inputState = state
      if (r.payload !== undefined && a.payload === undefined) a.payload = r.payload
      if (typeof r.inputKind === 'string') a.inputKind = r.inputKind
    } else {
      // Lifecycle row (consumed/steered/requeued): no dispatchOrdinal.
      accOf(op, byOp.get(op)?.dispatchOrdinal ?? 0).lifecycleState = state
    }
  }

  const view: PendingInputView = { queued: [], notAttempted: [], dispatchUnknown: [], drainedToPending: [], withdrawn: [] }
  for (const [operationId, a] of byOp) {
    if (a.inputState === undefined) continue
    if (a.inputState === 'withdrawn') { view.withdrawn.push(operationId); continue }
    if (a.inputState === 'drained-to-pending') {
      // Drain-preserve (spec §8.1): the entry was pulled from a live queue
      // BEFORE the provider consumed it, so its prompt row being in the app
      // projection (materializedUuids) is NOT dispatch evidence — only an
      // actual consumed lifecycle or the provider log carrying the uuid
      // resolves it. The executor's resume replay advances the state past
      // drained-to-pending, so this bucket holds only UNREPLAYED entries.
      const taken = a.lifecycleState === 'consumed' || canonicalUuids.has(operationId)
      if (taken) continue
      const kind = a.inputKind === 'supplement' || a.inputKind === 'control' ? a.inputKind : 'user'
      view.drainedToPending.push({ operationId, dispatchOrdinal: a.dispatchOrdinal, payload: a.payload, kind })
      continue
    }
    const resolved =
      a.lifecycleState === 'consumed'
      || materializedUuids.has(operationId)
      || canonicalUuids.has(operationId)
    if (resolved) continue
    const op: PendingInputOp = { operationId, dispatchOrdinal: a.dispatchOrdinal, payload: a.payload }
    if (a.inputState === 'queued-not-published') view.queued.push(op)
    else if (a.inputState === 'enqueue-not-attempted') view.notAttempted.push(op)
    else if (a.inputState === 'enqueue-attempted') view.dispatchUnknown.push(op)
  }
  const byOrdinal = (x: PendingInputOp, y: PendingInputOp): number => x.dispatchOrdinal - y.dispatchOrdinal
  view.queued.sort(byOrdinal)
  view.notAttempted.sort(byOrdinal)
  view.dispatchUnknown.sort(byOrdinal)
  view.drainedToPending.sort(byOrdinal)
  return view
}

/** Recover the durable rebuild-pending operations (spec §8.1/§8.3, Task 1).
 *  Pure: extracts committed `rebuild-pending` recovery rows NOT superseded by a
 *  later committed generation — a pending row written at generation G is
 *  superseded once a generation/reset batch commits above G (the rebuild that
 *  included it, or a clear/compact that wiped it). With no committed generation
 *  batch every pending row survives (the gen-0 case). Uncommitted crash tails
 *  and demoted corrupt commits are excluded by parseBatches. Dedups by
 *  operationId (a retry re-persists the same op — last committed payload wins,
 *  exactly once) and orders by dispatchOrdinal.
 *
 *  Same supersession concept as `unsupersededCorrupt`, but the comparison
 *  direction is INVERTED: a corrupt batch declares the generation it was trying
 *  to write (ahead of adopted, kept while `> adopted`), whereas a pending row
 *  sits AT the current generation BEFORE the resolving rebuild commits above
 *  it. So a pending row is kept while `batchGen >= adopted` and dropped only
 *  when `adopted > batchGen` — do not "fix" this back to `> adopted`, which
 *  would wrongly drop a still-pending op written at the current generation. */
export function readPendingRebuilds(rows: readonly SidecarRow[]): PendingOperation[] {
  const committed = parseBatches(rows).batches.filter((b) => b.commit !== null)
  const genGens = committed
    .filter((b) => b.commit!.batchType === 'generation' || b.commit!.batchType === 'reset')
    .map((b) => Number(b.commit!.generation))
  const adopted = genGens.length > 0 ? Math.max(...genGens) : null
  const byOp = new Map<string, { ordinal: number; op: PendingOperation }>()
  for (const b of committed) {
    if (b.commit!.batchType !== 'recovery') continue
    const batchGen = Number(b.commit!.generation)
    if (adopted !== null && adopted > batchGen) continue // superseded by a later committed generation
    for (const r of b.rows) {
      if (r.kind !== 'rebuild-pending') continue
      if (typeof r.operationId !== 'string' || typeof r.occurrenceId !== 'string') continue
      const source = r.source
      if (source !== 'provider' && source !== 'result' && source !== 'app') continue
      const ordinal = typeof r.dispatchOrdinal === 'number' ? r.dispatchOrdinal : 0
      byOp.set(r.operationId, {
        ordinal,
        op: {
          operationId: r.operationId,
          entry: {
            occurrenceId: r.occurrenceId,
            msg: r.payload,
            source,
            aliases: Array.isArray(r.aliases) ? r.aliases.filter((a): a is string => typeof a === 'string') : [],
            evicted: r.evicted === true,
          },
        },
      })
    }
  }
  return [...byOp.values()].sort((a, b) => a.ordinal - b.ordinal).map((v) => v.op)
}

/** Truncate raw sidecar text to the last VALID commit record of ANY batchType
 *  (spec §8.2). Returns the committed prefix and the salvaged uncommitted tail
 *  rows. A complete-but-invalid commit (crash damage) is NOT an anchor: it is
 *  skipped, its rows fall into the salvaged tail, and the caller rebuilds from
 *  the provider log — discarding the corrupt projection, not publishing it. A
 *  torn final line is dropped (it is after the last commit). */
export function truncateToLastCommit(raw: string): { prefix: string; salvaged: SidecarRow[] } {
  const lines = raw.split('\n')
  const parsed: Array<{ row: SidecarRow; idx: number }> = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) continue
    try {
      parsed.push({ row: JSON.parse(line) as SidecarRow, idx: i })
    } catch {
      /* torn line — part of the uncommitted tail, dropped from the prefix */
    }
  }
  // Corrupt commits are demoted (parseBatches reports them); they must not
  // serve as a truncation anchor. Exclude by commit-row IDENTITY, not batch
  // id: a valid re-commit may reuse a demoted batch's deterministic id
  // (rebuild-<id>-N) and must still anchor.
  const { corrupt } = parseBatches(parsed.map((p) => p.row))
  const corruptCommits = new Set(corrupt.map((c) => c.commit))
  let lastCommitIdx = -1
  for (const { row, idx } of parsed) {
    if (row.v === 2 && row.commit === true && !corruptCommits.has(row)) lastCommitIdx = idx
  }
  if (lastCommitIdx === -1) return { prefix: '', salvaged: parsed.map((p) => p.row) }
  const prefix = lines.slice(0, lastCommitIdx + 1).join('\n') + '\n'
  const salvaged = parsed.filter((p) => p.idx > lastCommitIdx).map((p) => p.row)
  return { prefix, salvaged }
}

/** Build the message row persisted for one seq-assigned message (spec §2
 *  shape: `{ seq, uuid, type, subtype, msg }`). Shared by the live ingest
 *  path and the reconcile back-fill so the on-disk row shape can't drift. */
export function transcriptRow(seq: number, uuid: string | null, msg: unknown): SidecarRow {
  const m = (msg ?? {}) as { type?: unknown; subtype?: unknown }
  return {
    seq,
    uuid,
    type: m.type,
    subtype: m.subtype,
    msg,
  }
}

/** Fold raw sidecar rows into TranscriptStore hydrate rows: message rows
 *  become `{ seq, uuid, msg }` entries and a later `{ seq, evicted: true }`
 *  tombstone row marks the matching entry evicted (rows are applied in file
 *  order, so a tombstone that precedes its base row — only possible from a
 *  reconcile back-fill appending after an eviction — still sticks).
 *  Malformed rows (non-integer/negative seq) are skipped.
 *
 *  Also repairs a duplicate the old uuid-only back-fill could write: see
 *  healDuplicateAssistantRows. The repair is deterministic from content, so
 *  no tombstone row is persisted — every later load re-derives the same
 *  projection. */
export function foldSidecarRows(rows: readonly SidecarRow[]): HydrateRow[] {
  const bySeq = new Map<number, HydrateRow>()
  const baseSeen = new Set<number>()
  for (const row of rows) {
    const seq = row.seq
    if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0) continue
    if (row.evicted === true) {
      const existing = bySeq.get(seq)
      if (existing) existing.evicted = true
      else bySeq.set(seq, { seq, uuid: null, evicted: true })
      continue
    }
    // Two distinct BASE rows sharing one seq is corruption (spec §9): a
    // Map last-wins would silently hide the overwritten occurrence.
    if (baseSeen.has(seq)) throw new Error(`duplicate-seq: ${seq}`)
    baseSeen.add(seq)
    const uuid = typeof row.uuid === 'string' ? row.uuid : null
    bySeq.set(seq, {
      seq,
      uuid,
      msg: row.msg,
      evicted: bySeq.get(seq)?.evicted,
    })
  }
  const folded = [...bySeq.values()].sort((a, b) => a.seq - b.seq)
  healDuplicateAssistantRows(folded)
  return folded
}

/** Tombstone the whole-message projection of a message that is already
 *  recorded as one frame per content block.
 *
 *  A JSONL line carrying an entire multi-block assistant message under its
 *  original uuid does not match the uuid of the live stream's per-block
 *  frames (the CLI derives one uuid per block: `uuid.slice(0,24) + blockIndex
 *  hex`). A reconcile whose dedupe only knew uuids therefore treated the disk
 *  line as new and appended it at the seq head — a duplicate that renders as
 *  the transcript tail. The fold removes it by shape and content alone: a row
 *  carrying more than one block is redundant when its blocks are EXACTLY the
 *  concatenation of the single-block rows for the same response id. A partial
 *  live recording (crash mid-stream) keeps the disk copy, since dropping it
 *  would lose the blocks it alone carries. Evicted frames still participate:
 *  a retraction tombstoned the derived-uuid rows, and the duplicate appended
 *  afterwards is exactly the row this removes. Only a visible multi-block row
 *  is ever tombstoned; its uuid is re-pointed at the covering frame
 *  (HydrateRow.aliasToSeq) so uuid-anchored reads do not resolve to the new
 *  tombstone.
 *
 *  The whole-message shape is rare: the dominant JSONL shape is one line per
 *  block, whose uuids match the live frames and therefore never reach this
 *  repair. */
function healDuplicateAssistantRows(rows: readonly HydrateRow[]): void {
  // Only a response recorded in BOTH shapes (single-block frames and a
  // whole-message row) can carry a duplicate. Collecting the ids first keeps a
  // normal load — where every response has just one shape — allocation-free.
  const multiBlockIds = new Set<string>()
  const singleBlockIds = new Set<string>()
  for (const row of rows) {
    const shape = assistantMessageShapeOf(row.msg)
    if (shape?.blocks == null) continue
    if (shape.blocks.length > 1) multiBlockIds.add(shape.id)
    else singleBlockIds.add(shape.id)
  }
  const candidateIds = new Set([...multiBlockIds].filter((id) => singleBlockIds.has(id)))
  if (candidateIds.size === 0) return

  const liveBlocksById = new Map<string, unknown[][]>()
  const liveFirstSeqById = new Map<string, number>()
  const liveFirstVisibleSeqById = new Map<string, number>()
  const candidatesById = new Map<string, Array<{ row: HydrateRow; blocks: unknown[] }>>()
  for (const row of rows) {
    const shape = assistantMessageShapeOf(row.msg)
    if (shape?.blocks == null || !candidateIds.has(shape.id)) continue
    if (shape.blocks.length > 1) {
      if (row.evicted !== true) {
        const list = candidatesById.get(shape.id) ?? []
        list.push({ row, blocks: shape.blocks })
        candidatesById.set(shape.id, list)
      }
    } else {
      // `rows` is seq-ordered, so the concatenation stays in message order.
      const list = liveBlocksById.get(shape.id) ?? []
      list.push(shape.blocks)
      liveBlocksById.set(shape.id, list)
      if (!liveFirstSeqById.has(shape.id)) liveFirstSeqById.set(shape.id, row.seq)
      if (row.evicted !== true && !liveFirstVisibleSeqById.has(shape.id)) {
        liveFirstVisibleSeqById.set(shape.id, row.seq)
      }
    }
  }
  for (const [id, candidates] of candidatesById) {
    const live = liveBlocksById.get(id)
    if (live === undefined || live.length === 0) continue
    const merged = live.flat()
    // Point the alias at a visible frame when one survives; otherwise at the
    // response's original position (a better pagination anchor than the tail).
    const aliasSeq = liveFirstVisibleSeqById.get(id) ?? liveFirstSeqById.get(id)
    for (const candidate of candidates) {
      if (!isDeepStrictEqual(candidate.blocks, merged)) continue
      candidate.row.evicted = true
      // The duplicate's seq is now a tombstone, so its original uuid must not
      // keep resolving to it: point the uuid at the covering frame instead.
      if (aliasSeq !== undefined) candidate.row.aliasToSeq = aliasSeq
    }
  }
}

/**
 * Seq-assign ONE message on the live ingest path (the pump's ring-append
 * point and SessionManager's direct ring appends). Renderable messages get
 * a seq from the store (dedup by uuid — an SDK echo of an already-recorded
 * message returns the original seq and appends nothing), the message object
 * is kept on the store entry for later window() reads, and a row is queued
 * to the sidecar fire-and-forget. Returns the assigned seq, or null when
 * the message is not part of the durable transcript (ephemeral / sidechain /
 * non-broadcast system frame) — such messages never enter the seq space.
 */
export function recordTranscriptMessage(t: TranscriptHolder, msg: unknown): number | null {
  if (!isRenderableSdkMessage(msg as RenderableCheck)) return null
  const m = msg as { uuid?: unknown; type?: unknown; subtype?: unknown }
  const uuid = typeof m.uuid === 'string' ? m.uuid : null
  // record() dedups by uuid internally; skip the sidecar row for a repeat
  // registration so the file keeps exactly one row per allocated seq.
  const isNew = uuid === null || t.store.seqOf(uuid) === undefined
  const seq = t.store.record(uuid, msg)
  if (isNew) void t.sidecar.appendRow(transcriptRow(seq, uuid, msg))
  return seq
}

/**
 * Reconcile back-fill: append every entry the store doesn't already know,
 * in the given (chronological) order, allocating seqs from the store's
 * current head. Used to catch a sidecar up with the on-disk JSONL after a
 * restart / cold session (spec §2: the sidecar may be missing or short).
 * Dedup is by uuid where one exists; uuid-less entries fall back to a
 * positional guard (only entries at or beyond the store's current head are
 * recorded, so an already-hydrated row is never double-allocated).
 *
 * One extra identity check applies ONLY to a whole-message assistant line
 * (more than one content block, original uuid): if the store already holds
 * that message id AND the recorded blocks reproduce the line's blocks
 * exactly, the live stream's derived-uuid frames cover it, so the line is
 * skipped — its original uuid is aliased to the covering frame's seq so
 * uuid-anchored reads still resolve. A partial live recording does not
 * match, and the line is appended rather than dropping the blocks only it
 * carries. Per-block JSONL lines (the dominant shape) share a message id but
 * each carries its own block, so they must NOT be skipped — the store's
 * first block would otherwise hide every sibling. Returns the number of rows
 * appended.
 *
 * `excludeUuids` (spec §8.1, Task 5): uuids of durable rebuild-pending operations
 * are SKIPPED by a passive back-fill. A held-back anomaly's canonical position is
 * mid-history, but back-fill appends at the tail — recording it there would
 * recreate the very inversion the rebuild exists to fix (and the live detector
 * already suppressed it). Excluding it keeps the anomaly out of the projection
 * until the executor's forced ordered rebuild places it correctly include-once.
 */
export function backfillFromEntries(t: TranscriptHolder, entries: readonly unknown[], excludeUuids?: ReadonlySet<string>): number {
  let appended = 0
  for (let i = 0; i < entries.length; i++) {
    const msg = entries[i]
    const uuid = typeof (msg as { uuid?: unknown } | undefined)?.uuid === 'string'
      ? (msg as { uuid: string }).uuid
      : null
    if (uuid !== null) {
      if (t.store.seqOf(uuid) !== undefined) continue
      if (excludeUuids?.has(uuid)) continue
    } else if (i < t.store.headSeq) {
      continue
    }
    const shape = assistantMessageShapeOf(msg)
    if (shape !== null && shape.blocks !== null && shape.blocks.length > 1) {
      const known = t.store.assistantMessageBlocksOf(shape.id)
      if (known !== undefined) {
        // Covered when the recorded blocks reproduce the line exactly. A fully
        // tombstoned response is covered too: it was retracted, and its disk
        // copy must not resurrect even if the recorded blocks differ.
        const covered = !t.store.assistantMessageHasVisibleRows(shape.id) || isDeepStrictEqual(shape.blocks, known)
        if (covered) {
          if (uuid !== null) {
            const firstSeq = t.store.assistantMessageSeqOf(shape.id)
            if (firstSeq !== undefined) t.store.registerUuidAlias(uuid, firstSeq)
          }
          continue
        }
      }
    }
    const seq = t.store.record(uuid, msg)
    void t.sidecar.appendRow(transcriptRow(seq, uuid, msg))
    appended++
  }
  return appended
}
