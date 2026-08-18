import type { ReactNode } from 'react'

interface EmptyStateProps {
  /** Optional line-art icon tile (use an icon from icons/ToolIcons). */
  icon?: ReactNode
  /** Primary heading. */
  title: ReactNode
  /** Secondary muted explanation. */
  body?: ReactNode
  /** Optional action button / link rendered under the body. */
  action?: ReactNode
  /** Extra classes passed through to the root. */
  className?: string
}

/** Compact inline empty-state block for settings tabs / panels. Distinct
 *  from the chat first-run state (ChatEmptyState) and the landing card
 *  (.app-empty-state) — this is the "no items yet" slot inside a panel. */
export function EmptyState({ icon, title, body, action, className }: EmptyStateProps) {
  return (
    <div className={`empty-state-ui${className ? ` ${className}` : ''}`}>
      {icon && (
        <div className="empty-state-ui-icon" aria-hidden="true">
          {icon}
        </div>
      )}
      <div className="empty-state-ui-title">{title}</div>
      {body && <div className="empty-state-ui-body">{body}</div>}
      {action && <div className="empty-state-ui-action">{action}</div>}
    </div>
  )
}
