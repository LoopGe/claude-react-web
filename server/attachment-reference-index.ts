// Derived native attachment-reference index.
//
// The native JSONL logs remain the only source of truth. This in-memory index
// accelerates upload-deletion checks and tracks sends that have not reached a
// native log yet; it is never persisted as an independent authorization DB.

import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createLogger } from './log.js'
import { loadNativeSessionLog } from './providers/native/session-log/log.js'
import type {
  NativeEventInput,
  NativeFileAttachment,
  NativeFileBlock,
  NativeLogEvent,
} from './providers/native/session-log/format.js'

const log = createLogger('attachment-references')

type AttachmentEvent = NativeLogEvent | NativeEventInput

function isNativeFileBlock(value: unknown): value is NativeFileBlock {
  return typeof value === 'object' && value !== null
    && (value as { type?: unknown }).type === 'file'
    && typeof (value as { attachment?: unknown }).attachment === 'object'
    && (value as { attachment?: unknown }).attachment !== null
}

/** Extract every structured occurrence that authorizes AttachmentRead: direct
 * user blocks, one-level tool-result blocks, and hidden handoff catalogs. */
export function nativeAttachmentOccurrences(
  events: readonly AttachmentEvent[],
): NativeFileAttachment[] {
  const occurrences: NativeFileAttachment[] = []
  for (const event of events) {
    if (event.type === 'session/attachments') {
      occurrences.push(...event.attachments)
      continue
    }
    if (event.type !== 'user') continue
    for (const block of event.message.content) {
      if (isNativeFileBlock(block)) {
        occurrences.push(block.attachment)
        continue
      }
      if (typeof block !== 'object' || block === null) continue
      const candidate = block as { type?: unknown; content?: unknown }
      if (candidate.type !== 'tool_result' || !Array.isArray(candidate.content)) continue
      for (const inner of candidate.content) {
        if (isNativeFileBlock(inner)) occurrences.push(inner.attachment)
      }
    }
  }
  return occurrences
}

export interface NativeAttachmentReferenceIndexOptions {
  stateDir: string
}

export class NativeAttachmentReferenceIndex {
  private readonly stateDir: string
  private readonly persisted = new Map<string, NativeFileAttachment[]>()
  private readonly leases = new Map<string, number>()
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
        if (snapshot) this.persisted.set(entry.name, nativeAttachmentOccurrences(snapshot.events))
      } catch (err) {
        this.unreadableSessions.add(entry.name)
        log.warn(`native attachment index could not read session ${entry.name}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  /** Replace one live session's derived view after open, fork, or a
   * reference-bearing append. */
  replaceSession(id: string, events: readonly AttachmentEvent[]): void {
    const occurrences = nativeAttachmentOccurrences(events)
    if (occurrences.length === 0) this.persisted.delete(id)
    else this.persisted.set(id, occurrences)
    this.unreadableSessions.delete(id)
  }

  /** Permanent transcript deletion is the only path that may discard a
   * session's persisted references. Ordinary unload/clear leaves the log. */
  removeSession(id: string): void {
    this.persisted.delete(id)
    this.unreadableSessions.delete(id)
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
    return false
  }
}
