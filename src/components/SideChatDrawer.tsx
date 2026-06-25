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
import { IconX, IconArrowLeft, IconSendInterruptToggle, IconLoader, IconPaperclip } from './icons/ToolIcons'
import { Tooltip } from './Tooltip'
import { api } from '../hooks/useApi'
import { usePastedImages } from '../hooks/usePastedImages'

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
  const pastedImages = usePastedImages()
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleSend = useCallback(async () => {
    const text = input.trim()
    if ((!text && pastedImages.images.length === 0) || sending) return
    setSending(true)
    // Optimistic insert — message appears immediately in the transcript.
    const pendingId = stream.insertUserMessage(text || '(image)')
    try {
      let res: SendMessageResponse
      if (pastedImages.images.length > 0) {
        const content: Array<{ type: string; text?: string; source?: { type: string; data: string; media_type: string } }> = []
        if (text) content.push({ type: 'text', text })
        for (const img of pastedImages.images) {
          content.push({ type: 'image', source: { type: 'base64', data: img.data, media_type: img.mediaType } })
        }
        res = await api.post<SendMessageResponse>(`/sessions/${session.id}/messages`, { content })
      } else {
        res = await api.post<SendMessageResponse>(`/sessions/${session.id}/messages`, { text })
      }
      stream.ackUserMessage(pendingId, res.message?.uuid ?? '', res.message?.receivedAt)
      setInput('')
      pastedImages.clear()
    } catch (e) {
      console.warn('Side Chat send failed:', (e as Error).message)
      stream.rollbackUserMessage(pendingId)
    } finally {
      setSending(false)
    }
  }, [input, sending, session.id, stream, pastedImages])

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

  // Auto-grow the textarea up to the CSS max-height (180px), then become
  // scrollable. Reset to 'auto' first so it can also shrink when the
  // user deletes lines — otherwise it would only ever grow.
  useLayoutEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`
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
          transcriptRevealKey={session.id}
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
        {pastedImages.images.length > 0 && (
          <div className="image-previews">
            {pastedImages.images.map((img) => (
              <div key={img.id} className="image-preview-card">
                <img src={img.previewUrl} alt="Pasted image" />
                <button
                  type="button"
                  className="image-preview-remove"
                  onClick={() => pastedImages.removeImage(img.id)}
                  aria-label="Remove image"
                >
                  <IconX size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
        {pastedImages.error && (
          <div className="side-chat-image-error">{pastedImages.error}</div>
        )}
        <div className="side-chat-drawer-input-row">
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
            onPaste={(e) => {
              const items = e.clipboardData?.items
              if (!items) return
              for (const item of items) {
                if (item.type.startsWith('image/') && item.type !== 'image/svg+xml') {
                  const file = item.getAsFile()
                  if (file) void pastedImages.addImage(file)
                  return
                }
              }
            }}
            placeholder={session.terminated ? 'Session ended' : 'Ask something...'}
            disabled={session.terminated || sending}
            rows={1}
          />
          <div className="side-chat-drawer-actions">
            <button
              type="button"
              className="btn btn-icon"
              onClick={() => fileInputRef.current?.click()}
              disabled={session.terminated || sending}
              title="Attach image"
              aria-label="Attach image"
            >
              <IconPaperclip size={16} />
            </button>
            <button
              type="button"
              className={`btn btn-icon ${session.working ? 'btn-danger' : 'btn-primary'}`}
              onClick={session.working ? handleInterrupt : handleSend}
              disabled={(!input.trim() && pastedImages.images.length === 0 && !session.working) || sending}
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
        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/gif,image/webp"
          multiple
          aria-hidden
          tabIndex={-1}
          style={{ display: 'none' }}
          onChange={(e) => {
            const files = e.target.files ? Array.from(e.target.files) : []
            e.target.value = ''
            for (const f of files) void pastedImages.addImage(f)
          }}
        />
      </div>
    </div>
  )
})
