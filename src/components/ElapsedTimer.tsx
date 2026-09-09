// Shared self-ticking elapsed-time text.
//
// Isolating the 1Hz interval in a memoized leaf means only this tiny text node
// re-renders each second — the surrounding card/row/bubble stays memoized and
// skips the per-second commit entirely. That matters most for the components
// that live INSIDE the virtualized transcript (SubagentCard, WorkflowCard):
// ticking at their own scope re-rendered the whole card, with all its child
// rows, once per second for as long as the work ran.
//
// Supersedes three near-identical local implementations (WorkingBubble's
// ElapsedTimer, TasksPanel's RowTimer, and the inline `setNow` timers in
// SubagentCard / WorkflowCard), whose small semantic differences are folded
// into the `live` / `fallbackToMount` props below.

import { memo, useEffect, useRef, useState } from 'react'
import { formatElapsed } from '../utils/format'

interface Props {
  /** Start of the measured span (ms epoch). */
  startedAt?: number
  /** End of the span. Honoured only when `live` is false — a live record keeps
   *  counting from `now` even if an `endedAt` is already stamped, which is what
   *  an async subagent needs (the reducer advances its `endedAt` to the latest
   *  child frame while the subagent is still working). */
  endedAt?: number
  /** Whether the span is still running. True → tick once a second from `now`.
   *  False → freeze at `endedAt` (or the last observed tick when no `endedAt`
   *  was stamped) and stop the interval, so settled rows cost nothing. */
  live?: boolean
  /** When `startedAt` is absent, fall back to mount time so the timer still
   *  advances instead of rendering nothing. Used by the turn-level bubble,
   *  where the first frame can arrive before the server stamps a start.
   *  Everything else renders nothing without a real `startedAt`. */
  fallbackToMount?: boolean
  className?: string
}

export const ElapsedTimer = memo(function ElapsedTimer({
  startedAt,
  endedAt,
  live = false,
  fallbackToMount = false,
  className,
}: Props) {
  // Date.now() in the initializer is intentional: an un-stamped span still
  // needs a baseline to tick from when fallbackToMount is set.
  const mountedAtRef = useRef<number>(Date.now())
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!live) return
    // Tick immediately so a false→true flip refreshes `now` right away rather
    // than showing the stale frozen value for up to a second.
    const tick = () => setNow(Date.now())
    tick()
    const id = window.setInterval(tick, 1000)
    return () => window.clearInterval(id)
  }, [live])

  const base = startedAt ?? (fallbackToMount ? mountedAtRef.current : undefined)
  if (base == null) return null

  const end = live ? now : (endedAt ?? now)
  // Clamp: a clock adjustment (or an endedAt stamped before startedAt by a
  // frame arriving out of order) must not render a negative duration.
  const text = formatElapsed(Math.max(0, end - base))

  return (
    <span className={className} aria-label={`elapsed ${text}`}>
      {text}
    </span>
  )
})
