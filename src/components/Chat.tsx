// Chat panel — orchestrates the stream, attachments, permissions, and
// renders the message list + composer. Side-effect hooks live in their
// own files; this module only wires things together.
//
// IMPORTANT: the parent MUST render this with `<Chat key={session.id} />`
// so React re-mounts the component on session switch. We rely on that
// instead of explicitly resetting state in an effect, which React 19's
// new rules flag as a cascading-render hazard. Re-mount is cheap because
// the sessions themselves are long-lived on the server.

import { useCallback, useMemo, useState } from 'react'
import { api } from '../hooks/useApi'
import { useAttachments } from '../hooks/useAttachments'
import { useChatStream } from '../hooks/useChatStream'
import { useInputHistory } from '../hooks/useInputHistory'
import { usePermissionChannel } from '../hooks/usePermissionChannel'
import { Composer } from './Composer'
import { ContextBar } from './ContextBar'
import { MessageList } from './MessageList'
import { PermissionDialog } from './PermissionDialog'
import type { SessionInfo } from '../types'

const INPUT_HISTORY_KEY = 'claude-react-web:input-history'
const DRAFT_KEY_PREFIX = 'claude-react-web:draft:'

/** Read a session's saved draft from sessionStorage. Non-throwing. */
function readDraft(sessionId: string): string {
  try {
    return window.sessionStorage.getItem(DRAFT_KEY_PREFIX + sessionId) ?? ''
  } catch {
    return ''
  }
}

/** Persist (or clear) a session's draft. Non-throwing. */
function writeDraft(sessionId: string, draft: string): void {
  try {
    if (draft) window.sessionStorage.setItem(DRAFT_KEY_PREFIX + sessionId, draft)
    else window.sessionStorage.removeItem(DRAFT_KEY_PREFIX + sessionId)
  } catch {
    /* quota or SecurityError — drafts are best-effort */
  }
}

interface Props {
  session: SessionInfo
  /** Reserved for future push updates — currently unused because session
   *  state is tracked via the SSE stream + top-level session list poll. */
  onSessionUpdate?: (s: SessionInfo) => void
}

export function Chat({ session }: Props) {
  // Lazy init reads the persisted draft for THIS session from sessionStorage.
  // The parent remounts Chat on session switch (<Chat key={session.id}>), so
  // this initializer runs exactly once per mount — the right place to hydrate.
  const [input, setInputState] = useState(() => readDraft(session.id))
  const [sending, setSending] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  /** Increments whenever we want the Composer's textarea refocused.
   *  Bumped after a successful send — otherwise the click on the Send
   *  button would leave focus on the button, breaking the
   *  type-enter-type-enter flow. */
  const [composerFocusSignal, setComposerFocusSignal] = useState(0)

  /** Write-through setter: mirror every change to sessionStorage so the
   *  draft survives a tab reload or a session switch-and-back. */
  const setInput = useCallback(
    (v: string) => {
      setInputState(v)
      writeDraft(session.id, v)
    },
    [session.id],
  )

  // Shell-style history is stored globally (all sessions share the same
  // ring) — matches how terminal users expect bash history to behave
  // across tabs.
  const history = useInputHistory(INPUT_HISTORY_KEY)

  // Permissions first — its onRequest/onResolved are passed into the
  // stream hook so SDK messages and permission events share one SSE.
  const permissions = usePermissionChannel(session.id)
  const stream = useChatStream(session.id, {
    onRequest: permissions.onRequest,
    onResolved: permissions.onResolved,
  })
  const attachments = useAttachments(session.id, session.cwd)

  // Pull out the specific functions/values we actually use downstream.
  // Putting the whole hook object in a dep list re-creates callbacks every
  // render and can churn child re-renders (the composer's onChange in
  // particular — that's what caused the "can't send / can't type" freeze).
  const { trackSentTurn, clearError: clearStreamError } = stream
  const {
    attachments: attachmentList,
    setDragOver,
    uploadFiles,
    clear: clearAttachments,
    clearError: clearAttachmentsError,
  } = attachments
  const { clearError: clearPermissionsError } = permissions

  // Unified error banner: whichever subsystem reported something.
  const error = localError ?? stream.error ?? attachments.error ?? permissions.error
  const clearError = useCallback(() => {
    setLocalError(null)
    clearStreamError()
    clearAttachmentsError()
    clearPermissionsError()
  }, [clearStreamError, clearAttachmentsError, clearPermissionsError])

  const onDragOver = useCallback(
    (e: React.DragEvent) => {
      // Needed for drop to fire. Only visually highlight when actual files
      // are being dragged — ignore text selections etc.
      if (!e.dataTransfer.types.includes('Files')) return
      e.preventDefault()
      setDragOver(true)
    },
    [setDragOver],
  )

  const onDragLeave = useCallback(
    (e: React.DragEvent) => {
      // relatedTarget is null when the pointer leaves the window entirely;
      // otherwise it's wherever the pointer went. Only clear the highlight
      // when we've actually left the drop zone (not moved to a child).
      if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
      setDragOver(false)
    },
    [setDragOver],
  )

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setDragOver(false)
      const files = Array.from(e.dataTransfer.files)
      if (files.length > 0) void uploadFiles(files)
    },
    [setDragOver, uploadFiles],
  )

  const send = useCallback(async () => {
    const text = input.trim()
    // Allow sending with just attachments (e.g. "here, look at these files")
    // — the model sees only the attachments preamble in that case.
    if (!text && attachmentList.length === 0) return
    if (sending) return
    setSending(true)
    clearError()
    try {
      const preamble =
        attachmentList.length > 0
          ? `Attached file${attachmentList.length === 1 ? '' : 's'} (absolute path${attachmentList.length === 1 ? '' : 's'} — use the Read tool to open):\n` +
            attachmentList.map((a) => `- ${a.path}`).join('\n') +
            '\n\n'
          : ''
      const full = preamble + text
      await api.post(`/sessions/${session.id}/messages`, { text: full })
      if (text) history.add(text)
      setInput('')
      clearAttachments()
      // Server queues this turn in the SDK input iterable; it will be
      // consumed as soon as the current turn's `result` arrives. Bump the
      // counter so the chip reflects "waiting in queue". The corresponding
      // `result` frame in onMessage will decrement it.
      trackSentTurn()
      // Put focus back on the textarea so the user can keep typing. If
      // they used Enter-to-send the focus is already there; if they
      // clicked the Send button it's currently on the button and the
      // next keystroke wouldn't show up.
      setComposerFocusSignal((n) => n + 1)
    } catch (e) {
      setLocalError((e as Error).message)
    } finally {
      setSending(false)
    }
  }, [input, attachmentList, sending, session.id, history, trackSentTurn, clearAttachments, clearError, setInput])

  const interrupt = useCallback(async () => {
    try {
      await api.post(`/sessions/${session.id}/interrupt`)
    } catch (e) {
      setLocalError((e as Error).message)
    }
  }, [session.id])

  // Note: we used to poll /sessions/:id 500ms after every SDK message to
  // keep the header badges fresh. That added O(messages × sessions) HTTP
  // requests on top of the SSE streams, and with three panels open it was
  // enough to saturate the browser's HTTP/1.1 connection pool. Model /
  // permissionMode only change via user actions (which already update
  // session state), and `working` is now derived from the message stream
  // itself (result messages clear it) — so no background poll is needed.

  // Count completed turns → re-fetch context usage whenever it increments.
  // Using messages.length alone would fire on every partial, which wastes
  // the control-request round-trip.
  const resultCount = useMemo(
    () => stream.messages.reduce((n, m) => (m.type === 'result' ? n + 1 : n), 0),
    [stream.messages],
  )

  return (
    <div className="chat">
      <MessageList messages={stream.messages} />

      {error && <div className="error-bar">{error}</div>}

      {stream.queuedAhead > 0 && (
        <div className="queue-bar">
          {stream.queuedAhead === 1 ? (
            <span>⏳ Assistant is replying…</span>
          ) : (
            <span>
              ⏳ Assistant is replying — {stream.queuedAhead - 1} more message
              {stream.queuedAhead - 1 === 1 ? '' : 's'} queued, will send automatically.
            </span>
          )}
        </div>
      )}

      <ContextBar sessionId={session.id} refreshKey={resultCount} running={session.running} />

      <Composer
        input={input}
        setInput={setInput}
        sending={sending}
        disabled={session.terminated}
        canAttach={!!session.cwd}
        attachments={attachments.attachments}
        uploading={attachments.uploading}
        dragOver={attachments.dragOver}
        onUploadFiles={(files) => void attachments.uploadFiles(files)}
        onRemoveAttachment={attachments.removeAttachment}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        history={history}
        onSend={() => void send()}
        onInterrupt={() => void interrupt()}
        canInterrupt={session.working}
        focusSignal={composerFocusSignal}
      />

      {permissions.pending.length > 0 && (
        <PermissionDialog
          key={permissions.pending[0].id}
          request={permissions.pending[0]}
          onDecide={(d) => void permissions.decide(permissions.pending[0].id, d)}
        />
      )}
    </div>
  )
}
