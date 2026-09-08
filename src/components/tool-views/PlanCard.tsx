// Bespoke card for ExitPlanMode (the plan PROPOSAL) — has its own
// pending/approved/rejected lifecycle that doesn't map onto the generic
// ToolCard running/success/error model, so it renders standalone rather
// than through TOOL_VIEWS.
//
// Extracted from ToolUseBlock.tsx for modularity.

import { memo } from 'react'
import { Markdown } from '../Markdown'
import { usePlanStatus, usePlanContent } from '../../hooks/usePlanStatus'
import { useReopenQuestion } from '../../hooks/useReopenQuestion'
import { AnimatedDetails } from '../AnimatedCollapse'
import { IconClipboardList } from '../icons/ToolIcons'

/**
 * Plan card. Renders the proposed plan as markdown so headings, lists,
 * and code blocks come through readably — it's almost always
 * multi-paragraph prose with bullets, and the default tool_use JSON dump
 * is unreadable for that. `allowedPrompts` (the prompt-permission
 * rules the SDK proposes when approving) gets a small chip row.
 *
 * Only `ExitPlanMode` (the plan PROPOSAL) routes here. `EnterPlanMode` is a
 * separate, semantically-opposite tool and renders as EnterPlanModeMarker.
 *
 * Wrapped in <details> so long plans (the common case) collapse by
 * default once they've been resolved. Pending plans auto-expand —
 * that's the moment the user most wants to read them.
 */
export const PlanCard = memo(function PlanCard({
  input,
  toolUseId,
}: {
  input?: Record<string, unknown>
  toolUseId?: string
}) {
  const plan = typeof input?.plan === 'string' ? input.plan : null
  const fallback =
    typeof input?.content === 'string'
      ? input.content
      : typeof input?.markdown === 'string'
        ? (input.markdown as string)
        : null
  // The CLI injects plan content from disk into the tool_result output
  // (not the tool_use input).  Fall back to the planContent map populated
  // from tool_results by the session-store reducer.
  const resultPlan = usePlanContent(toolUseId)
  const body = plan ?? fallback ?? resultPlan
  const allowedPrompts = Array.isArray(input?.allowedPrompts)
    ? (input.allowedPrompts as Array<{ tool?: string; prompt?: string }>)
    : []

  const status = usePlanStatus(toolUseId)
  const { minimizedPlanToolUseIds, onReopenPlan } = useReopenQuestion()
  const isMinimized = status === 'pending' && !!toolUseId && minimizedPlanToolUseIds.has(toolUseId)
  const statusLabel =
    status === 'approved' ? 'approved' : status === 'rejected' ? 'rejected' : 'pending'
  const statusTitle =
    status === 'approved'
      ? 'You approved this plan — Claude exited plan mode and started executing.'
      : status === 'rejected'
        ? 'You chose to keep planning — Claude received feedback and is revising.'
        : 'Pending your decision.'
  // Pending plans auto-expand (the user wants to read them right now);
  // resolved plans collapse to a one-line summary by default to keep
  // the transcript scannable. `key` forces a remount when status flips
  // so the <details> open attribute re-applies.
  const defaultOpen = status === 'pending'

  return (
    <AnimatedDetails
      key={status}
      className={`plan-card-collapsible plan-card-status-${status}${isMinimized ? ' plan-card-minimized' : ''}`}
      defaultOpen={defaultOpen}
      summary={(
        <div className="plan-card-header">
          <span className="plan-card-icon" aria-hidden>
            <IconClipboardList size={14} />
          </span>
          <span className="plan-card-title">Plan proposal</span>
          <span className={`plan-card-status ${status}`} title={statusTitle}>
            {statusLabel}
          </span>
          {isMinimized && toolUseId && (
            <button
              type="button"
              className="plan-card-reopen"
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                onReopenPlan(toolUseId)
              }}
            >
              Review plan
            </button>
          )}
        </div>
      )}
    >
      <div className="plan-card-body">
        {body ? <Markdown text={body} /> : (
          <div className="plan-card-empty">
            {status === 'pending'
              ? 'Plan will appear after approval (CLI reads it from the plan file on disk).'
              : 'Plan shown above — the CLI did not echo it back into this card.'}
          </div>
        )}
      </div>
      {allowedPrompts.length > 0 && (
        <div className="plan-card-allowed">
          <div className="plan-card-allowed-label">
            On approval, allow:
          </div>
          <ul className="plan-card-allowed-list">
            {allowedPrompts.map((p, i) => (
              <li key={i} className="plan-card-allowed-item">
                <code>{p.tool ?? 'tool'}</code> · {p.prompt ?? '(no description)'}
              </li>
            ))}
          </ul>
        </div>
      )}
    </AnimatedDetails>
  )
})
