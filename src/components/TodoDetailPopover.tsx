// Detail popover for a TaskList (TodoChecklist) row — click a task to see
// what the checklist card doesn't show: the TaskCreate/TaskUpdate
// description, the server-assigned `#N` id, the live activeForm.
//
// The positioning/dismissal shell (portal, measure+clamp, Esc, outside-click)
// lives in AnchoredPopover — shared with MonitorDetailPopover so a row click
// means the same thing in both bottom cards. This file owns the task body only.

import { memo } from 'react'
import { AnchoredPopover, type AnchorRect } from './AnchoredPopover'

export interface TodoDetail {
  /** Server-assigned numeric id (`#N`) — task-source items only. */
  id?: string
  subject: string
  status: 'pending' | 'in_progress' | 'completed'
  /** Present-tense label shown while in_progress ("Running tests"). */
  activeForm?: string
  description?: string
}

interface Props {
  detail: TodoDetail
  /** The clicked row's rect at open time — fallback anchor; the live anchor
   *  is re-read from triggerRef on every measure pass. */
  anchor: AnchorRect
  /** The open row element — the useOutsideMouseDown trigger exemption, and
   *  the live anchor source while the popover stays open. */
  triggerRef: React.RefObject<HTMLElement | null>
  onClose: () => void
}

const STATUS_LABEL: Record<TodoDetail['status'], string> = {
  pending: 'Pending',
  in_progress: 'In progress',
  completed: 'Completed',
}

export const TodoDetailPopover = memo(function TodoDetailPopover({ detail, anchor, triggerRef, onClose }: Props) {
  return (
    <AnchoredPopover
      className="todo-detail-pop"
      ariaLabel={`Task details: ${detail.subject}`}
      anchor={anchor}
      triggerRef={triggerRef}
      onClose={onClose}
    >
      <div className="todo-detail-head">
        <span className={`todo-detail-status todo-detail-status-${detail.status}`}>
          {STATUS_LABEL[detail.status]}
        </span>
        {detail.id !== undefined && <span className="todo-detail-id">#{detail.id}</span>}
      </div>
      <div className="todo-detail-subject">{detail.subject}</div>
      {detail.status === 'in_progress' && detail.activeForm && (
        <div className="todo-detail-active">{detail.activeForm}</div>
      )}
      {detail.description && <div className="todo-detail-desc">{detail.description}</div>}
    </AnchoredPopover>
  )
})
