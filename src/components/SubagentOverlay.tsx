// Per-panel right-side overlay that holds a subagent's full internal
// conversation. Same overlay-inside-the-Chat-column pattern as
// SettingsPanel: absolute positioned, semi-transparent backdrop, only
// covers this column. ESC or backdrop click closes; the breadcrumb
// supports nested drill-down (a Task spawned inside an Agent etc.).

import { memo, useEffect, useMemo, useRef } from 'react'
import { MessageList } from './MessageList'
import { useEscapeStack } from '../hooks/useEscapeStack'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { formatElapsed } from '../utils/format'
import { IconX, IconArrowLeft } from './icons/ToolIcons'
import type { ActiveSubagent, PlanStatus, ToolResultEntry, ToolStatus, TranscriptItem } from '../session-store/types'
import { userMessageHasToolResult } from '../session-store/normalize'
import type { SdkMessage } from '../types'
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
}: Props) {
  const currentId = stack[stack.length - 1]
  const current = currentId ? index.get(currentId) : undefined

  // The subagent's input prompt, as a synthetic leading message.
  //
  // The SDK does NOT echo an async/background subagent's prompt back as a
  // child frame, so the overlay's parent_tool_use_id filter hides it —
  // leaving the subagent's reply with no question for context. We inject
  // the prompt via `leadingItems` (bypasses the filter) so it shows once
  // at the top of the inner conversation.
  //
  // Two details that make this match the synchronous display:
  //  1. Skip when the SDK already echoed the prompt as a child user frame
  //     (synchronous subagents). Otherwise the prompt would render twice
  //     — the echo AND this synthetic — which is the repeat the sync
  //     overlay used to show.
  //  2. Carry parent_tool_use_id = currentId so MessageList renders it via
  //     the subagent-internal branch (label "subagent"), identical to the
  //     sync echo. A null parent would label it "you", which misrepresents
  //     the message — it's the parent agent's input to the subagent, not a
  //     human user's message.
  // Memoised so the array identity is stable (MessageList's renderableItems
  // useMemo depends on it).
  const promptLeading = useMemo<TranscriptItem[] | undefined>(() => {
    if (!currentId || !current?.prompt) return undefined
    // Synchronous subagent: the SDK echoes the prompt as a child user frame
    // (parent_tool_use_id === currentId, type 'user', with text). Detect it
    // so we don't duplicate.
    const sdkEchoedPrompt = items.some(
      (it) =>
        it.msg.parent_tool_use_id === currentId &&
        it.msg.type === 'user' &&
        // Exclude tool_result-bearing child frames: a subagent's internal
        // tool_results (e.g. a Read result) are child user frames whose
        // plainText is the tool output, which would otherwise trip this echo
        // detector and wrongly suppress the prompt injection — leaving the
        // overlay with no input bubble for any async subagent that uses tools.
        !userMessageHasToolResult(it.msg) &&
        typeof it.plainText === 'string' &&
        it.plainText.length > 0 &&
        !it.isCompactSummary,
    )
    if (sdkEchoedPrompt) return undefined
    const prompt = current.prompt
    const msg = {
      type: 'user',
      uuid: `${currentId}:prompt`,
      parent_tool_use_id: currentId,
      receivedAt: current.startedAt,
      message: { role: 'user', content: [{ type: 'text', text: prompt }] },
    } as unknown as SdkMessage
    return [{
      id: `${currentId}:prompt`,
      msg,
      plainText: prompt,
      isCompactSummary: false,
      hiddenByDefault: false,
      receivedAt: current.startedAt,
    }]
  }, [currentId, current?.prompt, current?.startedAt, items])

  // A synchronous subagent's reply lands as the Agent tool_result on the
  // MAIN thread (parent_tool_use_id = null), so the overlay's parent filter
  // hides it — the overlay would show only the prompt echo with no reply.
  // Append `record.result` as a synthetic trailing assistant message so the
  // subagent's output is visible. Skipped for async subagents: their reply
  // streams as a child assistant frame (parent = currentId) and is already
  // in the filtered list, so appending would duplicate it.
  const resultTrailing = useMemo<TranscriptItem[] | undefined>(() => {
    if (!currentId || !current) return undefined
    if (current.isAsync === true) return undefined
    const result = current.result
    if (!result) return undefined
    // Normalise result.content (string | block[]) into a text array + a
    // plain-text view so MessageList's assistant renderer and search both
    // have something to show.
    const content = result.content
    let text: string
    let blocks: Array<{ type: 'text'; text: string }>
    if (typeof content === 'string') {
      text = content
      blocks = [{ type: 'text', text }]
    } else if (Array.isArray(content)) {
      const parts: string[] = []
      for (const b of content as Array<Record<string, unknown>>) {
        if (b?.type === 'text' && typeof b.text === 'string') parts.push(b.text)
      }
      text = parts.join('\n\n')
      blocks = parts.length > 0 ? parts.map((t) => ({ type: 'text' as const, text: t })) : [{ type: 'text' as const, text: '' }]
    } else {
      return undefined
    }
    if (!text.trim()) return undefined
    const msg = {
      type: 'assistant',
      uuid: `${currentId}:result`,
      parent_tool_use_id: currentId,
      receivedAt: current.endedAt ?? current.startedAt,
      message: { role: 'assistant', content: blocks },
    } as unknown as SdkMessage
    return [{
      id: `${currentId}:result`,
      msg,
      plainText: text,
      isCompactSummary: false,
      hiddenByDefault: false,
      receivedAt: current.endedAt ?? current.startedAt,
    }]
  }, [currentId, current])

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
  const elapsedMs = startedAt ? (endedAt ?? Date.now()) - startedAt : null

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
        if (e.target === e.currentTarget) onClose()
      }}
      data-state={isExiting ? 'closing' : 'open'}
      onAnimationEnd={(e) => {
        if (e.target === e.currentTarget && isExiting && e.animationName === 'overlay-backdrop-out') {
          onExited?.()
        }
      }}
    >
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
              {elapsedMs != null && ` · ${formatElapsed(elapsedMs)}`}
            </span>
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
            leadingItems={promptLeading}
            trailingItems={resultTrailing}
            transcriptRevealKey={`subagent:${currentId}`}
            toolStatus={toolStatus}
            toolResults={toolResults}
            planStatus={planStatus}
            planContent={planContent}
            questionAnswers={questionAnswers}
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
