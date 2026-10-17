/**
 * Measured transcript-row heights, keyed by the row's stable message id.
 *
 * Why this exists: react-virtuoso estimates the height of every never-measured
 * item with a single "probe" default — the height of the FIRST rendered item.
 * A transcript opens pinned to the bottom, so the probe row is the last
 * message; in the measured repro it was a ~62px short message, while real row
 * heights range 50–907px. Every upward scroll into unmeasured territory then
 * mounts rows whose real height replaces the 62px estimate, and Virtuoso pays
 * for each replacement with an internal scrollBy compensation — a continuous
 * ±5–30px wobble (signs alternate because real heights straddle the probe
 * value) and, at outliers (a 907px row), a one-frame +845px jolt. Measured in
 * the live app: content +845px and a compensating `scrollBy(845)` inside a
 * single frame, with the correction visibly short of the viewport anchor.
 *
 * The fix: remember each row's measured height and feed the values back
 * through Virtuoso's `heightEstimates`. Consumption semantics, verified
 * against the react-virtuoso 4.18.6 bundle (the estimates input is gated on
 * `J(it(f).sizeTree)` — the EMPTY-tree sentinel, index.mjs ~line 800, and a
 * live probe confirmed a re-issued array on a non-empty tree is dropped):
 *
 *   - estimates are consumed ONCE per Virtuoso mount, while its size tree is
 *     still empty. Within a mount, Virtuoso's own size cache retains every
 *     measured row, so the cache earns nothing there.
 *   - the payoff is at REMOUNT boundaries — session switch, SubagentOverlay
 *     open, panel-cache eviction, page reload — where the transcript replays
 *     into a fresh empty tree: cached heights replace the probe default for
 *     every row the user has ever scrolled past, so the replay's upward
 *     geometry is right from the first frame.
 *   - re-issuing the array with a fresh identity while values are unchanged
 *     is a no-op (verified: 4 re-renders → zero geometry change, zero scroll
 *     events), so the per-render rebuild in MessageList is safe.
 *
 * Keyed by message id WITHOUT a width dimension: row height is wrap-width
 * dependent, and a height measured in one width context can seed another
 * (forked sessions share uuids; a panel resize leaves stale heights). That
 * staleness is accepted: estimates only seed, the real measurement replaces
 * them at mount, and with `skipAnimationFrameInResizeObserver` that
 * correction lands before paint — invisible. A width-keyed cache would buy
 * nothing but fragmentation.
 */

/** Bounded at 20k entries — one number per row id; ~a few hundred KB worst
 *  case for an absurdly long transcript. FIFO eviction (insertion-ordered
 *  Map), which is fine: evicted rows merely fall back to the estimate again
 *  and re-measure on their next mount. */
const CAP = 20_000

const cache = new Map<string, number>()

/** Height estimate for rows that have never been measured. Measured median of
 *  the real transcript distribution (rows observed at 50/56/57/77/99/127/258/
 *  883px) — the probe default it replaces was 62px, taken from whatever short
 *  message happened to be last at load. The exact value matters little:
 *  entries here exist only for virgin rows, and the cache replaces them with
 *  the real height after one pass. Lives here (not MeasuredItem.tsx) so the
 *  estimate producer and consumer share one home and MeasuredItem exports
 *  only its component. */
export const ROW_HEIGHT_FALLBACK_PX = 77

/** Round to whole pixels: sub-pixel offsets from wrapping changes would
 *  otherwise churn entries (and Map keys) for no geometric benefit. */
export function recordRowHeight(id: string, height: number): void {
  if (!Number.isFinite(height) || height <= 0) return
  if (cache.size >= CAP && !cache.has(id)) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(id, Math.round(height))
}

export function lookupRowHeight(id: string): number | undefined {
  return cache.get(id)
}

/** Test-only. */
export function clearRowHeightCache(): void {
  cache.clear()
}

/** Test-only. */
export function rowHeightCacheSize(): number {
  return cache.size
}
