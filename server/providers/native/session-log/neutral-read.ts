// server/providers/native/session-log/neutral-read.ts
//
// Shared neutral-read helpers for the native core read path: the canonical
// events of a session-log snapshot and the structured file occurrences they
// carry. Pure — no I/O, no logging, no host-service imports. Imports ONLY the
// neutral vocabulary, the session-log format/migration modules and the neutral
// shared attachment shape (the neutrality pin in ../vocabulary/neutrality.test.ts
// covers this file).
//
// The occurrence coordinates are the HOST SDK-transcript contract: consumers
// join them by uuid + blockPath against the SDK-shaped merged transcript
// (compact-attachments hydration). A user file block sits at content index i;
// a tool/result's inner content is wrapped in ONE tool_result block at outer
// index 0 in that transcript, so an inner file block sits at [0, inner].

import type { NativeSessionEvent } from '../vocabulary/session-event.js'
import type { NativeLogEvent } from './format.js'
import { migrateEventToV3 } from './migration.js'
import type { NativeFileAttachment } from '../../../../shared/attachment-types.js'

/** The canonical NEUTRAL events of a session-log snapshot: the v3 baseline
 *  when present, otherwise the lossless in-memory migration of the legacy read
 *  view (an unmigrated v1/v2 log — an arbitrary on-disk read, a resumed log
 *  whose eager-at-open migration has not completed, or a legacy-version fork
 *  seed). The single fallback decision point for every neutral read consumer;
 *  occurrences are never dropped on either path. */
export function neutralEventsOf(snapshot: {
  events: readonly NativeLogEvent[]
  neutralEvents?: readonly NativeSessionEvent[] | null
}): NativeSessionEvent[] {
  const neutral = snapshot.neutralEvents
  // The readonly parameter widens acceptance; the canonical baseline is
  // returned AS-IS (by reference) — both real snapshot shapes (the log reader's
  // and the live writer's) own a mutable array, and replay/repair consume that
  // same baseline. An EMPTY v3 baseline is still the v3 truth, not a fallback.
  if (neutral != null) return neutral as NativeSessionEvent[]
  return snapshot.events.map(migrateEventToV3)
}

/** One structured file occurrence in the neutral log, addressed by the host
 *  SDK-transcript coordinates (module header). Catalog entries carry no message
 *  identity: messageUuid '' and blockPath []. */
export interface NeutralFileOccurrence {
  attachment: NativeFileAttachment
  messageUuid: string
  parentToolUseId: string | null
  blockPath: readonly number[]
}

/** Every structured file occurrence that authorizes attachment reads: direct
 *  user blocks, tool/result inner blocks, and hidden handoff catalogs — the
 *  neutral counterpart of the legacy nativeAttachmentOccurrences scan, in log
 *  order. The vocabulary types a file block with the public FileAttachmentRef,
 *  but a persisted native occurrence carries the FULL resolved attachment
 *  verbatim (registry path / mediaType / modelForm ride structurally), so the
 *  cast to the resolved superset is the same duck-typing the legacy scan uses. */
export function neutralFileOccurrences(events: readonly NativeSessionEvent[]): NeutralFileOccurrence[] {
  const occurrences: NeutralFileOccurrence[] = []
  for (const event of events) {
    if (event.type === 'session/attachments') {
      for (const attachment of event.data.attachments) {
        occurrences.push({ attachment, messageUuid: '', parentToolUseId: null, blockPath: [] })
      }
      continue
    }
    if (event.type === 'user/message') {
      const parentToolUseId = event.parentToolUseId ?? null
      for (const [i, block] of event.data.content.entries()) {
        if (block.type !== 'file') continue
        occurrences.push({
          attachment: block.attachment as NativeFileAttachment,
          messageUuid: event.data.id,
          parentToolUseId,
          blockPath: [i],
        })
      }
      continue
    }
    if (event.type === 'tool/result') {
      const parentToolUseId = event.parentToolUseId ?? null
      for (const [inner, block] of event.data.message.content.entries()) {
        if (block.type !== 'file') continue
        occurrences.push({
          attachment: block.attachment as NativeFileAttachment,
          messageUuid: event.data.message.id,
          parentToolUseId,
          blockPath: [0, inner],
        })
      }
    }
  }
  return occurrences
}
