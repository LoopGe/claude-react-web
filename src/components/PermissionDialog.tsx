// Tool permission request modal.
//
// Rendered by <Chat /> when a session has any pending PermissionRequest.
// Shows the topmost pending request; if multiple are queued, the dialog
// re-renders once the user decides the current one.
//
// All session-level "always allow" decisions ride on the SDK-provided
// `suggestions` array — we just forward the request with
// persistForSession=true and let the server promote every suggestion's
// destination to 'session'. No suggestions? We hide the always button.

import { memo, useRef, useState } from 'react'
import type { PermissionRequest, PermissionMode } from '../types'
import type { PlanTargetMode } from '../hooks/usePermissionChannel'
import { Markdown } from './Markdown'
import { useOverlayScrollbar } from '../hooks/useOverlayScrollbar'
import { Overlay } from './Overlay'
import { PLAN_TOOL_NAMES } from '../constants/toolNames'
import { IconClipboardList, IconLock, IconX } from './icons/ToolIcons'

/** Narrowed to the permission variant of the union. The question variant
 *  is rendered by `<QuestionDialog />` instead. */
type PermissionRequestPermission = Extract<PermissionRequest, { kind: 'permission' }>

/** Deny message for the plan "stop the turn" actions (the Stop & take over
 *  button and Esc on a plan dialog). Contains the `denied by user` rejection
 *  needle so `computePlanStatus` classifies the resulting tool_result as
 *  `rejected` (not `approved`), and tells the model the user stopped the turn. */
const PLAN_STOP_MESSAGE = 'Plan denied by user — stopping the turn.'

interface Props {
  open?: boolean
  request: PermissionRequestPermission
  onDecide: (
    decision:
      | { behavior: 'allow'; persistForSession: boolean; planTargetMode?: PlanTargetMode }
      | { behavior: 'deny'; message?: string; interrupt?: boolean },
  ) => void
  /** Plan body text from ExitPlanMode tool_result outputs.  The CLI
   *  injects plan content into the tool_result (not the tool_use input),
   *  so the PermissionDialog falls back to this map when the input is
   *  empty.  May be undefined on first render (before the tool_result
   *  arrives); the dialog re-renders once the map is populated. */
  planContentMap?: ReadonlyMap<string, string>
  /** The session's current permission mode. On a plan-approval card, the
   *  approve option matching the current mode is promoted to the primary
   *  (first, highlighted) button so approving defaults to "keep running the
   *  way I already chose" rather than silently downgrading the mode. */
  currentMode?: PermissionMode
  /** Minimize the dialog (plan requests only). Hides the overlay so the
   *  user can read the transcript; the inline PlanCard provides a reopen. */
  onMinimize?: () => void
}

export const PermissionDialog = memo(function PermissionDialog({ open = true, request, onDecide, planContentMap, currentMode, onMinimize }: Props) {
  const [showRaw, setShowRaw] = useState(false)
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState('')
  // Ref provides a synchronous guard so that rapid double-clicks
  // can't slip through before React commits the state update.
  const busyRef = useRef(false)
  // Scroll region for the plan card / permission body. Same overlay scrollbar
  // every other dialog/panel uses — without it a long plan shows the native
  // 10px scrollbar instead of the project's 6px floating thumb.
  const setModalSectionOs = useOverlayScrollbar({ autoHide: 'leave' })

  const hasSuggestions = Array.isArray(request.suggestions) && request.suggestions.length > 0

  const click = (
    d:
      | { behavior: 'allow'; persistForSession: boolean; planTargetMode?: PlanTargetMode }
      | { behavior: 'deny'; message?: string; interrupt?: boolean },
  ) => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    onDecide(d)
  }

  // Plan-mode approval is its own UX: the request is "I'm done planning,
  // here's the plan — should I start executing?" The dialog renders the
  // plan as markdown and the Allow/Deny buttons re-label so they read
  // like a code-review approval rather than a tool gate.
  const isPlanRequest = PLAN_TOOL_NAMES.has(request.toolName)

  // Escape should deny and close — not fall through to the global Escape
  // handler which would interrupt the session instead. For plan requests,
  // Esc means "stop the turn" (interrupt:true, aligns with the CLI); for
  // plain tool permissions, Esc is a soft deny (model re-plans). The Overlay
  // routes Esc here via escapeBehavior="custom" (onEscape), gated by
  // canCloseOnEscape which swallows while busy (click also re-guards).
  const handleEscape = () => {
    if (isPlanRequest) {
      click({ behavior: 'deny', message: PLAN_STOP_MESSAGE, interrupt: true })
    } else {
      click({ behavior: 'deny' })
    }
  }

  const planInput = isPlanRequest ? (request.input as Record<string, unknown> | undefined) : undefined
  const planText =
    typeof planInput?.plan === 'string'
      ? planInput.plan
      : typeof planInput?.content === 'string'
        ? planInput.content
        : typeof planInput?.markdown === 'string'
          ? (planInput.markdown as string)
          : (request.toolUseID ? planContentMap?.get(request.toolUseID) : undefined) ?? null
  const planAllowedPrompts = Array.isArray(planInput?.allowedPrompts)
    ? (planInput.allowedPrompts as Array<{ tool?: string; prompt?: string }>)
    : []

  // Plan-approval execution-mode options. The one matching the session's
  // current mode is floated to the front (and rendered as the primary button)
  // so approving defaults to "keep running the way I already chose" instead of
  // silently downgrading the mode. `plan` and `default` both map to the
  // default (review-each) option since there's no distinct "stay in plan".
  // `auto` is intentionally not offered — it can't function on this backend
  // (see PERMISSION_MODES in types.ts).
  const PLAN_APPROVE_OPTIONS: Array<{ mode: PlanTargetMode; label: string; title: string }> = [
    { mode: 'acceptEdits', label: 'Approve & auto-accept edits', title: 'Approve and auto-accept file edits; other tools still prompt' },
    { mode: 'default', label: 'Approve & review each', title: 'Approve and review each action as it comes' },
    { mode: 'bypassPermissions', label: 'Approve & bypass', title: 'Approve and skip all permission prompts (use with care)' },
  ]
  const orderedPlanOptions = [...PLAN_APPROVE_OPTIONS].sort(
    (a, b) => Number(b.mode === currentMode) - Number(a.mode === currentMode),
  )
  // Lay the approve buttons out two-per-row (robust to any option count).
  const planOptionRows: typeof orderedPlanOptions[] = []
  for (let r = 0; r < orderedPlanOptions.length; r += 2) {
    planOptionRows.push(orderedPlanOptions.slice(r, r + 2))
  }

  const headline = request.title ?? (
    isPlanRequest
      ? 'Claude has a plan ready'
      : `Claude wants to use ${request.toolName}`
  )

  // Embedded in the chat panel rather than a full-screen modal: the grid
  // shows up to three sessions at once, so blocking the entire viewport
  // to ask about session A's Bash command would freeze the user's work
  // on session B and C. The dialog still acts as a modal *for its own
  // panel* (absolutely positioned overlay within .chat-messages-wrap or
  // the Chat root).
  return (
    <Overlay
      variant="perm"
      ariaLabel={isPlanRequest ? 'Plan ready for review' : 'Tool permission required'}
      open={open}
      onClose={handleEscape}
      backdropDismiss={false}
      escapeBehavior="custom"
      onEscape={handleEscape}
      canCloseOnEscape={() => !busyRef.current}
      focusEscapeSelector=".chat-panel"
      trapRefTarget="backdrop"
      cardClassName={isPlanRequest ? 'perm-card-plan' : undefined}
    >
      <div className="modal-header">
        <h3 style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span aria-hidden style={{ display: 'inline-flex' }}>{isPlanRequest ? <IconClipboardList size={16} /> : <IconLock size={16} />}</span>
          {isPlanRequest ? 'Plan ready for review' : 'Tool permission required'}
        </h3>
        {onMinimize && (
          <button
            className="btn-icon"
            aria-label="Minimize"
            disabled={busy}
            onClick={onMinimize}
          >
            <IconX size={14} />
          </button>
        )}
      </div>

      <div className="modal-section" ref={setModalSectionOs}>
        <div className="perm-headline">{headline}</div>
        {request.description && <div className="perm-sub">{request.description}</div>}

        {isPlanRequest ? (
          <div className="plan-card" style={{ marginTop: 10 }}>
            <div className="plan-card-body">
              {planText
                ? <Markdown text={planText} />
                : <div className="plan-card-empty">
                    Plan will appear in the transcript after approval.
                    The CLI reads it from the plan file during execution.
                  </div>}
            </div>
            {planAllowedPrompts.length > 0 && (
              <div className="plan-card-allowed">
                <div className="plan-card-allowed-label">On approval, allow:</div>
                <ul className="plan-card-allowed-list">
                  {planAllowedPrompts.map((p, i) => (
                    <li key={i} className="plan-card-allowed-item">
                      <code>{p.tool ?? 'tool'}</code> · {p.prompt ?? '(no description)'}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ) : (
          <>
            <div className="perm-summary">
              <span className="perm-badge">{request.displayName ?? request.toolName}</span>
            </div>
            <InputPreview input={request.input} />
          </>
        )}

        <button
          type="button"
          className="perm-raw-toggle"
          onClick={() => setShowRaw((v) => !v)}
        >
          {showRaw ? 'Hide raw input' : 'Show raw input'}
        </button>
        {showRaw && (
          <pre className="perm-raw">{JSON.stringify(request.input, null, 2)}</pre>
        )}
      </div>

      <div className="modal-footer" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
        {isPlanRequest ? (
          <>
            {/* Approving a plan exits plan mode and switches the session to
                the chosen execution mode (the SDK's read-only plan lock is
                released and replaced). Each button approves AND picks how
                Claude runs from here. The option matching the session's
                current mode is promoted to the primary (first) button. */}
            {planOptionRows.map((row, rowIdx) => (
              <div key={rowIdx} style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {row.map((opt, i) => {
                  const isPrimary = rowIdx === 0 && i === 0
                  const matchesCurrent = opt.mode === currentMode
                  return (
                    <button
                      key={opt.mode}
                      className={`btn ${isPrimary ? 'btn-primary' : ''}`}
                      onClick={() => click({ behavior: 'allow', persistForSession: false, planTargetMode: opt.mode })}
                      disabled={busy}
                      style={{ flex: 1 }}
                      title={opt.title}
                    >
                      {opt.label}{matchesCurrent ? ' (current)' : ''}
                    </button>
                  )
                })}
              </div>
            ))}
            <textarea
              className="perm-feedback-input"
              placeholder="Tell Claude what to change"
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              disabled={busy}
              rows={2}
              aria-label="Plan feedback"
            />
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                className="btn"
                onClick={() => click({ behavior: 'deny', message: `Plan denied by user. Feedback: ${feedback.trim()}` })}
                disabled={busy || feedback.trim().length === 0}
                style={{ flex: 1 }}
                title="Send this feedback to Claude — it keeps planning in this turn"
              >
                Send feedback
              </button>
              <button
                className="btn btn-danger"
                onClick={() => click({ behavior: 'deny', message: PLAN_STOP_MESSAGE, interrupt: true })}
                disabled={busy}
                style={{ flex: 1 }}
                title="Stop this turn and return to the input box"
              >
                Stop & take over
              </button>
            </div>
            <span className="hint" style={{ textAlign: 'center' }}>
              Approving exits plan mode and lets Claude execute in the chosen
              mode. "Send feedback" returns your note to Claude so it can
              revise. "Stop & take over" ends this turn so you can type.
            </span>
          </>
        ) : (
          <>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button
                className="btn btn-primary"
                onClick={() => click({ behavior: 'allow', persistForSession: false })}
                disabled={busy}
                style={{ flex: 1 }}
              >
                Allow once
              </button>
              {hasSuggestions && (
                <button
                  className="btn"
                  onClick={() => click({ behavior: 'allow', persistForSession: true })}
                  disabled={busy}
                  style={{ flex: 1 }}
                  title="Apply the SDK's suggested allow rule for the rest of this session"
                >
                  Allow for session
                </button>
              )}
              <button
                className="btn btn-danger"
                onClick={() => click({ behavior: 'deny' })}
                disabled={busy}
                style={{ flex: 1 }}
              >
                Deny
              </button>
            </div>
            <span className="hint" style={{ textAlign: 'center' }}>
              Deny returns a message to the model — it keeps thinking, but won't execute this tool.
            </span>
          </>
        )}
      </div>
    </Overlay>
  )
})

/**
 * Quick preview for common tool shapes. We pick out the obvious fields
 * (Bash.command, Read.file_path, Edit.file_path, etc.) and fall back to
 * showing nothing when the input is opaque — the "Show raw input" button
 * is always available below.
 */
function InputPreview({ input }: { input: Record<string, unknown> }) {
  const rows: { label: string; value: string }[] = []
  const pick = (key: string, label: string) => {
    const v = input[key]
    if (typeof v === 'string' && v.trim()) rows.push({ label, value: v })
  }
  pick('command', 'Command')
  pick('file_path', 'File')
  pick('path', 'Path')
  pick('url', 'URL')
  pick('pattern', 'Pattern')
  pick('description', 'Why')

  if (!rows.length) return null
  return (
    <div className="perm-preview">
      {rows.map((r) => (
        <div key={r.label} className="perm-row">
          <div className="perm-row-label">{r.label}</div>
          <div className="perm-row-value">{r.value}</div>
        </div>
      ))}
    </div>
  )
}
