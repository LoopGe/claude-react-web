// Detail popover for a MonitorBar row — click a monitor to see what the bar's
// one-line label can't show: the full description (the row truncates it), the
// server background task id parsed out of "Monitor started (task …)", and the
// Monitor's full command.
//
// Behavior parity with the TaskList card's TodoDetailPopover is the point:
// same shell (AnchoredPopover), same head anatomy (status chip + id chip).
// The bar only ever lists RUNNING monitors, so the status chip is the constant
// "Running" — it mirrors the TaskList head shape rather than reporting a
// state that can't vary.

import { memo } from 'react'
import { AnchoredPopover, type AnchorRect } from './AnchoredPopover'

export interface MonitorDetail {
  /** Short label shown on the row (description, else the command's first
   *  line) — repeated here untruncated. */
  description: string
  /** Server background task id parsed from the start result. Absent when the
   *  result carried none (or none has landed yet). */
  taskId?: string
  /** The Monitor tool's full `command` input. Absent when the input had none. */
  command?: string
  /** Persistent monitors have no timeout window — the row already badges
   *  this, repeated here so the popover is self-contained. */
  persistent: boolean
}

interface Props {
  detail: MonitorDetail
  /** The clicked row's rect at open time — fallback anchor; the live anchor
   *  is re-read from triggerRef on every measure pass. */
  anchor: AnchorRect
  /** The open row element — the useOutsideMouseDown trigger exemption, and
   *  the live anchor source while the popover stays open. */
  triggerRef: React.RefObject<HTMLElement | null>
  onClose: () => void
}

export const MonitorDetailPopover = memo(function MonitorDetailPopover({ detail, anchor, triggerRef, onClose }: Props) {
  return (
    <AnchoredPopover
      className="monitor-detail-pop"
      ariaLabel={`Monitor details: ${detail.description}`}
      anchor={anchor}
      triggerRef={triggerRef}
      onClose={onClose}
    >
      <div className="monitor-detail-head">
        <span className="monitor-detail-status">Running</span>
        {detail.taskId !== undefined && <span className="monitor-detail-id">{detail.taskId}</span>}
        {detail.persistent && <span className="tool-chip tool-chip-accent">persistent</span>}
      </div>
      <div className="monitor-detail-subject">{detail.description}</div>
      {detail.command && <pre className="monitor-detail-cmd">{detail.command}</pre>}
    </AnchoredPopover>
  )
})
