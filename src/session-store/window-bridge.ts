/** Window-bridge seam: the WINDOW_* action handlers that sit between the
 *  seq-window operators and the ordered transcript log.
 *
 *  This module exists to break what would otherwise be a runtime value-import
 *  cycle between `message-pipeline` and `transcript-log`:
 *
 *    - `message-pipeline.applyMessage` imports `updateTranscriptMirror` /
 *      `evictMessages` / `trimFront` from `transcript-log` (one-way).
 *    - The WINDOW_* handlers need to call `applyMessage` to drive freshly-
 *      windowed messages into the ordered log.
 *
 *  If the WINDOW_* handlers lived in `transcript-log` (where they used to),
 *  `transcript-log` would have to import `applyMessage` from
 *  `message-pipeline` — closing the cycle. Moving them here makes the
 *  dependency graph acyclic at the value level:
 *
 *    transcript-log ──────────┐
 *        ▲                     │
 *        │                     ▼
 *    message-pipeline ◀── window-bridge
 *        ▲                     │
 *        │                     ▼
 *    user-message-lifecycle   seq-window
 *
 *  `window-bridge` imports `applyMessage` from `message-pipeline` and
 *  `prependMessages` / `evictMessages` from `transcript-log` (plus the pure
 *  seq-window operators). No module imports `window-bridge` except the
 *  reducer entry, so the seam adds no new coupling surface for business
 *  modules.
 *
 *  The handlers themselves are unchanged from their pre-seam behaviour:
 *    - `windowLive` — a seq-carrying live frame; contiguous seqs append at
 *      the tail, gapped seqs park in the window and apply when the hole
 *      fills.
 *    - `windowPage` — a REST page; tail pages append in seq order and flip
 *      replayReady, head pages prepend via `prependMessages` with
 *      uuid-exact dedup.
 *    - `windowEvict` — server tombstones by seq; maps seqs → uuids and
 *      reuses `evictMessages`, then applies any frames drained by the
 *      tombstone (the interrupt/withdraw race).
 *
 *  The new window is attached BEFORE the fresh messages run so
 *  trimFront/eviction inside `applyMessage` sync the window the frames
 *  actually survive into. */

import type { SdkMessage } from '../types'
import {
  type SessionAction,
  type SessionState,
  withMirror,
} from './types'
import {
  evictSeqs,
  liveAppend,
  pageLoaded,
  type WindowState,
} from './seq-window'
import {
  evictMessages,
  prependMessages,
} from './transcript-log'
import { applyMessage } from './message-pipeline'

/** Messages now held by `nw` but not by `prev`, ordered by seq. These are
 *  exactly the frames the transcript hasn't applied yet: a prev-window seq
 *  means applyMessage already ran for it; prev-pending seqs drained into
 *  `nw` are fresh (they were parked, never applied). */
function freshWindowMessages(
  prev: WindowState,
  nw: WindowState,
): Array<[number, SdkMessage]> {
  const out: Array<[number, SdkMessage]> = []
  for (const [seq, msg] of nw.window) {
    if (!prev.window.has(seq)) out.push([seq, msg])
  }
  out.sort((a, b) => a[0] - b[0])
  return out
}

/** WINDOW_LIVE: a seq-carrying live message frame. Contiguous seqs append
 *  at the tail; gapped seqs park in the window (hole exposed via snapshot)
 *  and are applied — in seq order — when the hole fills. The new window is
 *  attached BEFORE the fresh messages run so trimFront/eviction inside
 *  applyMessage sync the window they'll actually survive into. */
export function windowLive(
  state: SessionState,
  seq: number,
  generation: number,
  message: SdkMessage,
): SessionState {
  const prev = state.mirror.window
  const nw = liveAppend(prev, seq, message, generation)
  if (nw === prev) return state
  let next = withMirror(state, { ...state.mirror, window: nw })
  for (const [, msg] of freshWindowMessages(prev, nw)) {
    next = applyMessage(next, msg)
  }
  return next
}

/** WINDOW_PAGE: a REST page from GET /sessions/:id/messages. Tail pages
 *  (the newest page, a reconnect catch-up, or a hole fill) append in seq
 *  order and flip replayReady — the tail page IS the transcript's initial
 *  paint in the seq protocol. Head pages prepend below oldestSeq via
 *  prependMessages (uuid dedup is exact: the REST page and the live stream
 *  share one seq space, so the prompt-signature overlap check is skipped —
 *  the same reasoning as tail-first backfill chunks' trustUuidDedup). */
export function windowPage(
  state: SessionState,
  action: Extract<SessionAction, { type: 'WINDOW_PAGE' }>,
): SessionState {
  const prev = state.mirror.window
  const nw = pageLoaded(prev, {
    at: action.at,
    messages: action.messages,
    hasMore: action.hasMore,
    generation: action.generation,
    headSeq: action.headSeq,
    tombstones: action.tombstones,
  })
  if (nw === prev) return state
  const fresh = freshWindowMessages(prev, nw)
  let next = withMirror(state, { ...state.mirror, window: nw })
  if (action.at === 'head') {
    if (fresh.length === 0) return next
    return prependMessages(
      next,
      fresh.map(([, msg]) => msg),
      { trustUuidDedup: true },
    )
  }
  for (const [, msg] of fresh) {
    next = applyMessage(next, msg)
  }
  return withMirror(next, { ...next.mirror, replayReady: true })
}

/** WINDOW_EVICT: server tombstones by seq. Maps the seqs to their uuids
 *  (from the PRE-eviction window) and reuses evictMessages — which also
 *  syncs the window — so the ordered log and lifecycle-map pruning stay
 *  identical to the uuid-based path. */
export function windowEvict(state: SessionState, seqs: number[]): SessionState {
  const prev = state.mirror.window
  const nw = evictSeqs(prev, seqs)
  if (nw === prev) return state
  const uuids = new Set<string>()
  for (const seq of seqs) {
    const msg = prev.window.get(seq) ?? prev.pending.get(seq)
    const u = msg ? (msg as { uuid?: unknown }).uuid : undefined
    if (typeof u === 'string' && u.length > 0) uuids.add(u)
  }
  // Attach the evicted window FIRST: evictMessages' internal window sync
  // (seqsForUuids + evictSeqs) then finds the seqs already deleted and
  // no-ops, instead of computing a second window from `prev` that the
  // overwrite below would discard. Its uuid pruning (items/messages,
  // toolUseId lifecycle maps) still runs on the attached state.
  let next = withMirror(state, { ...state.mirror, window: nw })
  if (uuids.size > 0) next = evictMessages(next, Array.from(uuids))
  // Recording tombstones can DRAIN parked frames: the interrupt/withdraw
  // race lands the result (seq N+1) while the steer (seq N) is still
  // missing — it parks — and the late messages-evicted [N] then tombstones
  // the hole and moves the parked result into the window. Those drained
  // frames are fresh (never applied — see freshWindowMessages) and MUST
  // reach the ordered log, or a stranded `result` never clears liveTurn
  // (the stuck WorkingBubble). Same attach-before-apply ordering as
  // windowLive: applyMessage's internal trim/eviction must sync the
  // window the frames actually survive into.
  for (const [, msg] of freshWindowMessages(prev, nw)) {
    next = applyMessage(next, msg)
  }
  return next
}
