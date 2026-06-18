// Side Chat drawer — slides in from the right edge of the parent session's
// ChatPanel. Renders a lightweight message list + input for the ephemeral
// Side Chat session. Uses the same overlay pattern as SubagentOverlay.
//
// The stream and permission hooks run at the ChatPanel level so the WS
// subscription stays alive during collapse. This component receives them
// as props and focuses purely on rendering + input.

import { memo, useEffect, useRef, useState, useCallback } from 'react'
import type { SessionInfo } from '../types'
import type { ChatStream } from '../hooks/useChatStream'
import type { UsePermissionChannel } from '../hooks/usePermissionChannel'
import { MessageList, WorkingBubble } from './MessageList'
import { PermissionDialog } from './PermissionDialog'
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
  const bodyRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)

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

  // ESC → collapse (non-destructive). Capture phase to beat parent handlers.
  // Triggers the collapse animation; onCollapse fires after it completes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isExiting && !isCollapsing) {
        e.preventDefault()
        e.stopPropagation()
        setIsCollapsing(true)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [isExiting, isCollapsing])

  // Auto-scroll on new messages and streaming content.
  useEffect(() => {
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [stream.items.length, stream.streamingContent])

  // Auto-focus the textarea on mount.
  useEffect(() => { textareaRef.current?.focus() }, [])

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
        <Tooltip label={`Back to ${parentSession.title ?? parentSession.id.slice(0, 8)}`} placement="bottom">
          <button
            type="button"
            className="btn btn-sm side-chat-drawer-back"
            onClick={() => setIsCollapsing(true)}
          >
            <IconArrowLeft size={14} />
            <span className="side-chat-drawer-parent-title">
              {parentSession.title ?? parentSession.id.slice(0, 8)}
            </span>
          </button>
        </Tooltip>
        <span className="side-chat-drawer-title">Side Chat</span>
        <Tooltip label="Close (delete session)" placement="bottom">
          <button
            type="button"
            className="btn btn-icon"
            disabled={isExiting || isCollapsing}
            onClick={() => setIsExiting(true)}
            aria-label="Close Side Chat"
          >
            <IconX size={14} />
          </button>
        </Tooltip>
      </div>

      <div className="side-chat-drawer-body" ref={bodyRef}>
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

      {stream.error && (
        <div className="error-bar" style={{ flexShrink: 0 }}>
          {stream.error}
        </div>
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
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void handleSend()
            }
          }}
          placeholder={session.terminated ? 'Session ended' : 'Ask something...'}
          disabled={session.terminated || sending}
          rows={1}
        />
        <button
          type="button"
          className={`btn btn-icon ${session.working ? 'btn-danger' : 'btn-primary'}`}
          onClick={session.working ? handleInterrupt : handleSend}
          disabled={(!input.trim() && !session.working) || sending}
          title={session.working ? 'Interrupt' : 'Send message (Enter)'}
          aria-label={session.working ? 'Interrupt' : 'Send message'}
        >
          {sending && !session.working ? (
            <IconLoader size={16} className="composer-send-spinner" />
          ) : (
            <IconSendInterruptToggle
              size={session.working ? 14 : 16}
              className={`composer-action-toggle ${session.working ? 'interrupt' : 'send'}`}
            />
          )}
        </button>
      </div>
    </div>
  )
})
