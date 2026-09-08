// Agent/task-ecosystem tool_use views: Skill invocation, agent-to-agent
// SendMessage, background TaskOutput polling, TaskCreate/TaskUpdate
// mutations, and the TodoWrite checklist snapshot.
//
// Extracted from ToolUseBlock.tsx for modularity.

import type { ReactNode } from 'react'
import { Markdown } from '../Markdown'
import { useToolResult } from '../../hooks/usePlanStatus'
import { useTaskInfo } from '../../hooks/useTaskInfo'
import { ToolCard } from '../ToolCard'
import { AnimatedDetails } from '../AnimatedCollapse'
import {
  IconCheck,
  IconCircle,
  IconCircleDot,
  IconClipboardList,
  IconDownload,
  IconListTodo,
  IconMessageCircle,
  IconSparkles,
} from '../icons/ToolIcons'
import { formatJson } from '../../utils/format'
import { truncate } from '../../utils/text'
import { parseTaskId, resultText } from '../../utils/task-events'
import type { ToolViewProps } from './shared'

// ---------------------------------------------------------------------------
// Skill
// ---------------------------------------------------------------------------

/**
 * Skill invocation. Input shape (loosely typed — the SDK schema drifts, so
 * every field is validated before use):
 *   { skill: string, args?: string }
 *
 * The skill name is namespaced like `superpowers:subagent-driven-development`
 * (plugin/scope prefix + bare skill name). We split the prefix into a muted
 * accent chip and show the bare skill name as the title so the active
 * capability is scannable at a glance, with optional args rendered as a
 * muted body line — mirroring the WebFetch prompt layout so "tool + argument"
 * reads consistently across cards.
 */
export function SkillToolView({ input, toolUseId, searchQuery, activeMatchIdx }: ToolViewProps) {
  if (!input || typeof input !== 'object') {
    return <div className="tool-input">{formatJson(input)}</div>
  }
  const raw =
    typeof input.skill === 'string' ? input.skill
    : typeof input.name === 'string' ? input.name
    : null
  if (!raw) return <div className="tool-input">{formatJson(input)}</div>
  const args = typeof input.args === 'string' ? input.args.trim() : ''

  const colon = raw.indexOf(':')
  const namespace = colon > 0 ? raw.slice(0, colon) : ''
  const skillName = colon > 0 ? raw.slice(colon + 1) : raw

  const chips = namespace ? (
    <span className="tool-chip tool-chip-accent" title="Skill namespace">{namespace}</span>
  ) : null

  return (
    <ToolCard
      icon={<IconSparkles />}
      title={<code className="skill-tool-name">{skillName || raw}</code>}
      chips={chips}
      toolUseId={toolUseId}
      copyValue={() => raw}
      copyLabel="Copy skill name"
      className="tool-card-skill"
      searchQuery={searchQuery}
      activeMatchIdx={activeMatchIdx}
    >
      {args && (
        <div className="skill-tool-args">
          <span className="skill-tool-args-marker" aria-hidden>└─</span>
          <span>{truncate(args, 400)}</span>
        </div>
      )}
    </ToolCard>
  )
}

// ---------------------------------------------------------------------------
// SendMessage
// ---------------------------------------------------------------------------

/**
 * Agent-to-agent / agent-to-main message. Input shape (loosely typed — the
 * SDK schema drifts, so every field is validated before use):
 *   { to: string, summary?: string, message: string }
 *
 *   - title  : the recipient ("→ name") so message routing is scannable at
 *              a glance. `to` may be a teammate name, "main", or an agent
 *              id (e.g. "a9c1a4af…"); long ids are truncated with the full
 *              value in the hover title.
 *   - chip   : the sender-provided `summary` (muted, truncated).
 *   - body   : the `message`, collapsed to a one-line preview by default
 *              and expanding to a full Markdown render — agents routinely
 *              embed code blocks / lists in these, and plain <pre> would
 *              show the backticks literally. Auto-opens when a search
 *              query is active so matches inside the body are reachable.
 *
 * Parallels WebSearch's title+chip header and ToolResultDetails' collapsible
 * body, so an inter-agent message reads as part of the same tool-card family
 * instead of falling through to the raw-JSON fallback.
 */
export function SendMessageToolView({ input, toolUseId, searchQuery, activeMatchIdx }: ToolViewProps) {
  if (!input || typeof input !== 'object') {
    return <div className="tool-input">{formatJson(input)}</div>
  }
  const to = typeof input.to === 'string' ? input.to : null
  const summary = typeof input.summary === 'string' ? input.summary : null
  const message = typeof input.message === 'string' ? input.message : null

  // Without a recipient AND a message there's nothing structured to show —
  // hand back to the raw-JSON branch so the user still sees something.
  if (!to && !message) return <div className="tool-input">{formatJson(input)}</div>

  const toLabel = to ? truncate(to, 40) : '(no recipient)'
  const firstLine = message ? (message.split('\n')[0]?.trim() || message) : ''
  const preview = firstLine ? truncate(firstLine, 120) : '(empty message)'
  const hasSearch = Boolean(searchQuery?.trim())

  const chips = summary ? (
    <span className="tool-chip" title={summary}>{truncate(summary, 80)}</span>
  ) : null

  return (
    <ToolCard
      icon={<IconMessageCircle />}
      title={
        <span className="sendmessage-tool-to" title={to ?? undefined}>
          <span className="sendmessage-tool-arrow" aria-hidden>→</span>
          <code>{toLabel}</code>
        </span>
      }
      chips={chips}
      toolUseId={toolUseId}
      copyValue={message ? () => message : undefined}
      copyLabel="Copy message"
      className="tool-card-sendmessage"
      searchQuery={searchQuery}
      activeMatchIdx={activeMatchIdx}
    >
      <AnimatedDetails
        className="sendmessage-tool-body"
        summaryClassName="sendmessage-tool-summary"
        summary={preview}
        open={hasSearch ? true : undefined}
      >
        <div className="sendmessage-tool-content">
          {message ? (
            <Markdown text={message} searchQuery={searchQuery} activeMatchIdx={activeMatchIdx} />
          ) : (
            <div className="tool-input">(empty message)</div>
          )}
        </div>
      </AnimatedDetails>
    </ToolCard>
  )
}

// ---------------------------------------------------------------------------
// TaskOutput
// ---------------------------------------------------------------------------

/**
 * Retrieve output from a background task/agent. Input shape (loosely typed):
 *   { task_id: string, block?: boolean, timeout?: number }
 *
 * Unlike SendMessage, the interesting payload here is NOT the input — it's
 * the tool_result (the retrieved output stream), which ToolCard already
 * renders inline via ToolCardResult/ToolResultDetails. So this view is a
 * body-less header card (like WebSearch): the task_id in a mono pill so
 * you can see WHICH background task is being polled, plus block/timeout
 * chips that distinguish a one-shot peek from a blocking wait.
 *
 * Without this, the input dumps as raw JSON (`{"task_id":"bash-7",
 * "block":true,"timeout":180000}`) and the id — the only bit you'd want
 * to scan for — is buried.
 */
export function TaskOutputToolView({ input, toolUseId, searchQuery, activeMatchIdx }: ToolViewProps) {
  if (!input || typeof input !== 'object') {
    return <div className="tool-input">{formatJson(input)}</div>
  }
  const taskId = typeof input.task_id === 'string' ? input.task_id : null
  const block = typeof input.block === 'boolean' ? input.block : null
  const timeout = typeof input.timeout === 'number' ? input.timeout : null

  if (!taskId) return <div className="tool-input">{formatJson(input)}</div>

  // Render timeout as a human chip: ms when <1s, seconds otherwise. The
  // raw ms is preserved in the title for copy/debug.
  const timeoutChip =
    timeout != null ? (
      <span className="tool-chip" title={`${timeout}ms`}>
        {timeout >= 1000
          ? `${(timeout / 1000).toFixed(timeout % 1000 === 0 ? 0 : 1)}s`
          : `${timeout}ms`}
      </span>
    ) : null

  const chips = (
    <>
      {block === true && <span className="tool-chip tool-chip-accent">blocking</span>}
      {block === false && <span className="tool-chip">non-blocking</span>}
      {timeoutChip}
    </>
  )

  return (
    <ToolCard
      icon={<IconDownload />}
      title={
        <span className="taskoutput-tool-to" title={taskId}>
          <code>{truncate(taskId, 40)}</code>
        </span>
      }
      chips={chips}
      toolUseId={toolUseId}
      className="tool-card-taskoutput"
      searchQuery={searchQuery}
      activeMatchIdx={activeMatchIdx}
    />
  )
}

// ---------------------------------------------------------------------------
// TaskCreate / TaskUpdate
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// TodoWrite
// ---------------------------------------------------------------------------

export function TodoWriteView({ input, toolUseId, searchQuery, activeMatchIdx }: ToolViewProps) {
  if (!input || !Array.isArray(input.todos)) {
    return <div className="tool-input">{formatJson(input)}</div>
  }
  const todos = input.todos as Array<Record<string, unknown>>
  const counts = {
    completed: 0,
    in_progress: 0,
    pending: 0,
  } as Record<string, number>
  for (const t of todos) {
    const s = t.status === 'completed' || t.status === 'in_progress' ? t.status : 'pending'
    counts[s]++
  }
  const chips: ReactNode[] = []
  if (counts.in_progress > 0) chips.push(
    <span key="ip" className="tool-chip tool-chip-accent">{counts.in_progress} active</span>,
  )
  if (counts.pending > 0) chips.push(
    <span key="p" className="tool-chip">{counts.pending} pending</span>,
  )
  if (counts.completed > 0) chips.push(
    <span key="c" className="tool-chip tool-chip-success">{counts.completed} done</span>,
  )

  return (
    <ToolCard
      icon={<IconListTodo />}
      title="Todo list"
      chips={<>{chips}</>}
      toolUseId={toolUseId}
      className="tool-card-todo"
      searchQuery={searchQuery}
      activeMatchIdx={activeMatchIdx}
    >
      <ul className="inline-todo-list">
        {todos.map((item, i) => {
          if (!item || typeof item !== 'object') return null
          const obj = item as Record<string, unknown>
          const content = typeof obj.content === 'string' ? obj.content : String(obj.content ?? '')
          const status = obj.status
          const cls =
            status === 'completed'
              ? 'inline-todo-completed'
              : status === 'in_progress'
                ? 'inline-todo-in_progress'
                : 'inline-todo-pending'
          const Icon =
            status === 'completed' ? IconCheck : status === 'in_progress' ? IconCircleDot : IconCircle
          return (
            <li key={i} className={`inline-todo-item ${cls}`}>
              <span className="inline-todo-icon" aria-hidden>
                <Icon size={12} />
              </span>
              <span className="inline-todo-text">
                <span className="inline-todo-text-shimmer">{content}</span>
              </span>
            </li>
          )
        })}
      </ul>
    </ToolCard>
  )
}
