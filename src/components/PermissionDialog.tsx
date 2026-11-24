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

import { memo, useCallback, useEffect, useRef, useState } from 'react'
import type { PermissionRequest, PermissionMode } from '../types'
import type { PlanTargetMode } from '../hooks/usePermissionChannel'
import { Markdown } from './Markdown'
import { useOverlayScrollbar } from '../hooks/useOverlayScrollbar'
import { useAutoHeightTransition } from '../hooks/useAutoHeightTransition'
import { measureCappedContentHeight } from '../utils/capped-height-measure'
import { useMergedRef } from '../utils/mergedRef'
import { Overlay } from './Overlay'
import { ContextMenu } from './ContextMenu'
import type { FloatingDismissReason } from '../hooks/floating-surface-registry'
import { HoverHint } from './HoverHint'
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

function planTargetModeFor(currentMode: PermissionMode | undefined): PlanTargetMode {
  return currentMode === 'acceptEdits' || currentMode === 'bypassPermissions'
    ? currentMode
    : 'default'
}

const PLAN_MORE_APPROVALS: Array<{ label: string; mode: PlanTargetMode }> = [
  { label: 'Approve & review each', mode: 'default' },
  { label: 'Approve & auto-accept edits', mode: 'acceptEdits' },
  { label: 'Approve & bypass', mode: 'bypassPermissions' },
]

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
  /** The session's current permission mode. Plan approval preserves the
   *  executable modes and exits plan/unsupported modes into `default`. */
  currentMode?: PermissionMode
  /** Minimize the dialog (plan requests only). Hides the overlay so the
   *  user can read the transcript; the inline PlanCard provides a reopen. */
  onMinimize?: () => void
}

export const PermissionDialog = memo(function PermissionDialog({ open = true, request, onDecide, planContentMap, currentMode, onMinimize }: Props) {
  const [showRaw, setShowRaw] = useState(false)
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [planView, setPlanView] = useState<'review' | 'feedback'>('review')
  const feedbackRef = useRef<HTMLTextAreaElement>(null)
  const requestChangesRef = useRef<HTMLButtonElement>(null)
  const previousPlanView = useRef<'review' | 'feedback'>('review')
  const [moreAnchor, setMoreAnchor] = useState<{ x: number; y: number } | null>(null)
  const moreTriggerRef = useRef<HTMLButtonElement>(null)
  // Ref provides a synchronous guard so that rapid double-clicks
  // can't slip through before React commits the state update.
  const busyRef = useRef(false)
  // Scroll region for the plan card / permission body. Same overlay scrollbar
  // every other dialog/panel uses — without it a long plan shows the native
  // 10px scrollbar instead of the project's 6px floating thumb.
  const setModalSectionOs = useOverlayScrollbar({ autoHide: 'leave' })
  // Height-animation box: the section (.modal-section) is the flex-fill, capped
  // scroll body; a content-sized wrapper inside it is the observer target. The
  // footer stays static (see the section hook comment).
  const sectionRef = useRef<HTMLDivElement>(null)
  const sectionContentRef = useRef<HTMLDivElement>(null)
  const sectionRefMerged = useMergedRef(sectionRef, setModalSectionOs)

  // `suppressAlwaysAllowRule` means the SDK's suggested rule would grant more
  // than this ask's own action — never offer the persistent session-wide allow.
  const hasSuggestions =
    Array.isArray(request.suggestions) &&
    request.suggestions.length > 0 &&
    request.suppressAlwaysAllowRule !== true
  // `defaultToNo` — the ask must not be approvable by a single stray keystroke:
  // open on the decline option. This dialog has no one-key approve shortcut, so
  // moving focus to Deny is the whole contract.
  const defaultToNo = request.defaultToNo === true
  const denyRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (defaultToNo) denyRef.current?.focus()
  }, [defaultToNo, request.id])

  useEffect(() => {
    if (planView === 'feedback') feedbackRef.current?.focus()
    else if (previousPlanView.current === 'feedback') requestChangesRef.current?.focus()
    previousPlanView.current = planView
  }, [planView])

  const closeMore = (reason?: FloatingDismissReason) => {
    setMoreAnchor(null)
    if (reason) return
    const active = document.activeElement
    const inMenuFlow =
      moreTriggerRef.current?.contains(active) ||
      (active instanceof Element && active.closest('[role="menu"]'))
    if (inMenuFlow) moreTriggerRef.current?.focus({ preventScroll: true })
  }

  const moreOpen = moreAnchor !== null
  useEffect(() => {
    if (!moreOpen) return
    const trigger = moreTriggerRef.current
    if (!trigger) return
    const syncAnchor = () => {
      const rect = trigger.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) {
        setMoreAnchor(null)
        return
      }
      const next = { x: rect.left, y: rect.top - 4 }
      setMoreAnchor(current => current?.x === next.x && current.y === next.y ? current : next)
    }
    const observer = new ResizeObserver(syncAnchor)
    observer.observe(trigger)
    const card = trigger.closest('.perm-card')
    if (card) observer.observe(card)
    window.addEventListener('resize', syncAnchor)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', syncAnchor)
    }
  }, [moreOpen])

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


  const headline = request.title ?? (
    isPlanRequest
      ? 'Claude has a plan ready'
      : `Claude wants to use ${request.toolName}`
  )

  // The section grows/shrinks as the raw input toggles, the plan body arrives,
  // or the request swaps; tween its height instead of jumping. The measure caps
  // at the .perm-card ceiling (pin-independent); the observer watches the
  // content-sized wrapper (markdown settles async). planView rides the key too:
  // a footer mode swap flexes this box at the card cap, so re-reading keeps its
  // baseline fresh. The footer itself is left static (flex-shrink:0): animating
  // it as a second box would make this section's ceiling pin-dependent, since the
  // chrome walk reads the footer sibling's transient pinned height mid-tween.
  const measureSectionHeight = useCallback(() => {
    const section = sectionRef.current
    const content = sectionContentRef.current
    const card = section?.closest('.perm-card') as HTMLElement | null
    if (!section || !content || !card) return null
    return measureCappedContentHeight(section, content, card)
  }, [])
  useAutoHeightTransition(
    sectionRef,
    `${request.id}|${isPlanRequest}|${showRaw}|${planText != null}|${planAllowedPrompts.length}|${planView}`,
    { measureTargetHeight: measureSectionHeight, observe: sectionContentRef },
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
      ariaLabel={isPlanRequest ? 'Review plan' : 'Tool permission required'}
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
          {isPlanRequest ? 'Review plan' : 'Tool permission required'}
        </h3>
        {onMinimize && (
          <button
            className="btn-icon"
            aria-label="Minimize"
            disabled={busy}
            onClick={() => {
              setMoreAnchor(null)
              onMinimize()
            }}
          >
            <IconX size={14} />
          </button>
        )}
      </div>

      <div className="modal-section" ref={sectionRefMerged}>
        <div className="modal-section-content" ref={sectionContentRef} role="presentation">
        {!isPlanRequest && <div className="perm-headline">{headline}</div>}
        {request.description && <div className="perm-sub">{request.description}</div>}

        {isPlanRequest ? (
          <div className="perm-plan-content">
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
            {request.mcpServer && (
              // SDK 0.3.274 provenance: trust the SOURCE, not the name.
              // `source: 'sdk'` is an in-process server this host registered;
              // every other source (user/project/plugin/dynamic/…) is config
              // authored elsewhere, so its name is untrusted display text.
              <HoverHint
                label={`MCP server: ${request.mcpServer.name} (${request.mcpServer.source})`}
                side="top"
              >
                <div className="perm-sub">
                  via {request.mcpServer.name}
                  {request.mcpServer.source === 'sdk' ? ' (in-process)' : ` (${request.mcpServer.source})`}
                </div>
              </HoverHint>
            )}
            <InputPreview input={request.input} />
          </>
        )}

        {!isPlanRequest && (
          <button
            type="button"
            className="perm-raw-toggle"
            onClick={() => setShowRaw((v) => !v)}
          >
            {showRaw ? 'Hide raw input' : 'Show raw input'}
          </button>
        )}
        {showRaw && (
          <pre className="perm-raw">{JSON.stringify(request.input, null, 2)}</pre>
        )}
        </div>
      </div>

      <div className="modal-footer" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
        {isPlanRequest ? (
          <>
            {planView === 'review' ? (
              <>
                <span className="hint" style={{ textAlign: 'center' }}>
                  {currentMode === 'default' || currentMode === 'acceptEdits' || currentMode === 'bypassPermissions'
                    ? 'Approval continues in your current permission mode.'
                    : 'Approval exits plan mode and continues in review-each mode.'}
                </span>
                <div className="perm-plan-actions decision-actions">
                  <button
                    className="btn btn-primary"
                    onClick={() => click({ behavior: 'allow', persistForSession: false, planTargetMode: planTargetModeFor(currentMode) })}
                    disabled={busy}
                    style={{ flex: 1 }}
                  >
                    Approve plan
                  </button>
                  <button
                    ref={requestChangesRef}
                    className="btn"
                    onClick={() => {
                      setMoreAnchor(null)
                      setPlanView('feedback')
                    }}
                    disabled={busy}
                    style={{ flex: 1 }}
                  >
                    Request changes
                  </button>
                  <button
                    ref={moreTriggerRef}
                    type="button"
                    className="btn-icon perm-more-trigger"
                    aria-label="More options"
                    aria-haspopup="menu"
                    aria-expanded={moreAnchor != null}
                    onClick={(e) => {
                      if (moreAnchor) {
                        closeMore()
                        return
                      }
                      const rect = e.currentTarget.getBoundingClientRect()
                      setMoreAnchor({ x: rect.left, y: rect.top - 4 })
                    }}
                  >
                    ⋯
                  </button>
                </div>
                {moreAnchor && (
                  <ContextMenu
                    x={moreAnchor.x}
                    y={moreAnchor.y}
                    placement="above"
                    items={[
                      ...PLAN_MORE_APPROVALS.map(option => ({
                        label: option.label,
                        disabled: busy,
                        onClick: () => click({ behavior: 'allow', persistForSession: false, planTargetMode: option.mode }),
                      })),
                      {},
                      { label: showRaw ? 'Hide raw input' : 'Show raw input', onClick: () => setShowRaw((v) => !v) },
                      {},
                      { label: 'Stop & take over', danger: true, disabled: busy, onClick: () => click({ behavior: 'deny', message: PLAN_STOP_MESSAGE, interrupt: true }) },
                    ]}
                    onClose={closeMore}
                    triggerRef={moreTriggerRef}
                    autoFocus
                    nonPrimary="close"
                  />
                )}
              </>
            ) : (
              <>
                <div className="perm-feedback-title">What should Claude change?</div>
                <textarea
                  ref={feedbackRef}
                  className="perm-feedback-input"
                  placeholder="Tell Claude what to change"
                  value={feedback}
                  onChange={(e) => setFeedback(e.target.value)}
                  disabled={busy}
                  rows={2}
                  aria-label="Plan feedback"
                />
                <div style={{ display: 'flex', gap: 8 }}>
                  <HoverHint
                    label="Send this feedback to Claude — it keeps planning in this turn"
                    side="top"
                  >
                    <button
                      className="btn btn-primary"
                      onClick={() => click({ behavior: 'deny', message: `Plan denied by user. Feedback: ${feedback.trim()}` })}
                      disabled={busy || feedback.trim().length === 0}
                      style={{ flex: 1 }}
                    >
                      Send feedback
                    </button>
                  </HoverHint>
                  <button className="btn" onClick={() => setPlanView('review')} disabled={busy}>
                    Back
                  </button>
                </div>
              </>
            )}
          </>
        ) : (
          <>
            {request.suppressAlwaysAllowRule === true && (
              <span className="hint" style={{ textAlign: 'center' }}>
                A session-wide allow isn&apos;t offered for this request.
              </span>
            )}
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
                <HoverHint
                  label="Apply the SDK's suggested allow rule for the rest of this session"
                  side="top"
                >
                  <button
                    className="btn"
                    onClick={() => click({ behavior: 'allow', persistForSession: true })}
                    disabled={busy}
                    style={{ flex: 1 }}
                  >
                    Allow for session
                  </button>
                </HoverHint>
              )}
              <button
                ref={denyRef}
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
