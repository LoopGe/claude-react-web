// Tail-first replay planning.
//
// A no-cache cold start (subscribe without sinceUuid) used to wait for
// the FULL history ring (≤ HISTORY_CAP = 500) before the first paint:
// the client buffers every replay chunk and only renders at
// replay-done. Chat UIs are read bottom-up, so the newest chunk is the
// only one the first paint actually needs. This module splits a
// filtered replay history into:
//
//   - tail:     the newest `chunkSize` messages — a complete, self-
//               sufficient first screen, applied by the client
//               immediately (REPLAY_REPLACE on arrival).
//   - backfill: the remaining messages grouped newest→oldest into
//               `chunkSize` chunks — the client PREPENDS each one as
//               it arrives (the same machinery the scroll-up disk
//               pager uses), so the transcript fills in above the
//               viewport while the user is already reading.
//
// Returns null when the history fits a single chunk: there is nothing
// to backfill, and the caller should use the ordinary single-frame
// replay path unchanged.
//
// The split is only valid when the client has NO cached transcript:
// `prependMessages` inserts at the FRONT of the item list, so a
// backfill chunk that is newer than cached items would land above them
// and corrupt the ordering. The caller (server/ws.ts startSession)
// therefore gates this on the subscribe carrying `replayMode:
// 'tail-backfill'` AND no `sinceUuid` (a sinceUuid implies a cached
// transcript on the client).

/** Split a chronological replay history into a tail-first replay plan.
 *  Generic over the message type — the planner only slices, it never
 *  inspects message content.
 *
 *  @param history  Chronological (oldest→newest) messages to replay.
 *  @param chunkSize Backfill chunk size (the replay chunk size).
 *  @returns null when `history.length <= chunkSize` (single-frame
 *  replay suffices); otherwise `{ tail, backfill }` where `tail` is the
 *  newest chunk and `backfill` is an array of chunks ordered
 *  newest→oldest, each internally chronological. Concatenating
 *  `[...backfill].reverse().flat()` with `tail` reproduces `history`
 *  exactly. */
export function planTailBackfillReplay<T>(
  history: readonly T[],
  chunkSize: number,
): { tail: T[]; backfill: T[][] } | null {
  if (history.length <= chunkSize) return null
  const tail = history.slice(history.length - chunkSize)
  const backfill: T[][] = []
  // `end` walks backwards from the tail's lower bound in chunkSize
  // steps; each chunk is [end - chunkSize, end), internally
  // chronological, older than everything emitted so far.
  for (let end = history.length - chunkSize; end > 0; end -= chunkSize) {
    backfill.push(history.slice(Math.max(0, end - chunkSize), end))
  }
  return { tail, backfill }
}
