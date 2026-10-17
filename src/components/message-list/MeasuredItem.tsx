/**
 * L0 of the transcript list: the Virtuoso item WRAPPER that records measured
 * row heights into the row-height cache (see row-height-cache.ts for the
 * jitter root cause this closes, and for where the recorded values are
 * consumed).
 *
 * Why measure here: Virtuoso sizes items from the OFFSET-HEIGHT of the
 * element its ItemComponent renders — that element is the direct child of the
 * item-list and the only element carrying `data-index` / `data-known-size`
 * (read by Virtuoso's own list-level ResizeObserver, bundle lines ~300-338 of
 * react-virtuoso 4.18.6). Replacing the default Item with this wrapper keeps
 * that contract: every prop Virtuoso passes (`style` — a module-level
 * constant `{ overflowAnchor: 'none' }`, the data attributes, `children`) is
 * spread onto the div untouched, so Virtuoso's measurement chain is
 * unaffected. Two extra props must be destructured OUT before the spread —
 * the bundle injects them only when ItemComponent is a component (not the
 * default string tag): `item` (the data entry) and `context`; spreading
 * either onto a DOM div trips React's unknown-prop warning.
 *
 * Measurement capture is a module-level SHARED ResizeObserver (one instance
 * for the whole app — the list is the only consumer). There is deliberately
 * NO mount-time offsetHeight read: the initial RO observation delivers the
 * same height later in the same rendering pass, so the immediate read would
 * only force one synchronous layout per mounting row — hundreds on the
 * replay hot path — for a value that was already coming. The RO also keeps
 * entries fresh for rows that resize while mounted (streaming text,
 * fold/unfold, viewport rewrap); unmounted rows stop being observed and keep
 * their last recorded value, which is exactly the estimate the next mount
 * should seed.
 */
import { memo, useLayoutEffect, useRef } from 'react'
import type { ItemProps } from 'react-virtuoso'
import { recordRowHeight } from '../../utils/row-height-cache'

// Lazily created shared observer: created on first mounted row, so test files
// that stub ResizeObserver globally can install the stub before any instance
// exists, and importing this module stays side-effect-free.
let heightRO: ResizeObserver | null = null
function ensureHeightRO(): ResizeObserver | null {
  if (heightRO) return heightRO
  if (typeof ResizeObserver === 'undefined') return null
  heightRO = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const el = entry.target as HTMLElement
      const id = el.dataset.crwRowId
      if (id && el.offsetHeight > 0) recordRowHeight(id, el.offsetHeight)
    }
  })
  return heightRO
}

/** Structural view of the data rows this wrapper may receive. TranscriptRow
 *  carries a stable string `id` (the cache key); the inline streaming tail
 *  row has none — it is always the mounted tail, so its estimate is never
 *  consulted before the real measurement lands. */
export interface MeasuredItemRow {
  id?: string
  kind?: 'streaming'
}

export interface MeasuredItemProps extends ItemProps<MeasuredItemRow> {
  /** Injected by the bundle for component (non-string) ItemComponents; must
   *  not reach the DOM. Destructured out of the spread with an underscore
   *  name — the eslint unused-var allowlist pattern. */
  context?: unknown
}

export const MeasuredItem = memo(function MeasuredItem(props: MeasuredItemProps) {
  const { item, context: _context, ...rest } = props
  const rowId = typeof item.id === 'string' ? item.id : null
  const ref = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || rowId == null) return
    const ro = ensureHeightRO()
    ro?.observe(el)
    return () => {
      ro?.unobserve(el)
    }
  }, [rowId])
  return (
    <div
      {...rest}
      data-crw-row-id={rowId ?? undefined}
      ref={ref}
    />
  )
})
