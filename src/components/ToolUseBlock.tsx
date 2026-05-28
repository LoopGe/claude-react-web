// Structured rendering for tool_use blocks.
//
// Dispatches by tool name to provide rich views for Edit/Write/Bash/Read
// /etc., falling back to raw JSON for unknown tools.  Every concrete view
// is wrapped in <ToolCard> (see ToolCard.tsx) so they share the same
// chrome — icon, title, chip row, status badge, copy button — and the UI
// stays consistent across the dispatch table.
//
// Three tools have their *own* card wrappers because they carry their own
// lifecycle that doesn't map onto the generic running/success/error model
// (PlanCard's pending/approved/rejected, QuestionCard's pending/answered
// /skipped, SubagentCard's child-conversation drill-in):
//
//   - ExitPlanMode / EnterPlanMode → PlanCard
//   - AskUserQuestion              → QuestionCard
//   - Agent / Task / Explore       → SubagentCard
//
// Everything else routes through TOOL_VIEWS at the bottom of the file.
//
// `toolUseId` is threaded through to every view so ToolCard can flip the
// status badge from running → success/error when the matching tool_result
// lands. Without it, the badge would be permanently stuck on "running".

import { memo, type ComponentType, type ReactNode } from 'react'
import { Markdown } from './Markdown'
import { usePlanStatus, usePlanContent } from '../hooks/usePlanStatus'
import { useQuestionAnswers } from '../hooks/useQuestionAnswers'
import { SubagentCard } from './SubagentCard'
import { ToolCard } from './ToolCard'
import {
  IconAlertCircle,
  IconCheck,
  IconCircle,
  IconCircleDot,
  IconClipboardList,
  IconExternalLink,
  IconFileCode,
  IconFileText,
  IconFolderSearch,
  IconGlobe,
  IconListTodo,
  IconMessageQuestion,
  IconNotebook,
  IconSearch,
  IconShield,
  IconTerminal,
  IconWebSearch,
} from './icons/ToolIcons'
import { formatJson } from '../utils/format'
import { SUBAGENT_TOOL_NAMES, PLAN_TOOL_NAMES } from '../constants/toolNames'
import { QUESTION_TOOL_NAME, type QuestionAnswerEntry } from '../utils/question-answers'
import { truncate } from '../utils/text'
import { splitFilePath, shortenDir, detectLanguage } from '../utils/file-display'
import { highlightLineHast } from '../utils/diff-highlight'
import { extractToolUseId } from '../session-store/normalize'
import type { Block, QuestionSpec } from '../types'

// Per-tool input view. Each view receives the raw tool_use input (loosely
// typed because SDK schemas drift) and falls back to formatJson internally
// when the shape is unexpected. `toolName` is forwarded so a single view
// can serve more than one tool (e.g. BashToolView covers both Bash and
// PowerShell, branching on the name to swap the prompt glyph).
// `toolUseId` is threaded so ToolCard can look up live status.
type ToolViewProps = {
  input?: Record<string, unknown>
  toolName?: string
  toolUseId?: string
}
type ToolInputView = ComponentType<ToolViewProps>

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
  const id = extractToolUseId(block)

  // ExitPlanMode / EnterPlanMode → bespoke PlanCard (own lifecycle).
  if (name && PLAN_TOOL_NAMES.has(name)) {
    return <PlanCard input={input} toolUseId={id} />
  }

  // AskUserQuestion → bespoke QuestionCard (own lifecycle).
  if (name === QUESTION_TOOL_NAME) {
    return <QuestionCard input={input} toolUseId={id} />
  }

  // Agent / Task / Explore → SubagentCard (drill-in to child conversation).
  if (name && SUBAGENT_TOOL_NAMES.has(name)) {
    if (id) {
      const fallback =
        (typeof input?.description === 'string' && input.description) ||
        (typeof input?.prompt === 'string' && truncate(input.prompt as string, 80)) ||
        undefined
      return <SubagentCard toolUseId={id} fallbackLabel={fallback} />
    }
  }

  const View = name ? TOOL_VIEWS[name] : undefined
  if (View) {
    return <View input={input} toolName={name} toolUseId={id} />
  }
  // Unknown tool — fall back to raw JSON inside a generic ToolCard so the
  // status badge is still visible and the row aligns with the rest of the
  // transcript. Title is the tool name itself; nothing better to show.
  return (
    <ToolCard
      icon={<IconShield />}
      title={name ? <code className="tool-card-title-code">{name}</code> : 'tool'}
      toolUseId={id}
      copyValue={() => formatJson(input)}
      copyLabel="Copy raw input"
      className="tool-card-unknown"
    >
      <pre className="tool-input">{formatJson(input)}</pre>
    </ToolCard>
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
// File-path header (shared)
// ---------------------------------------------------------------------------

/** A two-line file-path display used as the *title* of file-touching tool
 *  cards (Edit, Write, Read, NotebookEdit).  Bold filename on top, muted
 *  parent dir below — so the user's eye lands on the actual file name
 *  before processing the path context.
 *
 *  The directory uses middle-ellipsis truncation (see shortenDir) instead
 *  of CSS right-truncate, because the leaf folder is the most informative
 *  segment and `text-overflow: ellipsis` would clip it first.  */
function FilePathTitle({
  path,
  badge,
}: {
  path: string
  badge?: string
}) {
  const { dir, base } = splitFilePath(path)
  const shortDir = dir ? shortenDir(dir, 48) : ''
  return (
    <span className="tool-card-filepath" title={path}>
      <span className="tool-card-filepath-base">{base || path}</span>
      {badge && <span className="tool-card-filepath-badge">{badge}</span>}
      {shortDir && <span className="tool-card-filepath-dir">{shortDir}</span>}
    </span>
  )
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
          <span className="plan-card-icon" aria-hidden>
            <IconClipboardList size={15} />
          </span>
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
          <span className="question-inline-icon" aria-hidden>
            <IconMessageQuestion size={15} />
          </span>
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

function EditToolView({ input, toolUseId }: ToolViewProps) {
  if (!input || typeof input !== 'object') {
    return <div className="tool-input">{formatJson(input)}</div>
  }

  const filePath = typeof input.file_path === 'string' ? input.file_path : null
  const edits = input.edits

  // MultiEdit: { file_path, edits: [{ old_string, new_string }] }
  // Single Edit: { file_path, old_string, new_string }
  const editList: Array<{ old: string; new: string }> = Array.isArray(edits)
    ? edits.map((e) => {
        const o = e as Record<string, unknown>
        return {
          old: typeof o.old_string === 'string' ? o.old_string : '',
          new: typeof o.new_string === 'string' ? o.new_string : '',
        }
      })
    : [
        {
          old: typeof input.old_string === 'string' ? input.old_string : '',
          new: typeof input.new_string === 'string' ? input.new_string : '',
        },
      ]

  // Copy: serialise the edit as -/+ marked lines so a paste into chat,
  // a code review tool, or a Slack thread reads visually like a diff.
  // This is NOT a real unified diff — there's no `--- a/file +++ b/file`
  // header and no `@@` hunk marker, so `patch` won't apply it. The
  // button is labelled "Copy edit" rather than "Copy diff" to make
  // that contract honest. If a future caller actually needs an
  // applicable patch, generate one with a real diff library here.
  const copyValue = () =>
    editList
      .map((e, i) => {
        const header = editList.length > 1 ? `# edit ${i + 1}\n` : ''
        const oldLines = e.old.split('\n').map((l) => `- ${l}`).join('\n')
        const newLines = e.new.split('\n').map((l) => `+ ${l}`).join('\n')
        return `${header}${oldLines}\n${newLines}`
      })
      .join('\n\n')

  const chips = Array.isArray(edits) && edits.length > 1 ? (
    <span className="tool-chip">{edits.length} edits</span>
  ) : null

  return (
    <ToolCard
      icon={<IconFileCode />}
      title={filePath ? <FilePathTitle path={filePath} /> : 'edit'}
      chips={chips}
      toolUseId={toolUseId}
      copyValue={copyValue}
      copyLabel="Copy edit"
      className="tool-card-diff"
    >
      <div className="diff-block-inner">
        {editList.map((e, i) => (
          <DiffChunk
            key={i}
            oldText={e.old}
            newText={e.new}
            filePath={filePath ?? undefined}
            label={editList.length > 1 ? `edit ${i + 1}` : undefined}
          />
        ))}
      </div>
    </ToolCard>
  )
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

function WriteToolView({ input, toolUseId }: ToolViewProps) {
  if (!input || typeof input !== 'object') {
    return <div className="tool-input">{formatJson(input)}</div>
  }

  const filePath = typeof input.file_path === 'string' ? input.file_path : null
  const content = typeof input.content === 'string' ? input.content : ''
  const lines = content.split('\n')
  const totalLines = lines.length

  return (
    <ToolCard
      icon={<IconFileText />}
      title={filePath ? <FilePathTitle path={filePath} badge="new file" /> : 'write'}
      chips={<span className="tool-chip">{totalLines} line{totalLines === 1 ? '' : 's'}</span>}
      toolUseId={toolUseId}
      copyValue={() => content}
      copyLabel="Copy file content"
      className="tool-card-diff"
    >
      <div className="diff-block-inner">
        <ExpandableDiff
          lines={lines}
          filePath={filePath ?? undefined}
        />
      </div>
    </ToolCard>
  )
}

// ---------------------------------------------------------------------------
// Shared sub-components (diff rendering)
// ---------------------------------------------------------------------------

/** Render a single diff line with optional syntax highlighting via the
 *  shared lowlight instance. Empty / unknown-language lines fall back to
 *  plain text rather than throwing. */
function DiffLine({
  line,
  marker,
  variant,
  language,
}: {
  line: string
  marker: '+' | '-' | ' '
  variant: 'add' | 'del' | 'ctx'
  language: string | null
}) {
  // Empty lines: skip highlighting for a tiny perf win.
  const hast = line && language ? highlightLineHast(language, line) : null
  return (
    <div className={`diff-line diff-line-${variant === 'add' ? 'add' : variant === 'del' ? 'del' : 'ctx'}`}>
      <span className="diff-line-marker">{marker}</span>
      <span className="diff-line-text">
        {hast ?? line}
      </span>
    </div>
  )
}

function DiffChunk({
  oldText,
  newText,
  filePath,
  label,
}: {
  oldText: string
  newText: string
  filePath?: string
  label?: string
}) {
  const oldLines = oldText.split('\n')
  const newLines = newText.split('\n')
  const language = filePath ? detectLangSafe(filePath) : null

  return (
    <>
      {label && <div className="diff-chunk-label">{label}</div>}
      <div className="diff-lines">
        {oldLines.map((line, i) => (
          <DiffLine key={`del-${i}`} line={line} marker="-" variant="del" language={language} />
        ))}
        {newLines.map((line, i) => (
          <DiffLine key={`add-${i}`} line={line} marker="+" variant="add" language={language} />
        ))}
      </div>
    </>
  )
}

/** Render a sequence of additions (Write / NotebookEdit) with click-to-expand
 *  truncation: first MAX_PREVIEW_LINES are visible, remainder hides behind
 *  a <details> the user can open.
 *
 *  Currently only used for additions (the "create a file" / "write a cell"
 *  shapes — both are content the assistant is *adding*, not replacing).
 *  If a deletion-only call site appears later, lift the marker/variant
 *  back into props rather than reintroducing a dead branch. */
function ExpandableDiff({
  lines,
  filePath,
}: {
  lines: string[]
  filePath?: string
}) {
  const language = filePath ? detectLangSafe(filePath) : null
  const total = lines.length
  if (total <= MAX_PREVIEW_LINES) {
    return (
      <div className="diff-lines">
        {lines.map((line, i) => (
          <DiffLine
            key={i}
            line={line}
            marker="+"
            variant="add"
            language={language}
          />
        ))}
      </div>
    )
  }
  const visible = lines.slice(0, MAX_PREVIEW_LINES)
  const hidden = lines.slice(MAX_PREVIEW_LINES)
  return (
    <>
      <div className="diff-lines">
        {visible.map((line, i) => (
          <DiffLine
            key={i}
            line={line}
            marker="+"
            variant="add"
            language={language}
          />
        ))}
      </div>
      <details className="diff-truncation-details">
        <summary>
          <span className="diff-truncation-summary">
            … show {total - MAX_PREVIEW_LINES} more line{total - MAX_PREVIEW_LINES === 1 ? '' : 's'} ({total} total)
          </span>
        </summary>
        <div className="diff-lines">
          {hidden.map((line, i) => (
            <DiffLine
              key={i}
              line={line}
              marker="+"
              variant="add"
              language={language}
            />
          ))}
        </div>
      </details>
    </>
  )
}

// Cache lookups: detectLanguage is cheap, but most file paths repeat across
// many lines of the same diff so a tiny memo avoids re-walking the EXT
// table per render.
//
// Bounded with FIFO eviction so a long-lived tab that visits dozens of
// repos can't accumulate path entries indefinitely. The cap is
// deliberately generous — typical sessions touch <100 distinct paths and
// the cache value is just `string | null`, so the memory footprint at
// the cap is on the order of tens of KB.
const MAX_LANG_CACHE = 256
const langCache = new Map<string, string | null>()
function detectLangSafe(path: string): string | null {
  const cached = langCache.get(path)
  if (cached !== undefined || langCache.has(path)) {
    // Map order is preserved by insertion. Re-inserting would update
    // recency for an LRU policy; we don't bother — FIFO is fine here
    // because file paths in a session don't have a strong recency
    // pattern (every diff line of the same file hits the same key).
    return cached ?? null
  }
  if (langCache.size >= MAX_LANG_CACHE) {
    // Evict the oldest entry. `keys().next().value` on a Map returns
    // the first inserted key.
    const oldest = langCache.keys().next().value
    if (oldest !== undefined) langCache.delete(oldest)
  }
  const lang = detectLanguage(path)
  langCache.set(path, lang)
  return lang
}

// ---------------------------------------------------------------------------
// TodoWrite
// ---------------------------------------------------------------------------

function TodoWriteView({ input, toolUseId }: ToolViewProps) {
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
                <Icon size={13} />
              </span>
              <span className="inline-todo-text">{content}</span>
            </li>
          )
        })}
      </ul>
    </ToolCard>
  )
}

// ---------------------------------------------------------------------------
// Bash
// ---------------------------------------------------------------------------

const BASH_FOLD_THRESHOLD = 240
const BASH_PREVIEW_LINES = 3
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
function BashToolView({ input, toolName, toolUseId }: ToolViewProps) {
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

  // Title is the first line of the command (the most informative bit at a
  // glance); the body holds the full command (folded if long).
  const titleLine = (
    <span className="bash-tool-line">
      <span className="bash-tool-prompt" aria-hidden>{promptGlyph}</span>
      <code className="bash-tool-command">
        {tooLong ? previewText : command}
      </code>
    </span>
  )

  return (
    <ToolCard
      icon={<IconTerminal />}
      title={titleLine}
      chips={chips}
      toolUseId={toolUseId}
      copyValue={() => command}
      copyLabel="Copy command"
      className="tool-card-bash"
    >
      {(tooLong || description) && (
        <div className="bash-tool-body">
          {tooLong && (
            <details className="bash-tool-collapsible">
              <summary>
                <span className="bash-tool-fold-hint">
                  {remaining > 0
                    ? `… show ${remaining} more line${remaining === 1 ? '' : 's'} (${lines.length} total)`
                    : `… show full command (${command.length} chars)`}
                </span>
              </summary>
              <pre className="bash-tool-full"><code>{command}</code></pre>
            </details>
          )}
          {description && (
            <div className="bash-tool-desc">
              <span className="bash-tool-desc-marker" aria-hidden>└─</span>
              <span>{description}</span>
            </div>
          )}
        </div>
      )}
    </ToolCard>
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
 * File-path header (filename + grey dir) plus a "lines N–M" / "pages X–Y"
 * chip when offset/limit/pages are set. Reads have no body — the file path
 * + range is the entire useful payload at the tool_use stage.
 */
function ReadToolView({ input, toolUseId }: ToolViewProps) {
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
    <ToolCard
      icon={<IconFileText />}
      title={<FilePathTitle path={filePath} />}
      chips={rangeText ? <span className="tool-chip">{rangeText}</span> : null}
      toolUseId={toolUseId}
      copyValue={() => filePath}
      copyLabel="Copy path"
      className="tool-card-read"
    />
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
function GrepToolView({ input, toolUseId }: ToolViewProps) {
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

  const chips = (
    <>
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
    </>
  )

  return (
    <ToolCard
      icon={<IconSearch />}
      title={<code className="grep-tool-pattern">&ldquo;{pattern}&rdquo;</code>}
      chips={chips}
      toolUseId={toolUseId}
      copyValue={() => pattern}
      copyLabel="Copy pattern"
      className="tool-card-grep"
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
 */
function TaskMutationView({ input, toolUseId }: ToolViewProps) {
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

  // Heading: subject for both, falling back so the card always anchors on
  // something readable rather than collapsing to chip-only.
  const heading = subject ?? (verb === 'create' ? '(no subject)' : taskId ? `Update #${taskId}` : '(no subject)')

  const chips = (
    <>
      <span className={`task-mutation-verb verb-${verb}`}>{verb}</span>
      {taskId && <span className="task-mutation-id">#{taskId}</span>}
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
// Glob
// ---------------------------------------------------------------------------

/**
 * Pattern-only file matcher. Visually a stripped-down Grep — same row
 * layout, same chip vocabulary.
 */
function GlobToolView({ input, toolUseId }: ToolViewProps) {
  if (!input || typeof input !== 'object') {
    return <div className="tool-input">{formatJson(input)}</div>
  }
  const pattern = typeof input.pattern === 'string' ? input.pattern : null
  if (!pattern) return <div className="tool-input">{formatJson(input)}</div>

  const path = typeof input.path === 'string' ? input.path : null

  return (
    <ToolCard
      icon={<IconFolderSearch />}
      title={<code className="grep-tool-pattern">{pattern}</code>}
      chips={path ? <span className="tool-chip">in {path}</span> : null}
      toolUseId={toolUseId}
      copyValue={() => pattern}
      copyLabel="Copy pattern"
      className="tool-card-glob"
    />
  )
}

// ---------------------------------------------------------------------------
// WebFetch
// ---------------------------------------------------------------------------

/**
 * URL on top as a real anchor so the user can click through; prompt as
 * a muted body line. The URL itself is the key information — what the
 * model wants from it is secondary.
 *
 * The link is hardcoded to noopener/noreferrer + _blank — opening into
 * the chat tab is never what the user wants here, and a webpage that
 * inherits this app's window context could read its origin.
 */
function WebFetchToolView({ input, toolUseId }: ToolViewProps) {
  if (!input || typeof input !== 'object') {
    return <div className="tool-input">{formatJson(input)}</div>
  }
  const url = typeof input.url === 'string' ? input.url : null
  const prompt = typeof input.prompt === 'string' ? input.prompt : null
  if (!url) return <div className="tool-input">{formatJson(input)}</div>

  const safe = isSafeUrl(url)
  const titleNode = safe ? (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="web-tool-url"
      title={url}
      onClick={(e) => e.stopPropagation()}
    >
      {url}
      <IconExternalLink size={11} />
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
  )

  return (
    <ToolCard
      icon={<IconGlobe />}
      title={titleNode}
      toolUseId={toolUseId}
      copyValue={() => url}
      copyLabel="Copy URL"
      className="tool-card-web"
    >
      {prompt && (
        <div className="web-tool-prompt">
          <span className="web-tool-prompt-marker" aria-hidden>└─</span>
          <span>{truncate(prompt, 240)}</span>
        </div>
      )}
    </ToolCard>
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
function WebSearchToolView({ input, toolUseId }: ToolViewProps) {
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

  const chips = (
    <>
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
    </>
  )

  return (
    <ToolCard
      icon={<IconWebSearch />}
      title={<code className="grep-tool-pattern">&ldquo;{query}&rdquo;</code>}
      chips={chips}
      toolUseId={toolUseId}
      copyValue={() => query}
      copyLabel="Copy query"
      className="tool-card-websearch"
    />
  )
}

// ---------------------------------------------------------------------------
// NotebookEdit
// ---------------------------------------------------------------------------

/**
 * Path header + cell metadata chip row + a +/- diff body. NotebookEdit's
 * edit_mode has three values:
 *   - 'replace' (default) : the new_source replaces the cell — show
 *                           it as +-only (we don't have the old text).
 *   - 'insert'            : a fresh cell is added — show +-only.
 *   - 'delete'            : cell removed — show an empty body with
 *                           "(cell deleted)" instead of a diff.
 */
function NotebookEditToolView({ input, toolUseId }: ToolViewProps) {
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

  const chips = (
    <>
      <span className={`tool-chip tool-chip-${editMode === 'delete' ? 'danger' : 'accent'}`}>
        {editMode}
      </span>
      {cellId && <span className="tool-chip">cell {cellId}</span>}
      {cellType && <span className="tool-chip">{cellType}</span>}
      {!isDelete && <span className="tool-chip">{totalLines} line{totalLines === 1 ? '' : 's'}</span>}
    </>
  )

  return (
    <ToolCard
      icon={<IconNotebook />}
      title={<FilePathTitle path={filePath} />}
      chips={chips}
      toolUseId={toolUseId}
      copyValue={isDelete ? undefined : () => newSource}
      copyLabel="Copy cell content"
      className="tool-card-diff"
    >
      {isDelete ? (
        <div className="notebook-edit-deleted">
          <IconAlertCircle size={13} /> cell deleted
        </div>
      ) : (
        <div className="diff-block-inner">
          <ExpandableDiff
            lines={lines}
            filePath={filePath}
          />
        </div>
      )}
    </ToolCard>
  )
}

