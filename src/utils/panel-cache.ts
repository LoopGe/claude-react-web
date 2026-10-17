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

/** ScrollTop to snapshot for a panel's scroller, or null when the scroller is
 *  collapsed (display:none — clientHeight 0): scrollTop READS 0 there, and
 *  restoring onto a collapsed scroller would clamp to 0. Both the snapshot
 *  and the restore sides are visible-only operations. */
export function scrollerSnapshotTop(el: HTMLElement): number | null {
  return el.clientHeight > 0 ? el.scrollTop : null
}
