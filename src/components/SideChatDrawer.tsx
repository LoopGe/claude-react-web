// Side Chat drawer — slides in from the right edge of the parent session's
// ChatPanel. Renders a lightweight message list + input for the ephemeral
// Side Chat session. Uses the same overlay pattern as SubagentOverlay.
//
// Task 7: the drawer no longer takes a `stream: ChatStream` prop. ChatPanel
// owns the Side Chat synchronization/permission lifecycle (it calls
// useSessionSynchronizer + usePermissionChannel at the panel level so the WS
// subscription stays alive across collapse/expand). The drawer receives only
// the narrow `paging: TranscriptPaging` (for OlderHistoryFloat) and
// `permissions: UsePermissionChannel`, and reads every transcript field
// itself via the session-bound wrappers + narrow selectors:
//   · SessionMessageList  — items / replayReady / plan / tool maps / seq window
//   · SessionWorkingBubble — activeSubagents / apiRetry
//   · useSessionCommands  — insertUserMessage / ackUserMessage / rollbackUserMessage
//   · useSessionStreamError — the projected error banner string
//   · useSessionField('activeSubagents') — the waiting/mountBubble computation
//   · useSessionField('planContent')    — the PermissionDialog's plan map
// Drawer components never call hub.subscribe.

import { memo, useEffect, useRef, useState, useCallback } from 'react'
import type { SessionInfo } from '../types'
import type { StreamingRenderMode } from '../../shared/streaming-render-mode'
import type { TranscriptPaging } from '../session-sync/useSessionSynchronizer'
import type { UsePermissionChannel } from '../hooks/usePermissionChannel'
import { SessionMessageList } from './SessionMessageList'
import { SessionWorkingBubble } from './message-list/SessionWorkingBubble'
import { OlderHistoryFloat } from './message-list/transcript-chrome'
import { PermissionDialog } from './PermissionDialog'
import { RichPromptInput } from './RichPromptInput'
import { pasteAtCaret } from './richPromptApi'
import { IconX, IconArrowLeft, IconSendInterruptToggle, IconLoader, IconPaperclip } from './icons/ToolIcons'
import { ComposerImagePreviews } from './ComposerImagePreviews'
import { Tooltip } from './Tooltip'
import { api } from '../hooks/useApi'
import { usePastedImages } from '../hooks/usePastedImages'
import { usePastedTexts } from '../hooks/usePastedTexts'
import { usePastedTextEditing } from '../hooks/usePastedTextEditing'
import { useOverlayScrollbar } from '../hooks/useOverlayScrollbar'
import { useMergedRef } from '../utils/mergedRef'
import { useSessionCommands } from '../hooks/useSessionCommands'
import { useSessionStreamError } from '../session-sync/useSessionStreamError'
import { useSessionField, useOptionalSessionField } from '../session-store/selectors'
import { AnimatePresence } from 'motion/react'
import { BottomCardMotion } from './BottomCardMotion'
import { shouldMountWorkingBubble } from '../utils/task-actions'
import { sessionTitleOrFallback } from '../utils/session-title'
import { buildOutgoingBody } from '../utils/message-body'
import { prefersReducedMotion } from '../utils/reduced-motion'
import { computeWaiting } from '../session-store/normalize'
import { hasTranscriptBackground } from '../session-store/sidechain-index'

interface SendMessageResponse {
  ok: boolean
  message?: { uuid?: string; receivedAt?: number }
}

interface Props {
  session: SessionInfo
  parentSession: SessionInfo
  /** Narrow paging snapshot (loadingOlder / olderError / loadOlder) from
   *  ChatPanel's useSessionSynchronizer. Drives ONLY the OlderHistoryFloat —
   *  SessionMessageList receives loadingOlder / loadOlder as independent props
   *  so an olderError-only paging flip re-renders the caller (this drawer) for
   *  its float without re-rendering the wrapper. */
  paging: TranscriptPaging
  /** Permission state from the ChatPanel-level usePermissionChannel hook. */
  permissions: UsePermissionChannel
  /** Transcript's collapsible transcript-group-cards pref (tool-group fold) (effective value —
   *  session override ?? global default, resolved by ChatPanel). */
  toolGroupCards?: boolean
  /** Auto-expand running groups pref (effective value — session override ??
   *  global default, resolved by ChatPanel). */
  autoExpandRunningGroups?: boolean
  /** Message-card header visibility pref (effective value — session
   *  override ?? global default, resolved by ChatPanel). */
  showMessageHeaders?: boolean
  /** Where the live turn's text renders ('overlay' | 'inline'). Global-only
   *  pref (no per-session override), resolved by ChatPanel and fed verbatim
   *  to SessionMessageList's `streamingMode` seam. */
  streamingMode: StreamingRenderMode
  /** True close — deletes the ephemeral session. */
  onClose: () => void
  /** Collapse — hides the drawer but keeps the session alive. */
  onCollapse: () => void
}

/** Owns the 12.5 Hz streamingContent subscription that drives the drawer's
 *  auto-scroll. Renders null — a flush re-renders ONLY this component, never
 *  the drawer body (editor/footer would otherwise re-render every
 *  LIVE_TURN_FLUSH). Subscribes to `items` (for length) and `streamingContent`
 *  itself — the drawer does not thread an itemsLength prop. */
function SideChatAutoScroll({ sessionId, bodyRef }: {
  sessionId: string
  bodyRef: React.RefObject<HTMLDivElement | null>
}) {
  const items = useSessionField(sessionId, 'items')
  const itemsLength = items.length
  const streamingContent = useOptionalSessionField(sessionId, 'streamingContent')
  useEffect(() => {
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [bodyRef, itemsLength, streamingContent])
  return null
}

export const SideChatDrawer = memo(function SideChatDrawer({
  session,
  parentSession,
  paging,
  permissions,
  toolGroupCards,
  autoExpandRunningGroups,
  showMessageHeaders,
  streamingMode,
  onClose,
  onCollapse,
}: Props) {
  const [isExiting, setIsExiting] = useState(false)
  const [isCollapsing, setIsCollapsing] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  // Fallback overlay scrollbar for the drawer body. When <MessageList> is
  // present its Virtuoso scroller takes over (and has its own overlay); this
  // only shows a thumb when the body itself scrolls (e.g. empty drawer).
  const setBodyOs = useOverlayScrollbar({ autoHide: 'leave' })
  const bodyRefMerged = useMergedRef(bodyRef, setBodyOs)
  const editorRef = useRef<HTMLDivElement>(null)
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const pastedImages = usePastedImages()
  // Collapsed pastes: a long clipboard is replaced in the input by a
  // `[Pasted text #N]` reference whose body lives here and is spliced back in
  // on send, same as the main composer.
  const { add: addPastedText, expand: expandPastedText } = usePastedTexts()
  const fileInputRef = useRef<HTMLInputElement>(null)
  // Paste policy — the rich editor handles Backspace/Delete/arrows natively.
  const { placePastedText } = usePastedTextEditing({ addPastedText })

  // Session-bound optimistic-delivery commands (the same five actions the old
  // useChatStream exposed). Stable per session store (WeakMap cache).
  const { insertUserMessage, ackUserMessage, rollbackUserMessage } = useSessionCommands(session.id)
  // Projected stream-error banner. Re-renders this drawer only when the store
  // error OR the hub status actually changes — not on every transcript flush.
  const streamError = useSessionStreamError(session.id)

  /** Waiting = a background subagent is still in flight after the side-chat
   *  turn ended. Uses the SHARED predicates (computeWaiting /
   *  shouldMountWorkingBubble) so the RULE is the main panel's, with the task
   *  leg deliberately zeroed out: the drawer passes no `onOpenTasks` (the Tasks
   *  overlay is owned by the main panel), and WorkingBubble renders the count
   *  pill only when `onOpenTasks` is present — so a wait driven purely by a
   *  background task record would be an empty `Waiting...` bar with no pill and
   *  no entry point.
   *
   *  The INPUTS are the drawer's own, not Chat's: `turnActive` is
   *  `session.working` alone — no optimistic `pendingTurnSince` bridge and no
   *  `activePhase` leg. That mirrors the drawer's existing behaviour (it can
   *  show nothing during an SDK auto-continuation turn while the main panel
   *  shows its bubble); it is not a claim that the two surfaces agree on which
   *  turns count. The transcript-side leg is shared (hasTranscriptBackground).
   *
   *  `activeSubagents` is read directly from the store (a narrow selector) so
   *  the drawer re-renders only when the subagent list actually changes — not
   *  on every streaming flush the old aggregate ChatStream pulled along.
   */
  const activeSubagents = useSessionField(session.id, 'activeSubagents')
  const hasBackgroundSubagent = hasTranscriptBackground(activeSubagents)
  const waiting = computeWaiting({
    turnActive: session.working,
    terminated: session.terminated,
    runningCount: 0,
    hasTranscriptBackground: hasBackgroundSubagent,
  })
  /** Same shared predicate as the main panel, task leg zeroed (see above). */
  const mountBubble = shouldMountWorkingBubble({
    turnActive: session.working,
    terminated: session.terminated,
    taskCount: 0,
    hasTranscriptBackground: hasBackgroundSubagent,
    hasLiveSyncSubagent: false,
  })
  // Mount rise-in + staggered exit for the bubble, same as the main panel,
  // via the shared BottomCardMotion wrapper (also the exit-only overflow
  // clip); AnimatePresence keeps it mounted through the exit. Snaps under
  // reduced motion.

  // Plan-content map for the PermissionDialog (plan-permission cards). Read
  // from the store so the drawer doesn't carry it off the aggregate stream.
  const planContent = useSessionField(session.id, 'planContent')

  const handleSend = useCallback(async () => {
    // Expand first so no bare `[Pasted text #N]` can reach the model.
    const text = expandPastedText(input.trim())
    if ((!text && pastedImages.images.length === 0) || sending) return
    setSending(true)
    // Optimistic insert — message appears immediately in the transcript.
    const pendingId = insertUserMessage(text || '(image)')
    try {
      const res: SendMessageResponse = await api.post<SendMessageResponse>(
        `/sessions/${session.id}/messages`,
        buildOutgoingBody(text, pastedImages.images),
      )
      ackUserMessage(pendingId, res.message?.uuid ?? '', res.message?.receivedAt)
      setInput('')
      pastedImages.clear()
    } catch (e) {
      console.warn('Side Chat send failed:', (e as Error).message)
      rollbackUserMessage(pendingId)
    } finally {
      setSending(false)
    }
  }, [input, sending, session.id, insertUserMessage, ackUserMessage, rollbackUserMessage, pastedImages, expandPastedText])

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

  // Auto-scroll on new messages and streaming content lives in the
  // SideChatAutoScroll child below — the 12.5 Hz subscription must not sit on
  // the drawer root, or the whole drawer (editor, footer, buttons) re-renders
  // on every LIVE_TURN_FLUSH (review finding).

  // Auto-focus the editor on mount.
  useEffect(() => { editorRef.current?.focus() }, [])

  // When the user prefers reduced motion, CSS animations are disabled
  // (animation: none) so onAnimationEnd never fires. Skip straight to
  // the final callback so the drawer doesn't get stuck.
  const reduceMotion = prefersReducedMotion()

  useEffect(() => {
    if (isCollapsing && reduceMotion) onCollapse()
  }, [isCollapsing, reduceMotion, onCollapse])

  useEffect(() => {
    if (isExiting && reduceMotion) onClose()
  }, [isExiting, reduceMotion, onClose])

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
      <SideChatAutoScroll sessionId={session.id} bodyRef={bodyRef} />
      <div className="side-chat-drawer-header">
        <Tooltip label={`Back to ${sessionTitleOrFallback(parentSession)}`} placement="bottom">
          <button
            type="button"
            className="btn btn-sm side-chat-drawer-back"
            onClick={() => setIsCollapsing(true)}
          >
            <IconArrowLeft size={14} />
            <span className="side-chat-drawer-parent-title">
              {sessionTitleOrFallback(parentSession)}
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

      {/* Positioned wrapper for the older-history float: the body below is
          the scroll container, so an absolutely-anchored pill inside it would
          scroll away with the content. The stage stays put. */}
      <div className="side-chat-drawer-stage">
        <OlderHistoryFloat
          loading={paging.loadingOlder}
          error={paging.olderError}
          onRetry={paging.loadOlder}
        />
        <div className="side-chat-drawer-body" ref={bodyRefMerged}>
        <SessionMessageList
          sessionId={session.id}
          loadingOlder={paging.loadingOlder}
          loadOlder={paging.loadOlder}
          working={session.working}
          transcriptRevealKey={session.id}
          toolGroupCards={toolGroupCards}
          autoExpandRunningGroups={autoExpandRunningGroups}
          showMessageHeaders={showMessageHeaders}
          streamingMode={streamingMode}
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
        <AnimatePresence initial={false}>
          {mountBubble && (
            <BottomCardMotion key="working-bubble" fixed>
              {/* Raw phase (no dwell) and no thinking-token hint — the
                  drawer's behaviour before the telemetry moved into the
                  leaf. SessionWorkingBubble subscribes to activeSubagents /
                  apiRetry itself; ChatPanel owns the sync lifecycle. */}
              <SessionWorkingBubble
                sessionId={session.id}
                active={session.working}
                startedAt={session.workingSince}
                waiting={waiting}
              />
            </BottomCardMotion>
          )}
        </AnimatePresence>
        </div>
      </div>

      {streamError && (
        <div className="error-bar" style={{ flexShrink: 0 }}>
          {streamError}
        </div>
      )}

      {pendingHead?.kind === 'permission' && (
        <div className="side-chat-drawer-permission">
          <PermissionDialog
            open
            request={pendingHead}
            onDecide={(d) => void permissions.decide(pendingHead.id, d)}
            planContentMap={planContent}
            currentMode={session.permissionMode}
          />
        </div>
      )}

      <div className="side-chat-drawer-footer">
        {pastedImages.images.length > 0 && (
          <ComposerImagePreviews images={pastedImages.images} onRemove={pastedImages.removeImage} />
        )}
        {pastedImages.error && (
          <div className="side-chat-image-error">{pastedImages.error}</div>
        )}
        <div className="side-chat-drawer-input-row">
          <RichPromptInput
            editorRef={editorRef}
            value={input}
            onChange={setInput}
            ariaLabel="Message"
            className="side-chat-drawer-input"
            placeholder={session.terminated ? 'Session ended' : 'Ask something...'}
            disabled={session.terminated || sending}
            onSubmit={() => void handleSend()}
            onPasteImage={(file) => void pastedImages.addImage(file)}
            onNewline={() => {
              // Insert a literal \n at the live caret. execCommand is a jsdom
              // no-op (it does not exist there) but works in real browsers;
              // the onInput handler then reports the serialized DOM back
              // through onChange. Matches the main Composer's onNewline.
              if (typeof document.execCommand === 'function') {
                document.execCommand('insertText', false, '\n')
              }
            }}
            onPasteText={pasteAtCaret(placePastedText)}
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
                <IconLoader size={16} className="glyph-spin" />
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
