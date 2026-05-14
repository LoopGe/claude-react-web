// Chat panel — orchestrates the stream, attachments, permissions, and
// renders the message list + composer. Side-effect hooks live in their
// own files; this module only wires things together.
//
// IMPORTANT: the parent MUST render this with `<Chat key={session.id} />`
// so React re-mounts the component on session switch. We rely on that
// instead of explicitly resetting state in an effect, which React 19's
// new rules flag as a cascading-render hazard. Re-mount is cheap because
// the sessions themselves are long-lived on the server.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useDebouncedValue } from '../hooks/useDebouncedValue'
import { createPortal } from 'react-dom'
import { SettingsPanel } from './SettingsPanel'
import { api } from '../hooks/useApi'
import { useAttachments } from '../hooks/useAttachments'
import { useChatStream } from '../hooks/useChatStream'
import { usePastedImages } from '../hooks/usePastedImages'
import { useInputHistory } from '../hooks/useInputHistory'
import { usePermissionChannel } from '../hooks/usePermissionChannel'
import { Composer } from './Composer'
import { ContextBar } from './ContextBar'
import { MessageList, WorkingBubble } from './MessageList'
import { PermissionDialog } from './PermissionDialog'
import { QuestionDialog } from './QuestionDialog'
import { TodoChecklist } from './TodoChecklist'
import { useSessionRecap } from '../hooks/useSessionRecap'
import { MessageSearch } from './MessageSearch'
import { ContextMenu } from './ContextMenu'
import { exportConversation, exportConversationJson } from '../utils/exportConversation'
import type { PermissionRequest, SessionInfo, SlashCommand } from '../types'
import type { TranscriptItem } from '../session-store/types'

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
   *  state is tracked via the WebSocket hub + top-level session list poll. */
  onSessionUpdate: (s: SessionInfo) => void
  /** Forwarded to MessageList. App-level toggle (header bug icon). */
  showSystemEvents?: boolean
  /** When true, render the Settings overlay on top of this chat panel. */
  settingsOpen?: boolean
  onCloseSettings?: () => void
  /** Whether this panel is the currently focused (active) one. Used by
   *  useSessionRecap to track last-viewed timestamps. */
  focused?: boolean
  /** Called whenever the live stream message count changes, so the parent
   *  header can display an up-to-date count without waiting for a
   *  server-pushed session-update (which only fires at turn boundaries). */
  onLiveMessageCount?: (count: number) => void
  /** Called once on mount so the parent can store a reference to this
   *  panel's interrupt() function. Enables the ESC shortcut in App to
   *  trigger the same code-path as the Composer's interrupt button (which
   *  sets pendingInterruptRef for the "interrupted" label). */
  onRegisterInterrupt?: (sessionId: string, fn: () => void) => void
  /** Called once on mount so the parent can store a reference to this
   *  panel's recap.refresh() function. Enables the Alt+R shortcut in App. */
  onRegisterRecap?: (sessionId: string, fn: () => void) => void
  /** Portal target element in ChatPanel's header — set via callback ref.
   *  When non-null, Chat portals its toolbar buttons here so they appear
   *  in the panel header row instead of occupying a separate line. */
  headerButtonsRef?: HTMLDivElement | null
}

export function Chat({ session, showSystemEvents, settingsOpen, onCloseSettings, onSessionUpdate, focused, onLiveMessageCount, onRegisterInterrupt, onRegisterRecap, headerButtonsRef }: Props) {
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

  // Slash commands — cached per session so switching away and back
  // doesn't re-fetch. The SDK subprocess returns the list via a
  // control request; 410 on dormant sessions is expected and ignored.
  const [commands, setCommands] = useState<SlashCommand[]>([])
  const commandsCacheRef = useRef<Map<string, SlashCommand[]>>(new Map())
  useEffect(() => {
    if (!session.running) return
    const cached = commandsCacheRef.current.get(session.id)
    if (cached) {
      setCommands(cached)
      return
    }
    let cancelled = false
    api
      .get<{ commands: SlashCommand[] }>(`/sessions/${session.id}/commands`)
      .then((res) => {
        if (cancelled) return
        const cmds = res.commands ?? []
        commandsCacheRef.current.set(session.id, cmds)
        setCommands(cmds)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [session.id, session.running])

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
  // stream hook so SDK messages and permission events share one WebSocket.
  const permissions = usePermissionChannel(session.id)
  const stream = useChatStream(session.id, {
    onRequest: permissions.onRequest,
    onResolved: permissions.onResolved,
  })
  const attachments = useAttachments(session.id, session.cwd)
  const pastedImages = usePastedImages()

  // ── In-chat search ──────────────────────────────────────────
  const [searchOpen, setSearchOpen] = useState(false)
  const [exportMenuPos, setExportMenuPos] = useState<{ x: number; y: number } | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const debouncedQuery = useDebouncedValue(searchQuery, 200)
  const [searchActiveIdx, setSearchActiveIdx] = useState(0)
  /** Indices into transcript items that match the current search query. */
  const searchMatches = useMemo(() => {
    if (!debouncedQuery) return [] as number[]
    const q = debouncedQuery.toLowerCase()
    const out: number[] = []
    for (let i = 0; i < stream.items.length; i++) {
      const text = stream.items[i]?.searchableText
      if (text && text.toLowerCase().includes(q)) out.push(i)
    }
    return out
  }, [stream.items, debouncedQuery])
  // Reset active index when the match set changes (new query or new messages).
  // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional reset on derived data change
  useEffect(() => { setSearchActiveIdx(0) }, [searchMatches])
  // Ctrl+F opens search on the *focused* panel only. Without the
  // `focused` guard, every mounted Chat would intercept the same
  // keydown event and all search bars would open simultaneously.
  useEffect(() => {
    if (!focused) return
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f' && !e.shiftKey) {
        // Only intercept when the chat panel is focused (not when the
        // browser's own find bar is more appropriate).
        const target = e.target as HTMLElement
        if (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT') return
        e.preventDefault()
        setSearchOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [focused])

  const handleSearchNavigate = useCallback(
    (index: number) => {
      setSearchActiveIdx(index)
    },
    [],
  )

  // Report live message count to parent so the header stays up-to-date
  // during streaming (server only pushes session-update at turn boundaries).
  useEffect(() => {
    onLiveMessageCount?.(stream.messages.length)
  }, [stream.messages.length, onLiveMessageCount])

  // Session recap — auto-fired after 5 minutes of session idle. Returns
  // a synthetic message we splice into the transcript so the recap reads
  // as part of the conversation rather than a floating overlay. The hook
  // resets whenever lastTurnAt advances (i.e. user sent a new message).
  const recap = useSessionRecap(session.id, session.lastTurnAt)

  // Track questions that have been answered but whose dialog should stay
  // visible (showing the answer inline) for a few seconds before closing.
  // The permission is already resolved server-side; this just controls
  // how long the "answer sent" card remains on screen.
  const [answeredQuestions, setAnsweredQuestions] = useState<Map<string, { request: Extract<PermissionRequest, { kind: 'question' }>; answers: Array<string | string[] | null> }>>(() => new Map())
  const addAnsweredQuestion = useCallback((id: string, request: Extract<PermissionRequest, { kind: 'question' }>, answers: Array<string | string[] | null>) => {
    setAnsweredQuestions((prev) => {
      const next = new Map(prev)
      next.set(id, { request, answers })
      return next
    })
    setTimeout(() => {
      setAnsweredQuestions((prev) => {
        const next = new Map(prev)
        next.delete(id)
        return next
      })
    }, 3000)
  }, [])

  // Compose transcript items + recap. Answered questions now display
  // inline inside the QuestionDialog card, so no synthetic messages needed.
  const itemsWithRecap = useMemo(() => {
    if (!recap.message) return stream.items
    const item: TranscriptItem = {
      id: recap.message.uuid ?? `recap:${session.id}`,
      msg: recap.message,
      searchableText: recap.message.recap?.summary ?? recap.message.error ?? null,
      isCompactSummary: false,
      hiddenByDefault: false,
    }
    return [...stream.items, item]
  }, [stream.items, recap.message, session.id])

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
    if (!text && attachmentList.length === 0 && pastedImages.images.length === 0) return
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

      if (pastedImages.images.length > 0) {
        // Build content array with text + image blocks
        const content: Array<{ type: string; text?: string; source?: { type: string; data: string; media_type: string } }> = []
        if (full.trim()) content.push({ type: 'text', text: full })
        for (const img of pastedImages.images) {
          content.push({ type: 'image', source: { type: 'base64', data: img.data, media_type: img.mediaType } })
        }
        await api.post(`/sessions/${session.id}/messages`, { content })
      } else {
        await api.post(`/sessions/${session.id}/messages`, { text: full })
      }
      if (text) history.add(text)
      setInput('')
      clearAttachments()
      pastedImages.clear()
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
  }, [input, attachmentList, sending, session.id, history, trackSentTurn, clearAttachments, clearError, setInput, pastedImages])

  // Set to true when interrupt() fires; the next `result` message renders
  // as "interrupted" and resets this to false.
  const pendingInterruptRef = useRef(false)

  const interrupt = useCallback(async () => {
    try {
      pendingInterruptRef.current = true
      await api.post(`/sessions/${session.id}/interrupt`)
    } catch (e) {
      pendingInterruptRef.current = false
      setLocalError((e as Error).message)
    }
  }, [session.id])

  // Expose the interrupt callback to the parent so the ESC shortcut in
  // App.tsx can trigger the same code-path (which sets
  // pendingInterruptRef for the "interrupted" label).
  useEffect(() => {
    onRegisterInterrupt?.(session.id, interrupt)
  }, [session.id, interrupt, onRegisterInterrupt])

  // Expose the recap.refresh callback to the parent so the Alt+R shortcut
  // can trigger a recap fetch for the focused session.
  useEffect(() => {
    onRegisterRecap?.(session.id, recap.refresh)
  }, [session.id, recap.refresh, onRegisterRecap])

  // Note: we used to poll /sessions/:id 500ms after every SDK message to
  // keep the header badges fresh. That added O(messages × sessions) HTTP
  // requests on top of the WebSocket streams, and with three panels open it was
  // enough to saturate the browser's HTTP/1.1 connection pool. Model /
  // permissionMode only change via user actions (which already update
  // session state), and `working` is now derived from the message stream
  // itself (result messages clear it) — so no background poll is needed.

  return (
    <div className="chat">
      {headerButtonsRef && createPortal(
        <>
          <button
            className="chat-panel-header-btn"
            onClick={(e) => { e.stopPropagation(); setSearchOpen(true) }}
            onMouseDown={(e) => e.stopPropagation()}
            title="Search messages (Ctrl+F)"
            aria-label="Search messages"
          >
            🔍
          </button>
          <button
            className="chat-panel-header-btn"
            onClick={(e) => {
              e.stopPropagation()
              const rect = (e.currentTarget as HTMLButtonElement).getBoundingClientRect()
              setExportMenuPos({ x: rect.left, y: rect.bottom + 4 })
            }}
            onMouseDown={(e) => e.stopPropagation()}
            title="Export conversation"
            aria-label="Export conversation"
          >
            📥
          </button>
        </>,
        headerButtonsRef,
      )}

      {exportMenuPos && (
        <ContextMenu
          x={exportMenuPos.x}
          y={exportMenuPos.y}
          onClose={() => setExportMenuPos(null)}
          items={[
            {
              label: 'Export as Markdown',
              icon: '📄',
              onClick: () => exportConversation(stream.messages, session.title ?? session.id.slice(0, 8)),
            },
            {
              label: 'Export as JSON',
              icon: '{}',
              onClick: () => exportConversationJson(stream.messages, session.title ?? session.id.slice(0, 8)),
            },
          ]}
        />
      )}

      <MessageSearch
        key={searchOpen ? 'search-open' : undefined}
        open={searchOpen}
        onClose={() => {
          setSearchOpen(false)
          setSearchQuery('')
        }}
        onNavigate={handleSearchNavigate}
        totalResults={searchMatches.length}
        onQueryChange={setSearchQuery}
        activeIndex={searchActiveIdx}
      />

        <MessageList
        items={itemsWithRecap}
        showSystemEvents={showSystemEvents}
        pendingInterruptRef={pendingInterruptRef}
        replayReady={stream.replayReady}
        streamingContent={stream.streamingContent}
        onRefreshRecap={recap.refresh}
        planStatus={stream.planStatus}
        searchQuery={searchOpen ? debouncedQuery : ''}
        searchActiveMsgIdx={searchMatches[searchActiveIdx] ?? -1}
      />

      <TodoChecklist messages={stream.messages} working={session.working} />

      {error && <div className="error-bar">{error}</div>}

      {/* The queue bar is only interesting when the user has queued extra
          turns on top of the one currently running — a single pending
          turn is already covered by the thinking bubble in the
          transcript. Show it once queuedAhead > 1. */}
      {session.working && stream.queuedAhead > 1 && (
        <div className="queue-bar">
          <span>
            ⏳ {stream.queuedAhead - 1} more message{stream.queuedAhead - 1 === 1 ? '' : 's'} queued, will send automatically.
          </span>
        </div>
      )}

      {session.working && (
        <WorkingBubble
          startedAt={session.workingSince}
          activeSubagents={stream.activeSubagents}
          tokenRate={stream.tokenRate}
          activePhase={stream.activePhase}
        />
      )}

      <ContextBar usage={stream.contextUsage} />

      <Composer
        input={input}
        setInput={setInput}
        sending={sending}
        disabled={session.terminated}
        terminated={session.terminated}
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
        commands={commands}
        pastedImages={pastedImages.images}
        onPasteImage={pastedImages.addImage}
        onRemovePastedImage={pastedImages.removeImage}
        onSend={() => void send()}
        onInterrupt={() => void interrupt()}
        canInterrupt={session.working}
        focusSignal={composerFocusSignal}
      />

      {/* Pending permission dialogs + recently-answered question cards
          that linger for a few seconds so the user sees their answer. */}
      {(() => {
        // Active pending question — show the interactive dialog.
        const pendingHead = permissions.pending[0]
        if (pendingHead?.kind === 'question') {
          return (
            <QuestionDialog
              key={pendingHead.id}
              request={pendingHead}
              onSubmit={(answers) => {
                addAnsweredQuestion(pendingHead.id, pendingHead, answers)
                void permissions.answerQuestion(pendingHead.id, answers)
              }}
              onSkipAll={() => {
                addAnsweredQuestion(
                  pendingHead.id,
                  pendingHead,
                  pendingHead.questions.map(() => null),
                )
                void permissions.answerQuestion(
                  pendingHead.id,
                  pendingHead.questions.map(() => null),
                )
              }}
            />
          )
        }

        // Recently-answered question card (stays for 3s showing the answer).
        const answeredEntries = Array.from(answeredQuestions.values())
        if (answeredEntries.length > 0) {
          const entry = answeredEntries[answeredEntries.length - 1]
          return (
            <QuestionDialog
              key={`answered:${entry.request.id}`}
              request={entry.request}
              onSubmit={() => {}}
              onSkipAll={() => {}}
              initialAnswers={entry.answers}
            />
          )
        }

        // Pending tool permission (not a question).
        if (pendingHead?.kind === 'permission') {
          return (
            <PermissionDialog
              key={pendingHead.id}
              request={pendingHead}
              onDecide={(d) => void permissions.decide(pendingHead.id, d)}
            />
          )
        }

        return null
      })()}

      {settingsOpen && (
        <div
          className="settings-overlay"
          role="dialog"
          aria-modal="false"
          aria-label="Session settings"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) onCloseSettings?.()
          }}
        >
          <SettingsPanel
            key={session.id}
            session={session}
            onClose={() => onCloseSettings?.()}
            onSessionUpdate={onSessionUpdate}
          />
        </div>
      )}
    </div>
  )
}
