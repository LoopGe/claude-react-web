/** One column in the 3-up chat grid. Wraps <Chat> with a header bar that
 *  carries the close button, focus click-target, and a dormant/terminated
 *  placeholder when the session's Query isn't live. */

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { PluginContributionSlot } from '../app-plugins/PluginContributionSlot'
import { Chat } from './Chat'
import { SessionBody, errorCardState } from './SessionErrorCard'
import { DirectoryPicker } from './DirectoryPicker'
import { useLocalStorage } from '../hooks/useLocalStorage'
import { RECENT_CWDS_KEY, RECENT_CWDS_CAP_KEY, RECENT_CWDS_CAP_DEFAULT } from '../constants/recentKeys'
import { isStringArray } from '../../shared/type-guards'
import { clamp } from '../utils/clamp'
import type { ScrollNavigator } from './MessageList'
import { SideChatDrawer } from './SideChatDrawer'
import { ContextMenu } from './ContextMenu'
import { ConfirmDialog } from './ConfirmDialog'
import { WorktreeIsolationBadge } from './WorktreeIsolationBadge'
import { Tooltip } from './Tooltip'
import { api } from '../hooks/useApi'
import { useToast } from '../hooks/useToast'
import { useSessionActiveWorktree } from '../session-store/selectors'
import { useDraggable, useDroppable } from '@dnd-kit/core'
import { dndData, pointerOnlyListeners } from '../dnd/payload'
import { useGitStatus } from '../hooks/useGitStatus'
import { useSessionSynchronizer } from '../session-sync/useSessionSynchronizer'
import { usePermissionChannel } from '../hooks/usePermissionChannel'
import { useIsMobile } from '../hooks/useIsMobile'
import { useDiagnostics } from '../hooks/useDiagnostics'
import { useDelayedFlag } from '../hooks/useDelayedFlag'
import { shortenModel } from '../utils/session-status'
import { sessionTitleOrFallback } from '../utils/session-title'
import { cx } from '../utils/cx'
import { useModelOptions } from '../hooks/useModelOptions'
import { AnimatePresence } from 'motion/react'
import { ModelPicker } from './ModelPicker'
import { EffortSlider } from './EffortSlider'
import { basenameOf, initialOf } from '../utils/paths'
import { ProjectPopover } from './ProjectPopover'
import { gitChipText } from '../utils/git-chip'
import { IconCheck, IconSparkles, IconLoader, IconGauge, IconBrain, IconLayers, IconGitBranch, IconGitFork, IconEyeOff, IconMask } from './icons/ToolIcons'
import { useAgentDefinitions } from '../hooks/useAgentDefinitions'
import { PermissionModeIcon, permissionModeLabel, permissionModeShortLabel } from './permission-mode-display'
import type { EffortLevel, PermissionMode, SessionInfo, SlashCommand, ThinkingDisplay, ThinkingSetting } from '../types'
import type { Skin } from '../utils/theme'
import type { SettingsTabName } from '../local-commands'
import { PERMISSION_MODES, EFFORT_LEVELS, DEFAULT_EFFORT_LEVEL } from '../types'
import type { GitStatus } from '../../shared/git-types'
import type { MessageJumpTarget } from '../../shared/message-jump'
import type { StreamingRenderMode } from '../../shared/streaming-render-mode'
import type { ComposerSnippetsApi } from '../hooks/useComposerSnippets'

/** Chip tooltip — verbose form for users who hover before clicking.
 *  Returns a ReactNode (one <div> per line) rather than a `\n`-joined
 *  string: newlines inside HTML text collapse to spaces, so the multi-
 *  line intent was previously lost in the Tooltip bubble. Values are
 *  wrapped in `.tt-hl` (utilities.css) — a tinted mono pill that makes
 *  refs/identifiers pop out of the label text. */
function gitChipTitle(s: GitStatus): ReactNode {
  const hl = (text: string) => <span className="tt-hl">{text}</span>
  const lines = [
    <>Branch: {hl(s.detached ? 'detached HEAD' : (s.branch ?? 'unknown'))}</>,
    s.upstream ? <>Upstream: {hl(s.upstream)}</> : 'No upstream configured',
  ]
  if (s.ahead > 0 || s.behind > 0) lines.push(<>Sync: {hl(`${s.ahead} ahead, ${s.behind} behind`)}</>)
  lines.push(<>State: {hl(s.state)}</>)
  lines.push(
    <>
      Staged: {hl(String(s.staged.length))} · Unstaged: {hl(String(s.unstaged.length))} · Untracked:{' '}
      {hl(String(s.untracked.length))}
    </>,
  )
  lines.push('Click to open Git panel')
  return lines.map((line, i) => <div key={i}>{line}</div>)
}

/** Reconcile the agent's EnterWorktree intent (a name) against the git
 *  fact of what worktrees actually exist, matching by the conventional
 *  `worktree-<name>` branch or the worktree path basename. Returns the
 *  matched worktree (branch, lock state) or null when git has no such
 *  worktree yet — a timing gap right after Enter, or a stale claim. */
function worktreeMatch(
  active: { name: string },
  wts: GitStatus['linkedWorktrees'] | undefined,
): GitStatus['linkedWorktrees'][number] | null {
  if (!wts) return null
  const byBranch = wts.find((w) => w.branch === `worktree-${active.name}`)
  if (byBranch) return byBranch
  return wts.find((w) => w.path.split(/[/\\]/).filter(Boolean).pop() === active.name) ?? null
}

function worktreeChipTitle(
  match: GitStatus['linkedWorktrees'][number] | null,
): ReactNode {
  const lines = match
    ? ['Agent isolated in worktree', `Worktree: ${match.path}`, `Branch: ${match.branch ?? 'detached'}`]
    : ['Agent isolated in worktree', 'Git worktree not yet confirmed']
  if (match?.locked) lines.push(`Locked: ${match.lockMessage ?? 'yes'}`)
  lines.push('Click to view worktree changes')
  return lines.map((line, i) => <div key={i}>{line}</div>)
}

/** How long a model switch may be in flight before the chip swaps its glyph
 *  for a spinner. Ordinary switches measured on this gateway (state-dir logs,
 *  2026-10-19) run 6 ms–1.2 s, so ~1 s keeps the spinner off the bulk of them
 *  while still appearing well inside the window it exists for: a failed probe
 *  (the CLI's ~5 s deadline) and its server-side retry (~6–11 s). The switch
 *  is disabled for its whole flight regardless — this only gates the glyph, so
 *  a sub-second switch shows nothing beyond the chip's disabled styling. */
const MODEL_SWITCH_INDICATOR_DELAY_MS = 1000

/** Optimistic-update helper: POST to `apiPath`, update session on success,
 *  rollback + show error toast on failure. Returns the round-trip promise so
 *  callers can track in-flight state (the model chip's spinner); it never
 *  rejects — the failure path is the toast + rollback above. */
function commitWithRollback(
  session: SessionInfo,
  apiPath: string,
  payload: Record<string, unknown>,
  before: Partial<SessionInfo>,
  errorMsg: string,
  onSessionUpdate: (s: SessionInfo) => void,
  showError: (msg: string) => void,
) {
  return api
    .post<{ session: SessionInfo }>(apiPath, payload)
    .then((r) => onSessionUpdate(r.session))
    .catch(() => {
      showError(errorMsg)
      onSessionUpdate({ ...session, ...before } as SessionInfo)
    })
}

export interface ChatPanelProps {
  session: SessionInfo
  focused: boolean
  /** Global UI-pref defaults (server-backed). Sessions without an explicit
   *  per-session override inherit these. Forwarded to <Chat> (effective-value
   *  resolution) and <SettingsPanel> (override UI hints). */
  globalPrefs: {
    showPinnedUserMessage: boolean
    autoRecap: boolean
    toolGroupCards: boolean
    autoExpandRunningGroups: boolean
    showMessageHeaders: boolean
    streamingRenderMode: StreamingRenderMode
    firstPartyTools?: Record<string, { enabled: boolean }>
  }
  /** True when a turn has completed on this session since the user last
   *  looked at it. Rendered as a small dot next to the slot pill on
   *  non-focused open panels — so in a 2-up/3-up layout the user notices
   *  a reply landed on a sibling they aren't currently watching. Ignored
   *  when `focused` is true (the user is already looking). */
  hasUnread?: boolean
  /** True when this panel just mounted and should play its enter animation. */
  entering?: boolean
  /** Keep-alive re-show flavor of entering (320ms with a transparent hold
   *  masking Virtuoso's stale-position frames vs the fresh mount's 180ms). */
  enteringReplay?: boolean
  /** True while App is playing the /clear fade-in on this slot. Threaded
   *  through to <Chat> so TodoChecklist / MessageList / MonitorBar get their
   *  content-blur classes for the duration of the fade-in. */
  clearing?: boolean
  /** Called when the enter animation ends so the parent can clear the flag. */
  onAnimEnd?: (id: string) => void
  /** Slot number (1-indexed) in the main grid. Shown as a pill in the
   *  header so the user can tell this panel apart from the sidebar card
   *  and map it to the Ctrl+<n> shortcut. */
  slot: number
  /** False while this panel is in the keep-alive cache — forwarded to
   *  <Chat> → <MessageList> for the row-entrance replay on re-show. */
  panelVisible?: boolean
  /** External composer-focus signal from App — bumped by the mod+1/2/3
   *  slot shortcuts. Forwarded to <Chat> → <Composer> so switching panels
   *  also refocuses the target panel's composer. */
  composerFocusSignal?: number
  /** True while Ctrl/Cmd is held — paints the slot pill with a key-hint
   *  highlight so the mod+<n> mapping is discoverable. */
  showSlotHints?: boolean
  onFocus: (sessionId: string) => void
  onClose: (sessionId: string) => void
  /** Resume a dormant session directly from the panel's dormant empty-state
   *  (the "Resume" button). Mirrors the sidebar's click-to-resume path. */
  onResume?: (sessionId: string) => void
  /** Fork a terminated session from its last completed turn (the composer's
   *  choice-banner "Fork from last completed turn" button). */
  onForkFromLastCompleted?: (sessionId: string) => void
  /** Name of the session's owning group, or undefined when ungrouped.
   *  Drives the panel context-menu's close-item label: "Remove from
   *  <group>" for grouped sessions (closing a group member removes it
   *  from the group), plain "Close panel" for ungrouped ones. */
  groupLabel?: string
  /** Deactivate this session's group: close every open panel in the group
   *  while preserving membership. Shown in the panel context menu as
   *  "Close all panels in <group>" (only for grouped sessions). Undefined
   *  when the session is ungrouped. */
  onCloseGroupPanels?: () => void
  /** Delete the session entirely (App.handleDelete). Offered as a
   *  "Delete session" item in the panel context menu, mirroring the
   *  sidebar's Delete. */
  onDelete?: (sessionId: string) => void
  onSessionUpdate: (s: SessionInfo) => void
  /** Panel-swap and sidebar-card-accept drops are resolved by the App-level
   *  DndContext's onDragEnd (the panel here only provides the draggable
   *  header handle and the droppable surface). */
  /** Open the resume picker scope to this panel — the chosen session
   *  replaces this panel's slot. Triggered by the `/resume` local command. */
  onRequestResumeForPanel: (panelSessionId: string) => void
  /** When true, the resume picker renders as an in-panel overlay on top of
   *  this chat panel (column-scoped, mirroring the Settings/Git overlays).
   *  The chosen session replaces THIS panel's slot. Null-target / global
   *  resume still uses the App-root modal, not this prop. */
  resumeOpen?: boolean
  /** Resume the picked session INTO the panel whose id is `panelSessionId`.
   *  Passed the hosting panel's id so <Chat> doesn't need to know it. */
  onResumeIntoPanel?: (pickedId: string, panelSessionId: string) => void
  /** Close the in-panel resume overlay (Esc / backdrop click). */
  onCloseResume?: () => void
  /** When true, render the input-history browser as an in-panel overlay
   *  (Mod+Shift+H), scoped to this panel. App gates this on the focused
   *  panel so only one panel shows it at a time. */
  historyOpen?: boolean
  /** Close the in-panel input-history overlay (Esc / backdrop / select). */
  onCloseHistory?: () => void
  /** `/clear` this panel — the server detaches the pre-clear conversation
   *  and returns a fresh session; App swaps the panel id. Triggered by the
   *  `/clear` local command. */
  onClearSession: (panelSessionId: string) => void
  /** `/handoff` this panel — the server summarizes the conversation and
   *  returns a fresh seeded continuation session; App swaps the panel id.
   *  Triggered by the `/handoff` local command. */
  onHandoffSession: (panelSessionId: string) => void
  /** True while this panel's /handoff POST is in flight (App-owned state).
   *  Drives Chat's "Handing off…" pill + composer lockout. */
  handoffing?: boolean
  /** Discard every message after a given assistant message (right-click
   *  "discard from here"). Server forks from the anchor and swaps the
   *  panel id; `deleteOriginal` also unlinks the source transcript. */
  onDiscard?: (sessionId: string, fromAssistantUuid: string, deleteOriginal: boolean) => Promise<void> | void
  /** Open this panel's settings overlay on a specific tab. Triggered by the
   *  `/mcp` local command. */
  onOpenSettingsTab: (panelSessionId: string, tab: SettingsTabName) => void
  /** Open the in-app help dialog with the given slash commands. Triggered by
   *  the `/help` local command. */
  onShowHelp: (commands: SlashCommand[]) => void
  /** Side Chat session. Undefined when no Side Chat is active for this
   *  panel. Passed regardless of collapsed state so the stream hook
   *  stays alive. */
  sideChatSession?: SessionInfo
  /** True when the Side Chat drawer is hidden but the session is alive. */
  sideChatCollapsed?: boolean
  /** Number of new messages since collapse (for the collapsed badge). */
  sideChatUnread?: number
  /** Toggle between expanded drawer and collapsed badge. */
  onToggleCollapseSideChat?: () => void
  /** Close the Side Chat and delete the ephemeral session. */
  onCloseSideChat?: () => void
  /** Create a Side Chat from this session. */
  onSideChat?: (sessionId: string) => void
  /** Nonce-stamped request to switch the settings tab (forwarded to <Chat> →
   *  SettingsPanel). Null when no request targets this panel. */
  settingsTabRequest?: { tab: SettingsTabName; nonce: number } | null
  messageJumpTarget?: MessageJumpTarget | null
  /** When true, render the Settings overlay on top of this panel. */
  settingsOpen?: boolean
  onOpenSettings: (sessionId: string) => void
  onCloseSettings: () => void
  /** When true, render the Git overlay on top of this panel. Mutually
   *  exclusive with `settingsOpen` — opening one closes the other (the
   *  parent App enforces this via shared dispatch). */
  gitPanelOpen?: boolean
  onOpenGitPanel: (sessionId: string) => void
  onCloseGitPanel: () => void
  /** When true, render the Tasks overlay on top of this panel. Mutually
   *  exclusive with `settingsOpen` / `gitPanelOpen` (parent App enforces). */
  tasksPanelOpen?: boolean
  onOpenTasksPanel: (sessionId: string) => void
  onCloseTasksPanel: () => void
  /** When true, render the Worktree-changes overlay on top of this panel.
   *  Mutually exclusive with `settingsOpen` / `gitPanelOpen` /
   *  `tasksPanelOpen` (parent App enforces via the same shared dispatch). */
  worktreeOpen?: boolean
  onOpenWorktree: (sessionId: string) => void
  onCloseWorktree: () => void
  /** Forwarded to <Chat> so it can register its interrupt callback with
   *  the parent App. Enables ESC shortcut to trigger the same code-path
   *  as the Composer's interrupt button. */
  onRegisterInterrupt?: (sessionId: string, fn: () => void) => () => void
  /** Forwarded to <Chat> so it can register its recap-refresh callback. */
  onRegisterRecap?: (sessionId: string, fn: () => void) => () => void
  /** Forwarded to <Chat> so it can register its background-tasks callback.
   *  Enables the Alt+B shortcut in App. */
  onRegisterBackground?: (sessionId: string, fn: () => void) => () => void
  /** Forwarded to <Chat> so it can register its optimistic turn-active
   *  getter. App's escape handler consults it so an Esc right after a
   *  send (before the server flips working=true) interrupts the turn
   *  instead of opening the resume picker. */
  onRegisterTurnActive?: (sessionId: string, fn: () => boolean) => () => void
  /** Forwarded to <Chat> so it can register its transcript navigator.
   *  Enables the Alt+↑ / Alt+↓ prev/next user-message shortcuts in App. */
  onRegisterScrollNav?: (sessionId: string, nav: ScrollNavigator) => () => void
  /** Forwarded to <Chat>. Chat calls it whenever it fires an interrupt
   *  (its own funnel covers the Composer button), so App can arm the
   *  post-interrupt Esc suppression window for every interrupt path —
   *  not just the keyboard one. */
  onInterruptFired?: (sessionId: string) => void
  /** True while the session is being resumed from dormancy. */
  isResuming?: boolean
  /** Global composer-snippets api (single shared instance owned by App).
   *  Forwarded to the inner <Composer> via <Chat>. */
  snippets: ComposerSnippetsApi
  /** Open the global snippets manager dialog (owned by App). */
  onOpenSnippetsManager: () => void
  /** Capture composer text and ask App to prompt for a snippet label. */
  onSaveCurrentAsSnippet: (content: string) => void
  /** Active skin, forwarded to <Chat> → <TodoChecklist> so its markers can
   *  switch to square checkboxes under the High-Contrast skin. */
  skin?: Skin
  /** Open the uploads manager dialog (App-owned state). */
  onOpenUploads?: () => void
}

export const ChatPanel = memo(function ChatPanel({
  session,
  focused,
  globalPrefs,
  hasUnread,
  entering,
  enteringReplay,
  onAnimEnd,
  slot,
  composerFocusSignal,
  showSlotHints,
  onFocus,
  panelVisible,
  onClose,
  onResume,
  onForkFromLastCompleted,
  groupLabel,
  onCloseGroupPanels,
  onDelete,
  onSessionUpdate,
  onRequestResumeForPanel,
  resumeOpen,
  onResumeIntoPanel,
  onCloseResume,
  historyOpen,
  onCloseHistory,
  onClearSession,
  onHandoffSession,
  handoffing,
  onDiscard,
  onOpenSettingsTab,
  onShowHelp,
  sideChatSession,
  sideChatCollapsed,
  sideChatUnread: _sideChatUnread,
  onToggleCollapseSideChat,
  onCloseSideChat,
  onSideChat,
  settingsTabRequest,
  clearing,
  messageJumpTarget,
  settingsOpen,
  onOpenSettings,
  onCloseSettings,
  gitPanelOpen,
  onOpenGitPanel,
  onCloseGitPanel,
  tasksPanelOpen,
  onOpenTasksPanel,
  onCloseTasksPanel,
  worktreeOpen,
  onOpenWorktree,
  onCloseWorktree,
  onRegisterInterrupt,
  onRegisterRecap,
  onRegisterBackground,
  onRegisterTurnActive,
  onRegisterScrollNav,
  onInterruptFired,
  isResuming,
  snippets,
  onOpenSnippetsManager,
  onSaveCurrentAsSnippet,
  skin,
  onOpenUploads,
}: ChatPanelProps) {
  // Panel swap via drag is a multi-panel desktop affordance; mobile is
  // single-panel and touch can't drag, so disable the drag handle there
  // (the panel stays a drop target — harmless on touch).
  const isMobile = useIsMobile()
  const diagnostics = useDiagnostics(session.id, errorCardState(session) !== null)
  // New-session project picker (the error card's relocation affordance):
  // recents are the same localStorage MRU the new-session dialog maintains.
  const [recentCwds, setRecentCwds] = useLocalStorage<string[]>(RECENT_CWDS_KEY, [], { validate: isStringArray })
  const [recentCwdsCapRaw] = useLocalStorage<number>(RECENT_CWDS_CAP_KEY, RECENT_CWDS_CAP_DEFAULT)
  const recentCwdsCap = clamp(Math.round(recentCwdsCapRaw), 3, 50)
  const rememberCwd = (raw: string) => {
    const v = raw.trim()
    if (!v) return
    setRecentCwds((prev) => [v, ...prev.filter((x) => x !== v)].slice(0, recentCwdsCap))
  }
  const forgetCwd = (path: string) => setRecentCwds((prev) => prev.filter((c) => c !== path))
  const [cwdPickerOpen, setCwdPickerOpen] = useState(false)
  const handleSelectCwd = (path: string) => {
    // Record only after the relocation lands — a failed PATCH must not
    // pollute the shared recents list with a dead path.
    void api
      .patch(`/sessions/${session.id}`, { cwd: path })
      .then(() => rememberCwd(path))
      .catch((e) => {
        toast.error(`Couldn't change the workspace: ${(e as Error).message}`)
      })
  }
  // dnd-kit wiring: the header is the drag handle for panel swaps; the whole
  // panel section is the drop target (accepts another panel → swap, or a
  // sidebar card → replace this slot). Resolution lives in App's DndContext.
  const panelDrag = useDraggable({
    id: `panel-drag-${session.id}`,
    disabled: isMobile,
    data: dndData({ kind: 'main-panel', id: session.id }),
  })
  const panelDrop = useDroppable({
    id: `panel-drop-${session.id}`,
    data: dndData({ kind: 'main-panel', id: session.id }),
  })
  // Stable combined node ref for the section (draggable + droppable). The
  // draggable NODE is the whole panel: dnd-kit aligns the drag ghost and
  // measures the drop animation's target from this node's rect, and the
  // ghost content is a whole-panel clone — anchoring the node to the HEADER
  // (the old wiring) made the clone render at the header's rect, displacing
  // the ghost downward by the panel's 2px top border for the entire drag: a
  // pop at lift and a matching few-px snap at the drop handoff. The header
  // stays the drag HANDLE via setActivatorNodeRef (activator event /
  // constraints). An inline arrow here would instead detach/reattach both
  // node refs on EVERY render of this heaviest component — transiently
  // nulling them mid-commit, drag included — so the combined callback is
  // memoized; both dnd-kit setters are stable, so it never churns.
  const panelNodeRef = useCallback((el: HTMLElement | null) => {
    panelDrop.setNodeRef(el)
    panelDrag.setNodeRef(el)
  }, [panelDrop.setNodeRef, panelDrag.setNodeRef])
  // A pickup within the panel-enter window (open → grab fast) must cancel
  // the entrance animation: its keyframes own `opacity` (fill both) and would
  // override the source-dim until they end — the drag would read as two full
  // panels, exactly what the dim prevents. onAnimEnd clears the entering flag
  // through App's existing channel; `animationend` would never fire for a
  // cancelled animation.
  useEffect(() => {
    if (panelDrag.isDragging && (entering || enteringReplay)) onAnimEnd?.(session.id)
  }, [panelDrag.isDragging, entering, enteringReplay, onAnimEnd, session.id])
  /** Tracks the `generatedAt` of the recap the user has dismissed. When it
   *  matches the current session.recap.generatedAt, the floating window
   *  stays hidden; a NEW recap (different generatedAt) auto-reopens it.
   *  The stamp is stable across one generation's pending → ready/error
   *  lifecycle (stamped at dispatch server-side), so a card closed while
   *  LOADING also stays closed when that generation completes.
   *  Null = no dismissal in effect → window shows whenever a recap exists.
   *  Reset on session switch (see effect below). */
  const [recapDismissedAt, setRecapDismissedAt] = useState<number | null>(null)
  useEffect(() => { setRecapDismissedAt(null) }, [session.id])
  const recapOpen =
    !!session.recap &&
    (recapDismissedAt === null || session.recap.generatedAt !== recapDismissedAt)
  /** Anchor for the model picker dropdown. Non-null = picker visible. `source`
   *  is the chip itself, which the portalled picker needs to stamp this
   *  panel as the surface's owner (see `markPortaledSurface`); required so
   *  no caller can drop the ownership stamp by accident. */
  const [modelMenu, setModelMenu] = useState<{ x: number; y: number; source: Element | null } | null>(null)
  /** In-flight model switch, as the LABEL to show while it runs (null = none).
   *  Covers both the model and the model-group switch — they POST to different
   *  routes but both change the session's model. Kept as a label rather than a
   *  boolean so the chip's tooltip can name the target; the spinner itself is
   *  `modelSwitching` below, which waits out the flash-prevention delay. */
  const [modelSwitchLabel, setModelSwitchLabel] = useState<string | null>(null)
  const modelSwitching = useDelayedFlag(modelSwitchLabel !== null, MODEL_SWITCH_INDICATOR_DELAY_MS)
  /** Anchor for the permission-mode menu. Non-null = menu visible. A
   *  custom menu (rather than a native <select>) gives us full control
   *  over dark-theme styling; the native control's dropdown surface
   *  can't be restyled across browsers. */
  const [permMenu, setPermMenu] = useState<{ x: number; y: number } | null>(null)
  /** Anchor for the effort-level menu. Non-null = menu visible. */
  const [effortMenu, setEffortMenu] = useState<{ x: number; y: number } | null>(null)
  const [thinkingMenu, setThinkingMenu] = useState<{ x: number; y: number } | null>(null)
  /** Anchor for the persona (main-thread agent) menu. Non-null = visible. */
  const [personaMenu, setPersonaMenu] = useState<{ x: number; y: number } | null>(null)
  // Confirmation dialog for destructive panel-menu actions (Delete session).
  // Mirrors SessionList's confirm plumbing so the panel menu's Delete uses
  // the same ConfirmDialog + busy state as the sidebar's.
  const [confirmState, setConfirmState] = useState<{
    title: string
    message: ReactNode
    confirmLabel: string
    destructive?: boolean
    onConfirm: () => void | Promise<void>
  } | null>(null)
  const [confirmBusy, setConfirmBusy] = useState(false)
  const handleAskConfirm = useCallback((config: {
    title: string
    message: ReactNode
    confirmLabel: string
    destructive?: boolean
    onConfirm: () => void | Promise<void>
  }) => {
    setConfirmState({
      title: config.title,
      message: config.message,
      confirmLabel: config.confirmLabel,
      destructive: config.destructive,
      onConfirm: async () => {
        setConfirmBusy(true)
        try {
          await config.onConfirm()
        } finally {
          setConfirmBusy(false)
          setConfirmState(null)
        }
      },
    })
  }, [])
  /** Global toast hub. Model/permission failures used to render an
   *  inline panel banner; they now surface as right-bottom toasts. */
  const toast = useToast()
  // Options for the model picker. We only start fetching when the user
  // opens the picker — no need to ping /sessions/:id/models + /config for
  // every panel that happens to be open. The hook keeps recents from
  // localStorage as a fallback so the list isn't empty during the brief
  // fetch window.
  const modelOptions = useModelOptions(session.id, !!modelMenu && !!session.running, session.profileId)
  // Custom agent definitions, for the persona chip's menu. Fetched once on
  // mount (a small list) and re-fetched when the menu opens, so a definition
  // added or toggled elsewhere in the app shows up without a remount.
  const { agents: agentDefs, refresh: refreshAgentDefs } = useAgentDefinitions()
  const enabledAgentDefs = useMemo(() => agentDefs.filter((a) => a.enabled), [agentDefs])
  // Hidden when there's nothing to pick AND no persona to show — an empty
  // menu would be a dead control. A session whose persona was later disabled
  // still shows the chip so the user can see (and clear) what it's running as.
  const personaVisible = enabledAgentDefs.length > 0 || !!session.agent
  const chipsDisabled = !session.running || session.terminated
  // Git status powers BOTH the header chip (always-visible summary) and
  // the GitPanel overlay (mounted inside <Chat>). Hoisting the hook here
  // means a single fetch satisfies both consumers; the panel receives
  // status via prop drilling rather than re-fetching on open. Passing
  // session.id wires the git-snapshot WS sink (frames carry the full
  // status; no refetch).
  // Git status is a read-only filesystem probe — it's valid whether or not
  // the SDK subprocess is mid-turn. Gating on session.running made the chip
  // vanish (and never return) the moment a session went idle, because the
  // hook resets data to null when disabled. Only the cwd matters here.
  const gitStatus = useGitStatus(session.cwd, session.id, { enabled: !!session.cwd })

  // Project chip (header row 2) + its detail popover. Replaces the old cwd
  // Tooltip with a New-session-style project display (avatar + basename);
  // clicking opens ProjectPopover, which carries the full path and the
  // Finder/Terminal/copy actions.
  const [projectOpen, setProjectOpen] = useState(false)
  const projectChipRef = useRef<HTMLButtonElement | null>(null)

  // Agent-driven worktree isolation state, folded from EnterWorktree /
  // ExitWorktree in this session's transcript, reconciled against the git
  // fact (what worktrees actually exist + their lock state).
  const activeWorktree = useSessionActiveWorktree(session.id)
  const activeWorktreeMatch = useMemo(() => {
    if (!activeWorktree) return null
    const wts = gitStatus.data?.isRepo === true ? gitStatus.data.linkedWorktrees : undefined
    return worktreeMatch(activeWorktree, wts)
  }, [activeWorktree, gitStatus.data])
  // Data for the Worktree-changes overlay. Precomputed here (the header chip
  // already owns the match) and threaded into <Chat>, which hosts the overlay
  // inside .chat so its .git-overlay fills the body below the header — the
  // same positioning as the Git overlay. Memoized so Chat's memo() doesn't
  // re-render on every parent render when nothing relevant changed.
  const worktreeView = useMemo(
    () =>
      activeWorktree
        ? {
            cwd: activeWorktreeMatch?.path ?? null,
            branchName: activeWorktreeMatch?.branch ?? null,
            baseRef: gitStatus.data?.isRepo === true ? (gitStatus.data.branch ?? 'main') : 'main',
            displayName: activeWorktree.name,
          }
        : null,
    [activeWorktree, activeWorktreeMatch, gitStatus.data],
  )
  // Close the Worktree overlay the moment the worktree it was showing goes
  // away (ExitWorktree / transcript cleared). The open flag lives at the App
  // level (settings/git mutual-exclusion group); without this it would stay
  // latched and a later EnterWorktree in the same session would auto-reopen
  // an overlay the user never asked to open.
  useEffect(() => {
    if (worktreeOpen && !activeWorktree) onCloseWorktree()
  }, [worktreeOpen, activeWorktree, onCloseWorktree])

  // Side Chat synchronization + permission lifecycle — owned HERE (at the
  // panel level) so the WS subscription stays alive across collapse/expand.
  // The SideChatDrawer unmounts on collapse; if the synchronizer lived in the
  // drawer, each expand would re-subscribe and re-fetch the tail. Instead
  // ChatPanel calls useSessionSynchronizer with the effective side chat id
  // and passes only the narrow `paging` (for OlderHistoryFloat) + the
  // permission channel down to the drawer.
  // useSessionSynchronizer is fully inert on an empty sessionId (no subscribe,
  // no fetch, no store retain), so this is free when no side chat exists —
  // matching the old useChatStream gating.
  const effectiveSideChatId = sideChatSession?.id ?? ''
  const sideChatPermissions = usePermissionChannel(effectiveSideChatId)
  const sideChatPaging = useSessionSynchronizer(
    effectiveSideChatId,
    {
      onRequest: sideChatPermissions.onRequest,
      onResolved: sideChatPermissions.onResolved,
      onCleared: sideChatPermissions.clearError,
    },
    sideChatSession?.running ?? false,
    sideChatSession?.terminated ?? false,
  )

  const commitModel = (next: string) => {
    const value = next.trim()
    setModelMenu(null)
    if (value === (session.model ?? '')) return
    // One switch at a time. The chip's `disabled` covers the visible case, but
    // this guard is the authoritative stop: a second pick that arrived in the
    // same tick would still pass a stale `disabled`, and a switch started from
    // SettingsPanel's model select is invisible to this component entirely.
    // Without it the overlap issues a second POST and then clears the shared
    // label when IT settles, dropping the indicator while the first is still
    // in flight.
    if (modelSwitchLabel !== null) return
    setModelSwitchLabel(shortenModel(value))
    void commitWithRollback(
      session,
      `/sessions/${session.id}/model`,
      { model: value || undefined },
      { model: session.model },
      `Couldn't change model`,
      onSessionUpdate,
      toast.error,
    ).finally(() => setModelSwitchLabel(null))
  }

  const commitGroup = (groupId: string) => {
    setModelMenu(null)
    if (groupId === (session.modelGroupId ?? '')) return
    if (modelSwitchLabel !== null) return
    setModelSwitchLabel(
      modelOptions.modelGroups.find((g) => g.id === groupId)?.name ?? groupId,
    )
    void commitWithRollback(
      session,
      `/sessions/${session.id}/model-group`,
      { groupId },
      // Restore both the resolved main model AND the group reference on
      // failure — a group switch changes both on the session.
      { model: session.model, modelGroupId: session.modelGroupId },
      `Couldn't change model group`,
      onSessionUpdate,
      toast.error,
    ).finally(() => setModelSwitchLabel(null))
  }

  const commitPermissionMode = (mode: PermissionMode) => {
    if (mode === (session.permissionMode ?? 'default')) return
    commitWithRollback(
      session,
      `/sessions/${session.id}/permission-mode`,
      { mode },
      { permissionMode: session.permissionMode },
      `Couldn't change permission mode`,
      onSessionUpdate,
      toast.error,
    )
  }

  const commitFastMode = () => {
    const next = !(session.fastMode ?? false)
    commitWithRollback(
      session,
      `/sessions/${session.id}/fast-mode`,
      { enabled: next },
      { fastMode: session.fastMode },
      `Couldn't toggle fast mode`,
      onSessionUpdate,
      toast.error,
    )
  }

  const commitEffortLevel = (level: EffortLevel) => {
    // Don't close the popover here — the slider stays open so the user can
    // drag across stops; dismissal is via outside-click / Escape (owned by
    // EffortSlider). Guard against a no-op commit when the level is unchanged.
    if (level === (session.effortLevel ?? DEFAULT_EFFORT_LEVEL)) return
    // Optimistically update the session so the (controlled) slider thumb
    // follows the drag instantly. commitWithRollback reconciles to the
    // server's response and rolls back to `before` if the POST fails.
    onSessionUpdate({ ...session, effortLevel: level })
    commitWithRollback(
      session,
      `/sessions/${session.id}/effort-level`,
      { level },
      { effortLevel: session.effortLevel },
      `Couldn't change effort level`,
      onSessionUpdate,
      toast.error,
    )
  }
  /** Switch the MAIN-THREAD agent (persona) — its system prompt, model and
   *  tool restrictions. `null` clears it back to a plain session.
   *
   *  Not the same thing as "Run as agent" (RunAsAgentControl), which asks the
   *  model to DELEGATE a task to a subagent. This changes who the main
   *  conversation itself is. */
  const commitAgent = (name: string | null) => {
    setPersonaMenu(null)
    if ((name ?? '') === (session.agent ?? '')) return
    commitWithRollback(
      session,
      `/sessions/${session.id}/agent`,
      { agent: name },
      { agent: session.agent },
      `Couldn't change agent`,
      onSessionUpdate,
      toast.error,
    )
  }

  const effortLevel = session.effortLevel ?? DEFAULT_EFFORT_LEVEL
  /** Current thinking display mode, or undefined when unset / thinking off. */
  const displayOf = (t: ThinkingSetting | undefined): ThinkingDisplay | undefined =>
    t && t.type !== 'disabled' ? t.display : undefined
  const currentDisplay = displayOf(session.thinking)

  /** Attach a display mode (no-op when thinking is off — the disabled variant
   *  carries no display, matching SDK ThinkingDisabled). */
  const withDisplay = (t: ThinkingSetting, display: ThinkingDisplay): ThinkingSetting =>
    t.type === 'disabled' ? t
      : t.type === 'adaptive' ? { type: 'adaptive', display }
      : { type: 'enabled', budgetTokens: t.budgetTokens, display }

  /** Strip the display mode — the "use default" choice. */
  const withoutDisplay = (t: ThinkingSetting): ThinkingSetting =>
    t.type === 'disabled' ? t
      : t.type === 'adaptive' ? { type: 'adaptive' }
      : { type: 'enabled', budgetTokens: t.budgetTokens }

  /** Carry the current display onto a budget/type change so switching budget
   *  never silently resets the user's display choice. */
  const preserveDisplay = (next: ThinkingSetting): ThinkingSetting =>
    next.type !== 'disabled' && next.display === undefined && currentDisplay
      ? { ...next, display: currentDisplay }
      : next

  const commitThinking = (setting: ThinkingSetting, opts?: { clearDisplay?: boolean }) => {
    const prev = session.thinking
    if (
      prev != null &&
      displayOf(setting) === displayOf(prev) &&
      ((setting.type === 'adaptive' && prev.type === 'adaptive') ||
        (setting.type === 'disabled' && prev.type === 'disabled') ||
        (setting.type === 'enabled' && prev.type === 'enabled' && prev.budgetTokens === setting.budgetTokens))
    ) return
    onSessionUpdate({ ...session, thinking: setting })
    commitWithRollback(
      session,
      `/sessions/${session.id}/thinking`,
      { thinking: setting, clearDisplay: opts?.clearDisplay === true },
      { thinking: session.thinking },
      `Couldn't change thinking config`,
      onSessionUpdate,
      toast.error,
    )
  }
  // A LIVE display switch is only expressible with a concrete token budget
  // (setMaxThinkingTokens(tokens, display)); a bare {type:'enabled'} — no
  // budget, accepted at create — has none, so the reasoning items would 400
  // on such a session. Hide the section there instead of shipping dead
  // buttons. (Everything else — unset, adaptive, budgeted enabled — passes.)
  const reasoningSwitchable =
    session.thinking?.type !== 'enabled' || session.thinking.budgetTokens != null
  // Thinking chip gating (three-state like effort): undefined capability →
  // show the chip (fail-open); false → hide it. The chip label shows the
  // effective setting — Auto (model decides) unless the user pinned Off or a
  // token budget.
  const thinkingVisible = session.thinkingSupported !== false
  const thinkingLabel = session.thinking == null || session.thinking.type === 'adaptive'
    ? 'auto'
    : session.thinking.type === 'disabled'
      ? 'off'
      : `${Math.round((session.thinking.budgetTokens ?? 0) / 1024)}k`
  const THINKING_BUDGETS = [4096, 8192, 16384, 32768] as const
  // Effort chip gating from the model's reported capability (three-state):
  //   undefined → capability unknown → offer all 5 (fallback, chip visible)
  //   []        → model doesn't support effort → hide chip
  //   [subset]  → offer only the supported levels
  const effortCaps = session.effortLevels
  const effortVisible = effortCaps === undefined || effortCaps.length > 0
  const effortChoices = effortCaps && effortCaps.length > 0 ? effortCaps : EFFORT_LEVELS

  const permMode = session.permissionMode ?? 'default'
  /** Track the previous mode for the badge slide-out transition (the
   *  mode switch no longer flashes the header — colours were removed).
   *  Runs in a layout effect so the transition is in place before the
   *  first paint — otherwise the new label would flash one frame at its
   *  natural width and the trailing chips would already have shifted. */
  const prevPermModeRef = useRef(permMode)
  const [modeTransitionFrom, setModeTransitionFrom] = useState<PermissionMode | null>(null)
  useLayoutEffect(() => {
    if (prevPermModeRef.current !== permMode) {
      setModeTransitionFrom(prevPermModeRef.current)
      prevPermModeRef.current = permMode
    }
  }, [permMode])
  /** Mode labels vary in width ("ask" vs "accept edits"), so the
   *  wrap would otherwise snap to the new width the instant the label
   *  swaps and teleport every chip after it (fast, effort, model). On a
   *  transition we pin the wrap to the OLD width on the first painted
   *  frame, then glide it to the NEW width — that animates BOTH
   *  directions (narrowing glides left, widening glides right). Overflow
   *  is clipped while the width is pinned so the wider incoming label
   *  can't overlap the chips after it. */
  const modeWrapRef = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    if (modeTransitionFrom == null) return
    const wrap = modeWrapRef.current
    const incoming = wrap?.querySelector<HTMLElement>('.chat-panel-mode-badge.mode-slide-in')
    if (!wrap || !incoming) return
    const newW = incoming.getBoundingClientRect().width
    const outgoing = wrap.querySelector<HTMLElement>('.chat-panel-mode-badge.mode-slide-out')
    const oldW = outgoing ? outgoing.getBoundingClientRect().width : newW
    wrap.style.width = `${oldW}px`
    wrap.style.overflow = 'hidden'
    // Glide to the new width on the next frame. Guard on the same incoming
    // node so a stale rAF from a rapid A→B→C switch can't write a wrong
    // width.
    const raf = requestAnimationFrame(() => {
      if (wrap.querySelector('.chat-panel-mode-badge.mode-slide-in') === incoming) {
        wrap.style.width = `${newW}px`
      }
    })
    return () => {
      cancelAnimationFrame(raf)
      wrap.style.width = ''
      wrap.style.overflow = ''
    }
  }, [modeTransitionFrom])
  // Fast mode chip.
  //  - Visibility is gated on the SDK reporting a runtime state: undefined
  //    means the current model doesn't support fast mode (the SDK omits the
  //    field), so we hide the chip entirely.
  //  - cooldown is a real runtime state (rate-limited) and must NOT be masked
  //    by the optimistic intent — it takes precedence.
  //  - on/off appearance follows the user INTENT (session.fastMode) so a
  //    click flips the chip instantly, even while idle (the SDK only reports
  //    fastModeState on the next init/result). The runtime state catches up
  //    and the POST response / WS update keeps intent authoritative.
  const fastState = session.fastModeState
  const fastVisible = fastState !== undefined
  const fastCooldown = fastState === 'cooldown'
  const fastOn = !fastCooldown && (session.fastMode ?? false)

  return (
    <section
      ref={panelNodeRef}
      data-panel-id={session.id}
      className={cx(
        'chat-panel',
        focused ? 'focused' : '',
        enteringReplay ? 'entering-replay' : entering ? 'entering' : '',
        // The lifted ghost IS this panel's frozen clone — recede the source
        // into a quiet hole for the drag (same .dnd-source-dim language the
        // sidebar cards use), so the screen doesn't read as two panels.
        panelDrag.isDragging ? 'dnd-source-dim' : '',
        `mode-${permMode}`,
      )}
      onAnimationEnd={(e) => {
        if ((entering || enteringReplay) && e.target === e.currentTarget) onAnimEnd?.(session.id)
      }}
      onMouseDownCapture={(e) => {
        // Focus on any mousedown inside the panel (capture phase so we win
        // against children). Clicking the close button still works because
        // onClose stops propagation, but focusing on the way down is harmless.
        if (!focused) onFocus(session.id)
        void e
      }}
    >
      <div
        ref={panelDrag.setActivatorNodeRef}
        className="chat-panel-header"
        // The header is the drag handle for panel swaps — the body stays
        // non-draggable so textarea text selection and scrolling work.
        // Listeners only (no dnd-kit a11y attributes): the header already
        // contains focusable controls and the panel reorder has keyboard
        // alternatives in the panel context menu. The KeyboardSensor
        // activator is stripped — Enter/Space on the header's buttons must
        // activate them, not start a panel drag.
        {...(isMobile ? {} : pointerOnlyListeners(panelDrag.listeners))}
      >
        <div className="chat-panel-header-row1">
        <Tooltip label={`Slot ${slot} · Ctrl/Cmd+${slot} to focus`} placement="bottom" align="start">
          <span
            className={`chat-panel-slot ${focused ? 'focused' : ''} ${showSlotHints ? 'key-hint' : ''}`}
            aria-label={`slot ${slot}`}
          >
            {slot}
          </span>
        </Tooltip>
        {hasUnread && !focused && (
          <Tooltip label="New turn completed while this panel wasn't focused" placement="bottom" align="start">
            <span
              className="chat-panel-unread"
              role="img"
              aria-label="unread"
            />
          </Tooltip>
        )}
        <Tooltip
          // Full session title first: the header truncates long titles, so
          // hover is the only way to read the whole name. The cwd follows.
          // The bubble wraps within max-width, so a long title stays inside.
          label={
            sessionTitleOrFallback(session)
            + (session.cwd ? ` · ${session.cwd}` : '')
          }
          placement="bottom"
          align="start"
        >
          <span className="chat-panel-title">{sessionTitleOrFallback(session)}</span>
        </Tooltip>
        {/* Permission-mode control. Doubles as the at-a-glance cue (the
            user's eye lands on the title first) and the switch control —
            clicking opens the mode menu. Color-coded for non-default
            modes; muted/neutral in default mode so it reads as a quiet
            control rather than a warning. */}
        <Tooltip label={`Permission mode: ${permissionModeLabel(permMode)} · click to change`} placement="bottom">
          <span
            ref={modeWrapRef}
            className="chat-panel-mode-badge-wrap"
            onMouseDown={(e) => e.stopPropagation()}
          >
            {modeTransitionFrom != null && (
              <span
                key={`out-${modeTransitionFrom}`}
                className={`chat-panel-mode-badge mode-${modeTransitionFrom} mode-slide-out`}
                aria-hidden
              >
                <PermissionModeIcon mode={modeTransitionFrom} />
                <span className="chat-panel-mode-label"><span>{permissionModeShortLabel(modeTransitionFrom)}</span></span>
              </span>
            )}
            <button
              type="button"
              key={`mode-${permMode}`}
              className={`chat-panel-mode-badge mode-${permMode}${modeTransitionFrom != null ? ' mode-slide-in' : ''}${permMenu ? ' mode-expanded' : ''}`}
              disabled={chipsDisabled}
              aria-label={`Permission mode: ${permissionModeLabel(permMode)} · click to change`}
              onAnimationEnd={() => setModeTransitionFrom(null)}
              onClick={(e) => {
                e.stopPropagation()
                const rect = (e.currentTarget as HTMLButtonElement).getBoundingClientRect()
                setPermMenu({ x: rect.left, y: rect.bottom + 4 })
              }}
            >
              <PermissionModeIcon mode={permMode} />
              <span className="chat-panel-mode-label"><span>{permissionModeShortLabel(permMode)}</span></span>
            </button>
          </span>
        </Tooltip>
        {/* Fast-mode control. Only shown when the SDK reports a fast-mode
            runtime state for the current model (undefined → model doesn't
            support it → chip hidden). 'cooldown' means the speedup is
            rate-limited and temporarily inactive, so we disable the toggle
            and explain why. Clicking flips the persisted intent. */}
        {fastVisible && (
          <Tooltip
            label={
              fastCooldown
                ? 'Fast mode: rate-limited (cooldown) · resumes automatically'
                : `Fast mode: ${fastOn ? 'on' : 'off'} · Opus-only · faster output, premium pricing · click to toggle`
            }
            placement="bottom"
          >
            <button
              type="button"
              className={`chat-panel-fast-badge${fastOn ? ' fast-on' : ''}${fastCooldown ? ' fast-cooldown' : ''}`}
              disabled={chipsDisabled || fastCooldown}
              aria-pressed={fastOn}
              aria-label={`Fast mode: ${fastState} · click to toggle`}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                commitFastMode()
              }}
            >
              <IconGauge size={13} aria-hidden />
              <span className="chat-panel-fast-label"><span>{fastCooldown ? 'cooldown' : 'fast'}</span></span>
            </button>
          </Tooltip>
        )}
        {/* Effort-level control. Shown when the current model supports
            effort (or its capability is unknown → fallback to offering all
            5). Hidden only when the SDK explicitly reports no effort support
            (effortLevels === []). The menu lists the supported subset, or all
            5 when capability is unknown. Chip shows the active level,
            defaulting to 'high'. */}
        {effortVisible && (
          <Tooltip
            label={`Effort: ${effortLevel} · controls reasoning depth & token spend · click to change`}
            placement="bottom"
          >
            <button
              type="button"
              key={`effort-${effortLevel}`}
              className={`chat-panel-effort-badge effort-${effortLevel}${effortMenu ? ' effort-expanded' : ''}`}
              disabled={chipsDisabled}
              aria-haspopup="menu"
              aria-expanded={!!effortMenu}
              aria-label={`Effort: ${effortLevel} · click to change`}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                const rect = (e.currentTarget as HTMLButtonElement).getBoundingClientRect()
                setEffortMenu({ x: rect.left, y: rect.bottom + 4 })
              }}
            >
              <IconLayers size={13} aria-hidden />
              <span className="chat-panel-effort-label"><span>{effortLevel}</span></span>
            </button>
          </Tooltip>
        )}
        {/* Persona control — the custom agent driving the MAIN thread (its
            system prompt, model and tool restrictions). Distinct from "Run as
            agent" in the panel menu, which delegates a task to a SUBagent.
            Tinted only when a persona is active, so a plain session reads as
            a quiet, opt-in control. */}
        {personaVisible && (
          <Tooltip
            label={
              session.agent
                ? `Persona: ${session.agent} · its prompt, model and tool limits drive the main thread · click to change`
                : 'Persona: none · run the main thread as a custom agent · click to pick'
            }
            placement="bottom"
          >
            <button
              type="button"
              key={`persona-${session.agent ?? 'none'}`}
              className={`chat-panel-persona-badge${session.agent ? ' persona-on' : ''}${personaMenu ? ' persona-expanded' : ''}`}
              disabled={chipsDisabled}
              aria-haspopup="menu"
              aria-expanded={!!personaMenu}
              aria-label={`Persona: ${session.agent ?? 'none'} · click to change`}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                void refreshAgentDefs()
                const rect = (e.currentTarget as HTMLButtonElement).getBoundingClientRect()
                setPersonaMenu({ x: rect.left, y: rect.bottom + 4 })
              }}
            >
              <IconMask size={13} aria-hidden />
              <span className="chat-panel-persona-label"><span>{session.agent ?? 'persona'}</span></span>
            </button>
          </Tooltip>
        )}
        {/* Extended-thinking control. Shown unless the model is known to not
            support thinking (thinkingSupported === false → chip hidden);
            undefined capability fails open. Menu offers Auto (model decides),
            Off, and a few token budgets — the shape POST /thinking accepts.
            The chip label shows the effective setting. */}
        {thinkingVisible && (
          <Tooltip
            label={`Thinking: ${thinkingLabel}${currentDisplay === 'omitted' ? ' · reasoning hidden' : ''} · extended reasoning budget · click to change`}
            placement="bottom"
          >
            <button
              type="button"
              key={`thinking-${thinkingLabel}`}
              className={`chat-panel-thinking-badge${session.thinking?.type === 'disabled' ? ' thinking-off' : ''}${thinkingMenu ? ' thinking-expanded' : ''}`}
              disabled={chipsDisabled}
              aria-haspopup="menu"
              aria-expanded={!!thinkingMenu}
              aria-label={`Thinking: ${thinkingLabel}${currentDisplay === 'omitted' ? ' · reasoning hidden' : ''} · click to change`}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                const rect = (e.currentTarget as HTMLButtonElement).getBoundingClientRect()
                setThinkingMenu({ x: rect.left, y: rect.bottom + 4 })
              }}
            >
              <IconBrain size={13} aria-hidden />
              <span className="chat-panel-thinking-label"><span>{thinkingLabel}</span></span>
              {currentDisplay === 'omitted' && <IconEyeOff size={12} aria-hidden />}
            </button>
          </Tooltip>
        )}
        <div className="chat-panel-meta">
          <Tooltip
            label={
              modelSwitchLabel !== null
                ? `Model: switching to ${modelSwitchLabel}…`
                : `Model: ${session.model ?? 'default'} · click to change`
            }
            placement="bottom"
            align="end"
          >
            <button
              type="button"
              className={`chat-panel-model-badge${modelMenu ? ' open' : ''}${modelSwitching ? ' pending' : ''}`}
              // In-flight disable uses the UNDELAYED label, the same signal the
              // picker's own `disabled` reads: two different signals would let
              // the chip open a picker whose every row is already disabled.
              disabled={chipsDisabled || modelSwitchLabel !== null}
              aria-haspopup="listbox"
              aria-expanded={!!modelMenu}
              aria-busy={modelSwitching}
              aria-label={
                modelSwitchLabel !== null
                  ? `Model: switching to ${modelSwitchLabel}`
                  : `Model: ${session.model ?? 'default'} · click to change`
              }
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                // Open only. Closing is handled by the picker's own
                // outside-click / Escape listeners (matching the perm-mode
                // menu). A toggle here can't work: the picker's window
                // mousedown listener fires before this click and has
                // already closed it, so toggling would just reopen.
                const rect = (e.currentTarget as HTMLButtonElement).getBoundingClientRect()
                // `source` lets the portalled picker find this panel's theme
                // vars (it is no longer a DOM descendant of the panel).
                setModelMenu({ x: rect.left, y: rect.bottom + 4, source: e.currentTarget })
              }}
            >
              {modelSwitching
                ? <IconLoader size={13} className="glyph-spin" aria-hidden />
                : <IconSparkles size={13} aria-hidden />}
              <span className="chat-panel-model-badge-value">{shortenModel(session.model)}</span>
            </button>
          </Tooltip>
          {/* Side Chat collapsed badge — removed from header;
              now rendered as a tab on the panel's right edge below. */}
        </div>
        <AnimatePresence>
          {permMenu && (
            <ContextMenu
              key="perm"
              x={permMenu.x}
              y={permMenu.y}
              onClose={() => setPermMenu(null)}
              items={PERMISSION_MODES.map((m) => ({
                label: permissionModeShortLabel(m),
                icon: (session.permissionMode ?? 'default') === m ? <IconCheck size={14} /> : ' ',
                onClick: () => commitPermissionMode(m),
              }))}
            />
          )}
        </AnimatePresence>
        <AnimatePresence>
          {personaMenu && (
            <ContextMenu
              key="persona"
              x={personaMenu.x}
              y={personaMenu.y}
              onClose={() => setPersonaMenu(null)}
              items={[
                {
                  label: 'none',
                  icon: session.agent ? ' ' : <IconCheck size={14} />,
                  onClick: () => commitAgent(null),
                },
                // Only ENABLED definitions are offered — the server 400s on a
                // disabled name, so listing one would dead-end. A persona that
                // was disabled after being set therefore isn't in this list;
                // the chip still shows it and "none" clears it.
                ...enabledAgentDefs.map((a) => ({
                  label: a.name,
                  icon: session.agent === a.name ? <IconCheck size={14} /> : ' ',
                  onClick: () => commitAgent(a.name),
                })),
              ]}
            />
          )}
        </AnimatePresence>
        <AnimatePresence>
          {effortMenu && (
            <EffortSlider
              key="effort"
              anchor={effortMenu}
              levels={effortChoices}
              current={effortLevel}
              disabled={chipsDisabled}
              onSelect={(l) => commitEffortLevel(l)}
              onClose={() => setEffortMenu(null)}
            />
          )}
        </AnimatePresence>
        <AnimatePresence>
          {thinkingMenu && (
            <ContextMenu
              key="thinking"
              x={thinkingMenu.x}
              y={thinkingMenu.y}
              onClose={() => setThinkingMenu(null)}
              items={[
                {
                  label: 'auto',
                  icon: session.thinking == null || session.thinking.type === 'adaptive' ? <IconCheck size={14} /> : ' ',
                  onClick: () => { setThinkingMenu(null); commitThinking(preserveDisplay({ type: 'adaptive' })) },
                },
                {
                  label: 'off',
                  icon: session.thinking?.type === 'disabled' ? <IconCheck size={14} /> : ' ',
                  onClick: () => { setThinkingMenu(null); commitThinking({ type: 'disabled' }) },
                },
                ...THINKING_BUDGETS.map((n) => ({
                  label: `${Math.round(n / 1024)}k tokens`,
                  icon: session.thinking?.type === 'enabled' && session.thinking.budgetTokens === n
                    ? <IconCheck size={14} />
                    : ' ',
                  onClick: () => { setThinkingMenu(null); commitThinking(preserveDisplay({ type: 'enabled', budgetTokens: n })) },
                })),
                // Reasoning-display section — only while thinking is actually on
                // (disabled carries no display; SDK ThinkingDisabled omits it)
                // and only when a live display switch is expressible (see
                // reasoningSwitchable — a bare enabled setting has no budget
                // to pair the display change with).
                ...(session.thinking?.type !== 'disabled' && reasoningSwitchable ? [
                  {},
                  {
                    label: 'reasoning: default',
                    icon: currentDisplay === undefined ? <IconCheck size={14} /> : ' ',
                    onClick: () => { setThinkingMenu(null); if (currentDisplay !== undefined) commitThinking(withoutDisplay(session.thinking ?? { type: 'adaptive' }), { clearDisplay: true }) },
                  },
                  {
                    label: 'reasoning: summarized',
                    icon: currentDisplay === 'summarized' ? <IconCheck size={14} /> : ' ',
                    onClick: () => { setThinkingMenu(null); commitThinking(withDisplay(session.thinking ?? { type: 'adaptive' }, 'summarized')) },
                  },
                  {
                    // SDK 0.3.295: one short title per thinking stretch
                    // instead of the prose summary. Rejected by the API for
                    // non-first-party providers / experimental betas off /
                    // Claude 3 — the error surfaces via the commit path's
                    // toast and the display stays as it was.
                    label: 'reasoning: highlights',
                    icon: currentDisplay === 'highlights' ? <IconCheck size={14} /> : ' ',
                    onClick: () => { setThinkingMenu(null); commitThinking(withDisplay(session.thinking ?? { type: 'adaptive' }, 'highlights')) },
                  },
                  {
                    label: 'reasoning: hidden',
                    icon: currentDisplay === 'omitted' ? <IconCheck size={14} /> : ' ',
                    onClick: () => { setThinkingMenu(null); commitThinking(withDisplay(session.thinking ?? { type: 'adaptive' }, 'omitted')) },
                  },
                ] : []),
              ]}
            />
          )}
        </AnimatePresence>
        <AnimatePresence>
          {modelMenu && (
            <ModelPicker
              key="model"
              anchor={modelMenu}
              current={session.model}
              currentGroupId={session.modelGroupId}
              options={modelOptions}
              // Same in-flight signal as the chip's own `disabled` (not the
              // delayed spinner one): keeping the two in step is what stops the
              // chip from opening a picker whose every row is already disabled.
              disabled={chipsDisabled || modelSwitchLabel !== null}
              onSelect={(model) => commitModel(model)}
              onSelectGroup={(groupId) => commitGroup(groupId)}
              onClose={() => setModelMenu(null)}
            />
          )}
        </AnimatePresence>
        <AnimatePresence>
          {confirmState && (
            <ConfirmDialog
              key="confirm"
              title={confirmState.title}
              message={confirmState.message}
              confirmLabel={confirmState.confirmLabel}
              destructive={confirmState.destructive}
              busy={confirmBusy}
              onConfirm={confirmState.onConfirm}
              onCancel={() => { if (!confirmBusy) setConfirmState(null) }}
            />
          )}
        </AnimatePresence>
        <AnimatePresence>
          {projectOpen && session.cwd && (
            <ProjectPopover
              key="project"
              path={session.cwd}
              triggerRef={projectChipRef}
              onClose={() => setProjectOpen(false)}
            />
          )}
        </AnimatePresence>
        {cwdPickerOpen && (
          <DirectoryPicker
            open
            initialPath={session.cwd}
            onPick={(p) => {
              setCwdPickerOpen(false)
              handleSelectCwd(p)
            }}
            onClose={() => setCwdPickerOpen(false)}
          />
        )}
        </div>
        {/* session.error renders as the body-area error card (SessionBody
            in .chat-panel-body) — the old header red band is gone. */}
        {/* Second header row — secondary metadata. Muted colour, smaller
            font, skipped when there's literally nothing to show. */}
        {(session.cwd || gitStatus.data?.isRepo === true) && (
          <div className="chat-panel-header-row2">
            {session.cwd && (
              <button
                ref={projectChipRef}
                type="button"
                className="chat-panel-project"
                aria-haspopup="dialog"
                aria-expanded={projectOpen}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation()
                  setProjectOpen((v) => !v)
                }}
              >
                <span className="chat-panel-project-avatar" aria-hidden>
                  {initialOf(session.cwd)}
                </span>
                <span className="chat-panel-project-name">{basenameOf(session.cwd)}</span>
              </button>
            )}
            {/* Worktree-isolation badge — the session was created with the
                new-session dialog's isolate checkbox, so its cwd IS a
                server-provisioned linked worktree (crw/<id> branch). The cwd
                tooltip alone doesn't say that; this badge does. */}
            {session.worktree && <WorktreeIsolationBadge worktree={session.worktree} />}
            {/* Git chip — surfaces branch + dirty/ahead/behind/untracked
                counts at a glance. Lives on row 2, right-aligned, so it
                no longer competes with the row-1 badges. Hidden when the
                cwd isn't a git repo or while the status fetch is still
                settling (no data yet). */}
            {gitStatus.data && gitStatus.data.isRepo === true && (
              <Tooltip label={gitChipTitle(gitStatus.data)} placement="bottom" align="end">
                <button
                  type="button"
                  className={cx(
                    'chat-panel-git-badge',
                    gitStatus.data.state !== 'clean' && gitStatus.data.state !== 'dirty' ? 'conflict' : '',
                    gitStatus.data.state === 'dirty' ? 'dirty' : '',
                  )}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation()
                    onOpenGitPanel(session.id)
                  }}
                >
                  <IconGitBranch size={12} className="chat-panel-git-badge-icon" aria-hidden />
                  <span className="chat-panel-git-badge-value">{gitChipText(gitStatus.data)}</span>
                </button>
              </Tooltip>
            )}
            {/* Worktree chip — the agent is isolating work in a worktree
                opened by EnterWorktree (not yet exited). Distinguishes a
                git-confirmed worktree (normal tint) from a claimed-but-
                unconfirmed one (warning tint, tooltip says so). Click
                opens the Worktree-changes overlay — its own view of what
                the isolated worktree did, distinct from the git panel. */}
            {activeWorktree && (
              <Tooltip label={worktreeChipTitle(activeWorktreeMatch)} placement="bottom" align="end">
                <button
                  type="button"
                  className={cx(
                    'chat-panel-worktree-badge',
                    'clickable',
                    activeWorktreeMatch ? '' : 'unconfirmed',
                  )}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation()
                    onOpenWorktree(session.id)
                  }}
                >
                  <IconGitFork size={12} className="chat-panel-worktree-badge-icon" aria-hidden />
                  <span className="chat-panel-worktree-badge-value">{activeWorktree.name}</span>
                </button>
              </Tooltip>
            )}
          </div>
        )}
        {/* App Plugin `chat.header` action slot. Renders nothing when no
            enabled plugin contributes an action here. */}
        <PluginContributionSlot location="chat.header" session={session} />
      </div>
      <div className="chat-panel-body">
        <SessionBody
          session={session}
          onResume={onResume ? () => onResume(session.id) : undefined}
          onFork={onForkFromLastCompleted ? () => onForkFromLastCompleted(session.id) : undefined}
          resuming={isResuming}
          stderrTail={diagnostics.data?.stderrTail}
          workspace={{
            recents: recentCwds,
            onSelect: handleSelectCwd,
            onForget: forgetCwd,
            onBrowse: () => setCwdPickerOpen(true),
          }}
        >
        {session.running || session.terminated ? (
          <Chat
            key={session.id}
            session={session}
            focused={focused}
            panelVisible={panelVisible}
            composerFocusSignal={composerFocusSignal}
            globalPrefs={globalPrefs}
            clearing={clearing}
            onSessionUpdate={onSessionUpdate}
            onResume={onResume}
            onForkFromLastCompleted={onForkFromLastCompleted}
            onRequestResumeForPanel={onRequestResumeForPanel}
            resumeOpen={resumeOpen}
            onResumeIntoPanel={onResumeIntoPanel}
            onCloseResume={onCloseResume}
            historyOpen={historyOpen}
            onCloseHistory={onCloseHistory}
            onClearSession={onClearSession}
            onHandoffSession={onHandoffSession}
            handoffing={handoffing}
            onDiscard={onDiscard}
            onOpenSettingsTab={onOpenSettingsTab}
            onShowHelp={onShowHelp}
            settingsTabRequest={settingsTabRequest}
            messageJumpTarget={messageJumpTarget}
            settingsOpen={settingsOpen}
            onCloseSettings={onCloseSettings}
            gitPanelOpen={gitPanelOpen}
            onCloseGitPanel={onCloseGitPanel}
            tasksPanelOpen={tasksPanelOpen}
            onCloseTasksPanel={onCloseTasksPanel}
            onOpenTasksPanel={onOpenTasksPanel}
            gitStatus={gitStatus.data}
            gitLoading={gitStatus.loading}
            gitError={gitStatus.error}
            onGitRefresh={gitStatus.refresh}
            worktreeOpen={worktreeOpen}
            onCloseWorktree={onCloseWorktree}
            worktreeView={worktreeView}
            recapOpen={recapOpen}
            onCloseRecap={() => setRecapDismissedAt(session.recap?.generatedAt ?? null)}
            onRegisterInterrupt={onRegisterInterrupt}
            onRegisterRecap={onRegisterRecap}
            onRegisterBackground={onRegisterBackground}
            onRegisterTurnActive={onRegisterTurnActive}
            onRegisterScrollNav={onRegisterScrollNav}
            onInterruptFired={onInterruptFired}
            onOpenSettingsPanel={onOpenSettings}
            snippets={snippets}
            onOpenSnippetsManager={onOpenSnippetsManager}
            onSaveCurrentAsSnippet={onSaveCurrentAsSnippet}
            onClosePanel={onClose}
            onDelete={onDelete}
            onAskConfirm={onDelete ? handleAskConfirm : undefined}
            groupLabel={groupLabel}
            onCloseGroupPanels={onCloseGroupPanels}
            onSideChat={onSideChat}
            sideChatCollapsed={sideChatCollapsed}
            sideChatWorking={!!sideChatSession?.working}
            onToggleCollapseSideChat={onToggleCollapseSideChat}
            skin={skin}
            onOpenUploads={onOpenUploads}
          />
        ) : (
          <div className="empty-state">
            <h2>Session is dormant</h2>
            <p>This session is dormant. Resume it to pick up where you left off.</p>
            {onResume && (
              <button
                type="button"
                className="chat-panel-resume-btn"
                onClick={(e) => {
                  e.stopPropagation()
                  onResume(session.id)
                }}
              >
                Resume session
              </button>
            )}
          </div>
        )}
        </SessionBody>
      </div>
      {sideChatSession && !sideChatCollapsed && onCloseSideChat && onToggleCollapseSideChat && (
        <SideChatDrawer
          session={sideChatSession}
          parentSession={session}
          paging={sideChatPaging}
          permissions={sideChatPermissions}
          toolGroupCards={sideChatSession.toolGroupCards ?? globalPrefs.toolGroupCards}
          autoExpandRunningGroups={
            sideChatSession.autoExpandRunningGroups ?? globalPrefs.autoExpandRunningGroups
          }
          showMessageHeaders={sideChatSession.showMessageHeaders ?? globalPrefs.showMessageHeaders}
          streamingMode={globalPrefs.streamingRenderMode}
          onClose={onCloseSideChat}
          onCollapse={onToggleCollapseSideChat}
        />
      )}
    </section>
  )
})
