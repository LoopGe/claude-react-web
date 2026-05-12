// Interactive dialog for the SDK's AskUserQuestion tool.
//
// Rendered by <Chat /> when a session has a pending PermissionRequest of
// kind 'question'. Mirrors PermissionDialog's in-panel overlay style so
// one panel can prompt while the other two stay interactive.
//
// The tool's input has a `questions: QuestionSpec[]` array. Each question
// is either single- or multi-select. The user can also skip any question,
// which is reported back to the model as `answer: null`.
//
// We submit an answers array aligned positionally with the questions. The
// server's canUseTool interceptor resolves the SDK's deny branch with a
// JSON payload containing these answers — the model reads it as the tool
// result. See server/session-manager.ts `answerQuestion` for the wire
// format.

import { useEffect, useRef, useState } from 'react'
import { Markdown } from './Markdown'
import type { PermissionRequest, QuestionSpec } from '../types'

/** Narrowed to the question variant of the union. */
type QuestionRequest = Extract<PermissionRequest, { kind: 'question' }>

interface Props {
  request: QuestionRequest
  /** Array of per-question answers. Indices align with `request.questions`.
   *  Single-select answers are a label string; multi-select are string[];
   *  null means the user explicitly skipped. */
  onSubmit: (answers: Array<string | string[] | null>) => void
  /** Cancelling skips all questions (each becomes null). Lets the model
   *  continue with no guidance rather than blocking forever. */
  onSkipAll: () => void
}

export function QuestionDialog({ request, onSubmit, onSkipAll }: Props) {
  // Map question index → chosen label (or array for multi-select).
  // `null` means the user hasn't chosen anything for this question yet —
  // treated as "skip" on submit.
  const [choices, setChoices] = useState<Array<string | string[] | null>>(() =>
    request.questions.map(() => null),
  )
  const [busy, setBusy] = useState(false)
  const dialogRef = useRef<HTMLDivElement>(null)

  // Focus trap: keep Tab inside the dialog.
  useEffect(() => {
    const el = dialogRef.current
    if (!el) return
    const handleKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return
      const focusable = el.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      )
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (e.shiftKey ? document.activeElement === first : document.activeElement === last) {
        e.preventDefault()
        ;(e.shiftKey ? last : first).focus()
      }
    }
    el.addEventListener('keydown', handleKey)
    const firstFocusable = el.querySelector<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    )
    firstFocusable?.focus()
    return () => el.removeEventListener('keydown', handleKey)
  }, [])

  const setSingle = (qIdx: number, label: string) => {
    setChoices((prev) => {
      const next = prev.slice()
      // Toggle off if the user clicks the same option twice.
      next[qIdx] = prev[qIdx] === label ? null : label
      return next
    })
  }

  const toggleMulti = (qIdx: number, label: string) => {
    setChoices((prev) => {
      const cur = Array.isArray(prev[qIdx]) ? (prev[qIdx] as string[]) : []
      const next = prev.slice()
      next[qIdx] = cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label]
      // Empty array is treated as "skip" on submit — collapse to null so
      // the wire payload is consistent.
      if (Array.isArray(next[qIdx]) && (next[qIdx] as string[]).length === 0) {
        next[qIdx] = null
      }
      return next
    })
  }

  const skipQuestion = (qIdx: number) => {
    setChoices((prev) => {
      const next = prev.slice()
      next[qIdx] = null
      return next
    })
  }

  const submit = () => {
    if (busy) return
    setBusy(true)
    onSubmit(choices)
  }

  const cancel = () => {
    if (busy) return
    setBusy(true)
    onSkipAll()
  }

  // Require at least one question to have a non-null answer, otherwise
  // "Submit" is equivalent to "Cancel" and we'd rather the user hit the
  // explicit skip button.
  const hasAnyAnswer = choices.some((c) => c != null)

  return (
    <div className="perm-overlay" role="dialog" aria-modal="true" ref={dialogRef}>
      <div className="perm-card">
        <div className="modal-header">
          <h3 style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span aria-hidden>💬</span>
            Claude is asking
          </h3>
        </div>

        <div className="modal-section question-body">
          {request.questions.map((q, qIdx) => (
            <QuestionBlock
              key={qIdx}
              index={qIdx}
              question={q}
              value={choices[qIdx]}
              onSingle={(label) => setSingle(qIdx, label)}
              onMulti={(label) => toggleMulti(qIdx, label)}
              onSkip={() => skipQuestion(qIdx)}
            />
          ))}
        </div>

        <div className="modal-footer" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className="btn"
              onClick={cancel}
              disabled={busy}
              style={{ flex: 1 }}
              title="Skip every question — the model will continue with no guidance"
            >
              Skip all
            </button>
            <button
              className="btn btn-primary"
              onClick={submit}
              disabled={busy || !hasAnyAnswer}
              style={{ flex: 2 }}
            >
              Send answers
            </button>
          </div>
          <span className="hint" style={{ textAlign: 'center' }}>
            Your answers are sent back to the model as the tool result.
          </span>
        </div>
      </div>
    </div>
  )
}

interface BlockProps {
  index: number
  question: QuestionSpec
  value: string | string[] | null
  onSingle: (label: string) => void
  onMulti: (label: string) => void
  onSkip: () => void
}

function QuestionBlock({ index, question, value, onSingle, onMulti, onSkip }: BlockProps) {
  const isMulti = question.multiSelect === true
  const selectedSet =
    value == null ? new Set<string>() : Array.isArray(value) ? new Set(value) : new Set([value])

  return (
    <div className="question-block">
      <div className="question-header">
        {question.header && <span className="question-chip">{question.header}</span>}
        <span className="question-index">Q{index + 1}</span>
        {isMulti && <span className="question-mode">multi-select</span>}
      </div>
      <div className="question-text">{question.question}</div>
      <div className="question-options">
        {question.options.map((opt) => {
          const selected = selectedSet.has(opt.label)
          return (
            <button
              key={opt.label}
              type="button"
              className={`question-option ${selected ? 'selected' : ''}`}
              onClick={() => (isMulti ? onMulti(opt.label) : onSingle(opt.label))}
              aria-pressed={selected}
            >
              <span className="question-option-marker" aria-hidden>
                {isMulti ? (selected ? '☑' : '☐') : selected ? '●' : '○'}
              </span>
              <div className="question-option-body">
                <div className="question-option-label">{opt.label}</div>
                {opt.description && (
                  <div className="question-option-desc">{opt.description}</div>
                )}
                {opt.preview && (
                  // SDK default preview format is markdown. If users enable
                  // the HTML variant via `toolConfig.askUserQuestion` they'd
                  // want raw HTML — but we don't currently set that option,
                  // so markdown is the safe default.
                  <div className="question-option-preview">
                    <Markdown text={opt.preview} />
                  </div>
                )}
              </div>
            </button>
          )
        })}
      </div>
      <button
        type="button"
        className="question-skip"
        onClick={onSkip}
        disabled={value == null}
        title="Clear selection for this question"
      >
        Skip this question
      </button>
    </div>
  )
}
