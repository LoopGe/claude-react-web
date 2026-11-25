/** Render-time placement owner: merge optimistic placeholders into the
 *  transcript at their chronological (send-time) position instead of the tail.
 *
 *  Why: a mid-turn queued-not-published prompt lives only as a placeholder until
 *  the turn terminal materializes it. Appending it at the tail (the old merge)
 *  let every finalized assistant frame push it downward as the reply streamed —
 *  the bubble drifted. Placing it by `receivedAt` pins it where it was sent;
 *  later frames (receivedAt > send time) append after it, so it stays put.
 *
 *  This is RENDER-ONLY: placeholders stay in `intent.pendingPlaceholders` and
 *  `mirror.items` keeps its seq order. At materialization the echo-merge drops
 *  the placeholder and the real item appends at the seq tail (its permanent,
 *  cross-tab-consistent position — the main transcript is seq-ordered everywhere;
 *  repairChronology runs only on the subagent replay path). So the bubble settles
 *  ONCE at the turn boundary rather than drifting continuously.
 *
 *  Insertion rule mirrors `repairChronology`'s backward scan (replay-merge.ts):
 *  "after the last timed element with time ≤ t", null-time entries transparent.
 *  A binary search would assume a strictly time-sorted array the seq-ordered
 *  mirror does not guarantee (CLI ms jitter, null-time frames riding neighbours).
 *
 *  Time source is the SERVER stamp `msgTime(ph.msg)` only — never the item-level
 *  `receivedAt` (a pre-ack optimistic carries a client-clock Date.now() there).
 *  A pre-ack placeholder (msg timeless) falls back to the tail; once the REST ack
 *  stamps `msg.receivedAt` (server queue time) it pins chronologically. Using the
 *  server clock avoids misplacing a skewed remote client's bubble, and the stamp
 *  lives on `msg` so it survives the ack/consumed item rebuilds (toTranscriptItem
 *  re-derives item.receivedAt from msg.receivedAt).
 *
 *  Placeholders are processed in Map SEND order and the Map itself is never
 *  reordered — the FIFO echo-merge and the slot-preserving ack re-key depend on
 *  that order. `items` and `messages` are spliced at the same index so they stay
 *  index-aligned (exportConversation / search indices consume the merged arrays).
 */
import type { SdkMessage } from '../types'
import type { TranscriptItem } from './types'
import { msgTime } from './normalize'

export function mergePlaceholdersChronologically(
  items: readonly TranscriptItem[],
  messages: readonly SdkMessage[],
  placeholders: ReadonlyMap<string, TranscriptItem>,
): { items: TranscriptItem[]; messages: SdkMessage[] } {
  if (placeholders.size === 0) {
    return { items: items as TranscriptItem[], messages: messages as SdkMessage[] }
  }
  const outItems = items.slice()
  const outMsgs = messages.slice()
  for (const ph of placeholders.values()) {
    // Server stamp only (see module doc): a pre-ack optimistic has a timeless
    // msg → tail; an acked queued prompt carries msg.receivedAt → chronological.
    const t = msgTime(ph.msg)
    let insertAt = outItems.length // null-time (pre-ack) fallback: tail
    if (t != null) {
      let i = outItems.length - 1
      while (i >= 0) {
        const it = msgTime(outItems[i]!.msg)
        if (it != null && it <= t) break
        i--
      }
      insertAt = i + 1
    }
    outItems.splice(insertAt, 0, ph)
    outMsgs.splice(insertAt, 0, ph.msg)
  }
  return { items: outItems, messages: outMsgs }
}
