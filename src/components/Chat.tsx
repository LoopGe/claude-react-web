// Chat panel — orchestrates the stream, attachments, permissions, and
// renders the message list + composer. Side-effect hooks live in their
// own files; this module only wires things together.
//
// IMPORTANT: the parent MUST render this with `<Chat key={session.id} />`
// so React re-mounts the component on session switch. We rely on that
// instead of explicitly resetting state in an effect, which React 19's
// new rules flag as a cascading-render hazard. Re-mount is cheap because
// the sessions themselves are long-lived on the server.

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useDebouncedValue } from '../hooks/useDebouncedValue'
import { createPortal } from 'react-dom'
import { SettingsPanel } from './SettingsPanel'
import { GitPanel } from './GitPanel'
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
import { PromptDialog } from './PromptDialog'
import { QuestionDialog } from './QuestionDialog'
import { SnippetsManagerDialog } from './SnippetsManagerDialog'
import { SubagentOverlay } from './SubagentOverlay'
import { SubagentProvider } from '../hooks/useSubagentContext'
import { TodoChecklist } from './TodoChecklist'
import { useComposerSnippets } from '../hooks/useComposerSnippets'
import { useSessionRecap } from '../hooks/useSessionRecap'
import { MessageSearch } from './MessageSearch'
import { countMatches } from '../search'
import { ContextMenu } from './ContextMenu'
import { exportConversation, exportConversationJson } from '../utils/exportConversation'
import { IconSearch, IconDownload, IconClock } from './icons/ToolIcons'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { useToast } from '../hooks/useToast'
import type { AgentInfo, PermissionRequest, SessionInfo, SlashCommand } from '../types'
import type { GitStatusResponse } from '../../shared/git-types'


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
  /** When true, render the Git overlay. Receives git state already
   *  fetched by the parent ChatPanel so we don't double-fetch the same
   *  status the chip is consuming. */
  gitPanelOpen?: boolean
  onCloseGitPanel?: () => void
  gitStatus?: GitStatusResponse | null
  gitLoading?: boolean
  gitError?: string | null
  onGitRefresh?: () => void
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

export const Chat = memo(function Chat({
  session, showSystemEvents,
  settingsOpen, onCloseSettings,
  gitPanelOpen, onCloseGitPanel, gitStatus, gitLoading, gitError, onGitRefresh,
  onSessionUpdate, focused, onLiveMessageCount, onRegisterInterrupt, onRegisterRecap, headerButtonsRef,
}: Props) {
  // Lazy init reads the persisted draft for THIS session from sessionStorage.
  // The parent remounts Chat on session switch (<Chat key={session.id}>), so
  // this initializer runs exactly once per mount — the right place to hydrate.
  const [input, setInputState] = useState(() => readDraft(session.id))
  const [sending, setSending] = useState(false)
  // Synchronous reentrancy guard. setSending is async — between two
  // rapid keypresses (e.g. Enter pressed twice within one frame), React
  // hasn't committed the state update yet, so the closure inside send()
  // sees `sending === false` both times and POSTs twice. The ref flips
  // synchronously so the second call short-circuits immediately. Same
  // pattern PermissionDialog uses for its busy guard.
  const sendingRef = useRef(false)
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

  // Agents — fetched once per session, refreshed after plugin reload.
  const [agents, setAgents] = useState<AgentInfo[]>([])
  useEffect(() => {
    if (!session.running) return
    let cancelled = false
    api
      .get<{ agents: AgentInfo[] }>(`/sessions/${session.id}/agents`)
      .then((res) => { if (!cancelled) setAgents(res.agents ?? []) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [session.id, session.running])

  /** Invalidate command cache and re-fetch (called after plugin reload). */
  const refreshCommands = useCallback(() => {
    commandsCacheRef.current.delete(session.id)
    if (!session.running) return
    api
      .get<{ commands: SlashCommand[] }>(`/sessions/${session.id}/commands`)
      .then((res) => {
        const cmds = res.commands ?? []
        commandsCacheRef.current.set(session.id, cmds)
        setCommands(cmds)
      })
      .catch(() => {})
  }, [session.id, session.running])

  /** Re-fetch agents list (called after plugin reload). */
  const refreshAgents = useCallback(() => {
    if (!session.running) return
    api
      .get<{ agents: AgentInfo[] }>(`/sessions/${session.id}/agents`)
      .then((res) => setAgents(res.agents ?? []))
      .catch(() => {})
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

  // ── Subagent overlay state ────────────────────────────────
  // Stack of toolUseIds: empty = closed; otherwise the last entry is the
  // currently-shown subagent. Pushed when the user clicks a SubagentCard
  // (either in the main transcript or inside the overlay itself, for
  // nested drill-down). Popped on the back button; cleared on close.
  const [subagentStack, setSubagentStack] = useState<string[]>([])
  const openSubagent = useCallback((toolUseId: string) => {
    setSubagentStack((prev) => {
      // Don't push the same id twice in a row (idempotent open).
      if (prev[prev.length - 1] === toolUseId) return prev
      return [...prev, toolUseId]
    })
  }, [])
  const popSubagent = useCallback(() => {
    setSubagentStack((prev) => prev.slice(0, -1))
  }, [])
  const closeSubagent = useCallback(() => setSubagentStack([]), [])
  // Memoize the provider value so SubagentCard's `memo()` survives
  // unrelated Chat re-renders. Both providers below share this object.
  const subagentCtxValue = useMemo(
    () => ({ index: stream.subagentIndex, messages: stream.messages, open: openSubagent }),
    [stream.subagentIndex, stream.messages, openSubagent],
  )

  // ── In-chat search ──────────────────────────────────────────
  const [searchOpen, setSearchOpen] = useState(false)
  const [exportMenuPos, setExportMenuPos] = useState<{ x: number; y: number } | null>(null)
  // Export-success feedback now goes through the global toast hub.
  const toast = useToast()
  const [searchQuery, setSearchQuery] = useState('')
  const debouncedQuery = useDebouncedValue(searchQuery, 200)
  const [searchActiveIdx, setSearchActiveIdx] = useState(0)
  /** Flat list of text-level matches across the transcript. Each entry
   *  records the transcript item it lives in plus its local index
   *  within that item (0-based, so the third "foo" inside item #5 is
   *  `{ itemIdx: 5, matchInItem: 2 }`). The array length is the total
   *  hit count shown in the search bar.
   *
   *  We carry the per-item index alongside the global one so the
   *  active-mark highlighter can colour the precise `<mark>` the user
   *  is currently on — without it, "next match" jumps inside the same
   *  message would be invisible (same outline, no scroll change).
   *
   *  Matching uses the canonical `plainText` field — same view the
   *  rehype highlighter reconstructs at render time, so the counter
   *  and the visible <mark>s describe the same text. */
  const searchMatches = useMemo(() => {
    if (!debouncedQuery) return [] as Array<{ itemIdx: number; matchInItem: number }>
    const out: Array<{ itemIdx: number; matchInItem: number }> = []
    for (let i = 0; i < stream.items.length; i++) {
      const text = stream.items[i]?.plainText
      if (!text) continue
      const n = countMatches(text, debouncedQuery)
      for (let k = 0; k < n; k++) out.push({ itemIdx: i, matchInItem: k })
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

  // Session recap — phase-driven auto-generation. The hook reads
  // session.phase + session.lastTurnAt + session.recap (all kept current
  // by App-level WS frames) and schedules a single POST /recap when the
  // session has been idle for IDLE_THRESHOLD_MS with no fresh recap
  // covering it. The recap object lives on session.recap (broadcast via
  // session-recap-update / session-update); we render it via
  // <MessageList recap={session.recap}> below.
  const recap = useSessionRecap(session)

  // Composer snippets — owned at this (panel) level so the manager and
  // save-prompt dialogs can render as siblings of settings-overlay /
  // git-overlay. When mounted inside <Composer>, .perm-overlay anchored
  // to .chat-composer's tiny strip and the dialogs were unusable.
  // The hook persists to localStorage and syncs across instances, so
  // calling it once here gives every panel a consistent view.
  const snippets = useComposerSnippets()
  const [showSnippetsManager, setShowSnippetsManager] = useState(false)
  /** Set when the user clicked "Save current input as snippet…". Holds
   *  the textarea snapshot so future edits don't mutate the captured
   *  content before the user confirms a label. */
  const [pendingSnippetSave, setPendingSnippetSave] = useState<{ content: string } | null>(null)
  const handleOpenSnippetsManager = useCallback(() => setShowSnippetsManager(true), [])
  const handleSaveCurrentAsSnippet = useCallback(
    (content: string) => setPendingSnippetSave({ content }),
    [],
  )

  // Track questions that have been answered but whose dialog should stay
  // visible (showing the answer inline) for a few seconds before closing.
  // The permission is already resolved server-side; this just controls
  // how long the "answer sent" card remains on screen.
  const [answeredQuestions, setAnsweredQuestions] = useState<Map<string, { request: Extract<PermissionRequest, { kind: 'question' }>; answers: Array<string | string[] | null> }>>(() => new Map())
  // Track pending dismiss timeouts so they can be cleaned up on unmount.
  const pendingDismissTimers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set())
  useEffect(() => () => {
    for (const id of pendingDismissTimers.current) clearTimeout(id)
  }, [])
  const addAnsweredQuestion = useCallback((id: string, request: Extract<PermissionRequest, { kind: 'question' }>, answers: Array<string | string[] | null>) => {
    setAnsweredQuestions((prev) => {
      const next = new Map(prev)
      next.set(id, { request, answers })
      return next
    })
    const timerId = setTimeout(() => {
      pendingDismissTimers.current.delete(timerId)
      setAnsweredQuestions((prev) => {
        const next = new Map(prev)
        next.delete(id)
        return next
      })
    }, 3000)
    pendingDismissTimers.current.add(timerId)
  }, [])

  // Pull out the specific functions/values we actually use downstream.
  // Putting the whole hook object in a dep list re-creates callbacks every
  // render and can churn child re-renders (the composer's onChange in
  // particular — that's what caused the "can't send / can't type" freeze).
  const { trackSentTurn, insertUserMessage, rollbackUserMessage, clearError: clearStreamError } = stream
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

  const handleUploadFiles = useCallback(
    (files: File[]) => void uploadFiles(files),
    [uploadFiles],
  )

  const send = useCallback(async () => {
    // Synchronous guard FIRST — before any await or React state read,
    // so two rapid Enter presses (within one frame) can't both pass.
    if (sendingRef.current) return
    const text = input.trim()
    // Allow sending with just attachments (e.g. "here, look at these files")
    // — the model sees only the attachments preamble in that case.
    if (!text && attachmentList.length === 0 && pastedImages.images.length === 0) return
    sendingRef.current = true
    setSending(true)
    clearError()
    const preamble =
      attachmentList.length > 0
        ? `Attached file${attachmentList.length === 1 ? '' : 's'} (absolute path${attachmentList.length === 1 ? '' : 's'} — use the Read tool to open):\n` +
          attachmentList.map((a) => `- ${a.path}`).join('\n') +
          '\n\n'
        : ''
    const full = preamble + text

    // Insert the optimistic placeholder BEFORE the POST. The server
    // broadcasts the same user message back over WS the moment send/
    // sendContent runs, so by the time the POST resolves the broadcast
    // is already on its way. With this ordering the broadcast lands on
    // an existing pendingUserMessageId and reducer.applyMessage replaces
    // the placeholder by id — which works regardless of content shape
    // (multimodal arrays included). Previously the optimistic insert
    // ran AFTER await, so the broadcast arrived first and the dedup
    // (which compares content with ===) failed for image arrays,
    // leaving two "you" bubbles in the transcript.
    const pendingId = full.trim() ? insertUserMessage(full) : null

    try {
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
      // Roll back the optimistic placeholder so the user sees that the
      // send failed (text stays in the input, transcript stays clean).
      if (pendingId) rollbackUserMessage(pendingId)
    } finally {
      sendingRef.current = false
      setSending(false)
    }
  }, [input, attachmentList, session.id, history, trackSentTurn, insertUserMessage, rollbackUserMessage, clearAttachments, clearError, setInput, pastedImages])

  // Set to true when interrupt() fires; the next `result` message renders
  // as "interrupted" and resets this to false.
  const pendingInterruptRef = useRef(false)
  // Focus traps for the two in-panel overlays. The settings overlay is
  // always mounted (toggled via CSS .hidden), so the trap is gated on
  // `settingsOpen`; the git overlay only mounts when open. `active`
  // arms/disarms the trap and restores focus to the trigger on close.
  const settingsOverlayRef = useRef<HTMLDivElement>(null)
  const gitOverlayRef = useRef<HTMLDivElement>(null)
  useFocusTrap(settingsOverlayRef, { restoreFocus: true, active: !!settingsOpen })
  useFocusTrap(gitOverlayRef, { restoreFocus: true, active: !!gitPanelOpen })

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

  // Stable wrappers so Composer's React.memo isn't defeated by inline arrows.
  const handleSend = useCallback(() => void send(), [send])
  const handleInterrupt = useCallback(() => void interrupt(), [interrupt])

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
            <IconSearch size={16} />
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
            <IconDownload size={16} />
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
              onClick: () => {
                exportConversation(stream.messages, session.title ?? session.id.slice(0, 8))
                toast.success('Exported as Markdown')
              },
            },
            {
              label: 'Export as JSON',
              icon: '{}',
              onClick: () => {
                exportConversationJson(stream.messages, session.title ?? session.id.slice(0, 8))
                toast.success('Exported as JSON')
              },
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

      <SubagentProvider value={subagentCtxValue}>
        <MessageList
          items={stream.items}
          recap={session.recap}
          showSystemEvents={showSystemEvents}
          pendingInterruptRef={pendingInterruptRef}
          replayReady={stream.replayReady}
          streamingContent={stream.streamingContent}
          planStatus={stream.planStatus}
          planContent={stream.planContent}
          questionAnswers={stream.questionAnswers}
          toolStatus={stream.toolStatus}
          searchQuery={searchOpen ? debouncedQuery : ''}
          searchActiveMsgIdx={searchMatches[searchActiveIdx]?.itemIdx ?? -1}
          searchActiveMatchInItem={searchMatches[searchActiveIdx]?.matchInItem ?? -1}
          loadOlder={stream.loadOlder}
          hasOlder={stream.hasOlder}
          loadingOlder={stream.loadingOlder}
        />
      </SubagentProvider>

      <TodoChecklist messages={stream.messages} working={session.working} />

      {/* Always-mounted live region — see `.error-bar-empty` in styles.css.
          Keeping the region in the DOM (just visually hidden when empty)
          guarantees a screen reader announces the content mutation when an
          error arrives, instead of relying on the SR to notice that a
          fresh role="alert" element appeared with text already inside. */}
      <div
        className={`error-bar${error ? '' : ' error-bar-empty'}`}
        role="alert"
        aria-live="polite"
      >
        {error ?? ''}
      </div>
      {/* The queue bar is only interesting when the user has queued extra
          turns on top of the one currently running — a single pending
          turn is already covered by the thinking bubble in the
          transcript. Show it once queuedAhead > 1. */}
      {session.working && stream.queuedAhead > 1 && (
        <div className="queue-bar" role="status" aria-live="polite">
          <IconClock size={14} aria-hidden />
          <span>
            {stream.queuedAhead - 1} more message{stream.queuedAhead - 1 === 1 ? '' : 's'} queued, will send automatically.
          </span>
        </div>
      )}

      {session.working && (
        <WorkingBubble
          startedAt={session.workingSince}
          activeSubagents={stream.activeSubagents}
          tokenRate={stream.tokenRate}
          activePhase={stream.activePhase}
          onOpenSubagent={openSubagent}
        />
      )}

      <ContextBar usage={stream.contextUsage} />

      <Composer
        input={input}
        setInput={setInput}
        sending={sending}
        disabled={session.terminated}
        terminated={session.terminated}
        terminatedReason={session.terminatedReason}
        canAttach={!!session.cwd}
        attachments={attachments.attachments}
        uploading={attachments.uploading}
        dragOver={attachments.dragOver}
        onUploadFiles={handleUploadFiles}
        onRemoveAttachment={attachments.removeAttachment}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        history={history}
        commands={commands}
        pastedImages={pastedImages.images}
        onPasteImage={pastedImages.addImage}
        onRemovePastedImage={pastedImages.removeImage}
        onSend={handleSend}
        onInterrupt={handleInterrupt}
        canInterrupt={session.working}
        focusSignal={composerFocusSignal}
        onRecap={recap.refresh}
        canRecap={!!session.lastTurnAt}
        snippets={snippets}
        onOpenSnippetsManager={handleOpenSnippetsManager}
        onSaveCurrentAsSnippet={handleSaveCurrentAsSnippet}
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
              planContentMap={stream.planContent}
            />
          )
        }

        return null
      })()}

      <div
        ref={settingsOverlayRef}
        className={`settings-overlay${settingsOpen ? '' : ' hidden'}`}
        role="dialog"
        aria-modal={settingsOpen ? 'true' : 'false'}
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
          commands={commands}
          agents={agents}
          onPluginsReloaded={() => { refreshCommands(); refreshAgents() }}
        />
      </div>

      {gitPanelOpen && (
        <div
          ref={gitOverlayRef}
          className="git-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Git"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) onCloseGitPanel?.()
          }}
        >
          <GitPanel
            key={session.id}
            sessionId={session.id}
            cwd={session.cwd}
            status={gitStatus ?? null}
            loading={gitLoading ?? false}
            error={gitError ?? null}
            onRefresh={() => onGitRefresh?.()}
            onClose={() => onCloseGitPanel?.()}
          />
        </div>
      )}

      {subagentStack.length > 0 && (
        <SubagentProvider value={subagentCtxValue}>
          <SubagentOverlay
            stack={subagentStack}
            items={stream.items}
            index={stream.subagentIndex}
            onClose={closeSubagent}
            onPop={popSubagent}
            showSystemEvents={showSystemEvents}
          />
        </SubagentProvider>
      )}

      {/* Snippet dialogs render as panel-level overlays. They use
          .perm-overlay (position: absolute; inset: 0) which now anchors
          to .chat (position: relative) instead of the tiny .chat-composer
          strip — so they cover the whole panel like settings/git. */}
      {pendingSnippetSave && (
        <PromptDialog
          title="Save snippet"
          message={
            <>
              <p>Pick a label for this snippet. The current composer text will be saved as its content.</p>
              <pre className="snippet-save-preview">{pendingSnippetSave.content}</pre>
            </>
          }
          defaultValue=""
          confirmLabel="Save"
          placeholder="Snippet label"
          onConfirm={(label) => {
            snippets.add(label, pendingSnippetSave.content)
            setPendingSnippetSave(null)
          }}
          onCancel={() => setPendingSnippetSave(null)}
        />
      )}

      {showSnippetsManager && (
        <SnippetsManagerDialog
          api={snippets}
          onClose={() => setShowSnippetsManager(false)}
        />
      )}
    </div>
  )
})
