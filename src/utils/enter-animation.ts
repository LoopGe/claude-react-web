/** Entrance-animation gate predicate for the transcript list.
 *
 *  Lives in its own module (not MessageList.tsx) so MessageList only exports
 *  components — a non-component export would disable React Fast Refresh for
 *  the whole file. Arms when the list grew by a recent live tail append: any
 *  incremental growth (prevLen > 0) animates every new arrival; a fresh mount
 *  / bulk load (prevLen === 0) is capped at maxBatch so replay /
 *  session-switch cascades don't all animate at once. */
export function shouldArmEnterAnimation(
  replayReady: boolean,
  delta: number,
  prevLen: number,
  maxBatch: number,
): boolean {
  if (!replayReady || delta <= 0) return false
  if (prevLen > 0) return true
  return delta <= maxBatch
}
