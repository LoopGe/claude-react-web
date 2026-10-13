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

import { mkdir, open, readFile, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { dirname, basename, join } from 'node:path'
import { createLogger } from './log.js'
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
}

export class TranscriptSidecar {
  private readonly file: string | null
  private handle: FileHandle | null = null
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
    if (!this.file) return
    this.queue = this.queue
      .then(async () => {
        const handle = await this.ensureHandle()
        await handle.writeFile(JSON.stringify(row) + '\n')
      })
      .catch((err) => {
        // Swallow so one failed write doesn't poison the chain; drop the
        // handle so a later append can reopen (e.g. after EBADF/EBUSY).
        this.handle = null
        log.warn(`[session ${this.sessionId}] sidecar append failed: ${(err as Error).message ?? err}`)
      })
    await this.queue
  }

  /** Remove the sidecar file: drain pending appends, close the fd, then
   *  unlink. ENOENT counts as success (nothing to remove). */
  async remove(): Promise<void> {
    if (!this.file) return
    // Drain the append queue first so no queued write lands after the
    // unlink and resurrects the file.
    await this.queue.catch(() => {})
    if (this.handle) {
      try {
        await this.handle.close()
      } catch { /* already closed */ }
      this.handle = null
    }
    try {
      await unlink(this.file)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') {
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
      this.handle = await open(this.file!, 'a')
    }
    return this.handle
  }
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
 *  Malformed rows (non-integer/negative seq) are skipped. */
export function foldSidecarRows(rows: readonly SidecarRow[]): HydrateRow[] {
  const bySeq = new Map<number, HydrateRow & { evicted?: boolean }>()
  for (const row of rows) {
    const seq = row.seq
    if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0) continue
    if (row.evicted === true) {
      const existing = bySeq.get(seq)
      if (existing) existing.evicted = true
      else bySeq.set(seq, { seq, uuid: null, evicted: true })
      continue
    }
    const uuid = typeof row.uuid === 'string' ? row.uuid : null
    bySeq.set(seq, {
      seq,
      uuid,
      msg: row.msg,
      evicted: bySeq.get(seq)?.evicted,
    })
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq)
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
 * recorded, so an already-hydrated row is never double-allocated). Returns
 * the number of rows appended.
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
    const seq = t.store.record(uuid, msg)
    void t.sidecar.appendRow(transcriptRow(seq, uuid, msg))
    appended++
  }
  return appended
}
