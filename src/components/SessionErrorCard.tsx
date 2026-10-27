// Session error card — the body-area card that replaces the transcript
// whenever session.error is set on a session the user can't otherwise use.
// This is where errors are displayed in the panel (the old header red band
// is gone). Exception: a RUNNING session carrying a stale error keeps its
// live UI (see errorCardState) and surfaces the error via the sidebar chip
// only.
//
//   SessionBody      — gate: error card vs. normal body content
//   errorCardState   — trigger + kind mapping (dormant / terminated)
//
// The card reuses the dormant empty-state look (`.empty-state` +
// `.chat-panel-resume-btn`) so it matches the rest of the app's centered
// state cards in both themes.

import { useState } from 'react'
import type { MouseEvent, ReactNode } from 'react'

type CardAction = () => void | Promise<void>

export type ErrorCardKind = 'dormant' | 'terminated'

export interface ErrorCardSession {
  running: boolean
  terminated: boolean
  recovering?: boolean
  canRetryResume?: boolean
  error?: string
}

/** Lines shown in the collapsed stderr disclosure on the card — keeps the
 *  card compact; the full context lives in the Diagnostics tab (reachable
 *  again once the session resumes/forks into a live panel). */
const STDERR_TAIL_LINES = 30

/** The error text as a sentence end: server errors often already end in
 *  punctuation, so only append a period when they don't. */
function errorSentence(error: string): string {
  return /[.!?…]\s*$/.test(error) ? error : `${error}.`
}

/** Non-null exactly when the session has an error worth showing as a card.
 *  Live and recovering sessions keep their UI instead: a running session
 *  carrying a stale error (session-status.ts's 'err' state) must keep its
 *  transcript and composer, and a recovering session's paired ephemeral
 *  crash-recovery notices ("recovering" / "recovered") only resolve for
 *  live subscribers — the transcript view (and its useChatStream
 *  subscription) must stay mounted through the window. */
export function errorCardState(session: ErrorCardSession): { kind: ErrorCardKind; error: string } | null {
  if (!session.error) return null
  if (session.running || session.recovering) return null
  return { kind: session.terminated ? 'terminated' : 'dormant', error: session.error }
}

interface SessionBodyProps {
  session: ErrorCardSession
  onResume?: CardAction
  onFork?: CardAction
  /** A resume is in flight — show the spinner instead of the card (the
   *  button would otherwise stay clickable and double-fire resume()). */
  resuming?: boolean
  /** Recent stderr lines for the collapsed disclosure on the card. */
  stderrTail?: string[]
  children?: ReactNode
}

export function SessionBody({ session, onResume, onFork, resuming, stderrTail, children }: SessionBodyProps) {
  const state = errorCardState(session)
  // Spinner while a resume is in flight — shown wherever the old UI showed
  // it (the empty-state branch) plus over the error card, so the card's
  // button can't double-fire and the user gets loading feedback.
  if (resuming && (state !== null || (!session.running && !session.terminated))) {
    return (
      <div className="empty-state">
        <div className="empty-state-loading">
          <div className="app-loading-spinner" />
          <p>Resuming session...</p>
        </div>
      </div>
    )
  }
  if (!state) return <>{children}</>
  return (
    <ErrorCard
      state={state}
      canRetryResume={!!session.canRetryResume}
      onResume={onResume}
      onFork={onFork}
      stderrTail={stderrTail}
    />
  )
}

function ErrorCard({
  state,
  canRetryResume,
  onResume,
  onFork,
  stderrTail,
}: {
  state: { kind: ErrorCardKind; error: string }
  canRetryResume: boolean
  onResume?: CardAction
  onFork?: CardAction
  stderrTail?: string[]
}) {
  // Dormant sessions are resumable by definition; terminated sessions only
  // offer the crash-recovery choice when the server marked them retryable
  // (the old Composer choice-banner contract).
  const showResume = !!onResume && (state.kind === 'dormant' || canRetryResume)
  const showFork = state.kind === 'terminated' && canRetryResume && !!onFork
  // One-shot guard: disables every action button from the first click until
  // the action settles (promise-returning actions like fork), with the
  // parent's `resuming` spinner covering the resume swap — together these
  // block double-fire. A synchronous throw must not dead-end the card:
  // reset and rethrow so the failure surfaces loudly.
  const [fired, setFired] = useState(false)
  const fire = (action: CardAction) => (e: MouseEvent) => {
    e.stopPropagation()
    setFired(true)
    let pending: Promise<unknown>
    try {
      pending = Promise.resolve(action())
    } catch (err) {
      setFired(false)
      throw err
    }
    void pending.finally(() => setFired(false))
  }
  return (
    <div className="empty-state">
      {state.kind === 'dormant' && (
        <>
          <h2>Session is dormant</h2>
          <p>
            Last resume attempt failed: {errorSentence(state.error)}
            {showResume && ' Use “Resume session” below to try again.'}
          </p>
        </>
      )}
      {state.kind === 'terminated' && (
        <>
          <h2>Session terminated</h2>
          <p>
            {errorSentence(state.error)}
            {showResume && showFork && ' Resume to continue in place, or fork from your last completed turn.'}
            {showResume && !showFork && ' Resume to continue in place.'}
            {showFork && !showResume && ' Use “Fork from last completed turn” below to continue.'}
            {!showResume && !showFork && ' Create a new session to continue.'}
          </p>
        </>
      )}
      {stderrTail && stderrTail.length > 0 && (
        <details className="chat-panel-stderr-details">
          <summary>stderr</summary>
          <pre className="diag-stderr">{stderrTail.slice(-STDERR_TAIL_LINES).join('\n')}</pre>
        </details>
      )}
      {(showResume || showFork) && (
        <div className="empty-state-actions">
          {showResume && (
            <button
              type="button"
              className="chat-panel-resume-btn"
              disabled={fired}
              onClick={fire(onResume!)}
            >
              {state.kind === 'dormant' ? 'Resume session' : 'Resume'}
            </button>
          )}
          {showFork && (
            <button
              type="button"
              className="chat-panel-resume-btn"
              disabled={fired}
              onClick={fire(onFork!)}
            >
              Fork from last completed turn
            </button>
          )}
        </div>
      )}
    </div>
  )
}
