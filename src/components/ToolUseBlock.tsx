// Structured rendering for tool_use blocks.
//
// Dispatches by tool name to provide rich views for Edit/Write tools
// (diff preview, file-path header, etc.) while falling back to raw JSON
// for unknown tools.

import { memo } from 'react'
import { Markdown } from './Markdown'
import { usePlanStatus, usePlanContent } from '../hooks/usePlanStatus'
import { SubagentCard } from './SubagentCard'
import { formatJson } from '../utils/format'
import { SUBAGENT_TOOL_NAMES, PLAN_TOOL_NAMES } from '../constants/toolNames'
import { truncate } from '../utils/text'
import type { Block } from '../types'

const MAX_PREVIEW_LINES = 20

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export const ToolUseBlock = memo(function ToolUseBlock({ block }: { block: Block }) {
  const name = block.name
  const input = block.input as Record<string, unknown> | undefined

  // ExitPlanMode and (legacy/alt) EnterPlanMode get their own card —
  // see PlanCard. Skip the generic "→ tool: …" header so the card stands
  // on its own as the dominant element of the assistant message.
  if (name && PLAN_TOOL_NAMES.has(name)) {
    const blockAny = block as { id?: unknown }
    const id =
      typeof block.tool_use_id === 'string'
        ? block.tool_use_id
        : typeof blockAny.id === 'string'
          ? blockAny.id
          : undefined
    return <PlanCard input={input} toolUseId={id} />
  }

  // Agent / Task / Explore — render a SubagentCard placeholder instead
  // of the raw JSON dump. The card is the persistent inline entry point
  // to the SubagentOverlay (per-panel right-side overlay holding the
  // subagent's full internal conversation). Without this, the subagent's
  // child messages would either pollute the main transcript or vanish
  // entirely after we filter parent_tool_use_id != null out of the list.
  if (name && SUBAGENT_TOOL_NAMES.has(name)) {
    const blockAny = block as { id?: unknown }
    const id =
      typeof block.tool_use_id === 'string'
        ? block.tool_use_id
        : typeof blockAny.id === 'string'
          ? blockAny.id
          : undefined
    if (id) {
      const fallback =
        (typeof input?.description === 'string' && input.description) ||
        (typeof input?.prompt === 'string' && truncate(input.prompt as string, 80)) ||
        undefined
      return <SubagentCard toolUseId={id} fallbackLabel={fallback} />
    }
  }

  return (
    <div style={{ margin: '6px 0' }}>
      <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
        → tool: <code>{name}</code>
      </div>
      {name === 'Edit' || name === 'MultiEdit'
        ? <EditToolView input={input} />
        : name === 'Write'
          ? <WriteToolView input={input} />
          : name === 'TodoWrite'
            ? <TodoWriteView input={input} />
            : <div className="tool-input">{formatJson(block.input)}</div>
      }
    </div>
  )
})

// ---------------------------------------------------------------------------
// ExitPlanMode / EnterPlanMode
// ---------------------------------------------------------------------------

/**
 * Plan card. Renders the proposed plan as markdown so headings, lists,
 * and code blocks come through readably — it's almost always
 * multi-paragraph prose with bullets, and the default tool_use JSON dump
 * is unreadable for that. `allowedPrompts` (the prompt-permission
 * rules the SDK proposes when approving) gets a small chip row.
 *
 * Both `ExitPlanMode` (current SDK name) and the legacy `EnterPlanMode`
 * route here — the input shape is the same in practice.
 *
 * Wrapped in <details> so long plans (the common case) collapse by
 * default once they've been resolved. Pending plans auto-expand —
 * that's the moment the user most wants to read them.
 */
function PlanCard({
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
    <details
      key={status}
      className={`plan-card-collapsible plan-card-status-${status}`}
      open={defaultOpen}
    >
      <summary>
        <div className="plan-card-header">
          <span className="plan-card-icon" aria-hidden>🗒</span>
          <span className="plan-card-title">Plan proposal</span>
          <span className={`plan-card-status ${status}`} title={statusTitle}>
            {statusLabel}
          </span>
        </div>
      </summary>
      <div className="plan-card-body">
        {body ? <Markdown text={body} /> : (
          <div className="plan-card-empty">
            {status === 'pending'
              ? 'Plan will appear after approval (CLI reads it from the plan file on disk).'
              : '(empty plan — Claude sent no body)'}
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
    </details>
  )
}

// ---------------------------------------------------------------------------
// Edit / MultiEdit
// ---------------------------------------------------------------------------

function EditToolView({ input }: { input?: Record<string, unknown> }) {
  if (!input || typeof input !== 'object') {
    return <div className="tool-input">{formatJson(input)}</div>
  }

  const filePath = typeof input.file_path === 'string' ? input.file_path : null

  // MultiEdit: { file_path, edits: [{ old_string, new_string }] }
  const edits = input.edits
  if (Array.isArray(edits)) {
    return (
      <div className="diff-block">
        {filePath && <DiffFilePath path={filePath} />}
        {edits.map((edit: unknown, i: number) => {
          const e = edit as Record<string, unknown>
          return (
            <DiffChunk
              key={i}
              oldText={typeof e.old_string === 'string' ? e.old_string : ''}
              newText={typeof e.new_string === 'string' ? e.new_string : ''}
              label={edits.length > 1 ? `edit ${i + 1}` : undefined}
            />
          )
        })}
      </div>
    )
  }

  // Single Edit: { file_path, old_string, new_string }
  const oldText = typeof input.old_string === 'string' ? input.old_string : ''
  const newText = typeof input.new_string === 'string' ? input.new_string : ''
  return (
    <div className="diff-block">
      {filePath && <DiffFilePath path={filePath} />}
      <DiffChunk oldText={oldText} newText={newText} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

function WriteToolView({ input }: { input?: Record<string, unknown> }) {
  if (!input || typeof input !== 'object') {
    return <div className="tool-input">{formatJson(input)}</div>
  }

  const filePath = typeof input.file_path === 'string' ? input.file_path : null
  const content = typeof input.content === 'string' ? input.content : ''
  const lines = content.split('\n')
  const totalLines = lines.length
  const preview = lines.slice(0, MAX_PREVIEW_LINES)
  const truncated = totalLines > MAX_PREVIEW_LINES

  return (
    <div className="diff-block">
      {filePath && <DiffFilePath path={filePath} label="new file" />}
      <div className="diff-lines">
        {preview.map((line, i) => (
          <div key={i} className="diff-line diff-line-add">
            <span className="diff-line-marker">+</span>
            <span className="diff-line-text">{line}</span>
          </div>
        ))}
      </div>
      {truncated && (
        <div className="diff-truncation">
          … {totalLines - MAX_PREVIEW_LINES} more lines ({totalLines} total)
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Shared sub-components
// ---------------------------------------------------------------------------

function DiffFilePath({ path, label }: { path: string; label?: string }) {
  // Show just the filename prominently, full path as tooltip
  const parts = path.split('/')
  const fileName = parts[parts.length - 1] || path
  return (
    <div className="diff-file-path" title={path}>
      <span>📄</span>
      <span>{fileName}</span>
      {label && <span style={{ color: 'var(--fg-muted)', fontWeight: 400 }}>({label})</span>}
      {parts.length > 1 && (
        <span style={{ color: 'var(--fg-muted)', marginLeft: 'auto', fontSize: 11 }}>
          {parts.slice(0, -1).join('/')}
        </span>
      )}
    </div>
  )
}

function DiffChunk({
  oldText,
  newText,
  label,
}: {
  oldText: string
  newText: string
  label?: string
}) {
  const oldLines = oldText.split('\n')
  const newLines = newText.split('\n')

  return (
    <>
      {label && (
        <div style={{ padding: '4px 10px', color: 'var(--fg-muted)', fontSize: 11, borderBottom: '1px dashed var(--border)' }}>
          {label}
        </div>
      )}
      <div className="diff-lines">
        {oldLines.map((line, i) => (
          <div key={`del-${i}`} className="diff-line diff-line-del">
            <span className="diff-line-marker">-</span>
            <span className="diff-line-text">{line}</span>
          </div>
        ))}
        {newLines.map((line, i) => (
          <div key={`add-${i}`} className="diff-line diff-line-add">
            <span className="diff-line-marker">+</span>
            <span className="diff-line-text">{line}</span>
          </div>
        ))}
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// TodoWrite
// ---------------------------------------------------------------------------

function TodoWriteView({ input }: { input?: Record<string, unknown> }) {
  if (!input || !Array.isArray(input.todos)) {
    return <div className="tool-input">{formatJson(input)}</div>
  }
  return (
    <ul className="inline-todo-list">
      {(input.todos as unknown[]).map((item, i) => {
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
        const icon = status === 'completed' ? '✔' : status === 'in_progress' ? '◉' : '○'
        return (
          <li key={i} className={`inline-todo-item ${cls}`}>
            <span className="inline-todo-icon" aria-hidden>{icon}</span>
            <span className="inline-todo-text">{content}</span>
          </li>
        )
      })}
    </ul>
  )
}

