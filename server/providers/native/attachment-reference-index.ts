// Derived native attachment-reference index. Lives in the native provider
// because it indexes native JSONL logs; the host imports it one-way.
//
// The native JSONL logs remain the only source of truth. This in-memory index
// accelerates upload-deletion checks and tracks sends that have not reached a
// native log yet; it is never persisted as an independent authorization DB.

import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createLogger } from '../../log.js'
import { loadNativeSessionLog } from './session-log/log.js'
import { neutralEventsOf, neutralFileOccurrences } from './session-log/neutral-read.js'
import type { NativeSessionEvent } from './vocabulary/session-event.js'
import type { NativeFileAttachment } from '../../../shared/attachment-types.js'

const log = createLogger('attachment-references')

/** Extract every structured occurrence that authorizes AttachmentRead: direct
 * user blocks, tool/result inner blocks, and hidden handoff catalogs. Reads
 * the canonical NEUTRAL events (callers pass `neutralEventsOf(snapshot/log)`);
 * every occurrence is kept in log order, exactly as the legacy scan did. */
export function nativeAttachmentOccurrences(
  events: readonly NativeSessionEvent[],
): NativeFileAttachment[] {
  return neutralFileOccurrences(events).map((occurrence) => occurrence.attachment)
}

export interface NativeAttachmentReferenceIndexOptions {
  stateDir: string
}

export class NativeAttachmentReferenceIndex {
  private readonly stateDir: string
  private readonly persisted = new Map<string, NativeFileAttachment[]>()
  private readonly leases = new Map<string, number>()
  /** File ids referenced by durable pending dispatch states (queued-not-published
   *  / enqueue-*, spec §10 T7b Task 6). A crash loses the in-memory send leases
   *  and the prompt is not yet in the native log, so without this a deletion
   *  could remove a file a recovery is about to re-dispatch. Cleared when the
   *  prompt materializes (enters the log) or is withdrawn. */
  private readonly pendingInputs = new Map<string, Set<string>>()
  private readonly unreadableSessions = new Set<string>()
  private rootUnreadable = false

  constructor(opts: NativeAttachmentReferenceIndexOptions) {
    this.stateDir = opts.stateDir
  }

  /** Rebuild persisted state from every native log. An unreadable log blocks
   * every deletion conservatively: its missing parse cannot prove that an id
   * is unreferenced. Successful permanent deletion clears that session's mark. */
  async rebuild(): Promise<void> {
    this.persisted.clear()
    this.unreadableSessions.clear()
    this.rootUnreadable = false
    const root = join(this.stateDir, 'native-sessions')
    let entries
    try {
      entries = await readdir(root, { withFileTypes: true })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
      this.rootUnreadable = true
      log.warn(`native session directory read failed: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      try {
        const snapshot = await loadNativeSessionLog(this.stateDir, entry.name)
        // An arbitrary on-disk log may be an unmigrated v1/v2 (no neutralEvents);
        // neutralEventsOf falls back to the lossless migration, never dropping
        // occurrences.
        if (snapshot) this.persisted.set(entry.name, nativeAttachmentOccurrences(neutralEventsOf(snapshot)))
      } catch (err) {
        this.unreadableSessions.add(entry.name)
        log.warn(`native attachment index could not read session ${entry.name}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  /** Replace one live session's derived view after open, fork, or a
   * reference-bearing append. Takes the canonical neutral events. */
  replaceSession(id: string, events: readonly NativeSessionEvent[]): void {
    const occurrences = nativeAttachmentOccurrences(events)
    if (occurrences.length === 0) this.persisted.delete(id)
    else this.persisted.set(id, occurrences)
    this.unreadableSessions.delete(id)
  }

  /** Permanent transcript deletion is the only path that may discard a
   * session's persisted references. Ordinary unload/clear leaves the log. */
  removeSession(id: string): void {
    this.persisted.delete(id)
    this.pendingInputs.delete(id)
    this.unreadableSessions.delete(id)
  }

  /** Register the file ids a session's durable pending dispatch states reference
   *  (spec §10). An empty set clears the session's pending references (the
   *  prompts materialized into the log or were withdrawn). */
  setPendingInputReferences(id: string, ids: Iterable<string>): void {
    const set = new Set(ids)
    if (set.size === 0) this.pendingInputs.delete(id)
    else this.pendingInputs.set(id, set)
  }

  occurrencesForSession(id: string): readonly NativeFileAttachment[] {
    return this.persisted.get(id) ?? []
  }

  acquireLease(id: string): void {
    this.leases.set(id, (this.leases.get(id) ?? 0) + 1)
  }

  releaseLease(id: string): void {
    const count = this.leases.get(id)
    if (count === undefined) return
    if (count === 1) this.leases.delete(id)
    else this.leases.set(id, count - 1)
  }

  hasReference(id: string): boolean {
    if (this.rootUnreadable || this.unreadableSessions.size > 0) return true
    if ((this.leases.get(id) ?? 0) > 0) return true
    for (const occurrences of this.persisted.values()) {
      if (occurrences.some((occurrence) => occurrence.id === id)) return true
    }
    for (const ids of this.pendingInputs.values()) {
      if (ids.has(id)) return true
    }
    return false
  }
}
