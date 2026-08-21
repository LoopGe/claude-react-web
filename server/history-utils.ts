/**
 * Push an item into a bounded array, evicting the oldest entry when the
 * cap is exceeded. This is the single implementation used by the session
 * pump, pushToSession, and appendRecap so any future buffer-strategy
 * change (e.g. ring buffer) only needs one edit.
 */
export function pushBounded<T>(arr: T[], item: T, cap: number): void {
  arr.push(item)
  if (arr.length > cap) {
    // In-place copy avoids the throwaway removed-elements array that
    // splice() allocates in its return value.
    const excess = arr.length - cap
    for (let i = excess; i < arr.length; i++) arr[i - excess] = arr[i]
    arr.length = cap
  }
}

/**
 * Stamp the wall-clock time the server first observed a message, in place.
 *
 * The SDK's message type has no timestamp, so the client can't tell when a
 * message arrived — and stamping it client-side would mislabel replayed
 * history as "now". We stamp here, once, before the message enters the
 * history ring; because the ring and the live subscriber broadcast share the
 * same object reference, the value rides along on both the replay and live
 * paths with no extra plumbing.
 *
 * `receivedAt` is added defensively (only when absent) so a message that
 * somehow flows through twice keeps its original time. Typed loosely because
 * the field isn't part of the upstream SDKMessage shape.
 */
export function stampReceivedAt(msg: unknown): void {
  if (msg && typeof msg === 'object' && (msg as { receivedAt?: number }).receivedAt == null) {
    ;(msg as { receivedAt?: number }).receivedAt = Date.now()
  }
}

/**
 * Stamp the wall-clock time the SDK actually CONSUMED a user message off the
 * input queue (as opposed to `receivedAt`, which is when the server first
 * accepted it from the HTTP layer). The gap between the two is exactly how
 * long the message sat queued behind an in-flight turn.
 *
 * Stamped in place on the same object that lives in the history ring, so the
 * "consumed" state rides along on replay for free — a reconnecting client
 * sees `consumedAt` already set on historical messages and renders them as
 * delivered without needing the live `message-consumed` frame. Added only
 * when absent so a message that somehow flows through twice keeps its first
 * consumption time. Returns the stamped value so the caller can broadcast it
 * without re-reading.
 */
export function stampConsumedAt(msg: unknown): number {
  const m = msg as { consumedAt?: number }
  if (m && typeof m === 'object' && m.consumedAt == null) {
    m.consumedAt = Date.now()
  }
  return (m as { consumedAt?: number }).consumedAt ?? Date.now()
}

/** System subtypes that should be broadcast to clients and persisted in
 *  history. Other system frames (init, status, …) are kept in history for
 *  fastModeState extraction and /clear signaling, but skipped in broadcasts
 *  to save bandwidth and client memory. Matches history-reader.ts
 *  KEEP_SYSTEM_SUBTYPES.
 *
 *  `task_notification` MUST be broadcast: it is the SDK's background-task
 *  completion signal. The client reducer's async-subagent completion branch
 *  fires on it to flip a `background` subagent to `done` (clearing its
 *  WorkingBubble chip); without the broadcast the frame never reaches the
 *  reducer and the chip stays forever. */
export const BROADCAST_SYSTEM_SUBTYPES = new Set([
  'error',
  'compact_boundary',
  'api_retry',
  'task_notification',
  // SDK signal that an MCP URL-mode elicitation completed (the user
  // finished auth in the browser). Surfacing it lets the transcript show
  // the auth round-trip instead of silently resuming.
  'elicitation_complete',
  // Text output of CLI-local commands (/usage, /voice, …). Without this the
  // pump drops the frame and the user sees nothing after running the command.
  'local_command_output',
])

/** Check if a message should be broadcast to frontend clients.
 *  Returns true for all non-system messages, and for system messages with
 *  subtypes in BROADCAST_SYSTEM_SUBTYPES (error, compact_boundary, api_retry).
 *  System init/status messages return false. */
export function shouldBroadcastMessage(msg: { type?: string; subtype?: string }): boolean {
  if (msg.type !== 'system') return true
  return BROADCAST_SYSTEM_SUBTYPES.has(msg.subtype ?? '')
}

/** A message that belongs in the durable history ring (and therefore the
 *  WS full-replay surface). Ephemeral `stream_event` deltas are excluded:
 *  they are live-streaming fragments (one per content delta — hundreds per
 *  heavy turn) that the SDK never persists to the on-disk transcript and the
 *  client never renders as items (toTranscriptItem returns null). Keeping
 *  them in the 500-cap ring let a streaming turn evict durable content — a
 *  just-sent user message, an assistant message, a tool result — from the
 *  replay surface within seconds, so a reload during/after the flood lost
 *  recent durable messages. Everything the transcript model actually
 *  represents (user / assistant / result / system frames) is retained. */
export function isTranscriptMessage(msg: { type?: string }): boolean {
  return msg.type !== 'stream_event'
}
