// Chat panel ?orchestrates the stream, attachments, permissions, and
// renders the message list + composer. Side-effect hooks live in their
// own files; this module only wires things together.
//
// IMPORTANT: the parent MUST render this with `<Chat key={session.id} />`
// so React re-mounts the component on session switch. We rely on that
// instead of explicitly resetting state in an effect, which React 19's
// new rules flag as a cascading-render hazard. Re-mount is cheap because
// the sessions themselves are long-lived on the server.

import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { useDebouncedValue } from '../hooks/useDebouncedValue'
// SettingsPanel and GitPanel are split into their own chunks: both are
// per-panel overlays that many sessions never open, so keeping them out of
// the main bundle shrinks first paint. SettingsPanel stays mounted once
// opened (CSS-hidden when closed) to preserve its internal state, so we
// gate its first mount on `settingsEverOpened` rather than `settingsOpen`.
const SettingsPanel = lazy(() => import('./SettingsPanel').then((m) => ({ default: m.SettingsPanel })))
const GitPanel = lazy(() => import('./GitPanel').then((m) => ({ default: m.GitPanel })))
// ResumeSessionDialog is also a per-panel overlay (its 'panel' variant,
// rendered here) — lazy so the picker code stays out of the main bundle for
// sessions that never resume via the keyboard shortcut / `/resume`.
const ResumeSessionDialog = lazy(() =>
  import('./session-list/ResumeSessionDialog').then((m) => ({ default: m.ResumeSessionDialog })),
)
// InputHistoryPanel is a per-panel overlay (Mod+Shift+H) — lazy so the
// history browser code stays out of the main bundle for sessions that never
// open it.
const InputHistoryPanel = lazy(() =>
  import('./InputHistoryPanel').then((m) => ({ default: m.InputHistoryPanel })),
)
import { RecapWindow } from './RecapWindow'
import { PinnedUserMessage } from './PinnedUserMessage'
import { api } from '../hooks/useApi'
import { useAttachments } from '../hooks/useAttachments'
import { useChatStream } from '../hooks/useChatStream'
import { usePastedImages } from '../hooks/usePastedImages'
import { useInputHistory } from '../hooks/useInputHistory'
import { usePermissionChannel } from '../hooks/usePermissionChannel'
import { useElicitationChannel } from '../hooks/useElicitationChannel'
import { usePhaseDwell } from '../hooks/usePhaseDwell'
import { Composer } from './Composer'
import { ContextBar } from './ContextBar'
import { MessageList, WorkingBubble, type ScrollNavigator } from './MessageList'
import { PermissionDialog } from './PermissionDialog'
import { QuestionDialog, type QuestionDraft } from './QuestionDialog'
import { ElicitationDialog } from './ElicitationDialog'
import { SubagentOverlay } from './SubagentOverlay'
import { SubagentProvider } from '../hooks/useSubagentContext'
import { WorkflowOverlay } from './WorkflowOverlay'
import { WorkflowProvider } from '../hooks/useWorkflowContext'
import { ReopenQuestionProvider } from '../hooks/useReopenQuestion'
import { useMinimizedSet } from '../hooks/useMinimizedSet'
import { TodoChecklist } from './TodoChecklist'
import { MonitorBar } from './MonitorBar'
import type { ComposerSnippetsApi } from '../hooks/useComposerSnippets'
import { useSessionRecap } from '../hooks/useSessionRecap'
import { MessageSearch } from './MessageSearch'
import { countMatches } from '../search'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'
import { ConfirmDialog } from './ConfirmDialog'
import { exportConversation, exportConversationJson } from '../utils/exportConversation'
import { useAllContributions } from '../app-plugins/PluginRegistryProvider'
import { usePluginCommands } from '../app-plugins/usePluginCommands'
import { buildWhenContext, filterContributions } from '../app-plugins/when'
import { IconSearch, IconFileText, IconFileCode, IconX, IconCopy, IconSettings, IconArrowUp, IconArrowDown, IconMessageCircle, IconArrowLeft, IconTrash, IconGlobe, IconScissors } from './icons/ToolIcons'
import { PLAN_TOOL_NAMES } from '../constants/toolNames'
import { useOverlayScrollbar } from '../hooks/useOverlayScrollbar'
import { useToast } from '../hooks/useToast'
import { Overlay } from './Overlay'
import { useWsHub } from '../hooks/useWsHub'
import { useExitPresence, usePresenceValue } from '../hooks/useExitPresence'
import { AnimatePresence } from 'motion/react'
import type { AgentInfo, PermissionRequest, SessionInfo, SlashCommand } from '../types'
import type { Skin } from '../utils/theme'
import type { GitStatusResponse } from '../../shared/git-types'
import type { MessageJumpTarget } from '../../shared/message-jump'
import { LOCAL_COMMANDS, matchLocalCommand } from '../local-commands'
import type { SettingsTabName } from '../local-commands'


const DRAFT_KEY_PREFIX = 'claude-react-web:draft:'

// Module-level predicates for the three minimize/reopen sets (questions,
// plan-permissions, non-plan permissions). Stable identity so useMinimizedSet
// can take them as deps without re-binding callbacks/memos on every render.
const isQuestion = (p: PermissionRequest): boolean => p.kind === 'question'
const isPlanPermission = (p: PermissionRequest): boolean =>
  p.kind === 'permission' && PLAN_TOOL_NAMES.has(p.toolName)
const isNonPlanPermission = (p: PermissionRequest): boolean =>
  p.kind === 'permission' && !PLAN_TOOL_NAMES.has(p.toolName)

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
    /* quota or SecurityError ?drafts are best-effort */
  }
}

interface Props {
  session: SessionInfo
  /** Reserved for future push updates ?currently unused because session
   *  state is tracked via the WebSocket hub + top-level session list poll. */
  onSessionUpdate: (s: SessionInfo) => void
  /** Resume a terminated-but-recoverable session in place (the composer's
   *  choice-banner Resume button). */
  onResume?: (sessionId: string) => void
  /** Fork a terminated session from its last completed turn (the composer's
   *  choice-banner "Fork from last completed turn" button). */
  onForkFromLastCompleted?: (sessionId: string) => void
  /** Open the resume picker scope to this panel — the chosen session
   *  replaces this panel's slot. Invoked by the `/resume` local command. */
  onRequestResumeForPanel: (panelSessionId: string) => void
  /** When true, render the resume picker as an in-panel overlay (column-
   *  scoped, mirroring Settings/Git) instead of the App-root modal. The
   *  chosen session replaces THIS panel's slot. */
  resumeOpen?: boolean
  /** Resume the picked session INTO this panel. Passed this panel's session
   *  id so the callback in App knows which slot to replace. */
  onResumeIntoPanel?: (pickedId: string, panelSessionId: string) => void
  /** Close the in-panel resume overlay (Esc / backdrop / cancel). */
  onCloseResume?: () => void
  /** Open this panel's settings overlay on a specific tab. Invoked by the
   *  `/mcp` local command. */
  onOpenSettingsTab: (panelSessionId: string, tab: SettingsTabName) => void
  /** Open the in-app help dialog with the given slash commands. Invoked by
   *  the `/help` local command. */
  onShowHelp: (commands: SlashCommand[]) => void
  /** `/clear` this panel. App owns the POST + panel id-swap (the server
   *  detaches the pre-clear conversation and returns a fresh session under a
   *  new id). Invoked by the `/clear` local command. */
  onClearSession: (panelSessionId: string) => void
  /** Nonce-stamped request to switch the settings tab ?forwarded to
   *  SettingsPanel, which applies it when the nonce changes. */
  settingsTabRequest?: { tab: SettingsTabName; nonce: number } | null
  messageJumpTarget?: MessageJumpTarget | null
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
  /** When true, render the floating Recap window at the top of the chat
   *  area. Owned by ChatPanel (which also renders the reopen button in the
   *  header); Chat just renders the window and calls onCloseRecap when the
   *  user clicks X. */
  recapOpen?: boolean
  onCloseRecap?: () => void
  /** Whether this panel is the currently focused (active) one. Used by
   *  useSessionRecap to track last-viewed timestamps. */
  focused?: boolean
  /** External composer-focus signal from App — bumped by the mod+1/2/3
   *  slot shortcuts. Combined with the local composerFocusSignal so the
   *  target panel's <Composer> refocuses after a slot switch. */
  composerFocusSignal?: number
  /** Global UI-pref defaults (server-backed). Effective values are
   *  `session.<field> ?? globalPrefs.<field>` — a per-session override
   *  wins, otherwise the global default applies. Forwarded to
   *  <SettingsPanel> for the override UI. */
  globalPrefs: { showPinnedUserMessage: boolean; autoRecap: boolean }
  /** True while App is playing the /clear fade-in on this panel. Combined
   *  with the local `clearing` state (which serves the SDK in-band cleared
   *  path) via `effectiveClearing = clearingProp || localClearing`. */
  clearing?: boolean
  /** Called once on mount so the parent can store a reference to this
   *  panel's interrupt() function. Enables the ESC shortcut in App to
   *  trigger the same code-path as the Composer's interrupt button. */
  onRegisterInterrupt?: (sessionId: string, fn: () => void) => () => void
  /** Called once on mount so the parent can store a reference to this
   *  panel's recap.refresh() function. Enables the Alt+R shortcut in App. */
  onRegisterRecap?: (sessionId: string, fn: () => void) => () => void
  /** When true, render the input-history browser as an in-panel overlay
   *  (Mod+Shift+H), scoped to this panel. App gates this on the focused panel
   *  so only one panel shows it at a time. */
  historyOpen?: boolean
  /** Close the in-panel input-history overlay (Esc / backdrop / select). */
  onCloseHistory?: () => void
  /** Global composer-snippets api (single shared instance owned by App).
   *  Passed straight to <Composer>; the manager + save dialogs live in App. */
  snippets: ComposerSnippetsApi
  onOpenSnippetsManager: () => void
  onSaveCurrentAsSnippet: (content: string) => void
  /** Close this panel (session stays alive). Forwarded from ChatPanel so the
   *  message-area context menu can offer a "Close panel" item now that the
   *  header X button is gone. */
  onClosePanel?: (sessionId: string) => void
  /** Delete the session entirely (App.handleDelete — exit animation +
   *  Undo grace window). Offered as a "Delete session" item in the panel
   *  context menu, mirroring the sidebar's. */
  onDelete?: (sessionId: string) => void
  /** Request a confirmation dialog (rendered by ChatPanel) before a
   *  destructive action. Mirrors SessionList's onAskConfirm so the panel
   *  menu's Delete uses the same confirm UX as the sidebar's. The optional
   *  checkbox fields render a controlled checkbox below the message (used
   *  by "discard from here" for the "permanently delete" toggle). */
  onAskConfirm?: (config: {
    title: string
    message: React.ReactNode
    confirmLabel: string
    destructive?: boolean
    checkboxLabel?: string
    checkboxChecked?: boolean
    onCheckboxChange?: (checked: boolean) => void
    onConfirm: () => void | Promise<void>
  }) => void
  /** Discard every message after a given assistant message (fork-from-
   *  anchor + panel swap). `deleteOriginal` also unlinks the source
   *  transcript. Driven by the right-click "discard from here" menu item.
   *  Returns a promise so the caller's confirm dialog can await it and
   *  close (or un-busy) on completion — on success the Chat unmounts (id
   *  swap) so the resolution is a no-op; on failure the dialog reopens. */
  onDiscard?: (sessionId: string, fromAssistantUuid: string, deleteOriginal: boolean) => Promise<void> | void
  /** Owning group name, or undefined when ungrouped. Relabels the close
   *  menu item to "Remove from <group>" since closing a group member
   *  removes it from the group (App.closeSession). */
  groupLabel?: string
  /** Deactivate this session's group — close every open panel in the group
   *  while preserving membership (App.closeGroupPanels). Shown in the panel
   *  context menu as "Close all panels in <group>", only for grouped
   *  sessions. */
  onCloseGroupPanels?: () => void
  /** Open this panel's settings overlay. Forwarded from ChatPanel so the
   *  message-area context menu can offer a "Settings" item now that the
   *  header gear button is gone. */
  onOpenSettingsPanel?: (sessionId: string) => void
  /** Create a Side Chat from this session. */
  onSideChat?: (sessionId: string) => void
  /** Side Chat collapsed state — for rendering the expand tab. */
  sideChatCollapsed?: boolean
  /** Whether the (collapsed) Side Chat is currently processing a turn.
   *  Drives a small pulsing dot on the expand tab so users can spot
   *  background activity without re-expanding. */
  sideChatWorking?: boolean
  /** Toggle Side Chat expanded/collapsed. */
  onToggleCollapseSideChat?: () => void
  /** Active skin, forwarded to <TodoChecklist> so its pending / in-progress
   *  markers can switch to square checkboxes under the High-Contrast skin. */
  skin?: Skin
}

interface SendMessageResponse {
  ok: boolean
  message?: {
    uuid?: string
    receivedAt?: number
  }
}

/** Safety net for the optimistic turn bridge: if a POST resolves but neither
 *  `session.working` nor a stream phase ever arrives (a hung turn), clear the
 *  bridge so the WorkingBubble can't stick forever. Far above the real
 *  send→confirm latency (sub-second); it only ever applies to that window. */
const PENDING_TURN_SAFETY_MS = 30_000

export const Chat = memo(function Chat({
  session,
  clearing: clearingProp,
  settingsOpen, onCloseSettings,
  gitPanelOpen, onCloseGitPanel, gitStatus, gitLoading, gitError, onGitRefresh,
  recapOpen, onCloseRecap,
  onSessionUpdate, onRequestResumeForPanel, resumeOpen, onResumeIntoPanel, onCloseResume, onOpenSettingsTab, onShowHelp, onClearSession, settingsTabRequest, messageJumpTarget, focused, composerFocusSignal: externalComposerFocusSignal, globalPrefs, onRegisterInterrupt, onRegisterRecap, historyOpen, onCloseHistory,
  onResume, onForkFromLastCompleted,
  snippets, onOpenSnippetsManager, onSaveCurrentAsSnippet, onClosePanel, onDelete, onAskConfirm, onDiscard, groupLabel, onCloseGroupPanels, onOpenSettingsPanel, onSideChat,
  sideChatCollapsed, sideChatWorking, onToggleCollapseSideChat, skin,
}: Props) {
  // Lazy init reads the persisted draft for THIS session from sessionStorage.
  // The parent remounts Chat on session switch (<Chat key={session.id}>), so
  // this initializer runs exactly once per mount — the right place to hydrate.
  const [input, setInputState] = useState(() => readDraft(session.id))
  const [sending, setSending] = useState(false)
  // SettingsPanel is kept mounted (CSS-hidden) once shown so its internal
  // state survives close/reopen. We defer its first mount — and thus its
  // lazy chunk download — until the user first opens it. Latches true and
  // never resets for the lifetime of this Chat mount. Stored as state
  // (not a ref) so the write during render goes through React's normal
  // scheduling; a ref would break `react-hooks/refs` and also wouldn't
  // trigger the re-render that reveals the panel on first open.
  const [settingsEverOpened, setSettingsEverOpened] = useState(false)
  if (settingsOpen && !settingsEverOpened) setSettingsEverOpened(true)
  // In-chat search open state. Declared here (rather than in the search
  // section below) because it gates the recap/pinned presence hooks, which
  // hide those overlays while search is open so the search bar isn't covered.
  const [searchOpen, setSearchOpen] = useState(false)
  // Effective UI prefs: a per-session override (session.<field>) wins,
  // otherwise the global default (globalPrefs.<field>, server-backed) applies.
  // Computed inline so a SettingsPanel override or a global-settings save
  // re-renders this panel with the new effective value immediately.
  const effectiveShowPinned = session.showPinnedUserMessage ?? globalPrefs.showPinnedUserMessage
  const effectiveAutoRecap = session.autoRecap ?? globalPrefs.autoRecap
  // Pinned "current question" header — the user message of the turn in view,
  // shown when it has scrolled above the viewport. `pinnedUserMsg` drives
  // presence (open/exit); `pinnedText` retains the last text through the exit
  // animation so the bar can fade out instead of snapping. Presence is also
  // gated by the effective `showPinnedUserMessage` pref so disabling it fades
  // the bar out.
  const [pinnedUserMsg, setPinnedUserMsg] = useState<{ id: string; text: string } | null>(null)
  const [pinnedText, setPinnedText] = useState('')
  const handlePinnedUserMessageChange = useCallback(
    (info: { id: string; text: string } | null) => {
      if (info) setPinnedText(info.text)
      setPinnedUserMsg(info)
    },
    [],
  )
  // Full list of rendered user messages, lifted from MessageList for the
  // pinned-header dropdown. Dedup is done in MessageList (length+ids), so a
  // setState here only fires when the set genuinely changed.
  const [userMessages, setUserMessages] = useState<{ id: string; text: string; index: number }[]>([])
  const handleUserMessagesChange = useCallback((msgs: { id: string; text: string; index: number }[]) => {
    setUserMessages(msgs)
  }, [])
  // In-panel resume picker (variant="panel"). Only renders when this panel
  // is the resume target; the global / empty-state flow uses the App-root
  // modal instead. Mounted conditionally like the git overlay, so the
  // entrance animation fires on mount.
  const resumePresence = useExitPresence(!!resumeOpen)
  // Mirrors resumePresence: keeps InputHistoryPanel mounted through
  // PanelOverlay's exit animation after historyOpen flips false.
  const historyPresence = useExitPresence(!!historyOpen)
  // Synchronous reentrancy guard. setSending is async ?between two
  // rapid keypresses (e.g. Enter pressed twice within one frame), React
  // hasn't committed the state update yet, so the closure inside send()
  // sees `sending === false` both times and POSTs twice. The ref flips
  // synchronously so the second call short-circuits immediately. Same
  // pattern PermissionDialog uses for its busy guard.
  const sendingRef = useRef(false)
  // Bridges the gap between the optimistic user message (committed
  // synchronously on send) and the server confirming the turn started
  // (`session.working` rises over WS, ~1 frame later even on localhost).
  // Without this bridge the WorkingBubble mounts one frame AFTER the message
  // is painted, shrinking the message-list viewport by ~28px and triggering a
  // scroll snap — the "message jumps down / scrollbar flashes on send" jitter.
  // Holding an optimistic turn flag lets the WorkingBubble mount in the SAME
  // commit as the message, so the viewport is already at its working-size when
  // the message first paints. Stored as the start timestamp so the elapsed
  // timer has something to count from until `workingSince` arrives.
  const [pendingTurnSince, setPendingTurnSince] = useState<number | null>(null)
  // Non-stale mirror of session.working: handleSend's useCallback deps don't
  // include `session.working`, so reading it directly there would be stale.
  const workingRef = useRef(session.working)
  workingRef.current = session.working
  const [localError, setLocalError] = useState<string | null>(null)
  /** Local /clear signal. No producer sets this to `true` today — the local
   *  `/clear` command drives the animation via the App-owned `clearingProp`,
   *  and `onCleared` only resets it to `false`. Retained as the reset half
   *  of a future SDK-emitted `cleared` control signal so wiring the producer
   *  later is a one-line change; until then this state is effectively dead. */
  const [localClearing, setLocalClearing] = useState(false)
  /** Effective clearing signal for the downstream classes on TodoChecklist /
   *  MessageList / MonitorBar. During a local `/clear` fade-in it comes from
   *  App via prop; during an SDK-emitted clear it comes from local state. */
  const effectiveClearing = (clearingProp ?? false) || localClearing

  // Permissions first — its onRequest/onResolved are passed into the
  // stream hook so SDK messages and permission events share one WebSocket.
  // Moved here (before the pendingTurnSince effect) so stream.activePhase
  // is available in the effect's closure and dep array.
  const permissions = usePermissionChannel(session.id)
  const elicitations = useElicitationChannel(session.id)
  const stream = useChatStream(session.id, {
    onRequest: permissions.onRequest,
    onResolved: permissions.onResolved,
    onCleared: () => {
      permissions.reset()
      setLocalClearing(false)
    },
    onElicitationRequest: elicitations.onRequest,
    onElicitationResolved: elicitations.onResolved,
  })

  // Clear the optimistic turn bridge once the real turn is confirmed
  // (session.working rose OR the first stream phase arrived). The old fixed 4s
  // timeout cleared the bridge mid-turn for any turn longer than 4s, dropping
  // the Working indicator and popping it back on the next stream event (the
  // flicker). Now the bridge only survives the short send→confirm window; the
  // safety net covers a hung turn (POST resolved, neither signal ever came).
  useEffect(() => {
    if (pendingTurnSince == null) return
    if (session.working || stream.activePhase != null) {
      setPendingTurnSince(null)
      return
    }
    const t = setTimeout(() => setPendingTurnSince(null), PENDING_TURN_SAFETY_MS)
    return () => clearTimeout(t)
  }, [pendingTurnSince, session.working, stream.activePhase])
  // Drop any pending bridge when switching the panel to another session.
  useEffect(() => {
    setPendingTurnSince(null)
  }, [session.id])
  const turnStartedAt = session.workingSince ?? pendingTurnSince ?? undefined
  /** Increments whenever we want the Composer's textarea refocused.
   *  Bumped after a successful send ?otherwise the click on the Send
   *  button would leave focus on the button, breaking the
   *  type-enter-type-enter flow. */
  const [composerFocusSignal, setComposerFocusSignal] = useState(0)
  /** Sum of the local signal and App's external slot-switch signal. Composer
   *  only cares that the value CHANGES to refocus; both counters are
   *  monotonic, so the sum is a valid signal. */
  const effectiveComposerFocusSignal = composerFocusSignal + (externalComposerFocusSignal ?? 0)

  // Slash commands ?cached per session so switching away and back
  // doesn't re-fetch. The SDK subprocess returns the list via a
  // control request; 410 on dormant sessions is expected and ignored.
  const hub = useWsHub()
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


  useEffect(() => {
    return hub.addSessionListener(session.id, (frame) => {
      if (frame.kind !== 'commands-changed') return
      const next = frame.commands ?? []
      commandsCacheRef.current.set(session.id, next)
      setCommands(next)
    })
  }, [hub, session.id])
  // Local commands (e.g. /resume, /mcp) merged in ONLY for the Composer's "/"
  // picker, so they're discoverable. They're handled in-app by send()'s
  // matchLocalCommand check. The SDK may ALSO advertise a same-name command
  // (Claude Code ships a built-in /mcp): local wins, so we drop any SDK entry
  // whose name collides ?otherwise the picker shows duplicates and React
  // warns on the duplicate `key={cmd.name}`. Deliberately NOT passed to
  // SettingsPanel (which uses the raw `commands` for the skills/plugins
  // catalog — a client command doesn't belong there).
  const mergedCommands = useMemo<SlashCommand[]>(() => {
    const localNames = new Set(LOCAL_COMMANDS.flatMap((c) => [c.name, ...(c.aliases ?? [])]))
    return [
      ...LOCAL_COMMANDS.map((c) => ({
        name: c.name,
        description: c.description,
        argumentHint: c.argumentHint ?? '',
        aliases: c.aliases,
      })),
      ...commands.filter((c) => !localNames.has(c.name)),
    ]
  }, [commands])

  // Agents ?fetched once per session, refreshed after plugin reload.
  // Cached per session (like commands) so switching away and back ?or a
  // session.running flip from auto-resume ?doesn't re-issue the blocking
  // /agents control request (it's gated on the SDK init handshake, which
  // can stall on proxy backends and hang the UI). The agents list is
  // static for a given session, so the cache is safe until plugin reload.
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const agentsCacheRef = useRef<Map<string, AgentInfo[]>>(new Map())
  useEffect(() => {
    if (!session.running) return
    const cached = agentsCacheRef.current.get(session.id)
    if (cached) {
      setAgents(cached)
      return
    }
    let cancelled = false
    api
      .get<{ agents: AgentInfo[] }>(`/sessions/${session.id}/agents`)
      .then((res) => {
        if (cancelled) return
        const ag = res.agents ?? []
        agentsCacheRef.current.set(session.id, ag)
        setAgents(ag)
      })
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

  /** Invalidate agents cache and re-fetch (called after plugin reload). */
  const refreshAgents = useCallback(() => {
    agentsCacheRef.current.delete(session.id)
    if (!session.running) return
    api
      .get<{ agents: AgentInfo[] }>(`/sessions/${session.id}/agents`)
      .then((res) => {
        const ag = res.agents ?? []
        agentsCacheRef.current.set(session.id, ag)
        setAgents(ag)
      })
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

  // Shell-style history is persisted in one localStorage ring but partitioned
  // by session: composer navigation (Mod+?? Ctrl+P/N) only walks this
  // session's entries, so one panel never surfaces another's prompts. The
  // Mod+Shift+H panel still reads the whole ring across sessions.
  // Bash-mode history filter: in `!` mode, navigation walks only shell
  // commands (entries starting with `!`); otherwise it skips them so chat
  // history and shell history stay isolated. The filter is memoized on the
  // mode flip, so it only changes identity when the user enters/leaves bash
  // mode — not on every keystroke.
  const bashMode = input.startsWith('!')
  const historyFilter = useMemo(
    () => (bashMode ? (s: string) => s.startsWith('!') : (s: string) => !s.startsWith('!')),
    [bashMode],
  )
  const history = useInputHistory(session.id, historyFilter)

  const attachments = useAttachments(session.id, session.cwd)
  const pastedImages = usePastedImages()
  // Turn is "active" for layout purposes the instant the user sends, even
  // before `session.working` arrives — this is what keeps the WorkingBubble in
  // the same commit as the optimistic message (see pendingTurnSince comment).
  // Also active during an SDK-driven auto-continuation turn (e.g. the model
  // processing a background subagent's <task-notification> after the parent
  // turn ended): those turns don't go through send() so `session.working`
  // stays false and `pendingTurnSince` is null, but `stream.activePhase` is
  // non-null while the SDK streams its response. `activePhase` is cleared by
  // the result frame (in both replay and live), so this never false-fires on
  // a reconnect replay whose final state has no live turn. Gated on
  // `!session.terminated` because `liveTurn` is only cleared by a result
  // frame — a crashed/killed subprocess that never emits one would otherwise
  // leave `activePhase` non-null and stick the WorkingBubble on a dead
  // session; a terminated session has `working=false` and `terminated=true`,
  // so the gate drops the bubble exactly when it should.
  const turnActive = session.working || pendingTurnSince != null || (stream.activePhase != null && !session.terminated)
  // Dwelled phase label for the WorkingBubble — transient sub-300ms blips
  // between phases don't churn the label. `turnActive` above keeps the raw
  // activePhase so turn-end detection stays immediate.
  const displayPhase = usePhaseDwell(stream.activePhase)
  /** A background (async) subagent still in flight after the parent turn
   *  ended. The WorkingBubble stays mounted in a `Waiting` state while any
   *  such subagent exists, so the user sees that background work is ongoing
   *  — instead of the bubble silently unmounting and the only trace being a
   *  card buried in the transcript.
   *
   *  Checks both `pending` (the normal post-turn-end form: sweep ran) AND
   *  `background` (the form after a server-restart replay, where the CLI
   *  transcript has no `result` frame so the sweep never fires and the
   *  record stays `background`). Without accepting `background`, a page
   *  refresh after a server restart would lose the Waiting bubble even
   *  though the subagent is still running.
   *
   *  Gated on `!session.terminated`: a dead session will never receive the
   *  completion signal, so showing "Waiting..." forever (with only manual
   *  dismiss as an exit) would be a dead state. */
  const waiting = !turnActive && !session.terminated && (stream.activeSubagents?.some((a) => a.status === 'pending' || a.status === 'background') ?? false)

  // 鈹€鈹€ Subagent overlay state 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
  // Stack of toolUseIds: empty = closed; otherwise the last entry is the
  // currently-shown subagent. Pushed when the user clicks a SubagentCard
  // (either in the main transcript or inside the overlay itself, for
  // nested drill-down). Popped on the back button; cleared on close.
  const [subagentStack, setSubagentStack] = useState<string[]>([])
  const [subagentClosing, setSubagentClosing] = useState(false)
  const [subagentTransitionDirection, setSubagentTransitionDirection] = useState<'forward' | 'back' | null>(null)
  const openSubagent = useCallback((toolUseId: string) => {
    if (subagentStack[subagentStack.length - 1] === toolUseId) return
    setSubagentClosing(false)
    setSubagentTransitionDirection(subagentStack.length > 0 ? 'forward' : null)
    setSubagentStack((prev) => [...prev, toolUseId])
  }, [subagentStack])
  const popSubagent = useCallback(() => {
    setSubagentTransitionDirection('back')
    setSubagentStack((prev) => prev.slice(0, -1))
  }, [])
  const closeSubagent = useCallback(() => {
    setSubagentClosing(true)
    setSubagentTransitionDirection(null)
  }, [])
  const handleSubagentExited = useCallback(() => {
    setSubagentClosing(false)
    setSubagentStack([])
    setSubagentTransitionDirection(null)
  }, [])
  // Memoize the provider value so SubagentCard's `memo()` survives
  // unrelated Chat re-renders. Both providers below share this object.
  const subagentCtxValue = useMemo(
    () => ({ index: stream.subagentIndex, messages: stream.messages, open: openSubagent }),
    [stream.subagentIndex, stream.messages, openSubagent],
  )

  // 鈹€鈹€ Workflow overlay state 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
  // Simpler than the subagent stack: WorkflowOverlay owns its own focus state
  // (Workflow → child drill-in) internally, so Chat only needs to know WHICH
  // workflow is open (its tool_use_id) + the close/exit animation flags.
  // `workflowOpenId` is null when closed. openWorkflow is what WorkflowCard's
  // ctx.open() calls.
  const [workflowOpenId, setWorkflowOpenId] = useState<string | null>(null)
  const [workflowClosing, setWorkflowClosing] = useState(false)
  const openWorkflow = useCallback((toolUseId: string) => {
    setWorkflowClosing(false)
    setWorkflowOpenId(toolUseId)
  }, [])
  const closeWorkflow = useCallback(() => {
    setWorkflowClosing(true)
  }, [])
  const handleWorkflowExited = useCallback(() => {
    setWorkflowClosing(false)
    setWorkflowOpenId(null)
  }, [])
  const workflowCtxValue = useMemo(
    () => ({ index: stream.workflowIndex, open: openWorkflow }),
    [stream.workflowIndex, openWorkflow],
  )

  // 鈹€鈹€ AskUserQuestion minimize / re-open 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
  // A minimized question dialog is hidden (not resolved) so the user can
  // read the conversation behind it; the inline QuestionCard re-opens it.
  // Keyed by the pending request's `id`.
  // Persist in-progress answers across minimize/re-open (the dialog unmounts
  // when minimized). Keyed by request id. Held as stable state (mutable Map
  // from a lazy useState init) rather than a ref: reads/writes still don't
  // trigger re-renders, but we're not accessing `.current` during render,
  // which keeps `react-hooks/refs` quiet.
  const [questionDrafts] = useState<Map<string, QuestionDraft>>(() => new Map())


  // Minimize/reopen state for the three pending-request kinds. All three
  // share the same state machine (raw user intent Set -> derived view
  // intersected with live pending ids -> tool_use_id set for the inline
  // card); only the predicate that selects which pending requests belong
  // to each set differs. See src/hooks/useMinimizedSet.ts for the contract.
  const { minimized: minimizedQ, minimizedToolUseIds, minimize: minimizeQuestion, reopen: reopenQuestion } =
    useMinimizedSet(permissions.pending, isQuestion)
  const {
    minimized: minimizedPlan,
    minimizedToolUseIds: minimizedPlanToolUseIds,
    minimize: minimizePlan,
    reopen: reopenPlan,
  } = useMinimizedSet(permissions.pending, isPlanPermission)
  const {
    minimized: minimizedPermission,
    minimizedToolUseIds: minimizedPermissionToolUseIds,
    minimize: minimizePermission,
    reopen: reopenPermission,
  } = useMinimizedSet(permissions.pending, isNonPlanPermission)

  const reopenCtxValue = useMemo(
    () => ({
      minimizedToolUseIds,
      minimizedPlanToolUseIds,
      minimizedPermissionToolUseIds,
      onReopen: reopenQuestion,
      onReopenPlan: reopenPlan,
      onReopenPermission: reopenPermission,
    }),
    [minimizedToolUseIds, minimizedPlanToolUseIds, minimizedPermissionToolUseIds, reopenQuestion, reopenPlan, reopenPermission],
  )
  const activePendingRequest = permissions.pending[0]
  const isMinimizedQuestion = activePendingRequest?.kind === 'question' && minimizedQ.has(activePendingRequest.id)
  const isMinimizedPlan = activePendingRequest?.kind === 'permission' && PLAN_TOOL_NAMES.has(activePendingRequest.toolName) && minimizedPlan.has(activePendingRequest.id)
  const isMinimizedPermission = activePendingRequest?.kind === 'permission' && !PLAN_TOOL_NAMES.has(activePendingRequest.toolName) && minimizedPermission.has(activePendingRequest.id)
  const activeVisiblePendingRequest = (isMinimizedQuestion || isMinimizedPlan || isMinimizedPermission) ? null : activePendingRequest
  const pendingDialogPresence = usePresenceValue(activeVisiblePendingRequest)
  // Elicitation (MCP auth) dialog state. Kept separate from the permission
  // presence machine: the elicitation dialog yields to any permission/
  // question dialog (see the second dialog IIFE below) rather than stacking
  // two perm-variant overlays at once.
  const activeElicitation = elicitations.pending[0] ?? null
  const elicitationPresence = usePresenceValue(activeElicitation)
  // Drop persisted draft entries once a question resolves so questionDrafts
  // doesn't accumulate stale ids over a long session. The corresponding
  // minimize state is derived on read (see `minimizedQ` above), so we no
  // longer setState here.
  useEffect(() => {
    const liveQ = new Set(
      permissions.pending.filter((p) => p.kind === 'question').map((p) => p.id),
    )
    for (const id of questionDrafts.keys()) {
      if (!liveQ.has(id)) questionDrafts.delete(id)
    }
  }, [permissions.pending, questionDrafts])

  // ── In-chat search ──────────────────────────────────────────────────
  // (searchOpen is declared above with the panel-open states so the
  // recap/pinned presence hooks can gate on it.)
  // Seed for the search input, captured from the current selection at open time.
  const [searchSeed, setSearchSeed] = useState('')
  const [searchInstance, setSearchInstance] = useState(0)
  // Open search, pre-filling the input with the user's current selection
  // (single-line, trimmed) so they can search the highlighted text directly.
  const openSearch = useCallback(() => {
    const sel = window.getSelection()?.toString() ?? ''
    // Ignore multi-line / oversized selections ?those aren't useful as a query.
    const seed = sel.trim()
    setSearchSeed(seed && !seed.includes('\n') && seed.length <= 200 ? seed : '')
    setSearchInstance((prev) => prev + 1)
    setSearchOpen(true)
  }, [])
  // Message-area right-click menu. `selection` is captured at open time —
  // clicking a menu item can collapse the live selection, so we snapshot it.
  // `targetId` is the uuid of the message row the user right-clicked (via
  // `data-message-id`), used by the "discard from here" menu item.
  const [exportMenuPos, setExportMenuPos] = useState<
    { x: number; y: number; selection: string; targetId?: string } | null
  >(null)
  // Prefetched "discard from here" cut points: the uuids of every
  // successfully-completed turn's last assistant message, with a short
  // preview of each. A right-clicked assistant message is a legal cut
  // point iff its uuid is in this map. Fetched once when the panel opens a
  // session that has completed turns (lastTurnAt set); right-click then
  // checks locally with zero latency.
  const [discardAnchors, setDiscardAnchors] = useState<Map<string, string>>(new Map())
  useEffect(() => {
    if (!session.lastTurnAt || !onDiscard) { setDiscardAnchors(new Map()); return }
    let cancelled = false
    void api.get<{ anchors: Array<{ uuid: string; preview: string }> }>(`/sessions/${session.id}/discard-anchors`)
      .then((res) => {
        if (cancelled) return
        setDiscardAnchors(new Map(res.anchors.map((a) => [a.uuid, a.preview] as const)))
      })
      .catch(() => { /* session gone / not yet flushed — no anchors */ })
    return () => { cancelled = true }
  }, [session.id, session.lastTurnAt, onDiscard])
  // Plugin selection-menu commands (e.g. Translate). Injected into the
  // existing right-click menu when the user has a text selection.
  const allContribs = useAllContributions()
  const { execute: executePluginCommand } = usePluginCommands()

  /** True when `uuid` is a recorded turn anchor — a successfully-completed
   *  turn's last assistant message. Only such a uuid is a legal "discard
   *  from here" cut point (cutting mid-turn would orphan tool pairs). */
  const isDiscardableAnchor = useCallback((uuid: string | undefined) => {
    return !!uuid && discardAnchors.has(uuid)
  }, [discardAnchors])

  /** Open the discard confirmation modal (rendered locally via
   *  `discardConfirm`). The checkbox toggles `deleteOriginal` (also unlink
   *  the source transcript, irreversible). confirmLabel follows the
   *  checkbox so the button matches the chosen severity. */
  const [discardConfirm, setDiscardConfirm] = useState<{
    anchorUuid: string
    preview: string
    deleteOriginal: boolean
    busy: boolean
  } | null>(null)
  const openDiscardConfirm = useCallback((anchorUuid: string) => {
    if (!onDiscard) return
    setDiscardConfirm({
      anchorUuid,
      preview: discardAnchors.get(anchorUuid) ?? '',
      deleteOriginal: false,
      busy: false,
    })
  }, [discardAnchors, onDiscard])

  /** Build plugin ContextMenuItems for the current selection. Returns []
   *  when there's no selection or no enabled plugin contributes a
   *  `message.selectionContextMenu` command whose `when` holds. */
  const buildPluginMenuItems = useCallback((selection: string): ContextMenuItem[] => {
    if (!selection.trim()) return []
    const items: Array<{ id: string; title: string; commandId: string; when?: string; order?: number; pluginId: string }> = []
    for (const c of allContribs) {
      for (const m of c.contextMenus) {
        if (m.location === 'message.selectionContextMenu') {
          items.push({ ...m, pluginId: c.pluginId })
        }
      }
    }
    const ctx = buildWhenContext({ sessionWorking: !!session.working, messageHasSelection: true, messageSelectionLength: selection.length })
    const filtered = filterContributions(items, ctx)
    return filtered.map((m) => ({
      label: m.title,
      icon: <IconGlobe size={14} />,
      onClick: () => {
        // Capture the selection's screen rect at click time so the popover
        // anchors to where the user selected, not where they clicked the
        // menu item.
        const sel = window.getSelection()
        const rect = sel && sel.rangeCount > 0
          ? sel.getRangeAt(0).getBoundingClientRect()
          : new DOMRect(window.innerWidth / 2, window.innerHeight / 2, 0, 0)
        void executePluginCommand({
          pluginId: m.pluginId,
          commandId: m.commandId,
          context: {
            source: 'message-selection',
            invocationId: '',
            commandId: m.commandId,
            invokedAt: Date.now(),
            sessionId: session.id,
            messageId: '',
            message: { role: 'assistant', contentBlockType: 'text' },
            selection: { text: selection, length: selection.length, truncated: false },
          } as never,
          anchor: { messageId: '', element: null, rect },
        })
      },
    }))
  }, [allContribs, executePluginCommand, session.id, session.working])
  // Export-success feedback now goes through the global toast hub.
  const toast = useToast()
  const [searchQuery, setSearchQuery] = useState('')
  const debouncedQuery = useDebouncedValue(searchQuery, 200)
  // Raw state; the value consumers see (`searchActiveIdx`, below) is
  // clamped on read against the current match count. That way we don't
  // need an effect to reset the index when a query change shrinks or
  // clears the match set — an out-of-range raw value simply reads as 0
  // (empty) or `len - 1` (over) without a cascading render.
  //
  // Held via useReducer (not useState) so the pendingJump effect below
  // can dispatch the resolved-jump index without tripping
  // `react-hooks/set-state-in-effect`. The rule targets the
  // "derive-state-via-effect" antipattern where an effect calls setState
  // on a value it doesn't read; useReducer's dispatch is out of scope
  // because reducers are the sanctioned way to coordinate multi-source
  // updates. Behaviour is identical: `setSearchActiveIdx(n)` is a
  // one-arg replace.
  const [searchActiveIdxRaw, setSearchActiveIdx] = useReducer(
    (_prev: number, next: number) => next,
    0,
  )
  // Top-most visible item index, reported by MessageList on scroll.
  // Used to find the nearest search match to the viewport. Kept as a
  // ref (not state) to avoid re-renders on every scroll tick.
  const topVisibleIdxRef = useRef(0)
  const handleVisibleRangeChange = useCallback((idx: number) => { topVisibleIdxRef.current = idx }, [])
  /** Flat list of text-level matches across the transcript. Each entry
   *  records the transcript item it lives in plus its local index
   *  within that item (0-based, so the third "foo" inside item #5 is
   *  `{ itemIdx: 5, matchInItem: 2 }`). The array length is the total
   *  hit count shown in the search bar.
   *
   *  We carry the per-item index alongside the global one so the
   *  active-mark highlighter can colour the precise `<mark>` the user
   *  is currently on ?without it, "next match" jumps inside the same
   *  message would be invisible (same outline, no scroll change).
   *
   *  Matching uses the canonical `plainText` field — same view the
   *  rehype highlighter reconstructs at render time, so the counter
   *  and the visible <mark>s describe the same text. */
  const searchMatches = useMemo(() => {
    if (!debouncedQuery) return [] as Array<{ itemIdx: number; matchInItem: number }>
    const out: Array<{ itemIdx: number; matchInItem: number }> = []
    for (let i = 0; i < stream.items.length; i++) {
      const item = stream.items[i]
      // Hidden frames (system init/status, /model command logs, …) carry
      // non-null plainText but aren't in renderableItems, so counting them
      // would inflate the match counter and strand next/prev on matches that
      // have no virtual index to scroll to. Skip them.
      if (!item || item.hiddenByDefault) continue
      const text = item.plainText
      if (!text) continue
      const n = countMatches(text, debouncedQuery)
      for (let k = 0; k < n; k++) out.push({ itemIdx: i, matchInItem: k })
    }
    return out
  }, [stream.items, debouncedQuery])
  // Clamped view of the raw active-idx state — see the useState comment
  // above. Consumers that render the "N/total" chip or index into
  // `searchMatches` should use this, not the raw value.
  const searchActiveIdx = useMemo(() => {
    if (searchMatches.length === 0) return 0
    return Math.min(Math.max(0, searchActiveIdxRaw), searchMatches.length - 1)
  }, [searchActiveIdxRaw, searchMatches.length])
  // When the match set changes (new query or new messages), find the
  // nearest match to the current viewport rather than always starting
  // from the first one.
  useEffect(() => {
    if (searchMatches.length === 0) return
    const top = topVisibleIdxRef.current
    // Binary search for the first match whose itemIdx >= top.
    let lo = 0
    let hi = searchMatches.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (searchMatches[mid].itemIdx < top) lo = mid + 1
      else hi = mid
    }
    // lo is the first match at or after the viewport. The match
    // immediately before it (lo-1) might be closer, so compare.
    const after = lo < searchMatches.length ? searchMatches[lo].itemIdx : Infinity
    const before = lo > 0 ? searchMatches[lo - 1].itemIdx : -Infinity
    const nearest = (top - before) <= (after - top) ? lo - 1 : lo
    setSearchActiveIdx(Math.max(0, Math.min(nearest, searchMatches.length - 1)))
  }, [searchMatches])

  const handledJumpNonceRef = useRef<number | null>(null)
  const [pendingJump, setPendingJump] = useReducer(
    (_prev: MessageJumpTarget | null, next: MessageJumpTarget | null) => next,
    null,
  )
  useEffect(() => {
    if (!messageJumpTarget || messageJumpTarget.sessionId !== session.id) return
    if (handledJumpNonceRef.current === messageJumpTarget.nonce) return
    handledJumpNonceRef.current = messageJumpTarget.nonce

    setSearchSeed(messageJumpTarget.query)
    setSearchQuery(messageJumpTarget.query)
    setSearchActiveIdx(0)
    setSearchInstance((prev) => prev + 1)
    setSearchOpen(true)
    setPendingJump(messageJumpTarget)
  }, [messageJumpTarget, session.id])

  // Destructure the fields the pending-jump effect touches. Naming them
  // directly in the dep array (instead of bare `stream`) keeps the effect
  // from re-running every time the hook's return identity churns (e.g.
  // per streaming token), and satisfies react-hooks/exhaustive-deps.
  const {
    items: streamItems,
    hasOlder: streamHasOlder,
    loadOlder: streamLoadOlder,
    loadingOlder: streamLoadingOlder,
  } = stream
  useEffect(() => {
    if (!pendingJump) return
    if (debouncedQuery !== pendingJump.query) return

    const itemIdx = pendingJump.messageUuid
      ? streamItems.findIndex((item) => item.msg.uuid === pendingJump.messageUuid)
      : -1
    if (itemIdx >= 0) {
      const beforeTarget = streamItems.slice(0, itemIdx)
      let globalIdx = 0
      for (const item of beforeTarget) if (!item.hiddenByDefault) globalIdx += countMatches(item.plainText, pendingJump.query)
      setSearchActiveIdx(globalIdx)
      setPendingJump(null)
      return
    }

    if (!streamHasOlder) {
      const visibleMatches = streamItems.reduce(
        (total, item) => total + (item.hiddenByDefault ? 0 : countMatches(item.plainText, pendingJump.query)),
        0,
      )
      if (pendingJump.matchOrdinal != null && visibleMatches > pendingJump.matchOrdinal) {
        setSearchActiveIdx(pendingJump.matchOrdinal)
      }
      setPendingJump(null)
      return
    }
    if (streamLoadingOlder) return

    let cancelled = false
    void streamLoadOlder().then((loaded) => {
      if (!cancelled && loaded === 0) setPendingJump(null)
    })
    return () => { cancelled = true }
  }, [debouncedQuery, pendingJump, streamHasOlder, streamItems, streamLoadOlder, streamLoadingOlder])

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
        openSearch()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [focused, openSearch])

  const handleSearchNavigate = useCallback(
    (index: number) => {
      setSearchActiveIdx(index)
    },
    [],
  )

  // Session recap ?phase-driven auto-generation. The hook reads
  // session.phase + session.lastTurnAt + session.recap (all kept current
  // by App-level WS frames) and schedules a single POST /recap when the
  // session has been idle for IDLE_THRESHOLD_MS with no fresh recap
  // covering it. The recap object lives on session.recap (broadcast via
  // session-recap-update / session-update); we render it as a floating
  // window at the top of the chat area (see <RecapWindow> below).
  const recap = useSessionRecap(session, effectiveAutoRecap)

  // Composer snippets are a single GLOBAL instance owned by App and passed
  // down via props (`snippets`, `onOpenSnippetsManager`,
  // `onSaveCurrentAsSnippet`). The manager + save dialogs render once at
  // App level. The only panel-local snippet behaviour is "insert at caret",
  // which lives in <Composer>.

  // Pull out the specific functions/values we actually use downstream.
  // Putting the whole hook object in a dep list re-creates callbacks every
  // render and can churn child re-renders (the composer's onChange in
  // particular ?that's what caused the "can't send / can't type" freeze).
  const { insertUserMessage, ackUserMessage, rollbackUserMessage, clearError: clearStreamError } = stream
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
      // are being dragged ?ignore text selections etc.
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

  const requestClearSession = useCallback((sessionId: string) => {
    // App owns the POST + panel id-swap: the server detaches the pre-clear
    // conversation as a dormant resumable session and returns a fresh session
    // Y under a new id; App swaps this panel from X to Y. X unmounts (its
    // transcript/permissions/attachments state is discarded), Y mounts fresh.
    // We deliberately do NOT set `clearing` here — the blur-fade was tied to
    // the old same-id wipe, and a stuck "Clearing…" veil on a failed POST
    // (onCleared never fires for a local /clear) isn't worth the transition.
    // `clearing` remains wired for the SDK's own in-band `cleared` event.
    clearError()
    onClearSession(sessionId)
  }, [clearError, onClearSession])

  /** Run a `!`/`!!` bash command: optimistic placeholder → POST /exec →
   *  ack/rollback. `share:true` (`!!`) injects the result into the SDK
   *  transcript so the model sees it (triggers a model turn); the default
   *  `share:false` (`!`) is local-only — zero model round-trips. Either way
   *  the client manages the placeholder lifecycle like a normal send. */
  const runBashCommand = useCallback(async (command: string, opts: { share?: boolean } = {}) => {
    clearError()
    const placeholder = `<bash-input>${command}</bash-input>`
    const pendingId = insertUserMessage(placeholder)
    sendingRef.current = true
    setSending(true)
    // Shared bash (`!!`) triggers a real model turn — bridge the WorkingBubble
    // the same way a normal send does. Local `!` produces no turn, so skip it.
    if (opts.share && !workingRef.current) setPendingTurnSince(Date.now())
    try {
      const res = await api.post<{
        message: { uuid: string; receivedAt?: number }
      }>(`/sessions/${session.id}/exec`, { command, confirm: true, share: opts.share }, { timeoutMs: 0 })
      if (pendingId && typeof res.message?.uuid === 'string') {
        ackUserMessage(pendingId, res.message.uuid, res.message.receivedAt)
      }
      // Preserve the share mode in history: `!cmd` vs `!!cmd` so recalling a
      // previously-shared command re-runs it shared, not silently downgraded
      // to local. The bash-history filter matches both (`startsWith('!')`).
      history.add(`${opts.share ? '!!' : '!'}${command}`)
      setInput('')
      setComposerFocusSignal((n) => n + 1)
    } catch (e) {
      setLocalError((e as Error).message)
      if (pendingId) rollbackUserMessage(pendingId)
      setPendingTurnSince(null)
    } finally {
      sendingRef.current = false
      setSending(false)
    }
  }, [session.id, history, insertUserMessage, ackUserMessage, rollbackUserMessage, clearError, setInput])

  const send = useCallback(async () => {
    // Synchronous guard FIRST ?before any await or React state read,
    // so two rapid Enter presses (within one frame) can't both pass.
    if (sendingRef.current) return
    const text = input.trim()
    // `!` bash mode — run a shell command directly in the session cwd,
    // bypassing the model. Detected before slash-command matching so a
    // command starting with `!` (rare) still routes here. Mirrors Claude
    // Code's `!` prefix: the command runs unsandboxed in the user's shell.
    //   `!cmd`  — local only, zero model round-trips, model never sees output.
    //   `!!cmd` — share with model: injects output into the transcript so the
    //             model sees it on the next turn (triggers a real model turn).
    if (text.startsWith('!!') && text.length > 2) {
      const command = text.slice(2)
      setInput('')
      await runBashCommand(command, { share: true })
      return
    }
    // `!cmd` — local only. Exclude the `!!` prefix (handled above) so a bare
    // `!!` falls through to a normal message instead of running shell `!`.
    if (text.startsWith('!') && !text.startsWith('!!') && text.length > 1) {
      const command = text.slice(1)
      setInput('')
      await runBashCommand(command)
      return
    }
    // Client-side local commands (e.g. /resume) are intercepted here and
    // handled in-app instead of being POSTed to the SDK. Matched strictly
    // (first token only) so real SDK/plugin commands still pass through.
    const local = matchLocalCommand(text)
    if (local) {
      setInput('')
      local.run({
        sessionId: session.id,
        commands: mergedCommands,
        requestResumeForPanel: onRequestResumeForPanel,
        openSettingsTab: onOpenSettingsTab,
        showHelp: onShowHelp,
        clearSession: requestClearSession,
      })
      return
    }
    // Allow sending with just attachments (e.g. "here, look at these files")
    // — the model sees only the attachments preamble in that case.
    if (!text && attachmentList.length === 0 && pastedImages.images.length === 0) return
    sendingRef.current = true
    setSending(true)
    // Optimistically mark the turn active in the SAME commit as the message
    // insert below, so the WorkingBubble mounts alongside the message instead
    // of one frame later (which shifted the viewport and caused scroll jitter).
    // Guard on workingRef so a mid-turn queued send doesn't leave it stuck.
    if (!workingRef.current) setPendingTurnSince(Date.now())
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
    // the placeholder by id ?which works regardless of content shape
    // (multimodal arrays included). Previously the optimistic insert
    // ran AFTER await, so the broadcast arrived first and the dedup
    // (which compares content with ===) failed for image arrays,
    // leaving two "you" bubbles in the transcript.
    const pendingId = full.trim() ? insertUserMessage(full) : null

    // POST with a bounded retry for the crash-recovery window: the server
    // 409s sends while a session is `recovering` (the old handle is dead).
    // That window is usually sub-second, so retry instead of rolling the
    // optimistic bubble back and forcing the user to re-send. Only the
    // recovering 409 is retried (other 409s, e.g. "not running", won't
    // resolve and would just waste the backoff). The optimistic placeholder
    // stays during retry; the outer catch rolls it back on final failure.
    const postMessage = async (body: unknown): Promise<SendMessageResponse> => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await api.post<SendMessageResponse>(`/sessions/${session.id}/messages`, body)
        } catch (e) {
          const recovering = (e as { status?: number }).status === 409
            && /recovering/i.test((e as Error).message)
          if (recovering && attempt < 3) {
            await new Promise((r) => setTimeout(r, 500 * (attempt + 1)))
            continue
          }
          throw e
        }
      }
    }

    try {
      let res: SendMessageResponse
      if (pastedImages.images.length > 0) {
        // Build content array with text + image blocks
        const content: Array<{ type: string; text?: string; source?: { type: string; data: string; media_type: string } }> = []
        if (full.trim()) content.push({ type: 'text', text: full })
        for (const img of pastedImages.images) {
          content.push({ type: 'image', source: { type: 'base64', data: img.data, media_type: img.mediaType } })
        }
        res = await postMessage({ content })
      } else {
        res = await postMessage({ text: full })
      }
      if (pendingId && typeof res.message?.uuid === 'string') {
        ackUserMessage(pendingId, res.message.uuid, res.message.receivedAt)
      }
      if (text) history.add(text)
      setInput('')
      clearAttachments()
      pastedImages.clear()
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
      setPendingTurnSince(null)
    } finally {
      sendingRef.current = false
      setSending(false)
    }
  }, [input, attachmentList, session.id, history, insertUserMessage, ackUserMessage, rollbackUserMessage, clearAttachments, clearError, setInput, pastedImages, mergedCommands, onRequestResumeForPanel, onOpenSettingsTab, onShowHelp, requestClearSession, runBashCommand])

  // Overlay scrollbars on the settings + git overlay backdrops (these scroll
  // when the panel card exceeds the viewport). Passed to the <Overlay>
  // backdropRef so the scrollbar styles the same element the focus trap and
  // Escape stack target. The Overlay primitive owns the focus traps and
  // presence for both overlays; its `mounted && open` active gate reproduces
  // the old `gitPresence.shouldRender && gitPanelOpen` fix (the trap engages
  // only once the git overlay is actually mounted, so the chip's :focus
  // tooltip doesn't stick open).
  const setSettingsOverlayOs = useOverlayScrollbar({ autoHide: 'leave' })
  const setGitOverlayOs = useOverlayScrollbar({ autoHide: 'leave' })

  const interrupt = useCallback(async () => {
    try {
      await api.post(`/sessions/${session.id}/interrupt`)
    } catch (e) {
      setLocalError((e as Error).message)
    }
  }, [session.id])

  /** Force-stop the current in-flight `!`/`!!` command (SIGKILL the child),
   *  like Ctrl+C. The server then completes execInSession with
   *  interrupted:true and injects the result as a normal bash message, so no
   *  placeholder rollback is needed here — the existing echo-merge replaces
   *  the optimistic placeholder with the interrupted result. */
  const abortBashCommand = useCallback(async () => {
    try {
      await api.post(`/sessions/${session.id}/exec/abort`, {})
    } catch (e) {
      setLocalError((e as Error).message)
    }
  }, [session.id])

  // Expose the interrupt callback to the parent so the ESC shortcut in
  // App.tsx can trigger the same code-path. The "interrupted" (? result
  // label is now derived from the SDK result message's `terminal_reason`,
  // not from any client-side interrupt flag.
  useEffect(() => {
    // register returns a stale-guarded unregister; returning it from the
    // effect ensures the entry is dropped on unmount (panel close / session
    // switch / delete) instead of leaking the closure for the tab's lifetime.
    return onRegisterInterrupt?.(session.id, interrupt)
  }, [session.id, interrupt, onRegisterInterrupt])

  // Expose the recap.refresh callback to the parent so the Alt+R shortcut
  // can trigger a recap fetch for the focused session.
  useEffect(() => {
    return onRegisterRecap?.(session.id, recap.refresh)
  }, [session.id, recap.refresh, onRegisterRecap])

  // Inject a selected history entry into this panel's composer. Now that the
  // history panel is rendered in-panel (not at App root), this is a direct
  // local call — no registry indirection. setInput also write-throughs to the
  // per-session draft, so the recalled text persists.
  const handleHistorySelect = useCallback((text: string) => {
    setInput(text)
    history.reset()
    setComposerFocusSignal((n) => n + 1)
  }, [setInput, history, setComposerFocusSignal])

  // MessageList registers its prev/next-user-message navigator here so the
  // chat-area right-click menu ("Scroll to previous/next user message") can
  // drive it without prop-threading through the message list.
  const scrollNavRef = useRef<ScrollNavigator | null>(null)
  const registerNavigate = useCallback((nav: ScrollNavigator) => {
    scrollNavRef.current = nav
  }, [])

  // Stable wrapper so MessageList's `itemContent` useCallback (whose dep
  // array includes onSwitchModel) keeps a stable identity across streaming
  // token deltas. An inline arrow here would recreate itemContent on every
  // token, busting MessageView.memo and re-running every visible row per
  // delta. onSwitchModel is only consumed in the rare model_not_found branch.
  const handleSwitchModel = useCallback(
    () => onOpenSettingsTab(session.id, 'general'),
    [onOpenSettingsTab, session.id],
  )

  // Note: we used to poll /sessions/:id 500ms after every SDK message to
  // keep the header badges fresh. That added O(messages 脳 sessions) HTTP
  // requests on top of the WebSocket streams, and with three panels open it was
  // enough to saturate the browser's HTTP/1.1 connection pool. Model /
  // permissionMode only change via user actions (which already update
  // session state), and `working` is now derived from the message stream
  // itself (result messages clear it) ?so no background poll is needed.

  // Stable wrappers so Composer's React.memo isn't defeated by inline arrows.
  const handleSend = useCallback(() => void send(), [send])
  const handleInterrupt = useCallback(() => void interrupt(), [interrupt])

  return (
    <div className="chat">
      {exportMenuPos && (
        <ContextMenu
          x={exportMenuPos.x}
          y={exportMenuPos.y}
          onClose={() => setExportMenuPos(null)}
          items={[
            ...(exportMenuPos.selection.trim()
              ? [
                  {
                    label: 'Copy',
                    icon: <IconCopy size={14} />,
                    onClick: () => {
                      void navigator.clipboard?.writeText(exportMenuPos.selection)
                    },
                  },
                  { label: '' },
                ]
              : []),
            // Plugin selection-menu items (e.g. Translate) — injected above
            // "Search messages" when the user has a selection and a plugin
            // contributes a matching command.
            ...(() => {
              const pluginItems = buildPluginMenuItems(exportMenuPos.selection)
              return pluginItems.length > 0 ? [...pluginItems, { label: '' } as ContextMenuItem] : []
            })(),
            {
              label: 'Search messages',
              icon: <IconSearch size={14} />,
              onClick: () => openSearch(),
            },
            { label: '' },
            {
              label: 'Scroll to previous user message',
              icon: <IconArrowUp size={14} />,
              onClick: () => scrollNavRef.current?.prev(),
            },
            {
              label: 'Scroll to next user message',
              icon: <IconArrowDown size={14} />,
              onClick: () => scrollNavRef.current?.next(),
            },
            ...(onDiscard ? [{
              label: 'Discard this message and after',
              icon: <IconScissors size={14} />,
              danger: true,
              // Legal cut point = the right-clicked message is an assistant
              // message whose uuid is a recorded turn anchor (a success
              // turn's last reply). Otherwise grey out with a hint.
              disabled: !isDiscardableAnchor(exportMenuPos.targetId),
              title: !isDiscardableAnchor(exportMenuPos.targetId)
                ? 'Can only discard after a completed reply' : undefined,
              onClick: () => {
                if (exportMenuPos.targetId && isDiscardableAnchor(exportMenuPos.targetId)) {
                  openDiscardConfirm(exportMenuPos.targetId)
                }
              },
            } as ContextMenuItem, { label: '' } as ContextMenuItem] : []),
            { label: '' },
            {
              label: 'Export as Markdown',
              icon: <IconFileText size={14} />,
              onClick: () => {
                exportConversation(stream.messages, session.title ?? session.id.slice(0, 8))
                toast.success('Exported as Markdown')
              },
            },
            {
              label: 'Export as JSON',
              icon: <IconFileCode size={14} />,
              onClick: () => {
                exportConversationJson(stream.messages, session.title ?? session.id.slice(0, 8))
                toast.success('Exported as JSON')
              },
            },
            { label: '' },
            ...(onSideChat && session.messageCount > 0 && !session.parentId
              ? [
                  {
                    label: 'Side Chat',
                    icon: <IconMessageCircle size={14} />,
                    onClick: () => onSideChat(session.id),
                  },
                ]
              : []),
            ...(onOpenSettingsPanel
              ? [
                  {
                    label: 'Settings',
                    icon: <IconSettings size={14} />,
                    onClick: () => onOpenSettingsPanel(session.id),
                  },
                ]
              : []),
            // Deactivate the whole group: close every open panel in it while
            // keeping membership (App.closeGroupPanels). Distinct from the
            // "Remove from <group>" item below, which closes just this panel
            // and ungroups it. Only offered for grouped sessions.
            ...(onCloseGroupPanels && groupLabel
              ? [
                  {
                    label: `Close all panels in "${groupLabel}"`,
                    icon: <IconX size={14} />,
                    onClick: () => onCloseGroupPanels(),
                  },
                ]
              : []),
            ...(onClosePanel
              ? [
                  {
                    label: groupLabel ? `Remove from "${groupLabel}"` : 'Close panel',
                    icon: <IconX size={14} />,
                    onClick: () => onClosePanel(session.id),
                  },
                ]
              : []),
            // Delete the session entirely (same handler + Undo window as the
            // sidebar's Delete). Confirm first when there's history at stake;
            // empty scratch sessions delete immediately. Mirrors
            // SessionContextMenu's Delete row.
            ...(onDelete
              ? [
                  { label: '' },
                  {
                    label: 'Delete session',
                    icon: <IconTrash size={14} />,
                    danger: true,
                    onClick: () => {
                      const title = session.title ?? session.id.slice(0, 8)
                      const hasHistory = session.messageCount > 0
                      if (hasHistory && onAskConfirm) {
                        onAskConfirm({
                          title: 'Delete session?',
                          message: (
                            <>
                              <p>Delete &ldquo;{title}&rdquo;?</p>
                              <p>This permanently removes the conversation from disk. The Anthropic SDK&rsquo;s own session log in ~/.claude/projects/ is kept, but the app won&rsquo;t reference it anymore.</p>
                            </>
                          ),
                          confirmLabel: 'Delete',
                          destructive: true,
                          onConfirm: () => onDelete(session.id),
                        })
                        return
                      }
                      onDelete(session.id)
                    },
                  },
                ]
              : []),
          ]}
        />
      )}

      <MessageSearch
        key={`search-${searchInstance}`}
        open={searchOpen}
        onClose={() => {
          setSearchOpen(false)
          setSearchQuery('')
        }}
        onNavigate={handleSearchNavigate}
        totalResults={searchMatches.length}
        onQueryChange={setSearchQuery}
        activeIndex={searchActiveIdx}
        initialQuery={searchSeed}
      />

      <SubagentProvider value={subagentCtxValue}>
        <WorkflowProvider value={workflowCtxValue}>
        <ReopenQuestionProvider value={reopenCtxValue}>
        <div
          className="chat-messages-area"
          onContextMenu={(e) => {
            e.preventDefault()
            const selection = window.getSelection()?.toString() ?? ''
            const targetEl = (e.target as HTMLElement).closest('[data-message-id]')
            const targetId = targetEl?.getAttribute('data-message-id') ?? undefined
            setExportMenuPos({ x: e.clientX, y: e.clientY, selection, targetId })
          }}
        >
        <MessageList
          items={stream.items}
          working={turnActive}
          replayReady={stream.replayReady}
          expectHistory={session.messageCount > 0}
          clearing={effectiveClearing}
          transcriptRevealKey={session.id}
          streamingContent={stream.streamingContent}
          apiRetry={stream.apiRetry}
          planStatus={stream.planStatus}
          planContent={stream.planContent}
          questionAnswers={stream.questionAnswers}
          toolStatus={stream.toolStatus}
          toolResults={stream.toolResults}
          searchQuery={searchOpen ? debouncedQuery : ''}
          searchActiveMsgIdx={searchMatches[searchActiveIdx]?.itemIdx ?? -1}
          searchActiveMatchInItem={searchMatches[searchActiveIdx]?.matchInItem ?? -1}
          loadOlder={stream.loadOlder}
          hasOlder={stream.hasOlder}
          loadingOlder={stream.loadingOlder}
          onRegisterNavigate={registerNavigate}
          onSwitchModel={handleSwitchModel}
          onAbortBash={abortBashCommand}
          onVisibleRangeChange={handleVisibleRangeChange}
          onPinnedUserMessageChange={handlePinnedUserMessageChange}
          onUserMessagesChange={handleUserMessagesChange}
          cwd={session.cwd}
        />
        </div>
        {discardConfirm && (
          <ConfirmDialog
            title="Discard messages after this point?"
            message={
              <>
                <p>Messages after {discardConfirm.preview ? `「${discardConfirm.preview}」` : 'this reply'}{' '}
                will be discarded. The conversation continues from here in a new session.</p>
                <p className="confirm-dialog-hint">
                  {discardConfirm.deleteOriginal
                    ? <>The original conversation will be <strong>permanently deleted</strong> — it cannot be recovered.</>
                    : <>The original is kept on disk and can be recovered via <code>/resume</code>.</>}
                </p>
              </>
            }
            confirmLabel={discardConfirm.deleteOriginal ? 'Discard and delete' : 'Discard'}
            destructive
            busy={discardConfirm.busy}
            checkboxLabel="Also delete the original conversation (irreversible)"
            checkboxChecked={discardConfirm.deleteOriginal}
            onCheckboxChange={(checked) => setDiscardConfirm((prev) => prev && { ...prev, deleteOriginal: checked })}
            onConfirm={async () => {
              if (!onDiscard) return
              setDiscardConfirm((prev) => prev && { ...prev, busy: true })
              try {
                await onDiscard(session.id, discardConfirm.anchorUuid, discardConfirm.deleteOriginal)
                // On success the panel swaps to the forked session id and
                // this Chat unmounts (key=session.id), so the close below is
                // a no-op. Keep it for the rare same-id-success edge.
                setDiscardConfirm(null)
              } catch {
                // Failure: App.handleDiscard already toasted the error.
                // Reopen the dialog so the user can retry or cancel.
                setDiscardConfirm((prev) => prev && { ...prev, busy: false })
              }
            }}
            onCancel={() => { if (!discardConfirm.busy) setDiscardConfirm(null) }}
          />
        )}
        </ReopenQuestionProvider>
        </WorkflowProvider>
      </SubagentProvider>

      <TodoChecklist messages={stream.messages} working={session.working} skin={skin} clearing={effectiveClearing} sessionId={session.id} />
      <MonitorBar messages={stream.messages} clearing={effectiveClearing} />

      {/* Always-mounted live region ?see `.error-bar-empty` in styles.css.
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
      {(turnActive || waiting) && (
        <WorkingBubble
          startedAt={turnStartedAt}
          activeSubagents={stream.activeSubagents}
          tokenRate={stream.tokenRate}
          activePhase={displayPhase}
          waiting={waiting}
          onOpenSubagent={openSubagent}
        />
      )}

      <ContextBar usage={stream.contextUsage} />

      <Composer
      input={input}
      setInput={setInput}
      sending={sending}
      // Any terminated session shows the ended banner / choice UI and has its
      // input disabled. A transiently-terminated (canRetryResume) one gets the
      // Resume / Fork-from-last-completed choice banner — the user decides.
      disabled={session.terminated}
      terminated={session.terminated}
      terminatedReason={session.terminatedReason}
      canRetryResume={session.canRetryResume}
      error={session.error}
      onResume={onResume ? () => onResume(session.id) : undefined}
      onForkFromLastCompleted={onForkFromLastCompleted ? () => onForkFromLastCompleted(session.id) : undefined}
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
      commands={mergedCommands}
      pastedImages={pastedImages.images}
      onPasteImage={pastedImages.addImage}
      onRemovePastedImage={pastedImages.removeImage}
      onSend={handleSend}
      onInterrupt={handleInterrupt}
      canInterrupt={session.working}
      focusSignal={effectiveComposerFocusSignal}
      onRecap={recap.refresh}
      canRecap={!!session.lastTurnAt}
      snippets={snippets}
      onOpenSnippetsManager={onOpenSnippetsManager}
      onSaveCurrentAsSnippet={onSaveCurrentAsSnippet}
      />

      {/* Pending permission dialogs. The question dialog closes
          immediately on submit ?the parent drops it from the pending
          queue optimistically (see usePermissionChannel). */}
      {(() => {
        const pendingHead = pendingDialogPresence.value
        const pendingDialogOpen = activeVisiblePendingRequest?.id === pendingHead?.id
        if (pendingHead?.kind === 'question') {
          return (
            <QuestionDialog
              key={pendingHead.id}
              open={pendingDialogOpen}
              request={pendingHead}
              initialDraft={questionDrafts.get(pendingHead.id)}
              onDraftChange={(draft) => {
                questionDrafts.set(pendingHead.id, draft)
              }}
              onMinimize={() => minimizeQuestion(pendingHead.id)}
              onSubmit={(answers) => {
                void permissions.answerQuestion(pendingHead.id, answers)
              }}
              onClarify={(feedback) => {
                void permissions.clarifyQuestion(pendingHead.id, feedback)
              }}
              onSkipAll={() => {
                void permissions.answerQuestion(
                  pendingHead.id,
                  (pendingHead.questions ?? []).map(() => null),
                )
              }}
            />
          )
        }

        if (pendingHead?.kind === 'permission') {
          return (
            <PermissionDialog
              key={pendingHead.id}
              open={pendingDialogOpen}
              request={pendingHead}
              onDecide={(d) => void permissions.decide(pendingHead.id, d)}
              planContentMap={stream.planContent}
              currentMode={session.permissionMode}
              onMinimize={PLAN_TOOL_NAMES.has(pendingHead.toolName) ? () => minimizePlan(pendingHead.id) : () => minimizePermission(pendingHead.id)}
            />
          )
        }

        return null
      })()}

      {/* Pending MCP elicitation (auth) dialog. Yields to any permission/
          question dialog above — two simultaneous perm-variant overlays is
          worse UX than a short wait; when the permission dialog clears (or
          is minimized), this one appears. usePresenceValue keeps the dialog
          mounted through its exit animation when the head changes. */}
      {(() => {
        if (pendingDialogPresence.value != null) return null
        const head = elicitationPresence.value
        if (!head) return null
        return (
          <ElicitationDialog
            key={head.id}
            open={activeElicitation?.id === head.id}
            request={head}
            onDecide={(d) => void elicitations.decide(head.id, d)}
          />
        )
      })()}

      <Overlay
        variant="settings"
        ariaLabel="Session settings"
        open={settingsOpen}
        onClose={() => onCloseSettings?.()}
        renderCard={false}
        trapRefTarget="backdrop"
        focusEscapeSelector=".chat-panel"
        keepMounted={settingsEverOpened}
        backdropRef={setSettingsOverlayOs}
      >
        {settingsEverOpened && (
          <Suspense fallback={null}>
            <SettingsPanel
              key={session.id}
              session={session}
              globalPrefs={globalPrefs}
              onClose={() => onCloseSettings?.()}
              onSessionUpdate={onSessionUpdate}
              commands={commands}
              agents={agents}
              contextUsage={stream.contextUsage}
              tabRequest={settingsTabRequest}
              onPluginsReloaded={() => { refreshCommands(); refreshAgents() }}
              onSkillsReloaded={() => { refreshCommands() }}
            />
          </Suspense>
        )}
      </Overlay>

      <Overlay
        variant="git"
        ariaLabel="Git"
        open={gitPanelOpen}
        onClose={() => onCloseGitPanel?.()}
        renderCard={false}
        trapRefTarget="backdrop"
        focusEscapeSelector=".chat-panel"
        backdropRef={setGitOverlayOs}
      >
        <Suspense fallback={null}>
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
        </Suspense>
      </Overlay>

      {/* In-panel resume picker (variant="panel"). Column-scoped overlay
          mirroring the Settings/Git overlays: only covers this chat panel,
          not the whole app. The chosen session replaces THIS panel's slot
          via onResumeIntoPanel. The global / empty-state flow (no focused
          panel) uses the App-root modal instead, so this only mounts when
          this panel is the explicit target. */}
      {resumePresence.shouldRender && (
        <Suspense fallback={null}>
          <ResumeSessionDialog
            variant="panel"
            open={!!resumeOpen}
            defaultCwd={session.cwd}
            onResume={(id) => onResumeIntoPanel?.(id, session.id)}
            onCancel={() => onCloseResume?.()}
          />
        </Suspense>
      )}

      {/* In-panel input-history browser (Mod+Shift+H). Column-scoped overlay:
          only covers this chat panel, not the whole app. App gates `historyOpen`
          on the focused panel, so only one panel mounts it at a time. A selected
          entry is injected into THIS panel's composer via handleHistorySelect.
          Gated on historyPresence (not historyOpen directly) so the panel stays
          mounted through PanelOverlay's exit animation. */}
      {historyPresence.shouldRender && (
        <Suspense fallback={null}>
          <InputHistoryPanel
            open={!!historyOpen}
            currentSessionId={session.id}
            onSelect={handleHistorySelect}
            onClose={() => onCloseHistory?.()}
          />
        </Suspense>
      )}

      {/* Top-anchored overlay stack — non-modal, dismissible. Holds the
          session recap (when open) and the pinned "current question" header
          (when the user message of the turn in view has scrolled out of the
          viewport), stacked vertically: recap on top, pinned question
          beneath. The stack carries the absolute positioning + a 45%
          max-height cap (resolves against .chat's definite height), so
          RecapWindow drops its own absolute positioning and becomes a flex
          child; its body already scrolls, so the cap distributes gracefully
          when both children are present. `pointer-events:none` on the stack
          lets clicks fall through to the transcript where neither child is;
          each child re-enables pointer-events. */}
      <div className="chat-top-stack">
        <AnimatePresence>
          {!!recapOpen && !searchOpen && session.recap && (
            <RecapWindow
              key="recap"
              recap={session.recap}
              clearing={effectiveClearing}
              onClose={() => onCloseRecap?.()}
            />
          )}
          {effectiveShowPinned && !!pinnedUserMsg && !searchOpen && (
            <PinnedUserMessage
              key="pinned"
              text={pinnedText}
              clearing={effectiveClearing}
              userMessages={userMessages}
              activeId={pinnedUserMsg.id}
              onJumpTo={(id) => {
                const msg = userMessages.find((m) => m.id === id)
                if (msg) scrollNavRef.current?.to(msg.index)
              }}
              onClick={() => scrollNavRef.current?.prev()}
            />
          )}
        </AnimatePresence>
      </div>

      {subagentStack.length > 0 && (
        <SubagentProvider value={subagentCtxValue}>
          <SubagentOverlay
            stack={subagentStack}
            items={stream.items}
            index={stream.subagentIndex}
            onClose={closeSubagent}
            onPop={popSubagent}
            onDismiss={stream.dismissSubagent}
            isExiting={subagentClosing}
            transitionDirection={subagentTransitionDirection}
            onExited={handleSubagentExited}
            toolStatus={stream.toolStatus}
            toolResults={stream.toolResults}
            planStatus={stream.planStatus}
            planContent={stream.planContent}
            questionAnswers={stream.questionAnswers}
          />
        </SubagentProvider>
      )}

      {/* Workflow overlay — two-column phase tree + messages. Rendered when a
          Workflow card's open() fired. The record is read from the workflow
          index; if it has vanished (session reset / fork) we close the overlay
          rather than render a null panel (mirrors SubagentOverlay's guard). */}
      {workflowOpenId && workflowCtxValue.index.get(workflowOpenId) && (
        <SubagentProvider value={subagentCtxValue}>
          <WorkflowProvider value={workflowCtxValue}>
            <WorkflowOverlay
              record={workflowCtxValue.index.get(workflowOpenId)!}
              items={stream.items}
              onClose={closeWorkflow}
              isExiting={workflowClosing}
              onExited={handleWorkflowExited}
              toolStatus={stream.toolStatus}
              toolResults={stream.toolResults}
              planStatus={stream.planStatus}
              planContent={stream.planContent}
              questionAnswers={stream.questionAnswers}
            />
          </WorkflowProvider>
        </SubagentProvider>
      )}
      {/* Side Chat collapsed tab — vertical strip on the right edge,
          vertically centred. Click to re-expand the drawer. Shows a
          pulsing accent dot while the collapsed side chat is processing
          a turn so background activity is discoverable without
          re-expanding. */}
      {sideChatCollapsed && onToggleCollapseSideChat && (
        <button
          type="button"
          className={`side-chat-expand-tab${sideChatWorking ? ' working' : ''}`}
          aria-label={sideChatWorking ? 'Expand Side Chat (working)' : 'Expand Side Chat'}
          title={sideChatWorking ? 'Side Chat is working — click to view' : 'Expand Side Chat'}
          onClick={onToggleCollapseSideChat}
        >
          <IconArrowLeft size={14} />
          {sideChatWorking && <span className="side-chat-expand-tab-dot" aria-hidden />}
        </button>
      )}
    </div>
  )
})
