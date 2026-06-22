// Side Chat drawer — slides in from the right edge of the parent session's
// ChatPanel. Renders a lightweight message list + input for the ephemeral
// Side Chat session. Uses the same overlay pattern as SubagentOverlay.
//
// The stream and permission hooks run at the ChatPanel level so the WS
// subscription stays alive during collapse. This component receives them
// as props and focuses purely on rendering + input.

import { memo, useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react'
import type { SessionInfo } from '../types'
import type { ChatStream } from '../hooks/useChatStream'
import type { UsePermissionChannel } from '../hooks/usePermissionChannel'
import { MessageList, WorkingBubble } from './MessageList'
import { PermissionDialog } from './PermissionDialog'
import { ConfirmDialog } from './ConfirmDialog'
import { IconX, IconArrowLeft, IconSendInterruptToggle, IconLoader } from './icons/ToolIcons'
import { Tooltip } from './Tooltip'
import { api } from '../hooks/useApi'

interface SendMessageResponse {
  ok: boolean
  message?: { uuid?: string; receivedAt?: number }
}

interface Props {
  session: SessionInfo
  parentSession: SessionInfo
  /** Live stream data from the ChatPanel-level useChatStream hook. */
  stream: ChatStream
  /** Permission state from the ChatPanel-level usePermissionChannel hook. */
  permissions: UsePermissionChannel
  /** True close — deletes the ephemeral session. */
  onClose: () => void
  /** Collapse — hides the drawer but keeps the session alive. */
  onCollapse: () => void
}

/** Max textarea height in px before the textarea becomes scrollable.
 *  Matches the CSS `max-height` on `.side-chat-drawer-input`. */
const TEXTAREA_MAX_HEIGHT = 180

export const SideChatDrawer = memo(function SideChatDrawer({
  session,
  parentSession,
  stream,
  permissions,
  onClose,
  onCollapse,
}: Props) {
  const [isExiting, setIsExiting] = useState(false)
  const [isCollapsing, setIsCollapsing] = useState(false)
  const [confirmingClose, setConfirmingClose] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)

  // Whether the drawer has any user-visible content that would be lost on
  // close. Used to gate the destructive-close confirmation: an empty side
  // chat closes silently (no harm done); a side chat with at least one
  // exchange asks first.
  const hasContent =
    stream.items.length > 0 ||
    !!stream.streamingContent ||
    !!session.working

  const handleSend = useCallback(async () => {
    const text = input.trim()
    if (!text || sending) return
    setSending(true)
    // Optimistic insert — message appears immediately in the transcript.
    const pendingId = stream.insertUserMessage(text)
    try {
      const res = await api.post<SendMessageResponse>(`/sessions/${session.id}/messages`, { text })
      stream.ackUserMessage(pendingId, res.message?.uuid ?? '', res.message?.receivedAt)
      setInput('')
    } catch (e) {
      console.warn('Side Chat send failed:', (e as Error).message)
      stream.rollbackUserMessage(pendingId)
    } finally {
      setSending(false)
    }
  }, [input, sending, session.id, stream])

  const handleInterrupt = useCallback(async () => {
    try { await api.post(`/sessions/${session.id}/interrupt`, {}) } catch { /* */ }
  }, [session.id])

  // Destructive close: only ask the user if they have content to lose.
  // The whole point of Side Chat is that throwaway questions are fine — we
  // don't want to ask twice when the user just opened it and changed their
  // mind. But once an exchange exists, deletion needs explicit consent.
  const requestClose = useCallback(() => {
    if (isExiting || isCollapsing) return
    if (hasContent) setConfirmingClose(true)
    else setIsExiting(true)
  }, [hasContent, isExiting, isCollapsing])

  const confirmCloseNow = useCallback(() => {
    setConfirmingClose(false)
    setIsExiting(true)
  }, [])

  // ESC behaviour:
  //   - If a confirmation dialog is mounted, let it handle the key (its
  //     own bubble-phase listener will cancel).
  //   - Otherwise collapse (non-destructive); ESC should never silently
  //     destroy a side chat.
  //
  // Bubble phase (NOT capture) so that descendants with their own ESC
  // handlers (PermissionDialog, ConfirmDialog) run first. Early-return on
  // permission/confirm so we don't fight nested dialogs.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (isExiting || isCollapsing) return
      if (confirmingClose) return
      if (permissions.pending.length > 0) return
      e.preventDefault()
      setIsCollapsing(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isExiting, isCollapsing, confirmingClose, permissions.pending.length])

  // Auto-focus the textarea on mount.
  useEffect(() => { textareaRef.current?.focus() }, [])

  // Auto-grow the textarea up to TEXTAREA_MAX_HEIGHT, then become
  // scrollable. Reset to 'auto' first so it can also shrink as the user
  // deletes lines (without this it would only ever grow).
  useLayoutEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    const next = Math.min(el.scrollHeight, TEXTAREA_MAX_HEIGHT)
    el.style.height = `${next}px`
  }, [input])

  // When the user prefers reduced motion, CSS animations are disabled
  // (animation: none) so onAnimationEnd never fires. Skip straight to
  // the final callback so the drawer doesn't get stuck.
  const prefersReducedMotion =
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches

  useEffect(() => {
    if (isCollapsing && prefersReducedMotion) onCollapse()
  }, [isCollapsing, prefersReducedMotion, onCollapse])

  useEffect(() => {
    if (isExiting && prefersReducedMotion) onClose()
  }, [isExiting, prefersReducedMotion, onClose])

  const handleExited = useCallback(() => { onClose() }, [onClose])
  const handleCollapsed = useCallback(() => { onCollapse() }, [onCollapse])
  const pendingHead = permissions.pending[0] ?? null

  const parentTitle = parentSession.title ?? parentSession.id.slice(0, 8)
  const isWorking = !!session.working
  const isSending = sending && !isWorking
  const isTerminated = !!session.terminated

  return (
    <div
      className={`side-chat-drawer${isExiting ? ' exiting' : ''}${isCollapsing ? ' collapsing' : ''}`}
      data-state={isExiting ? 'closing' : isCollapsing ? 'collapsing' : 'open'}
      onAnimationEnd={() => {
        if (isExiting) handleExited()
        else if (isCollapsing) handleCollapsed()
      }}
    >
      <div className="side-chat-drawer-header">
        <Tooltip label={`Back to ${parentTitle}`} placement="bottom">
          <button
            type="button"
            className="btn btn-sm side-chat-drawer-back"
            onClick={() => setIsCollapsing(true)}
          >
            <IconArrowLeft size={14} />
            <span className="side-chat-drawer-parent-title">{parentTitle}</span>
          </button>
        </Tooltip>
        <span className="side-chat-drawer-title">Side Chat</span>
        <Tooltip label="Close (delete session)" placement="bottom">
          <button
            type="button"
            className="btn btn-icon side-chat-drawer-close"
            disabled={isExiting || isCollapsing}
            onClick={requestClose}
            aria-label="Close Side Chat"
          >
            <IconX size={14} />
          </button>
        </Tooltip>
      </div>

      <div className="side-chat-drawer-body">
        <MessageList
          items={stream.items}
          working={session.working}
          replayReady={stream.replayReady}
          streamingContent={stream.streamingContent}
          planStatus={stream.planStatus}
          planContent={stream.planContent}
          questionAnswers={stream.questionAnswers}
          toolStatus={stream.toolStatus}
          toolResults={stream.toolResults}
          loadOlder={stream.loadOlder}
          hasOlder={stream.hasOlder}
          loadingOlder={stream.loadingOlder}
          emptyStateContent={(
            // Side Chat-specific empty state. The drawer is ephemeral —
            // closing it deletes the conversation — and most users only
            // discover this when they accidentally lose work. The empty
            // state is the natural place to teach that property before
            // they invest in a long thread.
            <div className="chat-messages-empty-side">
              <div className="chat-messages-empty-title">Ask a quick question.</div>
              <div className="chat-messages-empty-hint">
                This side chat is ephemeral — closing it deletes the conversation.
              </div>
            </div>
          )}
        />
        {session.working && (
          <WorkingBubble
            startedAt={session.workingSince}
            activeSubagents={stream.activeSubagents}
            tokenRate={stream.tokenRate}
            activePhase={stream.activePhase}
          />
        )}
      </div>

      {isTerminated && (
        <div className="side-chat-drawer-banner" role="status">
          This side chat has ended. Open a new one to continue.
        </div>
      )}

      {stream.error && (
        <div className="side-chat-drawer-error error-bar">{stream.error}</div>
      )}

      {pendingHead?.kind === 'permission' && (
        <div className="side-chat-drawer-permission">
          <PermissionDialog
            open
            request={pendingHead}
            onDecide={(d) => void permissions.decide(pendingHead.id, d)}
            planContentMap={stream.planContent}
            currentMode={session.permissionMode}
          />
        </div>
      )}

      <div className="side-chat-drawer-footer">
        <textarea
          ref={textareaRef}
          className="side-chat-drawer-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            // Skip Enter while an IME composition is active — Enter in
            // that context confirms the candidate, not submission. Without
            // this check Chinese/Japanese/Korean users would send partial
            // candidate strings.
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void handleSend()
            }
          }}
          placeholder={isTerminated ? 'Session ended' : 'Ask something...'}
          disabled={isTerminated || sending}
          rows={1}
        />
        <Tooltip
          label={isWorking ? 'Interrupt' : 'Send message (Enter)'}
          placement="top"
        >
          <button
            type="button"
            className={`btn btn-icon ${isWorking ? 'btn-danger' : 'btn-primary'}`}
            onClick={isWorking ? handleInterrupt : handleSend}
            disabled={(!input.trim() && !isWorking) || isSending}
            aria-label={isWorking ? 'Interrupt' : 'Send message'}
          >
            {isSending ? (
              <IconLoader size={16} className="composer-send-spinner" />
            ) : (
              <IconSendInterruptToggle
                size={isWorking ? 14 : 16}
                className={`composer-action-toggle ${isWorking ? 'interrupt' : 'send'}`}
              />
            )}
          </button>
        </Tooltip>
      </div>

      {confirmingClose && (
        <ConfirmDialog
          open
          title="Discard this side chat?"
          message="The conversation will be permanently deleted. This cannot be undone."
          confirmLabel="Discard"
          cancelLabel="Keep"
          destructive
          onConfirm={confirmCloseNow}
          onCancel={() => setConfirmingClose(false)}
        />
      )}
    </div>
  )
})
