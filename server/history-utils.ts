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
