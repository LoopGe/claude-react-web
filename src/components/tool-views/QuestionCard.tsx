// Bespoke card for AskUserQuestion — has its own pending/answered/skipped
// /clarified lifecycle that doesn't map onto the generic ToolCard
// running/success/error model, so it renders standalone rather than
// through TOOL_VIEWS.
//
// Extracted from ToolUseBlock.tsx for modularity.

import { memo } from 'react'
import { useQuestionAnswers } from '../../hooks/useQuestionAnswers'
import { useReopenQuestion } from '../../hooks/useReopenQuestion'
import { AnimatedDetails } from '../AnimatedCollapse'
import {
  IconCheckSquare,
  IconCircle,
  IconCircleDot,
  IconMessageQuestion,
  IconSquare,
} from '../icons/ToolIcons'
import type { QuestionAnswerEntry } from '../../utils/question-answers'
import type { QuestionSpec } from '../../types'

type QuestionCardStatus = 'pending' | 'answered' | 'skipped' | 'clarified'

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
export const QuestionCard = memo(function QuestionCard({
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
    if (answers.some((a) => a.clarified)) return 'clarified'
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
        : status === 'clarified'
          ? 'You sent context or a follow-up instead of selecting an answer.'
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
