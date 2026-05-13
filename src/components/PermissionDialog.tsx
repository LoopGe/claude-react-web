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

import { useEffect, useRef, useState } from 'react'
import type { PermissionRequest } from '../types'
import { Markdown } from './Markdown'

/** Narrowed to the permission variant of the union. The question variant
 *  is rendered by `<QuestionDialog />` instead. */
type PermissionRequestPermission = Extract<PermissionRequest, { kind: 'permission' }>

interface Props {
  request: PermissionRequestPermission
  onDecide: (
    decision:
      | { behavior: 'allow'; persistForSession: boolean }
      | { behavior: 'deny'; message?: string },
  ) => void
}

export function PermissionDialog({ request, onDecide }: Props) {
  const [showRaw, setShowRaw] = useState(false)
  const [busy, setBusy] = useState(false)
  // Ref provides a synchronous guard so that rapid double-clicks
  // can't slip through before React commits the state update.
  const busyRef = useRef(false)
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

  const hasSuggestions = Array.isArray(request.suggestions) && request.suggestions.length > 0

  const click = (
    d:
      | { behavior: 'allow'; persistForSession: boolean }
      | { behavior: 'deny'; message?: string },
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
  const isPlanRequest =
    request.toolName === 'ExitPlanMode' || request.toolName === 'EnterPlanMode'
  const planInput = isPlanRequest ? (request.input as Record<string, unknown> | undefined) : undefined
  const planText =
    typeof planInput?.plan === 'string'
      ? planInput.plan
      : typeof planInput?.content === 'string'
        ? planInput.content
        : typeof planInput?.markdown === 'string'
          ? (planInput.markdown as string)
          : null
  const planAllowedPrompts = Array.isArray(planInput?.allowedPrompts)
    ? (planInput.allowedPrompts as Array<{ tool?: string; prompt?: string }>)
    : []

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
    <div className="perm-overlay" role="dialog" aria-modal="true" ref={dialogRef}>
      <div className={`perm-card ${isPlanRequest ? 'perm-card-plan' : ''}`}>
        <div className="modal-header">
          <h3 style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span aria-hidden>{isPlanRequest ? '🗒' : '🔐'}</span>
            {isPlanRequest ? 'Plan ready for review' : 'Tool permission required'}
          </h3>
        </div>

        <div className="modal-section">
          <div className="perm-headline">{headline}</div>
          {request.description && <div className="perm-sub">{request.description}</div>}

          {isPlanRequest ? (
            <div className="plan-card" style={{ marginTop: 10 }}>
              <div className="plan-card-body">
                {planText
                  ? <Markdown text={planText} />
                  : <div className="plan-card-empty">(empty plan — Claude sent no body)</div>}
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
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              className="btn btn-primary"
              onClick={() => click({ behavior: 'allow', persistForSession: false })}
              disabled={busy}
              style={{ flex: 1 }}
            >
              {isPlanRequest ? 'Approve plan' : 'Allow once'}
            </button>
            {hasSuggestions && !isPlanRequest && (
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
              {isPlanRequest ? 'Keep planning' : 'Deny'}
            </button>
          </div>
          <span className="hint" style={{ textAlign: 'center' }}>
            {isPlanRequest
              ? 'Approving exits plan mode and lets Claude execute. "Keep planning" returns control to Claude with feedback so it can revise.'
              : 'Deny returns a message to the model — it keeps thinking, but won\'t execute this tool.'}
          </span>
        </div>
      </div>
    </div>
  )
}

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
