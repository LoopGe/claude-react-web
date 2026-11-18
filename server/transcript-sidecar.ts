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
   *  append) is skipped with a warning — append-only design means a torn
   *  tail can only ever lose the very last in-flight row, never corrupt
   *  earlier ones. ENOENT (no sidecar yet) is an empty load, not an error. */
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

  /** Truncate an uncommitted/torn tail back to the last valid commit (v2) or
   *  the last complete line (v1), then fsync. A complete-but-invalid v2 commit
   *  throws corrupt-sidecar (fail closed). No-op for an empty/missing file. */
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
    let prefix: string
    if (raw.includes('"commit":true')) {
      // v2: cut to the last valid commit of any batch type (throws on a
      // complete-but-invalid commit).
      prefix = truncateToLastCommit(raw).prefix
    } else {
      // v1: drop a torn trailing partial line (keep up to the last newline).
      const lastNl = raw.lastIndexOf('\n')
      prefix = lastNl >= 0 ? raw.slice(0, lastNl + 1) : ''
    }
    if (prefix.length < raw.length) {
      await truncate(this.file, prefix.length)
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

interface ParsedBatch {
  batchId: string
  rows: SidecarRow[]
  commit: SidecarRow | null
}

function validateCommit(b: ParsedBatch): void {
  const c = b.commit!
  if (typeof c.count !== 'number' || c.count !== b.rows.length) {
    throw new Error(`corrupt-sidecar: batch ${b.batchId} count mismatch`)
  }
  if (batchChecksum(b.rows) !== c.checksum) {
    throw new Error(`corrupt-sidecar: batch ${b.batchId} checksum mismatch`)
  }
}

/** Group v2 rows into batches in file order; a commit record closes its batch.
 *  A complete-but-invalid commit throws corrupt-sidecar. Trailing batches with
 *  no commit record are returned uncommitted (commit:null). v1 rows are skipped. */
function parseBatches(rows: readonly SidecarRow[]): ParsedBatch[] {
  const committed: ParsedBatch[] = []
  const open = new Map<string, ParsedBatch>()
  for (const row of rows) {
    if (row.v !== 2) continue
    const batchId = typeof row.batchId === 'string' ? row.batchId : null
    if (batchId === null) continue
    if (row.commit === true) {
      const b = open.get(batchId) ?? { batchId, rows: [], commit: null }
      b.commit = row
      validateCommit(b)
      committed.push(b)
      open.delete(batchId)
    } else {
      const b = open.get(batchId) ?? { batchId, rows: [], commit: null }
      b.rows.push(row)
      open.set(batchId, b)
    }
  }
  return [...committed, ...open.values()]
}

/** Fold v2 rows: adopt the latest committed generation, then replay every row
 *  AFTER that generation's commit record in file order — both committed v2
 *  live/recovery/lifecycle/input batches AND the v1 suffix that live ingest /
 *  eviction still append after a rebuild (spec §8.2). The pre-migration v1
 *  prefix and any superseded earlier generations are ignored. Uncommitted
 *  trailing batches are ignored. Complete-invalid commits throw.
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
} {
  const batches = parseBatches(rows)
  const committed = batches.filter((b) => b.commit !== null)
  const genBatches = committed.filter(
    (b) => b.commit!.batchType === 'generation' || b.commit!.batchType === 'reset',
  )
  if (genBatches.length === 0) {
    return { entries: [], generation: 0, history: [], hasCommittedGeneration: false, aliases: [] }
  }
  const latest = genBatches.reduce((a, b) => (Number(b.commit!.generation) > Number(a.commit!.generation) ? b : a))
  const generation = Number(latest.commit!.generation)
  const history: GenerationRecord[] = genBatches.map((b) => ({
    generation: Number(b.commit!.generation),
    reason: b.commit!.reason as GenerationRecord['reason'],
    contentPolicy: b.commit!.contentPolicy as GenerationRecord['contentPolicy'],
  }))
  const bySeq = new Map<number, HydrateRow>()
  const occToSeq = new Map<string, number>()
  const aliases: Array<{ uuid: string; seq: number }> = []
  const isTombstoneOnly = (row: SidecarRow): boolean => row.evicted === true && row.msg === undefined
  const applyMsg = (row: SidecarRow): void => {
    if (typeof row.seq !== 'number') return
    bySeq.set(row.seq, {
      seq: row.seq,
      uuid: typeof row.uuid === 'string' ? row.uuid : null,
      msg: row.msg,
      evicted: row.evicted === true ? true : undefined,
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

  for (const row of latest.rows) applyRow(row)

  // Replay everything after the latest generation's commit record, in file order.
  const committedBatchIds = new Set(committed.map((b) => b.batchId))
  const openBatches = new Map<string, SidecarRow[]>()
  let passedLatest = false
  for (const row of rows) {
    if (!passedLatest) {
      if (row.v === 2 && row.commit === true && row.batchId === latest.batchId) passedLatest = true
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
      // v1 suffix row appended by live ingest / eviction after the rebuild.
      applyRow(row)
    }
  }
  const entries = [...bySeq.values()].sort((a, b) => a.seq - b.seq)
  return { entries, generation, history, hasCommittedGeneration: true, aliases }
}

/** Truncate raw sidecar text to the last VALID commit record of ANY batchType
 *  (spec §8.2). Returns the committed prefix and the salvaged uncommitted tail
 *  rows. A complete-but-invalid commit record is NOT truncatable — it throws
 *  corrupt-sidecar (the caller must fail closed, not hide corruption). A torn
 *  final line is dropped (it is after the last commit). */
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
  // Validates every complete commit; throws corrupt-sidecar on a bad one.
  parseBatches(parsed.map((p) => p.row))
  let lastCommitIdx = -1
  for (const { row, idx } of parsed) {
    if (row.v === 2 && row.commit === true) lastCommitIdx = idx
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
 */
export function backfillFromEntries(t: TranscriptHolder, entries: readonly unknown[]): number {
  let appended = 0
  for (let i = 0; i < entries.length; i++) {
    const msg = entries[i]
    const uuid = typeof (msg as { uuid?: unknown } | undefined)?.uuid === 'string'
      ? (msg as { uuid: string }).uuid
      : null
    if (uuid !== null) {
      if (t.store.seqOf(uuid) !== undefined) continue
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
