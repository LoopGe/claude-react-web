/** Pure state machine for the main-grid panel keep-alive cache.
 *
 * The cache is why switching sessions preserves the transcript's scroll
 * position: a panel that leaves the open view stays MOUNTED (display:none in
 * its grid slot — CSS Grid skips such children, so visible tracks are
 * unaffected) instead of unmounting, so the Virtuoso scroller, the follow
 * gate and every hook's state survive the switch. Pure helpers so the
 * membership rules are unit-testable without mounting App (App has no test
 * harness; extracting state transitions is the codebase convention — see
 * open-target.ts). */

/** Extra hidden panels kept beyond the open view. Desktop maxOpen is 3, so
 *  the cache peaks at 6 mounted panels ≈ two full 3-up views of DOM + session
 *  stores; mobile (maxOpen 1) peaks at 4. This is the single cost knob. */
export const PANEL_CACHE_EXTRA = 3

/** Fold the currently-open ids into the cache. LRU: the open view is always
 *  the head; ids that leave the view keep their relative order behind it.
 *  Trims the tail beyond `cap` — cap must be >= maxOpen (callers pass
 *  maxOpen + PANEL_CACHE_EXTRA) so an OPEN id is never trimmed (open ids sit
 *  at the head by construction). Returns the SAME reference when nothing
 *  changed, so the render-phase sync can skip its setState. */
export function mergeOpenIntoCache(
  prev: readonly string[],
  openIds: readonly string[],
  cap: number,
): readonly string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const id of openIds) {
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  for (const id of prev) {
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  if (out.length > cap) return out.slice(0, cap)
  return out.length === prev.length && out.every((id, i) => prev[i] === id) ? prev : out
}

/** Remove ids from the cache (explicit dismissal / dead session). Returns
 *  the same reference when nothing matched. */
export function evictFromCache(prev: readonly string[], ids: readonly string[]): readonly string[] {
  const drop = new Set(ids)
  const next = prev.filter((id) => !drop.has(id))
  return next.length === prev.length ? prev : next
}

/** The ids whose PanelSlots must RENDER this frame: the open view first (in
 *  view order), then cached-but-hidden ids. Open ids first is what keeps the
 *  visible panels' DOM order — and therefore grid auto-placement — stable
 *  while the cache churns behind them. */
export function renderedPanelIds(openIds: readonly string[], cache: readonly string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const id of openIds) {
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  for (const id of cache) {
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

/** Of the ids that left the open view, which should play the closing ghost?
 *  Only the ones that also left the cache — a keep-alive panel is HIDDEN,
 *  not gone, and its collapsed (display:none) rect would render a 0×0
 *  ghost. */
export function ghostableIds(gone: readonly string[], cache: readonly string[]): string[] {
  const kept = new Set(cache)
  return gone.filter((id) => !kept.has(id))
}

export interface PanelScrollSnapshot {
  top: number
  /** Stable TranscriptRow id of the first geometrically visible row. */
  anchorId: string | null
  /** scrollTop minus the anchor row's content-top at snapshot time. */
  anchorOffset: number
}

function rowContentTop(el: HTMLElement, row: HTMLElement): number {
  const viewport = el.getBoundingClientRect()
  // getBoundingClientRect is transformed; scrollTop is not. During the 320ms
  // panel-enter scale, normalize the relative viewport geometry back to CSS
  // content pixels before combining it with scrollTop.
  const scale = (viewport.bottom - viewport.top) / el.offsetHeight
  return (row.getBoundingClientRect().top - viewport.top) / scale + el.scrollTop
}

/** Capture position relative to a stable message, not only an absolute pixel
 * offset. Older-history prepends move every row below the anchor, so restoring
 * the same row+offset preserves the user's reading position without knowing
 * the inserted height. */
export function scrollerSnapshot(el: HTMLElement): PanelScrollSnapshot | null {
  if (el.clientHeight <= 0) return null
  // A missing report belongs only to the previous snapshot's anchor lookup.
  delete el.dataset.crwAnchorMissing
  const top = el.scrollTop
  const viewport = el.getBoundingClientRect()
  for (const row of el.querySelectorAll<HTMLElement>('[data-crw-row-id]')) {
    const rect = row.getBoundingClientRect()
    if (rect.bottom <= viewport.top || rect.top >= viewport.bottom) continue
    const rowTop = rowContentTop(el, row)
    return { top, anchorId: row.dataset.crwRowId ?? null, anchorOffset: top - rowTop }
  }
  return { top, anchorId: null, anchorOffset: 0 }
}

/** Resolve a snapshot against CURRENT geometry. Recomputed per re-assert frame
 * so Virtuoso's own range corrections and prepends are absorbed rather than
 * fought with a stale absolute scrollTop. */
export function scrollSnapshotTop(el: HTMLElement, snapshot: PanelScrollSnapshot): number | null {
  if (snapshot.anchorId) {
    for (const row of el.querySelectorAll<HTMLElement>('[data-crw-row-id]')) {
      if (row.dataset.crwRowId !== snapshot.anchorId && row.dataset.crwOptimisticSource !== snapshot.anchorId) continue
      const rowTop = rowContentTop(el, row)
      return rowTop + snapshot.anchorOffset
    }
    // The owner must reveal a virtualized anchor by id. If it reports that the
    // row no longer exists (ack/settled replacement), retain the pixel fallback.
    return el.dataset.crwAnchorMissing === snapshot.anchorId ? snapshot.top : null
  }
  return snapshot.top
}
