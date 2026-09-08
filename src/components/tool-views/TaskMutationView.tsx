// TaskCreate / TaskUpdate tool_use view.
//
// Extracted from ToolUseBlock.tsx for modularity.

import { useToolResult } from '../../hooks/usePlanStatus'
import { useTaskInfo } from '../../hooks/useTaskInfo'
import { ToolCard } from '../ToolCard'
import { IconClipboardList } from '../icons/ToolIcons'
import { formatJson } from '../../utils/format'
import { truncate } from '../../utils/text'
import { parseTaskId, resultText } from '../../utils/task-events'
import type { ToolViewProps } from './shared'

/**
 * Compact card for task-management tool calls. Both shapes share enough
 * fields (subject, description, status) that a single component handles
 * them with a leading verb chip ("create" / "update") to disambiguate.
 *
 * TaskUpdate calls only set the fields being changed, so we surface only
 * what's present — nothing in the input means "this field is unchanged"
 * and we don't render a blank line for it.
 *
 * Subject resolution: a TaskUpdate input usually omits `subject` (it was
 * set at TaskCreate time). We look the task up via `useTaskInfo` — which
 * reads the folded TaskCreate/TaskUpdate stream from context — so the
 * update card shows the actual task content instead of just `#N`. The
 * `#N` itself comes from the TaskCreate's tool_result text, so for a
 * TaskCreate we parse it from the captured result (`useToolResult`) once
 * it lands; for a TaskUpdate it's in the input directly.
 */
export function TaskMutationView({ input, toolUseId, searchQuery, activeMatchIdx }: ToolViewProps) {
  // Hooks first (before any early return) — resolve the create-time state
  // for an update, and the #N for a create.
  const taskIdRaw = typeof (input as Record<string, unknown> | undefined)?.taskId === 'string'
    ? (input as Record<string, unknown>).taskId as string
    : null
  const taskInfo = useTaskInfo(taskIdRaw ?? undefined)
  const resultEntry = useToolResult(toolUseId)

  if (!input || typeof input !== 'object') {
    return <div className="tool-input">{formatJson(input)}</div>
  }
  // TaskCreate has no taskId; TaskUpdate always has one.
  const taskId = taskIdRaw
  const verb: 'create' | 'update' = taskId ? 'update' : 'create'

  // Create: learn #N from the tool_result text once it lands.
  const createdId = verb === 'create' && resultEntry
    ? parseTaskId(resultText(resultEntry.content))
    : null
  const idLabel = taskId ?? createdId

  const subject =
    (typeof input.subject === 'string' && input.subject) ||
    taskInfo?.subject ||
    null
  const description = typeof input.description === 'string' ? input.description : null
  const status = typeof input.status === 'string' ? input.status : null
  const owner = typeof input.owner === 'string' ? input.owner : null
  const addBlocks = Array.isArray(input.addBlocks) ? (input.addBlocks as string[]) : null
  const addBlockedBy = Array.isArray(input.addBlockedBy) ? (input.addBlockedBy as string[]) : null

  // Heading: the resolved subject. Falls back to `Task #N` only when the
  // create is out of the retained history window (so `useTaskInfo` couldn't
  // resolve it). When the heading IS the `Task #N` fallback, the `#N` chip
  // below is suppressed so #N isn't shown twice (the duplication this card
  // set out to eliminate).
  const headingIsTaskIdFallback = !subject && verb !== 'create' && !!idLabel
  const heading =
    subject ??
    (verb === 'create'
      ? '(no subject)'
      : idLabel
        ? `Task #${idLabel}`
        : '(no subject)')

  const chips = (
    <>
      <span className={`task-mutation-verb verb-${verb}`}>{verb}</span>
      {idLabel && !headingIsTaskIdFallback && <span className="task-mutation-id">#{idLabel}</span>}
      {status && (
        <span className={`task-mutation-status status-${status}`} title={`Status: ${status}`}>
          {status}
        </span>
      )}
      {owner && <span className="task-mutation-owner" title="Owner">@{owner}</span>}
    </>
  )

  return (
    <ToolCard
      icon={<IconClipboardList />}
      title={heading}
      chips={chips}
      toolUseId={toolUseId}
      className="tool-card-task"
      searchQuery={searchQuery}
      activeMatchIdx={activeMatchIdx}
    >
      {(description || addBlocks?.length || addBlockedBy?.length) ? (
        <div className="task-mutation-body">
          {description && <div className="task-mutation-desc">{truncate(description, 200)}</div>}
          {(addBlocks?.length || addBlockedBy?.length) ? (
            <div className="task-mutation-deps">
              {addBlocks?.length ? (
                <span>
                  blocks <code>{addBlocks.join(', ')}</code>
                </span>
              ) : null}
              {addBlockedBy?.length ? (
                <span>
                  blocked by <code>{addBlockedBy.join(', ')}</code>
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </ToolCard>
  )
}
