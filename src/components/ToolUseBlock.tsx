// Structured rendering for tool_use blocks.
//
// Dispatches by tool name to provide rich views for Edit/Write tools
// (diff preview, file-path header, etc.) while falling back to raw JSON
// for unknown tools.

import { memo, type ComponentType } from 'react'
import { Markdown } from './Markdown'
import { usePlanStatus, usePlanContent } from '../hooks/usePlanStatus'
import { useQuestionAnswers } from '../hooks/useQuestionAnswers'
import { SubagentCard } from './SubagentCard'
import { formatJson } from '../utils/format'
import { SUBAGENT_TOOL_NAMES, PLAN_TOOL_NAMES } from '../constants/toolNames'
import { QUESTION_TOOL_NAME, type QuestionAnswerEntry } from '../utils/question-answers'
import { truncate } from '../utils/text'
import type { Block, QuestionSpec } from '../types'

// Per-tool input view. Each view receives the raw tool_use input (loosely
// typed because SDK schemas drift) and falls back to formatJson internally
// when the shape is unexpected. `toolName` is forwarded so a single view
// can serve more than one tool (e.g. BashToolView covers both Bash and
// PowerShell, branching on the name to swap the prompt glyph).
type ToolInputView = ComponentType<{ input?: Record<string, unknown>; toolName?: string }>

const MAX_PREVIEW_LINES = 20

/**
 * Allowlist-based URL safety check for tool_use-supplied URLs we render as
 * <a href>. The model's input is *not* trusted output — a `javascript:` or
 * `data:` URL would execute on click (rel="noopener noreferrer" doesn't
 * block dangerous schemes, only window.opener leakage). We only let
 * regular web/email/file-transfer schemes through; anything else falls
 * back to a plain <code> render so the user can still see what was asked
 * for without one click compromising the page.
 */
const SAFE_URL_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'ftp:', 'ftps:'])
function isSafeUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol.toLowerCase()
    return SAFE_URL_SCHEMES.has(protocol)
  } catch {
    return false
  }
}

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

  // AskUserQuestion — render a QuestionCard with the question/options
  // and (once the user answers) the selection. Without this, the raw
  // tool_use JSON dumps the entire questions array into the transcript
  // as ugly preformatted JSON.
  if (name === QUESTION_TOOL_NAME) {
    const blockAny = block as { id?: unknown }
    const id =
      typeof block.tool_use_id === 'string'
        ? block.tool_use_id
        : typeof blockAny.id === 'string'
          ? blockAny.id
          : undefined
    return <QuestionCard input={input} toolUseId={id} />
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

  const View = name ? TOOL_VIEWS[name] : undefined
  return (
    <div style={{ margin: '6px 0' }}>
      <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
        → tool: <code>{name}</code>
      </div>
      {View
        ? <View input={input} toolName={name} />
        : <div className="tool-input">{formatJson(block.input)}</div>
      }
    </div>
  )
})

// Dispatch table for per-tool inline views. Defined after the component
// declarations below — JS hoisting handles the function references.
// New tools: declare the view, then add an entry here.
//
// Bash and PowerShell share BashToolView — both have the same input shape
// (command, description, run_in_background, timeout) and the same visual
// "shell command + chips + description" layout. The view branches on
// `toolName` to swap the prompt glyph ($ vs >).
const TOOL_VIEWS: Record<string, ToolInputView> = {
  Edit: EditToolView,
  MultiEdit: EditToolView,
  Write: WriteToolView,
  TodoWrite: TodoWriteView,
  Bash: BashToolView,
  PowerShell: BashToolView,
  Read: ReadToolView,
  Grep: GrepToolView,
  Glob: GlobToolView,
  WebFetch: WebFetchToolView,
  WebSearch: WebSearchToolView,
  NotebookEdit: NotebookEditToolView,
  TaskCreate: TaskMutationView,
  TaskUpdate: TaskMutationView,
}

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
// AskUserQuestion
// ---------------------------------------------------------------------------

type QuestionCardStatus = 'pending' | 'answered' | 'skipped'

/**
 * Inline card for AskUserQuestion. The QuestionDialog overlay handles the
 * live answer flow (separate concern); this component handles the
 * scrollback view — it must work for both pending and resolved cards.
 *
 * State comes from two sources:
 *  - `input.questions` : the QuestionSpec[] from the tool_use block
 *  - `useQuestionAnswers(toolUseId)` : the parsed answers payload from
 *    the matching tool_result, populated by the session-store reducer.
 *    Returns `[]` while pending, a non-empty array once answers land.
 *
 * Status:
 *  - undefined / empty array      → pending (no tool_result yet)
 *  - non-empty, all answers null  → skipped (user dismissed all)
 *  - non-empty, some non-null     → answered
 *
 * Mirrors PlanCard's collapsible behaviour: pending auto-expands so the
 * user can read what's being asked; resolved cards collapse to a one-line
 * summary so long transcripts stay scannable.
 */
function QuestionCard({
  input,
  toolUseId,
}: {
  input?: Record<string, unknown>
  toolUseId?: string
}) {
  const questions = Array.isArray(input?.questions)
    ? (input.questions as QuestionSpec[])
    : []
  const answers = useQuestionAnswers(toolUseId)

  const status: QuestionCardStatus = (() => {
    if (!answers || answers.length === 0) return 'pending'
    return answers.every((a) => a.answer == null) ? 'skipped' : 'answered'
  })()
  const statusLabel = status
  const statusTitle =
    status === 'answered'
      ? 'You answered — Claude received your selections.'
      : status === 'skipped'
        ? 'You skipped every question — Claude is continuing without guidance.'
        : 'Pending your answer.'
  // `key` forces a remount when status flips so the <details> open
  // attribute re-applies — same trick PlanCard uses.
  const defaultOpen = status === 'pending'

  return (
    <details
      key={status}
      className={`question-inline-card question-inline-card-${status}`}
      open={defaultOpen}
    >
      <summary>
        <div className="question-inline-header">
          <span className="question-inline-icon" aria-hidden>💬</span>
          <span className="question-inline-title">
            {questions.length === 1 ? 'Question for you' : `${questions.length} questions for you`}
          </span>
          <span className={`question-inline-status ${status}`} title={statusTitle}>
            {statusLabel}
          </span>
        </div>
      </summary>
      <div className="question-inline-body">
        {questions.length === 0 ? (
          <div className="question-inline-empty">(no questions in tool input)</div>
        ) : (
          questions.map((q, i) => (
            <QuestionItemView
              key={i}
              index={i}
              question={q}
              answer={answers?.[i]}
              status={status}
            />
          ))
        )}
      </div>
    </details>
  )
}

function QuestionItemView({
  index,
  question,
  answer,
  status,
}: {
  index: number
  question: QuestionSpec
  answer: QuestionAnswerEntry | undefined
  status: QuestionCardStatus
}) {
  const isMulti = question.multiSelect === true
  // Build the selected-set from the answer payload so we can highlight
  // the user's pick(s). For single-select string answers we wrap into
  // a one-element set; multi-select arrays go in directly.
  const value = answer?.answer
  const selectedSet =
    value == null
      ? new Set<string>()
      : Array.isArray(value)
        ? new Set(value)
        : new Set([value])
  const presetLabels = new Set(question.options.map((o) => o.label))
  // Custom "Other" answers don't appear in options[]; surface them as a
  // virtual extra row so the answer is never lost.
  const customAnswers = Array.isArray(value)
    ? value.filter((v) => !presetLabels.has(v))
    : typeof value === 'string' && !presetLabels.has(value)
      ? [value]
      : []

  const skipped = status !== 'pending' && value == null

  return (
    <div className={`question-inline-item ${skipped ? 'skipped' : ''}`}>
      <div className="question-inline-item-header">
        {question.header && <span className="question-chip">{question.header}</span>}
        <span className="question-index">Q{index + 1}</span>
        {isMulti && <span className="question-mode">multi-select</span>}
        {skipped && <span className="question-inline-skipped-badge">skipped</span>}
      </div>
      <div className="question-text">{question.question}</div>
      <ul className="question-inline-options">
        {question.options.map((opt) => {
          const selected = selectedSet.has(opt.label)
          return (
            <li
              key={opt.label}
              className={`question-inline-option ${selected ? 'selected' : ''}`}
            >
              <span className="question-inline-option-marker" aria-hidden>
                {isMulti ? (selected ? '☑' : '☐') : selected ? '●' : '○'}
              </span>
              <div className="question-inline-option-body">
                <div className="question-inline-option-label">{opt.label}</div>
                {opt.description && (
                  <div className="question-inline-option-desc">{opt.description}</div>
                )}
              </div>
            </li>
          )
        })}
        {customAnswers.map((custom) => (
          <li
            key={`custom:${custom}`}
            className="question-inline-option selected question-inline-option-custom"
          >
            <span className="question-inline-option-marker" aria-hidden>
              {isMulti ? '☑' : '●'}
            </span>
            <div className="question-inline-option-body">
              <div className="question-inline-option-label">
                {custom} <span className="question-inline-option-custom-tag">(custom)</span>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
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

// ---------------------------------------------------------------------------
// Bash
// ---------------------------------------------------------------------------

const BASH_FOLD_THRESHOLD = 240
const BASH_PREVIEW_LINES = 3
// When the command is a single line longer than the fold threshold, the
// summary still needs to be short — otherwise we'd render the full 800-char
// command in the closed <details> and the fold would do nothing. Truncate
// to roughly the fold width with an ellipsis.
const BASH_SINGLE_LINE_PREVIEW = 200

/**
 * Compact one-liner header (`$ command` + description subtitle) so a long
 * stretch of bash hops doesn't bury the transcript in nested JSON. Long
 * or multiline commands collapse into <details> with the first 3 lines
 * as a preview — the model often pipes here-docs that easily exceed the
 * fold threshold.
 *
 * Also serves the `PowerShell` tool (same input shape: command,
 * description, run_in_background, timeout). The `toolName` prop swaps
 * the prompt glyph: `$` for Bash, `PS>` for PowerShell — both are
 * universally recognised shell prompts and disambiguate the language
 * at a glance when both tools appear in the same transcript.
 */
function BashToolView({ input, toolName }: { input?: Record<string, unknown>; toolName?: string }) {
  if (!input || typeof input !== 'object') {
    return <div className="tool-input">{formatJson(input)}</div>
  }
  const command = typeof input.command === 'string' ? input.command : ''
  const description = typeof input.description === 'string' ? input.description : null
  const inBackground = input.run_in_background === true
  const timeoutMs = typeof input.timeout === 'number' ? input.timeout : null
  const isPowerShell = toolName === 'PowerShell'
  const promptGlyph = isPowerShell ? 'PS>' : '$'

  const lines = command.split('\n')
  const tooLong = command.length > BASH_FOLD_THRESHOLD || lines.length > BASH_PREVIEW_LINES
  // Two preview shapes:
  //  - Multi-line command → first N lines verbatim (line-count fold).
  //  - Single-line command above the char threshold → truncate the line so
  //    the closed <details> stays compact instead of rendering the entire
  //    command in the summary. (Without this branch, single-line 800-char
  //    pipelines visually defeat the fold.)
  const isSingleLineLong = lines.length === 1 && command.length > BASH_FOLD_THRESHOLD
  const previewText = isSingleLineLong
    ? command.slice(0, BASH_SINGLE_LINE_PREVIEW) + '…'
    : lines.slice(0, BASH_PREVIEW_LINES).join('\n')
  const remaining = lines.length - BASH_PREVIEW_LINES

  const chips = (
    <>
      {inBackground && <span className="tool-chip tool-chip-accent">background</span>}
      {timeoutMs != null && (
        <span className="tool-chip" title="Timeout in milliseconds">
          {formatBashTimeout(timeoutMs)}
        </span>
      )}
    </>
  )

  return (
    <div className="bash-tool">
      {tooLong ? (
        <details className="bash-tool-collapsible">
          <summary>
            <div className="bash-tool-line">
              <span className="bash-tool-prompt" aria-hidden>{promptGlyph}</span>
              <code className="bash-tool-command">{previewText}</code>
              {chips}
            </div>
            <div className="bash-tool-fold-hint">
              {remaining > 0
                ? `… ${remaining} more line${remaining === 1 ? '' : 's'} (${lines.length} total)`
                : `… ${command.length} chars (click to expand)`}
            </div>
          </summary>
          <pre className="bash-tool-full"><code>{command}</code></pre>
        </details>
      ) : (
        <div className="bash-tool-line">
          <span className="bash-tool-prompt" aria-hidden>{promptGlyph}</span>
          <code className="bash-tool-command">{command}</code>
          {chips}
        </div>
      )}
      {description && (
        <div className="bash-tool-desc">
          <span className="bash-tool-desc-marker" aria-hidden>└─</span>
          <span>{description}</span>
        </div>
      )}
    </div>
  )
}

function formatBashTimeout(ms: number): string {
  if (ms >= 60_000) {
    const m = Math.round((ms / 60_000) * 10) / 10
    return `timeout ${m}m`
  }
  if (ms >= 1000) return `timeout ${Math.round(ms / 1000)}s`
  return `timeout ${ms}ms`
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * File-path header (reuses the diff-file-path layout: bold filename, grey
 * directory right-aligned) plus a "lines N–M" / "pages X–Y" subline when
 * offset/limit/pages are set.
 */
function ReadToolView({ input }: { input?: Record<string, unknown> }) {
  if (!input || typeof input !== 'object') {
    return <div className="tool-input">{formatJson(input)}</div>
  }
  const filePath = typeof input.file_path === 'string' ? input.file_path : null
  const offset = typeof input.offset === 'number' ? input.offset : null
  const limit = typeof input.limit === 'number' ? input.limit : null
  const pages = typeof input.pages === 'string' ? input.pages : null

  if (!filePath) return <div className="tool-input">{formatJson(input)}</div>

  // offset is 0-indexed (per Read tool spec), but humans expect 1-indexed
  // line numbers, so display as offset+1 .. offset+limit.
  let rangeText: string | null = null
  if (offset != null && limit != null) {
    rangeText = `lines ${offset + 1}–${offset + limit}`
  } else if (offset != null) {
    rangeText = `from line ${offset + 1}`
  } else if (limit != null) {
    rangeText = `first ${limit} lines`
  }
  if (pages) rangeText = rangeText ? `${rangeText} · pages ${pages}` : `pages ${pages}`

  return (
    <div className="read-tool">
      <DiffFilePath path={filePath} />
      {rangeText && <div className="read-tool-range">{rangeText}</div>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Grep
// ---------------------------------------------------------------------------

/**
 * Pattern in quotes (the most important bit visually) plus modifier chips
 * for glob/type/path/output_mode and the case/multiline/-n flags. Order
 * mirrors how a human reads `rg "pattern" --glob='*.tsx' src/`.
 */
function GrepToolView({ input }: { input?: Record<string, unknown> }) {
  if (!input || typeof input !== 'object') {
    return <div className="tool-input">{formatJson(input)}</div>
  }
  const pattern = typeof input.pattern === 'string' ? input.pattern : null
  if (!pattern) return <div className="tool-input">{formatJson(input)}</div>

  const path = typeof input.path === 'string' ? input.path : null
  const glob = typeof input.glob === 'string' ? input.glob : null
  const type = typeof input.type === 'string' ? input.type : null
  const outputMode = typeof input.output_mode === 'string' ? input.output_mode : null
  const caseInsensitive = input['-i'] === true
  const multiline = input.multiline === true
  const headLimit = typeof input.head_limit === 'number' ? input.head_limit : null
  const before = typeof input['-B'] === 'number' ? (input['-B'] as number) : null
  const after = typeof input['-A'] === 'number' ? (input['-A'] as number) : null
  const context = typeof input['-C'] === 'number' ? (input['-C'] as number) : null

  return (
    <div className="grep-tool">
      <div className="grep-tool-row">
        <span className="grep-tool-icon" aria-hidden>🔍</span>
        <code className="grep-tool-pattern">&ldquo;{pattern}&rdquo;</code>
        {(glob || type) && (
          <span className="tool-chip tool-chip-accent">
            {glob ? `glob:${glob}` : `type:${type}`}
          </span>
        )}
        {path && <span className="tool-chip">in {path}</span>}
        {outputMode && outputMode !== 'files_with_matches' && (
          <span className="tool-chip">{outputMode}</span>
        )}
        {caseInsensitive && <span className="tool-chip" title="Case insensitive">-i</span>}
        {multiline && <span className="tool-chip" title="Multiline mode">multiline</span>}
        {context != null
          ? <span className="tool-chip">±{context}</span>
          : (before != null || after != null) && (
              <span className="tool-chip">
                {before != null ? `-B${before}` : ''}
                {before != null && after != null ? ' ' : ''}
                {after != null ? `-A${after}` : ''}
              </span>
            )}
        {headLimit != null && <span className="tool-chip">head:{headLimit}</span>}
      </div>
    </div>
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
 */
function TaskMutationView({ input }: { input?: Record<string, unknown> }) {
  if (!input || typeof input !== 'object') {
    return <div className="tool-input">{formatJson(input)}</div>
  }
  // TaskCreate has no taskId; TaskUpdate always has one.
  const taskId = typeof input.taskId === 'string' ? input.taskId : null
  const verb: 'create' | 'update' = taskId ? 'update' : 'create'

  const subject = typeof input.subject === 'string' ? input.subject : null
  const description = typeof input.description === 'string' ? input.description : null
  const status = typeof input.status === 'string' ? input.status : null
  const owner = typeof input.owner === 'string' ? input.owner : null
  const addBlocks = Array.isArray(input.addBlocks) ? (input.addBlocks as string[]) : null
  const addBlockedBy = Array.isArray(input.addBlockedBy) ? (input.addBlockedBy as string[]) : null

  // For pure-create the subject is mandatory in practice; for update it's
  // optional. Fall back to "(no subject)" rather than an empty line so
  // the card always has something to anchor on.
  const heading = subject ?? (verb === 'create' ? '(no subject)' : null)

  return (
    <div className="task-mutation">
      <div className="task-mutation-header">
        <span className={`task-mutation-verb verb-${verb}`}>{verb}</span>
        {taskId && <span className="task-mutation-id">#{taskId}</span>}
        {status && (
          <span className={`task-mutation-status status-${status}`} title={`Status: ${status}`}>
            {status}
          </span>
        )}
        {owner && <span className="task-mutation-owner" title="Owner">@{owner}</span>}
      </div>
      {heading && <div className="task-mutation-subject">{heading}</div>}
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
  )
}

// ---------------------------------------------------------------------------
// Glob
// ---------------------------------------------------------------------------

/**
 * Pattern-only file matcher. Visually a stripped-down Grep — same row
 * layout, same .grep-tool-* CSS (factoring out shared styles is the
 * pragmatic move when two tools render almost identically).
 */
function GlobToolView({ input }: { input?: Record<string, unknown> }) {
  if (!input || typeof input !== 'object') {
    return <div className="tool-input">{formatJson(input)}</div>
  }
  const pattern = typeof input.pattern === 'string' ? input.pattern : null
  if (!pattern) return <div className="tool-input">{formatJson(input)}</div>

  const path = typeof input.path === 'string' ? input.path : null

  return (
    <div className="grep-tool">
      <div className="grep-tool-row">
        <span className="grep-tool-icon" aria-hidden>📁</span>
        <code className="grep-tool-pattern">{pattern}</code>
        {path && <span className="tool-chip">in {path}</span>}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// WebFetch
// ---------------------------------------------------------------------------

/**
 * URL on top as a real anchor so the user can click through; prompt as
 * a muted subtitle on the second line. The URL itself is the key
 * information — what the model wants from it is secondary.
 *
 * The link is hardcoded to noopener/noreferrer + _blank — opening into
 * the chat tab is never what the user wants here, and a webpage that
 * inherits this app's window context could read its origin.
 */
function WebFetchToolView({ input }: { input?: Record<string, unknown> }) {
  if (!input || typeof input !== 'object') {
    return <div className="tool-input">{formatJson(input)}</div>
  }
  const url = typeof input.url === 'string' ? input.url : null
  const prompt = typeof input.prompt === 'string' ? input.prompt : null
  if (!url) return <div className="tool-input">{formatJson(input)}</div>

  const safe = isSafeUrl(url)

  return (
    <div className="web-tool">
      <div className="web-tool-line">
        <span className="web-tool-icon" aria-hidden>🌐</span>
        {safe ? (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="web-tool-url"
            title={url}
          >
            {url}
          </a>
        ) : (
          <>
            <code className="web-tool-url" title={url}>{url}</code>
            <span
              className="tool-chip"
              title="URL scheme is not in the http/https/mailto/ftp allowlist; rendered as plain text to avoid javascript: / data: URL execution."
            >
              unsafe scheme
            </span>
          </>
        )}
      </div>
      {prompt && (
        <div className="web-tool-prompt">
          <span className="web-tool-prompt-marker" aria-hidden>└─</span>
          <span>{truncate(prompt, 240)}</span>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// WebSearch
// ---------------------------------------------------------------------------

/**
 * Query in quotes (mono), allowed/blocked domain filters as muted chips
 * — visually parallels Grep / Glob so the "I'm searching X with these
 *   modifiers" pattern reads consistently across tools.
 */
function WebSearchToolView({ input }: { input?: Record<string, unknown> }) {
  if (!input || typeof input !== 'object') {
    return <div className="tool-input">{formatJson(input)}</div>
  }
  const query = typeof input.query === 'string' ? input.query : null
  if (!query) return <div className="tool-input">{formatJson(input)}</div>

  const allowed = Array.isArray(input.allowed_domains)
    ? (input.allowed_domains as string[]).filter((d) => typeof d === 'string')
    : []
  const blocked = Array.isArray(input.blocked_domains)
    ? (input.blocked_domains as string[]).filter((d) => typeof d === 'string')
    : []

  return (
    <div className="grep-tool">
      <div className="grep-tool-row">
        <span className="grep-tool-icon" aria-hidden>🔎</span>
        <code className="grep-tool-pattern">&ldquo;{query}&rdquo;</code>
        {allowed.length > 0 && (
          <span className="tool-chip tool-chip-accent" title="Allowed domains">
            only: {allowed.join(', ')}
          </span>
        )}
        {blocked.length > 0 && (
          <span className="tool-chip" title="Blocked domains">
            block: {blocked.join(', ')}
          </span>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// NotebookEdit
// ---------------------------------------------------------------------------

/**
 * Path header (reuses DiffFilePath) + cell metadata chip row + a +/-
 * diff body. NotebookEdit's edit_mode has three values:
 *   - 'replace' (default) : the new_source replaces the cell — show
 *                           it as +-only (we don't have the old text).
 *   - 'insert'            : a fresh cell is added — show +-only.
 *   - 'delete'            : cell removed — show an empty body with
 *                           "(cell deleted)" instead of a diff.
 *
 * Long sources collapse the same way WriteToolView truncates — keep
 * the pattern consistent so users learn one rule.
 */
function NotebookEditToolView({ input }: { input?: Record<string, unknown> }) {
  if (!input || typeof input !== 'object') {
    return <div className="tool-input">{formatJson(input)}</div>
  }
  const filePath = typeof input.notebook_path === 'string' ? input.notebook_path : null
  const cellId = typeof input.cell_id === 'string' ? input.cell_id : null
  const cellType = typeof input.cell_type === 'string' ? input.cell_type : null
  const editMode = typeof input.edit_mode === 'string' ? input.edit_mode : 'replace'
  const newSource = typeof input.new_source === 'string' ? input.new_source : ''

  if (!filePath) return <div className="tool-input">{formatJson(input)}</div>

  const isDelete = editMode === 'delete'
  const lines = newSource.split('\n')
  const totalLines = lines.length
  const preview = lines.slice(0, MAX_PREVIEW_LINES)
  const truncated = totalLines > MAX_PREVIEW_LINES

  return (
    <div className="diff-block">
      <DiffFilePath path={filePath} label={editMode} />
      {(cellId || cellType) && (
        <div className="notebook-edit-meta">
          {cellId && <span className="tool-chip">cell {cellId}</span>}
          {cellType && <span className="tool-chip tool-chip-accent">{cellType}</span>}
        </div>
      )}
      {isDelete ? (
        <div className="notebook-edit-deleted">(cell deleted)</div>
      ) : (
        <>
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
        </>
      )}
    </div>
  )
}

