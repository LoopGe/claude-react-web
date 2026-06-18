// Side Chat drawer — slides in from the right edge of the parent session's
// ChatPanel. Renders a lightweight message list + input for the ephemeral
// Side Chat session. Uses the same overlay pattern as SubagentOverlay.

import { memo, useEffect, useRef, useState, useCallback } from 'react'
import type { SessionInfo } from '../types'
import { useChatStream } from '../hooks/useChatStream'
import { usePermissionChannel } from '../hooks/usePermissionChannel'
import { MessageList, WorkingBubble } from './MessageList'
import { PermissionDialog } from './PermissionDialog'
import { IconX, IconArrowLeft } from './icons/ToolIcons'
import { Tooltip } from './Tooltip'
import { api } from '../hooks/useApi'

interface Props {
  session: SessionInfo
  parentSession: SessionInfo
  onClose: (sessionId?: string) => void
  onSelectParent: (id: string) => void
}

export const SideChatDrawer = memo(function SideChatDrawer({
  session,
  parentSession,
  onClose,
  onSelectParent,
}: Props) {
  const [isExiting, setIsExiting] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)

  const permissions = usePermissionChannel(session.id)
  const stream = useChatStream(session.id, {
    onRequest: permissions.onRequest,
    onResolved: permissions.onResolved,
    onCleared: permissions.clearError,
  })

  const handleSend = useCallback(async () => {
    const text = input.trim()
    if (!text || sending) return
    setSending(true)
    try {
      await api.post(`/sessions/${session.id}/messages`, { text })
      setInput('')
    } catch (e) {
      console.warn('Side Chat send failed:', (e as Error).message)
    } finally {
      setSending(false)
    }
  }, [input, sending, session.id])

  const handleInterrupt = useCallback(async () => {
    try { await api.post(`/sessions/${session.id}/interrupt`, {}) } catch { /* */ }
  }, [session.id])

  // ESC to close (capture phase to beat parent handlers).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isExiting) {
        e.preventDefault()
        e.stopPropagation()
        setIsExiting(true)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [isExiting])

  // Defensive unmount cleanup — if the parent panel is removed without
  // triggering the exit animation (e.g. closeSession), onAnimationEnd
  // never fires and onClose would be skipped. This effect catches that.
  // Capture the session ID at mount so the cleanup always targets the
  // correct session, even if a new side-chat was created later.
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const sessionIdRef = useRef(session.id)
  useEffect(() => {
    return () => { onCloseRef.current(sessionIdRef.current) }
  }, [])

  // Auto-scroll on new messages.
  useEffect(() => {
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [stream.items.length])

  // Auto-focus the textarea on mount.
  useEffect(() => { textareaRef.current?.focus() }, [])

  const handleExited = useCallback(() => { onClose() }, [onClose])
  const pendingHead = permissions.pending[0] ?? null

  return (
    <div
      className={`side-chat-drawer${isExiting ? ' exiting' : ''}`}
      data-state={isExiting ? 'closing' : 'open'}
      onAnimationEnd={() => { if (isExiting) handleExited() }}
    >
      <div className="side-chat-drawer-header">
        <Tooltip label={`Back to ${parentSession.title ?? parentSession.id.slice(0, 8)}`} placement="bottom">
          <button
            type="button"
            className="side-chat-drawer-back"
            onClick={() => onSelectParent(parentSession.id)}
          >
            <IconArrowLeft size={14} />
            <span className="side-chat-drawer-parent-title">
              {parentSession.title ?? parentSession.id.slice(0, 8)}
            </span>
          </button>
        </Tooltip>
        <span className="side-chat-drawer-title">Side Chat</span>
        <button
          type="button"
          className="side-chat-drawer-close"
          onClick={() => setIsExiting(true)}
          aria-label="Close Side Chat"
        >
          <IconX size={14} />
        </button>
      </div>

      <div className="side-chat-drawer-body" ref={bodyRef}>
        <MessageList
          items={stream.items}
          working={session.working}
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
        <WorkingBubble
          startedAt={session.workingSince}
          activeSubagents={stream.activeSubagents}
          tokenRate={stream.tokenRate}
          activePhase={stream.activePhase}
        />
      </div>

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
          className="side-chat-drawer-send"
          onClick={session.working ? handleInterrupt : handleSend}
          disabled={(!input.trim() && !session.working) || sending}
        >
          {session.working ? '■' : '↑'}
        </button>
      </div>
    </div>
  )
})
