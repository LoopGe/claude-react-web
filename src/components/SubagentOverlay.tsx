// Per-panel right-side overlay that holds a subagent's full internal
// conversation. Same overlay-inside-the-Chat-column pattern as
// SettingsPanel: absolute positioned, semi-transparent backdrop, only
// covers this column. ESC or backdrop click closes; the breadcrumb
// supports nested drill-down (a Task spawned inside an Agent etc.).

import { memo, useEffect, useRef } from 'react'
import { MessageList } from './MessageList'
import { useEscapeStack } from '../hooks/useEscapeStack'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { ElapsedTimer } from './ElapsedTimer'
import { IconX, IconArrowLeft } from './icons/ToolIcons'
import type { ActiveSubagent, PlanStatus, ToolResultEntry, ToolStatus, TranscriptItem } from '../session-store/types'
import type { QuestionAnswerEntry } from '../utils/question-answers'

interface Props {
  /** Stack of toolUseIds: stack[0] is the outermost subagent the user
   *  drilled into, stack[length-1] is the one currently shown. */
  stack: string[]
  /** Full session transcript — we filter it to messages whose
   *  parent_tool_use_id matches the current frame. */
  items: TranscriptItem[]
  index: ReadonlyMap<string, ActiveSubagent>
  onClose: () => void
  onPop: () => void
  /** When provided, the × (close) button dismisses an in-flight subagent
   *  (running/background/pending — flips to `dismissed` via
   *  DISMISS_SUBAGENT) before closing the overlay. For already-settled
   *  subagents (done/interrupted/dismissed/rejected) the × just closes. */
  onDismiss?: (toolUseId: string) => void
  isExiting?: boolean
  transitionDirection?: 'forward' | 'back' | null
  onExited?: () => void
  /** Tool/plan/question lifecycle maps. These MUST be forwarded to the
   *  nested MessageList — it builds its OWN status context providers, so
   *  without them every tool card inside a drilled-in subagent reads the
   *  empty-default provider and useToolStatus() falls back to 'running'
   *  forever (the "tool stuck running" bug). The reducer already seeds
   *  subagent-internal tool ids (it ignores parent_tool_use_id), so the
   *  data exists — it just has to reach this MessageList. */
  toolStatus?: ReadonlyMap<string, ToolStatus>
  /** Captured tool_result payloads — forwarded so subagent-internal tool
   *  cards merge their results inline too (the reducer seeds those ids
   *  regardless of parent_tool_use_id). */
  toolResults?: ReadonlyMap<string, ToolResultEntry>
  planStatus?: ReadonlyMap<string, PlanStatus>
  planContent?: ReadonlyMap<string, string>
  questionAnswers?: ReadonlyMap<string, QuestionAnswerEntry[]>
  /** Background ONE in-flight tool call by tool_use id — forwarded to the
   *  nested MessageList so Bash cards inside the subagent's conversation can
   *  offer the per-card background button too (same session, tool ids are
   *  session-scoped). */
  onBackgroundTool?: (toolUseId: string) => void
}


export const SubagentOverlay = memo(function SubagentOverlay({
  stack,
  items,
  index,
  onClose,
  onPop,
  onDismiss,
  isExiting = false,
  transitionDirection = null,
  onExited,
  toolStatus,
  toolResults,
  planStatus,
  planContent,
  questionAnswers,
  onBackgroundTool,
}: Props) {
  const currentId = stack[stack.length - 1]
  const current = currentId ? index.get(currentId) : undefined
  // The synthetic prompt / result rows the parent filter can't reach are
  // derived inside MessageList from the `subagent` prop — see
  // message-list/useSubagentSyntheticRows.ts for why they must be built
  // there (referential stability) rather than assembled here.

  // ESC closes (or pops one level if nested). Registered in the escape stack
  // (window CAPTURE + stopPropagation) so the keypress is consumed here and
  // CANNOT fall through to App's bubble-phase interrupt branch. The old bubble
  // listener had no stopPropagation, so Esc while a subagent overlay was open
  // closed it AND interrupted the running session — the exact bug this fixes.
  // canClose gates the exit window: while the overlay is animating out the
  // keypress is still swallowed, just not acted on. The container is the root
  // (.subagent-overlay), so the stack's containment scan resolves nesting with
  // any other overlay regardless of which element holds focus.
  const overlayRef = useRef<HTMLDivElement>(null)
  useEscapeStack({
    active: true,
    onEscape: () => {
      if (stack.length > 1) onPop()
      else onClose()
    },
    canClose: () => !isExiting,
    getContainer: () => overlayRef.current,
  })

  // Focus trap + restore, mirroring the Settings/Git overlays' Overlay
  // configuration (trapRefTarget="backdrop", focusEscapeSelector=".chat-panel").
  // Before this, closing the overlay left keyboard focus on <body>: every
  // other overlay in the app restores focus to its trigger on close. The
  // escapeSelector lets focus move to a sibling chat panel while this column's
  // overlay is open (same semantics as Settings/Git), and the trap stays
  // engaged through the exit animation — focus is restored on unmount.
  //
  // `active: !!current` (not constant true): this component renders null when
  // the index entry is missing, and useFocusTrap's effect binds the ref-based
  // listeners once per `active` flip. With a constant true, a first commit
  // where the entry isn't in the index yet (stack persisted across resume,
  // index still rebuilding from replay) would leave the trap bound to a null
  // ref forever — open overlay, unmanaged keyboard focus. Gating on `current`
  // re-arms the trap when content actually appears.
  useFocusTrap(overlayRef, { active: !!current, restoreFocus: true, escapeSelector: '.chat-panel' })

  // If the referenced subagent vanishes from the index (session reset,
  // fork, etc.) the overlay would render null and the stack would be
  // stuck non-empty — close/back become silent no-ops. Drive a real
  // close so subsequent open() calls work.
  useEffect(() => {
    if (currentId && !current) {
      if (onExited) onExited()
      else onClose()
    }
  }, [currentId, current, onClose, onExited])

  if (!currentId || !current) return null

  // Live elapsed for the current frame's header. Re-renders piggy-back
  // on the parent (Chat) re-rendering — good enough at second granularity.
  const startedAt = current.startedAt
  const endedAt = current.endedAt
  // In-flight statuses keep counting; settled ones freeze at endedAt. Before
  // this the header computed Date.now() once per render, so an open overlay on
  // a running subagent showed a frozen elapsed until some unrelated state
  // change happened to re-render it.
  const elapsedLive =
    current.status === 'running' || current.status === 'background' || current.status === 'pending'

  const statusText =
    current.status === 'running' ? 'running'
    : current.status === 'background' ? 'background'
    : current.status === 'pending' ? 'pending'
    : current.status === 'dismissed' ? 'dismissed'
    : current.status === 'done' ? 'done'
    : current.status === 'rejected' ? 'rejected'
    : 'interrupted'

  return (
    <div
      ref={overlayRef}
      className="subagent-overlay"
      role="dialog"
      aria-modal="false"
      aria-label="Subagent details"
      onMouseDown={(e) => {
        if (isExiting) return
        // Click-outside-to-close. The scrim is what actually covers the region
        // outside the panel now (see the compositing contract in chat.css), so
        // accept it as well as the container itself.
        const target = e.target as HTMLElement
        if (target === e.currentTarget || target.classList.contains('subagent-overlay-scrim')) {
          onClose()
        }
      }}
      data-state={isExiting ? 'closing' : 'open'}
      onAnimationEnd={(e) => {
        // The exit fade runs on the scrim, so this arrives via bubbling rather
        // than on the container itself. Match on BOTH the source element and
        // the animation name: `overlay-backdrop-out` is shared by every overlay
        // in the app, so a name-only check would let a nested overlay's exit
        // fade close this one.
        if (!isExiting) return
        const target = e.target as HTMLElement
        if (target.classList.contains('subagent-overlay-scrim') && e.animationName === 'overlay-backdrop-out') {
          onExited?.()
        }
      }}
    >
      {/* Scrim: background + backdrop-filter live here, NOT on the container,
          so the panel's virtualised transcript isn't inside a
          backdrop-filtered render surface. See chat.css. */}
      <div className="subagent-overlay-scrim" aria-hidden />
      <div className="subagent-overlay-panel">
        <div className="subagent-overlay-header">
          <button
            type="button"
            className="subagent-overlay-back"
            onClick={stack.length > 1 ? onPop : onClose}
            disabled={isExiting}
            title={stack.length > 1 ? 'Back to outer subagent' : 'Back to conversation'}
            aria-label="Back"
          >
            <IconArrowLeft size={14} />
          </button>
          <div className="subagent-overlay-title">
            {stack.length > 1 && (
              <span className="subagent-overlay-breadcrumb">
                {stack.slice(0, -1).map((id) => {
                  const r = index.get(id)
                  return (r?.label ?? 'subagent') + ' › '
                })}
              </span>
            )}
            <span className="subagent-overlay-current-label">{current.label}</span>
            <span className={`subagent-overlay-status status-${current.status}`}>
              {statusText}
              {startedAt != null && ' · '}
              <ElapsedTimer startedAt={startedAt} endedAt={endedAt} live={elapsedLive} />
            </span>
            {/* Live progress summary (agentProgressSummaries) — shown only
                while the subagent is in flight; cleared on terminal. */}
            {current.progressSummary && (current.status === 'running' || current.status === 'background' || current.status === 'pending') && (
              <span className="subagent-overlay-progress" title={current.progressSummary}>
                {current.progressSummary}
              </span>
            )}
          </div>
          <button
            type="button"
            className="subagent-overlay-close"
            onClick={() => {
              const st = current?.status
              if (onDismiss && (st === 'running' || st === 'background' || st === 'pending')) {
                onDismiss(currentId)
              }
              onClose()
            }}
            disabled={isExiting}
            title={current && (current.status === 'running' || current.status === 'background' || current.status === 'pending') && onDismiss ? 'Dismiss and close' : 'Close (Esc)'}
            aria-label={current && (current.status === 'running' || current.status === 'background' || current.status === 'pending') && onDismiss ? 'Dismiss and close' : 'Close'}
          >
            <IconX size={14} />
          </button>
        </div>
        <div
          key={currentId}
          className={[
            'subagent-overlay-body',
            transitionDirection ? `subagent-overlay-body-${transitionDirection}` : '',
          ].filter(Boolean).join(' ')}
        >
          <MessageList
            items={items}
            parentToolUseIdFilter={currentId}
            subagent={current}
            transcriptRevealKey={`subagent:${currentId}`}
            toolStatus={toolStatus}
            toolResults={toolResults}
            planStatus={planStatus}
            planContent={planContent}
            questionAnswers={questionAnswers}
            onBackgroundTool={onBackgroundTool}
            replayReady
            // Subagents are not interactive — you can't type into them.
            // The default ChatEmptyState ("Type a message below, or paste
            // an image to begin") would be misleading here, so override
            // with copy that explains why the body is empty. Reuses the
            // Side Chat two-line empty-state shape (.chat-messages-empty-side).
            emptyStateContent={(
              <div className="chat-messages-empty-side">
                <div className="chat-messages-empty-title">
                  {current.status === 'running' || current.status === 'background' || current.status === 'pending' ? 'This subagent is working' : 'No subagent output'}
                </div>
                <div className="chat-messages-empty-hint">
                  Subagents run autonomously — you can follow its progress here, but can't send messages to it.
                </div>
              </div>
            )}
          />
        </div>
      </div>
    </div>
  )
})
