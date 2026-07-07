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
//   - ExitPlanMode                 → PlanCard (plan proposal, review lifecycle)
//   - AskUserQuestion              → QuestionCard
//   - Agent / Task / Explore       → SubagentCard
//
// EnterPlanMode is NOT a bespoke-card tool despite the similar name — it is the
// plan-mode ENTRY signal (empty input, nothing to review) and renders as a
// lightweight inline marker (EnterPlanModeMarker), distinct from ExitPlanMode.
//
// Everything else routes through TOOL_VIEWS at the bottom of the file.
//
// `toolUseId` is threaded through to every view so ToolCard can flip the
// status badge from running → success/error when the matching tool_result
// lands. Without it, the badge would be permanently stuck on "running".

import { memo, useMemo, type ComponentType, type ReactNode } from 'react'
import { Markdown } from './Markdown'
import { usePlanStatus, usePlanContent, useToolResult } from '../hooks/usePlanStatus'
import { useQuestionAnswers } from '../hooks/useQuestionAnswers'
import { useTaskInfo } from '../hooks/useTaskInfo'
import { useReopenQuestion } from '../hooks/useReopenQuestion'
import { useSessionCwd } from '../hooks/useSessionCwd'
import { useEditDiffInfo, type EditAnchor, type EditDiffInfo } from '../hooks/useEditDiffInfo'
import { SubagentCard } from './SubagentCard'
import { WorkflowCard } from './WorkflowCard'
import { ToolCard } from './ToolCard'
import { AnimatedDetails } from './AnimatedCollapse'
import {
  IconAlertCircle,
  IconCheck,
  IconCheckSquare,
  IconCircle,
  IconCircleDot,
  IconClipboardList,
  IconDownload,
  IconSquare,
  IconExternalLink,
  IconFileCode,
  IconFileText,
  IconFolderSearch,
  IconGlobe,
  IconListTodo,
  IconMessageCircle,
  IconMessageQuestion,
  IconNotebook,
  IconSearch,
  IconShield,
  IconSparkles,
  IconTerminal,
  IconWebSearch,
} from './icons/ToolIcons'
import { formatJson } from '../utils/format'
import { SUBAGENT_TOOL_NAMES, PLAN_TOOL_NAMES, ENTER_PLAN_MODE_TOOL_NAME, WORKFLOW_TOOL_NAME } from '../constants/toolNames'
import { QUESTION_TOOL_NAME, type QuestionAnswerEntry } from '../utils/question-answers'
import { parseTaskId, resultText } from '../utils/task-events'
import { truncate } from '../utils/text'
import { splitFilePath, shortenDir, detectLanguage } from '../utils/file-display'
import { highlightLineHast } from '../utils/diff-highlight'
import { extractToolUseId } from '../session-store/normalize'
import type { Block, QuestionSpec } from '../types'

// Per-tool input view. Each view receives the raw tool_use input (loosely
// type because SDK schemas drift) and falls back to formatJson internally
// when the shape is unexpected. `toolName` is forwarded so a single view
// can serve more than one tool (e.g. BashToolView covers both Bash and
// PowerShell, branching on the name to swap the prompt glyph).
// `toolUseId` is threaded so ToolCard can look up live status.
type ToolViewProps = {
  input?: Record<string, unknown>
  toolName?: string
  toolUseId?: string
  searchQuery?: string
  activeMatchIdx?: number
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

export const ToolUseBlock = memo(function ToolUseBlock({ block, searchQuery, activeMatchIdx }: { block: Block; searchQuery?: string; activeMatchIdx?: number }) {
  const name = block.name
  const input = block.input as Record<string, unknown> | undefined
  const id = extractToolUseId(block)

  // EnterPlanMode → lightweight inline marker. It only signals "the model is
  // about to start planning" (empty input, no plan to show) — NOT a plan
  // proposal, so it must NOT render a PlanCard. Check before PLAN_TOOL_NAMES.
  if (name === ENTER_PLAN_MODE_TOOL_NAME) {
    return <EnterPlanModeMarker />
  }

  // ExitPlanMode → bespoke PlanCard (own pending/approved/rejected lifecycle).
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

  // Workflow → WorkflowCard (drill-in to the two-column phase-tree overlay).
  // Like SubagentCard it spawns nested tool_use/tool_result frames (its child
  // agents carry parent_tool_use_id = its own tool_use id), but it gets its
  // own card/overlay pair because it additionally carries a declarative phase
  // tree (input.meta.phases) that has no analogue in a plain Agent/Task/Explore
  // call. Falls through to the raw-JSON branch only when we somehow lack an id.
  if (name === WORKFLOW_TOOL_NAME && id) {
    const fallback =
      (typeof input?.description === 'string' && input.description) ||
      (typeof input?.prompt === 'string' && truncate(input.prompt as string, 80)) ||
      undefined
    return <WorkflowCard toolUseId={id} fallbackLabel={fallback} />
  }

  const View = name ? TOOL_VIEWS[name] : undefined
  if (View) {
    return <View input={input} toolName={name} toolUseId={id} searchQuery={searchQuery} activeMatchIdx={activeMatchIdx} />
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
      searchQuery={searchQuery}
      activeMatchIdx={activeMatchIdx}
    >
      <pre className="tool-input">{formatJson(input)}</pre>
    </ToolCard>
  )
})

// Dispatch table for per-tool inline views lives at the END of this file:
// several views are now `const X = memo(...)` rather than hoisted function
// declarations, so the map must be defined after them to avoid a
// temporal-dead-zone reference. New tools: declare the view, then add an
// entry to TOOL_VIEWS at the bottom.

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
// EnterPlanMode
// ---------------------------------------------------------------------------

/**
 * Lightweight inline marker for the EnterPlanMode tool. The model emits this
 * when it is about to start planning — the input is empty and there is nothing
 * to approve, so this is intentionally NOT a card with a body or status badge.
 * It reads as a thin divider-style cue ("Entered plan mode") so the transcript
 * shows the mode transition without the noise of an empty Plan proposal card.
 */
function EnterPlanModeMarker() {
  return (
    <div className="enter-plan-marker" role="note" aria-label="Claude entered plan mode">
      <span className="enter-plan-marker-icon" aria-hidden>
        <IconClipboardList size={13} />
      </span>
      <span className="enter-plan-marker-label">Entered plan mode</span>
      <span className="enter-plan-marker-sub">Claude is planning before acting</span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// ExitPlanMode
// ---------------------------------------------------------------------------

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
const PlanCard = memo(function PlanCard({
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
const QuestionCard = memo(function QuestionCard({
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
  const { minimizedToolUseIds, onReopen } = useReopenQuestion()

  const status: QuestionCardStatus = (() => {
    if (!answers || answers.length === 0) return 'pending'
    return answers.every((a) => a.answer == null) ? 'skipped' : 'answered'
  })()
  // The dialog is minimized (hidden) but the question is still awaiting an
  // answer; let the user click this card to bring the dialog back.
  const isMinimized = status === 'pending' && !!toolUseId && minimizedToolUseIds.has(toolUseId)
  const statusLabel = status
  const statusTitle =
    status === 'answered'
      ? 'You answered - Claude received your selections.'
      : status === 'skipped'
        ? 'You skipped every question - Claude is continuing without guidance.'
        : 'Pending your answer.'
  // `key` forces a remount when status flips so the default-open state
  // re-applies; same trick PlanCard uses.
  const defaultOpen = status === 'pending'

  return (
    <AnimatedDetails
      key={status}
      className={`question-inline-card question-inline-card-${status}${isMinimized ? ' question-inline-card-minimized' : ''}`}
      defaultOpen={defaultOpen}
      summary={(
        <div className="question-inline-header">
          <span className="question-inline-icon" aria-hidden>
            <IconMessageQuestion size={14} />
          </span>
          <span className="question-inline-title">
            {questions.length === 1 ? 'Question for you' : `${questions.length} questions for you`}
          </span>
          <span className={`question-inline-status ${status}`} title={statusTitle}>
            {statusLabel}
          </span>
          {isMinimized && toolUseId && (
            <button
              type="button"
              className="question-inline-reopen"
              // <summary>'s click toggles the details; stop it so reopening
              // the dialog does not also collapse/expand the card.
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                onReopen(toolUseId)
              }}
              title="Reopen question dialog"
            >
              Click to answer
            </button>
          )}
        </div>
      )}
      contentClassName="question-inline-body"
    >
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
    </AnimatedDetails>
  )
})

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
  const presetLabels = new Set((question.options ?? []).map((o) => o.label))
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
        {(question.options ?? []).map((opt) => {
          const selected = selectedSet.has(opt.label)
          return (
            <li
              key={opt.label}
              className={`question-inline-option ${selected ? 'selected' : ''}`}
            >
              <span className="question-inline-option-marker" aria-hidden>
                {isMulti ? (selected ? <IconCheckSquare size={14} /> : <IconSquare size={14} />) : selected ? <IconCircleDot size={14} /> : <IconCircle size={14} />}
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
              {isMulti ? <IconCheckSquare size={14} /> : <IconCircleDot size={14} />}
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

const EditToolView = memo(function EditToolView({ input, toolUseId, searchQuery, activeMatchIdx }: ToolViewProps) {
  // Hooks must run before the early return below, so derive editList /
  // filePath via useMemo and resolve start lines unconditionally.
  const cwd = useSessionCwd()

  const filePath = useMemo(
    () =>
      input && typeof input === 'object' && typeof input.file_path === 'string'
        ? input.file_path
        : null,
    [input],
  )

  // MultiEdit: { file_path, edits: [{ old_string, new_string }] }
  // Single Edit: { file_path, old_string, new_string }
  const editList = useMemo<Array<{ old: string; new: string }>>(() => {
    if (!input || typeof input !== 'object') return []
    const edits = input.edits
    if (Array.isArray(edits)) {
      return edits.map((e) => {
        const o = e as Record<string, unknown>
        return {
          old: typeof o.old_string === 'string' ? o.old_string : '',
          new: typeof o.new_string === 'string' ? o.new_string : '',
        }
      })
    }
    return [
      {
        old: typeof input.old_string === 'string' ? input.old_string : '',
        new: typeof input.new_string === 'string' ? input.new_string : '',
      },
    ]
  }, [input])

  // Real file line numbers + surrounding context per edit — the server reads
  // <cwd>/<path> and locates new_string (applied) or old_string (not applied),
  // returning the start line plus 3 unchanged lines above/below (git-diff
  // style). null startLine while loading or when the location can't be pinned
  // down (file changed / ambiguous / missing) — DiffChunk then renders no
  // gutter and no context rather than misleading numbers.
  const anchors = useMemo<EditAnchor[]>(() => editList.map((e) => ({ old: e.old, new: e.new })), [editList])
  const diffInfos = useEditDiffInfo(cwd, filePath ?? undefined, anchors)

  if (!input || typeof input !== 'object') {
    return <div className="tool-input">{formatJson(input)}</div>
  }

  const edits = input.edits

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
      searchQuery={searchQuery}
      activeMatchIdx={activeMatchIdx}
    >
      <div className="diff-block-inner">
        {editList.map((e, i) => (
          <DiffChunk
            key={i}
            oldText={e.old}
            newText={e.new}
            filePath={filePath ?? undefined}
            label={editList.length > 1 ? `edit ${i + 1}` : undefined}
            info={diffInfos[i]}
          />
        ))}
      </div>
    </ToolCard>
  )
})

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

const WriteToolView = memo(function WriteToolView({ input, toolUseId, searchQuery, activeMatchIdx }: ToolViewProps) {
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
      searchQuery={searchQuery}
      activeMatchIdx={activeMatchIdx}
    >
      <div className="diff-block-inner">
        <ExpandableDiff
          lines={lines}
          filePath={filePath ?? undefined}
        />
      </div>
    </ToolCard>
  )
})

// ---------------------------------------------------------------------------
// Shared sub-components (diff rendering)
// ---------------------------------------------------------------------------

/** Line-level LCS diff of two strings → interleaved op sequence
 *  (equal / delete / add) with 0-based oldIdx / newIdx per op. Used by
 *  DiffChunk to render a unified-style interleaved diff (claude-code /
 *  `git diff` reading order) instead of a before/after split.
 *
 *  O(M·N) DP is fine here: old_string / new_string are edit fragments, not
 *  whole files, so M and N are small (typically <100 lines). */
type LineDiffOp =
  | { type: 'eq'; oldIdx: number; newIdx: number; text: string }
  | { type: 'del'; oldIdx: number; newIdx: number; text: string }
  | { type: 'add'; oldIdx: number; newIdx: number; text: string }

function lineDiff(oldLines: readonly string[], newLines: readonly string[]): LineDiffOp[] {
  const m = oldLines.length
  const n = newLines.length
  if (m === 0) return newLines.map((text, j) => ({ type: 'add' as const, oldIdx: 0, newIdx: j, text }))
  if (n === 0) return oldLines.map((text, i) => ({ type: 'del' as const, oldIdx: i, newIdx: 0, text }))

  // LCS length DP, built from the bottom-right so we can walk forward.
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--) {
    const row = dp[i]
    const next = dp[i + 1]
    const oi = oldLines[i]
    for (let j = n - 1; j >= 0; j--) {
      row[j] = oi === newLines[j] ? next[j + 1] + 1 : Math.max(next[j], row[j + 1])
    }
  }

  const ops: LineDiffOp[] = []
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (oldLines[i] === newLines[j]) {
      ops.push({ type: 'eq', oldIdx: i, newIdx: j, text: oldLines[i] })
      i++; j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: 'del', oldIdx: i, newIdx: j, text: oldLines[i] })
      i++
    } else {
      ops.push({ type: 'add', oldIdx: i, newIdx: j, text: newLines[j] })
      j++
    }
  }
  while (i < m) {
    ops.push({ type: 'del', oldIdx: i, newIdx: j, text: oldLines[i] })
    i++
  }
  while (j < n) {
    ops.push({ type: 'add', oldIdx: i, newIdx: j, text: newLines[j] })
    j++
  }
  return ops
}

/** Render a single diff line with optional syntax highlighting via the
 *  shared lowlight instance. Empty / unknown-language lines fall back to
 *  plain text rather than throwing. The gutter is two columns (old | new):
 *  ctx rows show both, del rows blank the new cell, add rows blank the old
 *  cell. When a column's width is 0/undefined the cell isn't rendered. */
const DiffLine = memo(function DiffLine({
  line,
  marker,
  variant,
  language,
  oldLine,
  newLine,
  gutterOldWidth,
  gutterNewWidth,
}: {
  line: string
  marker: '+' | '-' | ' '
  variant: 'add' | 'del' | 'ctx'
  language: string | null
  /** Old-file line number for the gutter (ctx / del rows). undefined = blank
   *  cell. The old cell only renders when gutterOldWidth > 0. */
  oldLine?: number
  /** New-file line number for the gutter (ctx / add rows). undefined = blank. */
  newLine?: number
  /** Old gutter column width in ch (0 / undefined → don't render the cell). */
  gutterOldWidth?: number
  /** New gutter column width in ch (0 / undefined → don't render the cell). */
  gutterNewWidth?: number
}) {
  // Empty lines: skip highlighting for a tiny perf win.
  const hast = line && language ? highlightLineHast(language, line) : null
  const showOld = (gutterOldWidth ?? 0) > 0
  const showNew = (gutterNewWidth ?? 0) > 0
  return (
    <div className={`diff-line diff-line-${variant === 'add' ? 'add' : variant === 'del' ? 'del' : 'ctx'}`}>
      {showOld && (
        <span className="diff-line-gutter diff-line-gutter-old" style={{ minWidth: `${gutterOldWidth}ch` }}>
          {oldLine ?? ''}
        </span>
      )}
      {showNew && (
        <span className="diff-line-gutter diff-line-gutter-new" style={{ minWidth: `${gutterNewWidth}ch` }}>
          {newLine ?? ''}
        </span>
      )}
      <span className="diff-line-marker">{marker}</span>
      <span className="diff-line-text">
        {hast ?? line}
      </span>
    </div>
  )
})

const DiffChunk = memo(function DiffChunk({
  oldText,
  newText,
  filePath,
  label,
  info,
}: {
  oldText: string
  newText: string
  filePath?: string
  label?: string
  /** Server-resolved unified-diff hunks for this edit. null / undefined → no
   *  gutter and no context; the bare interleaved +/- fragment still renders. */
  info?: EditDiffInfo | null
}) {
  const language = filePath ? detectLangSafe(filePath) : null
  // '' → 0 lines (pure insertion / deletion); '\n' → ['', ''] (two empty
  // lines). Without this guard an empty old_string would render a spurious
  // empty del row. Used only for the no-hunks fallback.
  const oldLines = useMemo(
    () => (oldText === '' ? [] : oldText.split('\n')),
    [oldText],
  )
  const newLines = useMemo(
    () => (newText === '' ? [] : newText.split('\n')),
    [newText],
  )
  const ops = useMemo(() => lineDiff(oldLines, newLines), [oldLines, newLines])

  const hunks = info?.hunks ?? null

  if (hunks && hunks.length > 0) {
    // Width each column to its widest visible number so ctx / del / add rows
    // stay aligned across every hunk.
    let maxOld = 0
    let maxNew = 0
    for (const h of hunks) {
      maxOld = Math.max(maxOld, h.oldStart + h.oldLines - 1)
      maxNew = Math.max(maxNew, h.newStart + h.newLines - 1)
    }
    const gutterOldWidth = maxOld > 0 ? String(maxOld).length : 0
    const gutterNewWidth = maxNew > 0 ? String(maxNew).length : 0

    // Walk each hunk's lines, tracking the running old/new line number.
    // structuredPatch prefixes lines with ' ' (ctx) / '-' (del) / '+' (add);
    // ctx increments both counters, del increments old, add increments new.
    const rows: ReactNode[] = []
    for (let hi = 0; hi < hunks.length; hi++) {
      const h = hunks[hi]
      let oldLine = h.oldStart
      let newLine = h.newStart
      for (let li = 0; li < h.lines.length; li++) {
        const raw = h.lines[li]
        const prefix = raw[0]
        const text = raw.slice(1)
        if (prefix === ' ') {
          rows.push(
            <DiffLine
              key={`${hi}-${li}`}
              line={text}
              marker=" "
              variant="ctx"
              language={language}
              oldLine={oldLine}
              newLine={newLine}
              gutterOldWidth={gutterOldWidth}
              gutterNewWidth={gutterNewWidth}
            />,
          )
          oldLine++
          newLine++
        } else if (prefix === '-') {
          rows.push(
            <DiffLine
              key={`${hi}-${li}`}
              line={text}
              marker="-"
              variant="del"
              language={language}
              oldLine={oldLine}
              gutterOldWidth={gutterOldWidth}
              gutterNewWidth={gutterNewWidth}
            />,
          )
          oldLine++
        } else if (prefix === '+') {
          rows.push(
            <DiffLine
              key={`${hi}-${li}`}
              line={text}
              marker="+"
              variant="add"
              language={language}
              newLine={newLine}
              gutterOldWidth={gutterOldWidth}
              gutterNewWidth={gutterNewWidth}
            />,
          )
          newLine++
        }
        // Other prefixes (e.g. '\ No newline at end of file') are skipped.
      }
    }

    return (
      <>
        {label && <div className="diff-chunk-label">{label}</div>}
        <div className="diff-lines">{rows}</div>
      </>
    )
  }

  // Fallback: edit couldn't be located in the file, so no line numbers /
  // context. Render the bare interleaved +/- fragment so the card still shows
  // what changed.
  return (
    <>
      {label && <div className="diff-chunk-label">{label}</div>}
      <div className="diff-lines">
        {ops.map((op, idx) => {
          const variant = op.type === 'eq' ? 'ctx' : op.type === 'del' ? 'del' : 'add'
          const marker = op.type === 'eq' ? ' ' : op.type === 'del' ? '-' : '+'
          return (
            <DiffLine
              key={idx}
              line={op.text}
              marker={marker}
              variant={variant}
              language={language}
            />
          )
        })}
      </div>
    </>
  )
})

/** Render a sequence of additions (Write / NotebookEdit) with click-to-expand
 *  truncation: first MAX_PREVIEW_LINES are visible, remainder hides behind
 *  a <details> the user can open.
 *
 *  Currently only used for additions (the "create a file" / "write a cell"
 *  shapes — both are content the assistant is *adding*, not replacing).
 *  If a deletion-only call site appears later, lift the marker/variant
 *  back into props rather than reintroducing a dead branch. */
const ExpandableDiff = memo(function ExpandableDiff({
  lines,
  filePath,
}: {
  lines: string[]
  filePath?: string
}) {
  const language = filePath ? detectLangSafe(filePath) : null
  const total = lines.length
  // Pure additions (Write / NotebookEdit) → single new-file line-number
  // column, no old column.
  const gutterNewWidth = String(total).length
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
            newLine={i + 1}
            gutterNewWidth={gutterNewWidth}
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
            newLine={i + 1}
            gutterNewWidth={gutterNewWidth}
          />
        ))}
      </div>
      <AnimatedDetails
        className="diff-truncation-details"
        summary={(
          <span className="diff-truncation-summary">
            ... show {total - MAX_PREVIEW_LINES} more line{total - MAX_PREVIEW_LINES === 1 ? '' : 's'} ({total} total)
          </span>
        )}
      >
        <div className="diff-lines">
          {hidden.map((line, i) => (
            <DiffLine
              key={i}
              line={line}
              marker="+"
              variant="add"
              language={language}
              newLine={MAX_PREVIEW_LINES + i + 1}
              gutterNewWidth={gutterNewWidth}
            />
          ))}
        </div>
      </AnimatedDetails>
    </>
  )
})

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

function TodoWriteView({ input, toolUseId, searchQuery, activeMatchIdx }: ToolViewProps) {
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
const BashToolView = memo(function BashToolView({ input, toolName, toolUseId, searchQuery, activeMatchIdx }: ToolViewProps) {
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
      searchQuery={searchQuery}
      activeMatchIdx={activeMatchIdx}
    >
      {(tooLong || description) && (
        <div className="bash-tool-body">
          {tooLong && (
            <AnimatedDetails
              className="bash-tool-collapsible"
              summary={(
                <span className="bash-tool-fold-hint">
                  {remaining > 0
                    ? `... show ${remaining} more line${remaining === 1 ? '' : 's'} (${lines.length} total)`
                    : `... show full command (${command.length} chars)`}
                </span>
              )}
            >
              <pre className="bash-tool-full"><code>{command}</code></pre>
            </AnimatedDetails>
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
})

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
const ReadToolView = memo(function ReadToolView({ input, toolUseId, searchQuery, activeMatchIdx }: ToolViewProps) {
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
      searchQuery={searchQuery}
      activeMatchIdx={activeMatchIdx}
      className="tool-card-read"
    />
  )
})

// ---------------------------------------------------------------------------
// Grep
// ---------------------------------------------------------------------------

/**
 * Pattern in quotes (the most important bit visually) plus modifier chips
 * for glob/type/path/output_mode and the case/multiline/-n flags. Order
 * mirrors how a human reads `rg "pattern" --glob='*.tsx' src/`.
 */
const GrepToolView = memo(function GrepToolView({ input, toolUseId, searchQuery, activeMatchIdx }: ToolViewProps) {
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
      searchQuery={searchQuery}
      activeMatchIdx={activeMatchIdx}
    />
  )
})

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
function TaskMutationView({ input, toolUseId, searchQuery, activeMatchIdx }: ToolViewProps) {
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
// Glob
// ---------------------------------------------------------------------------

/**
 * Pattern-only file matcher. Visually a stripped-down Grep — same row
 * layout, same chip vocabulary.
 */
function GlobToolView({ input, toolUseId, searchQuery, activeMatchIdx }: ToolViewProps) {
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
      searchQuery={searchQuery}
      activeMatchIdx={activeMatchIdx}
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
function WebFetchToolView({ input, toolUseId, searchQuery, activeMatchIdx }: ToolViewProps) {
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
      <IconExternalLink size={12} />
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
      searchQuery={searchQuery}
      activeMatchIdx={activeMatchIdx}
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
function WebSearchToolView({ input, toolUseId, searchQuery, activeMatchIdx }: ToolViewProps) {
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
      searchQuery={searchQuery}
      activeMatchIdx={activeMatchIdx}
      toolUseId={toolUseId}
      copyValue={() => query}
      copyLabel="Copy query"
      className="tool-card-websearch"
    />
  )
}

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
function SkillToolView({ input, toolUseId, searchQuery, activeMatchIdx }: ToolViewProps) {
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
function SendMessageToolView({ input, toolUseId, searchQuery, activeMatchIdx }: ToolViewProps) {
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
function TaskOutputToolView({ input, toolUseId, searchQuery, activeMatchIdx }: ToolViewProps) {
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
function NotebookEditToolView({ input, toolUseId, searchQuery, activeMatchIdx }: ToolViewProps) {
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
      searchQuery={searchQuery}
      activeMatchIdx={activeMatchIdx}
    >
      {isDelete ? (
        <div className="notebook-edit-deleted">
          <IconAlertCircle size={12} /> cell deleted
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

// Dispatch table for per-tool inline views. Defined here, after every view
// declaration, because several views are `const X = memo(...)` and would be
// in the temporal dead zone if referenced earlier. ToolUseBlock only reads
// this map at render time, so the forward reference from above is safe.
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
  Skill: SkillToolView,
  SendMessage: SendMessageToolView,
  TaskOutput: TaskOutputToolView,
  NotebookEdit: NotebookEditToolView,
  TaskCreate: TaskMutationView,
  TaskUpdate: TaskMutationView,
}

