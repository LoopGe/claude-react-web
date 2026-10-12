// Shared collapsed-header rotor for the two docked bottom-overlay cards
// (TodoChecklist / MonitorBar): position chip + the current item's label, one
// slot at a time. The cadence, wrap, reset-on-list-change and hover pause
// live in the useRotor hook (src/hooks/useRotor.ts); this component is the
// presentational half. The keyed slide replays the shared `rotor-in` rise-in
// on every slot change, and the label carries the CARD'S OWN shimmer class
// (todo-text-shimmer / monitor-text-shimmer — the sweep's accent differs per
// card, so the recipe stays with each card's list rows). Structural styles
// are the shared .dock-rotor* rules in messages.css — one copy for both
// cards, so the two docked bars cannot drift apart.

import { memo } from 'react'

export const DockRotor = memo(function DockRotor({
  slideKey,
  index,
  total,
  label,
  shimmerClass,
}: {
  /** The current item's STABLE identity — the slide span's React key. Keying
   *  by item (not by slot index) is what makes the rise-in replay honest: a
   *  list change that lands a DIFFERENT item on the same slot remounts and
   *  replays, while a reset that keeps the same item correctly does not. */
  slideKey: string
  /** Current slot (0-based, from useRotor — always in range). */
  index: number
  /** Total rotatable items; the position chip renders only when > 1. */
  total: number
  /** The current item's label. */
  label: string
  /** The card's own shimmer class for the label (todo-text-shimmer /
   *  monitor-text-shimmer). */
  shimmerClass: string
}) {
  return (
    <span className="dock-rotor" aria-live="off">
      {total > 1 && (
        <span className="dock-rotor-index">
          {index + 1}/{total}
        </span>
      )}
      <span className="dock-rotor-text truncate">
        <span key={slideKey} className="dock-rotor-slide" title={label}>
          <span className={shimmerClass}>{label}</span>
        </span>
      </span>
    </span>
  )
})
