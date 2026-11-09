// server/providers/native/session-log/fork.ts
//
// Fork seed builder: take a source session log's snapshot and produce the event
// stream a child log starts with. The cut is inclusive of the assistant turn
// anchor named by `resumeSessionAt` (or the whole log when no boundary is
// given); `seq` is renumbered to the child's own 0..n-1 range and every copied
// event's `session_id` is rewritten to the child id (a fork is a new session,
// not a resumption of the source), a `session/end-seed` marker closes the
// inherited prefix, any tool_use left unanswered at the cut gets a synthetic
// error result, `turn/end { forked }` closes the inherited turn, and a
// `session/context` event carries the child's cwd.
//
// Pure: no I/O and no logging.

import { NativeSessionStorageError } from './errors.js'
import type { NativeEventInput, NativeLogEvent } from './format.js'
import type { NativeSessionLogSnapshot } from './log.js'
import { contextSnapshot, repairInterruptedTurn } from './replay.js'

export interface BuildForkSeedOptions {
  source: NativeSessionLogSnapshot
  sourceId: string
  /** Child session id. The seed carries no header of its own —
   *  `NativeSessionLog.open` stamps the header id from its options. */
  newId: string
  cwd: string
  resumeSessionAt?: string
  now?: () => Date
}

export interface NativeForkSeed {
  events: NativeLogEvent[]
  inheritedEventCount: number
  isSeeded: true
}

export function buildForkSeed(opts: BuildForkSeedOptions): NativeForkSeed {
  const { source, sourceId, newId, cwd, resumeSessionAt } = opts

  let prefix: NativeLogEvent[]
  if (resumeSessionAt === undefined) {
    prefix = [...source.events]
  } else {
    const cut = source.events.findIndex(
      (event) => 'uuid' in event && event.uuid === resumeSessionAt,
    )
    if (cut === -1) {
      throw new NativeSessionStorageError(
        'fork-boundary',
        `fork boundary ${resumeSessionAt} not found in source session ${sourceId}`,
        sourceId,
        source.path,
      )
    }
    prefix = source.events.slice(0, cut + 1)
  }

  // Copied events belong to the CHILD session: renumber `seq` and rewrite
  // `session_id` so the child log never claims events from the source.
  // Synthetic repairs below derive their session_id from these events.
  const copied: NativeLogEvent[] = prefix.map((event, index) =>
    'session_id' in event
      ? { ...event, seq: index, session_id: newId }
      : { ...event, seq: index },
  )
  const events: NativeLogEvent[] = [...copied]
  const append = (event: NativeEventInput): void => {
    events.push({ ...event, seq: events.length } as NativeLogEvent)
  }

  append({ type: 'session/end-seed' })
  const { synthetic } = repairInterruptedTurn(copied, { now: opts.now })
  for (const event of synthetic) append(event)
  append({ type: 'turn/end', reason: 'forked' })
  append({ type: 'session/context', text: contextSnapshot(cwd) })

  return { events, inheritedEventCount: copied.length, isSeeded: true }
}