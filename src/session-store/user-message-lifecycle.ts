/** User-message-lifecycle owner: optimistic delivery intent and the
 *  consumed/steered coordination entry points.
 *
 *  Owns the `intent.pendingPlaceholders` map (insert / ack / rollback / clear)
 *  and the user-facing entry points for MESSAGE_CONSUMED / MESSAGE_STEERED.
 *  The split the design pins:
 *
 *    - Intent-only writes (placeholder re-derivation, ack re-keying,
 *      clearSendingPlaceholders) live HERE.
 *    - Mirror-only writes (items/messages/activeWorktree stamps for consumed
 *      and steered) live in `transcript-log.stampMessageConsumed` /
 *      `stampMessageSteered`, which this module delegates to.
 *
 *  Dependency direction (one-way): user-message-lifecycle → transcript-log.
 *  transcript-log never imports this module. message-pipeline imports
 *  `clearSendingPlaceholders` from here (one-way); this module does NOT
 *  import message-pipeline (the reducer delegates each action to its owner).
 */

import type { SdkMessage } from '../types'
import {
  type ClientIntent,
  type SessionState,
  type TranscriptItem,
  withIntent,
  withMirror,
} from './types'
import { toTranscriptItem } from './normalize'
import { stampMessageConsumed, stampMessageSteered } from './transcript-log'

/** Insert an optimistic user-message placeholder into `intent.pendingPlaceholders`.
 *
 *  Mirror-only: does NOT touch `mirror.items`. The render path
 *  (SessionStore.buildSnapshot) merges placeholders at the tail of
 *  mirror.items, so components see a flat list. On echo, applyMessage
 *  (message-pipeline) drops the matching placeholder from intent and appends
 *  the real server item to mirror.items.
 *
 *  Idempotent against a server echo that already landed: if the last on-screen
 *  item is the same top-level user content (matched shallowly on `content`),
 *  the placeholder is moot and the insert is a no-op.
 *
 *  Stamps `sending: true` (drives the bubble spinner) and `receivedAt` (so
 *  the timestamp shows immediately, before the server broadcast). */
export function applyOptimisticUserMessage(state: SessionState, message: SdkMessage): SessionState {
  const mirror = state.mirror
  // Build the placeholder TranscriptItem. `prev` is the last RENDERED item —
  // which, post-refactor, is whichever placeholder is queued last (insertion
  // order) or, if none, the tail of mirror.items. We pass mirror tail as the
  // prev because compact-summary detection only fires on assistant/system
  // frames, and an optimistic user prompt's predecessor is always a server
  // frame in practice.
  const item = toTranscriptItem(message, mirror.items[mirror.items.length - 1])
  if (!item) return state

  // If the server's WS echo already arrived and was appended to mirror.items
  // before this optimistic insert ran, don't add a duplicate placeholder.
  // We mark that server item as a known-pending id so applyMessage's echo
  // path is a no-op on its NEXT arrival (the echo can land twice in some
  // reconnect paths).
  //
  // NOTE: This uses shallow === on `content`. For plain text strings this
  // works correctly. For multimodal messages (arrays), the ref comparison
  // always returns false — the safe direction (no false dedup).
  const last = mirror.items[mirror.items.length - 1]
  if (last && last.msg.type === 'user' && last.msg.message?.content === message.message?.content) {
    // Server echo landed first; nothing to do for the intent layer. The
    // placeholder is moot.
    return state
  }

  // Mark the placeholder as 'sending' so the user bubble renders a spinner.
  // The flag is implicitly cleared by the echo-merge in applyMessage, which
  // drops the placeholder from intent and appends the server's clean item to
  // mirror.items (which has no `sending` field). Stamp receivedAt locally so
  // the timestamp shows immediately.
  const placeholder: TranscriptItem = {
    ...item,
    sending: true,
    receivedAt: item.receivedAt ?? Date.now(),
  }
  const next = new Map(state.intent.pendingPlaceholders)
  next.set(placeholder.id, placeholder)
  return withIntent(state, { ...state.intent, pendingPlaceholders: next })
}

/** Ack an optimistic user message: the REST POST returned the server-side
 *  uuid. Re-key the placeholder to the server uuid, strip `sending`, and
 *  stamp receivedAt/consumedAt from what we know.
 *
 *  Idempotent against a WS echo that already arrived (placeholder gone →
 *  no-op). Preserves the placeholder's Map insertion slot (a delete+set
 *  would move it to the end, breaking the FIFO echo-merge in applyMessage).
 *
 *  Forwards `pendingConsumedMessages[serverUuid]` onto the acked placeholder
 *  (a MESSAGE_CONSUMED frame that landed before the ack) and clears the
 *  parking entry — the placeholder is now the carrier of that state. */
export function ackUserMessage(
  state: SessionState,
  pendingId: string,
  serverUuid: string,
  receivedAt?: number,
): SessionState {
  // ACK flow: the REST POST returned the server-side uuid for an optimistic
  // placeholder. Two outcomes are possible — both must be idempotent against
  // the WS echo arriving before or after the ACK:
  //
  //   1. The WS echo has NOT landed yet. The placeholder still lives in
  //      intent.pendingPlaceholders. Re-key it to the server uuid, strip
  //      `sending`, and stamp receivedAt/consumedAt from what we know.
  //      The next echo for this uuid is a no-op (placeholder gone).
  //   2. The WS echo HAS landed. The placeholder was removed from intent
  //      by applyMessage. There's nothing to ack — return unchanged.
  const placeholder = state.intent.pendingPlaceholders.get(pendingId)
  if (!placeholder) return state

  const consumedAt = state.mirror.pendingConsumedMessages.get(serverUuid)
  const msg: SdkMessage = {
    ...placeholder.msg,
    uuid: serverUuid,
    ...(typeof receivedAt === 'number' ? { receivedAt } : {}),
    ...(typeof consumedAt === 'number' ? { consumedAt } : {}),
  }
  // Re-derive the TranscriptItem with the new uuid so its id matches the
  // server's. `prev` is unknown at this point — we pass undefined; compact-
  // summary detection on a user prompt is always false, so it's harmless.
  const updated = toTranscriptItem(msg, undefined)
  if (!updated) {
    // Couldn't rebuild — drop the placeholder anyway so the spinner clears.
    const next = new Map(state.intent.pendingPlaceholders)
    next.delete(pendingId)
    return withIntent(state, { ...state.intent, pendingPlaceholders: next })
  }
  // Carry sending=false implicitly (toTranscriptItem doesn't set it). Re-key
  // the map to the server uuid so the next echo (if any) can match.
  //
  // The re-key must PRESERVE the entry's position in the Map. A delete+set
  // moves the ack'd entry to the end, which (with another send still pending)
  // transiently renders the acked bubble BELOW the newer un-acked one — and
  // worse, breaks applyMessage's echo-merge, which consumes the OLDEST
  // placeholder on each top-level user echo in FIFO send order: after the
  // reorder the oldest entry is the WRONG one, so the echo eats the newer
  // placeholder and the acked one lingers as a duplicate bubble until the
  // turn-end sweep. Map preserves insertion order, so rebuilding the map
  // entry-by-entry (replacing the value at the ack'd entry's original slot)
  // keeps order === send order across ack/echo interleavings. This closes
  // the wrong-eat class ONLY for placeholders that eventually echo: a
  // placeholder removed without its echo (rollbackUserMessage after the
  // server nonetheless accepted, or a turn-end sweep racing a late echo)
  // still shifts the FIFO — a pre-existing edge accepted here, since
  // signature-based matching was explicitly deferred in applyMessage.
  const next = new Map<string, TranscriptItem>()
  for (const [key, value] of state.intent.pendingPlaceholders) {
    if (key === pendingId) next.set(updated.id, updated)
    else next.set(key, value)
  }

  // If the consumed signal already arrived, drop it from the mirror cache
  // since we've folded it into the placeholder's msg.
  let nextMirror = state.mirror
  if (typeof consumedAt === 'number' && state.mirror.pendingConsumedMessages.has(serverUuid)) {
    const pendingConsumedMessages = new Map(state.mirror.pendingConsumedMessages)
    pendingConsumedMessages.delete(serverUuid)
    nextMirror = { ...state.mirror, pendingConsumedMessages }
  }
  return {
    sessionId: state.sessionId,
    mirror: nextMirror,
    intent: { ...state.intent, pendingPlaceholders: next },
  }
}

/** Flip a queued user message to 'consumed' when the live message-consumed
 *  frame arrives. Matches by uuid.
 *
 *  Split contract:
 *    - INTENT path: if the uuid matches an optimistic placeholder still in
 *      `intent.pendingPlaceholders`, the stamp is intent-only (re-derive the
 *      placeholder with consumedAt + deliveryStatus='consumed'). Mirror is
 *      untouched. This is the case when the consumed signal lands BEFORE the
 *      server echo / REST ack.
 *    - MIRROR path: otherwise, delegate to
 *      `transcript-log.stampMessageConsumed` for the items/messages/
 *      activeWorktree/pendingConsumedMessages update.
 *
 *  No-op when neither path applies (a duplicate consumed frame, or a
 *  pre-broadcast signal that already parked). */
export function applyMessageConsumed(
  state: SessionState,
  uuid: string,
  consumedAt: number,
): SessionState {
  // Also stamp a placeholder living in intent: the user message hasn't been
  // echoed by the server yet, so it isn't in mirror.items, but its bubble is
  // already rendered (via the buildSnapshot merge) and must flip from queued/
  // sending to consumed when the signal lands first. Without this branch the
  // post-refactor intent layer swallows the consumed signal until the echo —
  // a regression the pre-refactor code didn't have because placeholders lived
  // in items. We re-derive the placeholder so deliveryStatus is recomputed.
  const placeholder = state.intent.pendingPlaceholders.get(uuid)
  if (placeholder) {
    // Identity-stable for a duplicate consumed frame: if the placeholder is
    // already consumed with the same consumedAt, return state unchanged —
    // matches stampMessageConsumed's mirror-path short-circuit and avoids
    // spurious store emissions on duplicate MESSAGE_CONSUMED frames.
    if (
      placeholder.deliveryStatus === 'consumed'
      && placeholder.msg.consumedAt === consumedAt
    ) return state
    const nextMsg: SdkMessage = { ...placeholder.msg, consumedAt }
    const rebuilt = toTranscriptItem(nextMsg, undefined)
    const updated: TranscriptItem = rebuilt
      ? { ...rebuilt, sending: placeholder.sending }
      : { ...placeholder, msg: nextMsg, deliveryStatus: 'consumed' }
    const nextPlaceholders = new Map(state.intent.pendingPlaceholders)
    nextPlaceholders.set(uuid, updated)
    return withIntent(state, { ...state.intent, pendingPlaceholders: nextPlaceholders })
  }
  // Mirror path: the on-screen item (or a not-yet-broadcast parking entry).
  // Delegated to transcript-log so the mirror-only writes stay owned there.
  const nextMirror = stampMessageConsumed(state.mirror, uuid, consumedAt)
  if (nextMirror === state.mirror) return state
  return withMirror(state, nextMirror)
}

/** Stamp `injectedAt` / `requeuedAt` on the matching steered message.
 *
 *  Mirror-only via `transcript-log.stampMessageSteered` — no intent changes:
 *  the initial broadcast carries steeredAt (the 'injecting' state never
 *  arrives via this action), and the injected / requeued frames are pushed
 *  strictly after the broadcast, so the item is always present. A miss is a
 *  harmless no-op (replay's ring stamps are the durable truth). 'requeued'
 *  falls through to the queued→consumed flow on the next MESSAGE_CONSUMED. */
export function applyMessageSteered(
  state: SessionState,
  uuid: string,
  steerState: 'injected' | 'requeued',
): SessionState {
  const nextMirror = stampMessageSteered(state.mirror, uuid, steerState)
  if (nextMirror === state.mirror) return state
  return withMirror(state, nextMirror)
}

/** Drop all optimistic placeholders from the intent. Called from
 *  `message-pipeline.applyMessage`'s result branch (and the reducer's
 *  SESSION_TERMINATED branch): after a `result` frame the SDK has finished
 *  processing — any lingering placeholders are abandoned. The matching server
 *  messages are already in mirror.items by this point (the result frame lands
 *  AFTER the user echo).
 *
 *  Pure intent helper — no mirror writes. Identity-stable when the intent has
 *  no placeholders. */
export function clearSendingPlaceholders(intent: ClientIntent): ClientIntent {
  if (intent.pendingPlaceholders.size === 0) return intent
  return { ...intent, pendingPlaceholders: new Map<string, TranscriptItem>() }
}
