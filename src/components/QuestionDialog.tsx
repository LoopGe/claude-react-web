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

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Markdown } from './Markdown'
import type { PermissionRequest, QuestionSpec } from '../types'
import { useFocusTrap } from '../hooks/useFocusTrap'

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
  /** Called after the answer has been shown inline for a moment. The
   *  parent removes the dialog from the pending queue on this signal. */
  onSubmitted?: () => void
  /** When set, the dialog immediately renders in the "answered" state
   *  showing these pre-filled answers. Used for the linger card that
   *  stays visible after the user submits. */
  initialAnswers?: Array<string | string[] | null>
}

export function QuestionDialog({ request, onSubmit, onSkipAll, onSubmitted, initialAnswers }: Props) {
  // Map question index → chosen label (or array for multi-select).
  // `null` means the user hasn't chosen anything for this question yet —
  // treated as "skip" on submit.
  const [choices, setChoices] = useState<Array<string | string[] | null>>(() =>
    initialAnswers ?? request.questions.map(() => null),
  )
  // Track which questions have "Other" mode active and the custom text.
  const [otherActive, setOtherActive] = useState<boolean[]>(() =>
    request.questions.map(() => false),
  )
  const [otherTexts, setOtherTexts] = useState<string[]>(() =>
    request.questions.map(() => ''),
  )
  const [busy, setBusy] = useState(false)
  const [submitted, setSubmitted] = useState(!!initialAnswers)
  const dialogRef = useRef<HTMLDivElement>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  // Refs so the Escape effect (registered once on mount) always reads
  // current values without re-registering on every render.
  const busyRef = useRef(busy)
  const submittedRef = useRef(submitted)
  const cancelRef = useRef<() => void>(() => {})
  // Sync refs after commit so they're always current without triggering
  // re-renders (the react-hooks/refs rule forbids writing during render).
  useLayoutEffect(() => {
    busyRef.current = busy
    submittedRef.current = submitted
  })

  useFocusTrap(dialogRef)

  const setSingle = (qIdx: number, label: string) => {
    setChoices((prev) => {
      const next = prev.slice()
      // Toggle off if the user clicks the same option twice.
      next[qIdx] = prev[qIdx] === label ? null : label
      return next
    })
    // Deactivate "Other" when a preset option is chosen (single-select).
    setOtherActive((prev) => {
      if (!prev[qIdx]) return prev
      const next = prev.slice()
      next[qIdx] = false
      return next
    })
    setOtherTexts((prev) => {
      if (!prev[qIdx]) return prev
      const next = prev.slice()
      next[qIdx] = ''
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

  const toggleOther = (qIdx: number) => {
    setOtherActive((prev) => {
      const next = prev.slice()
      const activating = !prev[qIdx]
      next[qIdx] = activating
      if (!activating) {
        // Turning off "Other" — clear the text and remove custom answer from choices.
        setOtherTexts((t) => {
          const nt = t.slice()
          nt[qIdx] = ''
          return nt
        })
        setChoices((c) => {
          const nc = c.slice()
          const cur = nc[qIdx]
          if (typeof cur === 'string') {
            nc[qIdx] = null
          } else if (Array.isArray(cur)) {
            // Remove any entries that aren't preset labels.
            const presetLabels = new Set(
              request.questions[qIdx].options.map((o) => o.label),
            )
            const filtered = cur.filter((v) => presetLabels.has(v))
            nc[qIdx] = filtered.length > 0 ? filtered : null
          }
          return nc
        })
      } else {
        // Activating "Other" for single-select — deselect preset options.
        if (!request.questions[qIdx].multiSelect) {
          setChoices((c) => {
            const nc = c.slice()
            nc[qIdx] = null
            return nc
          })
        }
      }
      return next
    })
  }

  const setOtherText = (qIdx: number, text: string) => {
    setOtherTexts((prev) => {
      const next = prev.slice()
      next[qIdx] = text
      return next
    })
    // Update choices with the custom text.
    setChoices((prev) => {
      const nc = prev.slice()
      const isMulti = request.questions[qIdx].multiSelect === true
      if (!isMulti) {
        nc[qIdx] = text || null
      } else {
        // For multi-select, replace previous custom text in the array.
        const presetLabels = new Set(
          request.questions[qIdx].options.map((o) => o.label),
        )
        const existing = Array.isArray(nc[qIdx]) ? (nc[qIdx] as string[]) : []
        const presetPicks = existing.filter((v) => presetLabels.has(v))
        if (text) {
          presetPicks.push(text)
        }
        nc[qIdx] = presetPicks.length > 0 ? presetPicks : null
      }
      return nc
    })
  }

  // Cleanup the auto-close timer on unmount.
  useEffect(() => () => { clearTimeout(timerRef.current) }, [])

  const submit = useCallback(() => {
    if (busy || submitted) return
    setBusy(true)
    setSubmitted(true)
    onSubmit(choices)
    timerRef.current = setTimeout(() => onSubmitted?.(), 3000)
  }, [busy, submitted, choices, onSubmit, onSubmitted])

  const cancel = useCallback(() => {
    if (busy || submitted) return
    setBusy(true)
    setSubmitted(true)
    onSkipAll()
    timerRef.current = setTimeout(() => onSubmitted?.(), 3000)
  }, [busy, submitted, onSkipAll, onSubmitted])
  useLayoutEffect(() => { cancelRef.current = cancel })

  // Escape should cancel/skip — not fall through to the global Escape
  // handler which would interrupt the session instead.
  // Uses refs for busy/submitted/cancel so the listener is registered
  // once on mount instead of on every render.
  useEffect(() => {
    const el = dialogRef.current
    if (!el) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busyRef.current && !submittedRef.current) {
        e.preventDefault()
        e.stopPropagation()
        cancelRef.current()
      }
    }
    el.addEventListener('keydown', onKey)
    return () => el.removeEventListener('keydown', onKey)
  })

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
            submitted ? (
              <AnsweredBlock key={qIdx} question={q} answer={choices[qIdx]} />
            ) : (
              <QuestionBlock
                key={qIdx}
                index={qIdx}
                question={q}
                value={choices[qIdx]}
                onSingle={(label) => setSingle(qIdx, label)}
                onMulti={(label) => toggleMulti(qIdx, label)}
                onSkip={() => skipQuestion(qIdx)}
                otherActive={otherActive[qIdx]}
                otherText={otherTexts[qIdx]}
                onOtherToggle={() => toggleOther(qIdx)}
                onOtherTextChange={(text) => setOtherText(qIdx, text)}
              />
            )
          ))}
        </div>

        {!submitted && (
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
        )}
        {submitted && (
          <div className="modal-footer" style={{ justifyContent: 'center' }}>
            <span className="hint">Answer sent — waiting for Claude to respond…</span>
          </div>
        )}
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
  otherActive: boolean
  otherText: string
  onOtherToggle: () => void
  onOtherTextChange: (text: string) => void
}

function QuestionBlock({ index, question, value, onSingle, onMulti, onSkip, otherActive, otherText, onOtherToggle, onOtherTextChange }: BlockProps) {
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
        {/* Other — free-text option.
         *
         * The toggle and the input are SIBLINGS, not nested. Earlier we
         * tried both <button>(input inside) and <div role=button>(input
         * inside): the first hits a Chrome bug where Space inside the
         * nested input activates the outer button (clearing the typed
         * text), and the second violates the WAI-ARIA rule that role=
         * button must not contain interactive descendants (NVDA/VO read
         * the input value into the button's accessible name). A real
         * <button> sibling-of an <input> is plain, valid markup and
         * neither footgun applies. */}
        <button
          type="button"
          className={`question-option ${otherActive ? 'selected' : ''}`}
          onClick={onOtherToggle}
          aria-pressed={otherActive}
        >
          <span className="question-option-marker" aria-hidden>
            {isMulti ? (otherActive ? '☑' : '☐') : otherActive ? '●' : '○'}
          </span>
          <div className="question-option-body">
            <div className="question-option-label">Other</div>
          </div>
        </button>
        {otherActive && (
          <input
            type="text"
            className="question-other-input"
            placeholder="Type your answer..."
            value={otherText}
            onChange={(e) => onOtherTextChange(e.target.value)}
            // Enter would trigger the dialog's outer focus-trap form
            // semantics or bubble to keyboard shortcuts; eat it so the
            // user can't accidentally submit while typing.
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.preventDefault()
            }}
            autoFocus
          />
        )}
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

/** Read-only block shown after the user submits their answer. */
function AnsweredBlock({ question, answer }: { question: QuestionSpec; answer: string | string[] | null }) {
  const answerText =
    answer == null
      ? '(skipped)'
      : Array.isArray(answer)
        ? answer.join(', ')
        : answer
  return (
    <div className="question-block question-block-answered">
      <div className="question-header">
        {question.header && <span className="question-chip">{question.header}</span>}
        <span className="question-answered-badge">✓ answered</span>
      </div>
      <div className="question-text">{question.question}</div>
      <div className="question-answer-display">{answerText}</div>
    </div>
  )
}
