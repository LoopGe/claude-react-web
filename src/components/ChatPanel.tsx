/** One column in the 3-up chat grid. Wraps <Chat> with a header bar that
 *  carries the close button, focus click-target, and a dormant/terminated
 *  placeholder when the session's Query isn't live. */

import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { PluginContributionSlot } from '../app-plugins/PluginContributionSlot'
import { Chat } from './Chat'
import { SideChatDrawer } from './SideChatDrawer'
import { ContextMenu } from './ContextMenu'
import { ConfirmDialog } from './ConfirmDialog'
import { Tooltip } from './Tooltip'
import { api } from '../hooks/useApi'
import { useToast } from '../hooks/useToast'
import { isInAppDrag, readDragPayload, setDragPayload } from '../hooks/useDragPayload'
import { useGitStatus } from '../hooks/useGitStatus'
import { useChatStream } from '../hooks/useChatStream'
import { usePermissionChannel } from '../hooks/usePermissionChannel'
import { useIsMobile } from '../hooks/useIsMobile'
import { shortenModel } from '../utils/session-status'
import { useModelOptions } from '../hooks/useModelOptions'
import { AnimatePresence } from 'motion/react'
import { ModelPicker } from './ModelPicker'
import { EffortSlider } from './EffortSlider'
import { shortenPath } from '../utils/paths'
import { gitChipText } from '../utils/git-chip'
import { IconFolder, IconCheck, IconAlertTriangle, IconSparkles, IconGauge, IconBrain, IconLayers, IconGitBranch, IconEyeOff } from './icons/ToolIcons'
import { PermissionModeIcon, permissionModeLabel } from './permission-mode-display'
import type { EffortLevel, PermissionMode, SessionInfo, SlashCommand, ThinkingSetting } from '../types'
import type { Skin } from '../utils/theme'
import type { SettingsTabName } from '../local-commands'
import { PERMISSION_MODES, EFFORT_LEVELS, DEFAULT_EFFORT_LEVEL } from '../types'
import type { GitStatus } from '../../shared/git-types'
import type { MessageJumpTarget } from '../../shared/message-jump'
import type { ComposerSnippetsApi } from '../hooks/useComposerSnippets'

/** Chip tooltip — verbose form for users who hover before clicking.
 *  Returns a ReactNode (one <div> per line) rather than a `\n`-joined
 *  string: newlines inside HTML text collapse to spaces, so the multi-
 *  line intent was previously lost in the Tooltip bubble. */
function gitChipTitle(s: GitStatus): ReactNode {
  const lines = [
    `Branch: ${s.detached ? 'detached HEAD' : (s.branch ?? 'unknown')}`,
    s.upstream ? `Upstream: ${s.upstream}` : 'No upstream configured',
  ]
  if (s.ahead > 0 || s.behind > 0) lines.push(`Sync: ${s.ahead} ahead, ${s.behind} behind`)
  lines.push(`State: ${s.state}`)
  lines.push(`Staged: ${s.staged.length} · Unstaged: ${s.unstaged.length} · Untracked: ${s.untracked.length}`)
  lines.push('Click to open Git panel')
  return lines.map((line, i) => <div key={i}>{line}</div>)
}

/** Optimistic-update helper: POST to `apiPath`, update session on success,
 *  rollback + show error toast on failure. */
function commitWithRollback(
  session: SessionInfo,
  apiPath: string,
  payload: Record<string, unknown>,
  before: Partial<SessionInfo>,
  errorMsg: string,
  onSessionUpdate: (s: SessionInfo) => void,
  showError: (msg: string) => void,
) {
  void api
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
  globalPrefs: { showPinnedUserMessage: boolean; autoRecap: boolean; appToolsGit: boolean }
  /** True when a turn has completed on this session since the user last
   *  looked at it. Rendered as a small dot next to the slot pill on
   *  non-focused open panels — so in a 2-up/3-up layout the user notices
   *  a reply landed on a sibling they aren't currently watching. Ignored
   *  when `focused` is true (the user is already looking). */
  hasUnread?: boolean
  /** True when this panel just mounted and should play its enter animation. */
  entering?: boolean
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
  /** External composer-focus signal from App — bumped by the mod+1/2/3
   *  slot shortcuts. Forwarded to <Chat> → <Composer> so switching panels
   *  also refocuses the target panel's composer. */
  composerFocusSignal?: number
  /** True while Ctrl/Cmd is held — paints the slot pill with a key-hint
   *  highlight so the mod+<n> mapping is discoverable. */
  showSlotHints?: boolean
  /** Per-session accent overrides (sets --accent / --accent-strong on the
   *  panel root so all child var() references pick up the session colour). */
  accentStyle?: CSSProperties
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
  /** Swap this panel with another open panel (called with the dragged id). */
  onSwap: (draggedId: string, targetId: string) => void
  /** A sidebar card was dropped onto this panel — replace it. */
  onAcceptSidebarDrop: (sidebarId: string, sessionId: string) => void
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
  /** `/compact` this panel — the server summarizes and returns a fresh seeded
   *  continuation session; App swaps the panel id. Triggered by the `/compact`
   *  local command. Required (like onClearSession) so a missing pass-through
   *  fails loudly instead of silently swallowing `/compact`. */
  onCompactSession: (panelSessionId: string) => void
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
}

export const ChatPanel = memo(function ChatPanel({
  session,
  focused,
  globalPrefs,
  hasUnread,
  entering,
  onAnimEnd,
  slot,
  composerFocusSignal,
  showSlotHints,
  accentStyle,
  onFocus,
  onClose,
  onResume,
  onForkFromLastCompleted,
  groupLabel,
  onCloseGroupPanels,
  onDelete,
  onSessionUpdate,
  onSwap,
  onAcceptSidebarDrop,
  onRequestResumeForPanel,
  resumeOpen,
  onResumeIntoPanel,
  onCloseResume,
  historyOpen,
  onCloseHistory,
  onClearSession,
  onCompactSession,
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
  onRegisterInterrupt,
  onRegisterRecap,
  onRegisterBackground,
  onRegisterTurnActive,
  onInterruptFired,
  isResuming,
  snippets,
  onOpenSnippetsManager,
  onSaveCurrentAsSnippet,
  skin,
}: ChatPanelProps) {
  // Panel swap via drag is a multi-panel desktop affordance; mobile is
  // single-panel and touch can't HTML5-drag, so disable it there.
  const isMobile = useIsMobile()
  const [dropActive, setDropActive] = useState(false)
  /** Tracks the `generatedAt` of the recap the user has dismissed. When it
   *  matches the current session.recap.generatedAt, the floating window
   *  stays hidden; a NEW recap (different generatedAt) auto-reopens it.
   *  Null = no dismissal in effect → window shows whenever a recap exists.
   *  Reset on session switch (see effect below). */
  const [recapDismissedAt, setRecapDismissedAt] = useState<number | null>(null)
  useEffect(() => { setRecapDismissedAt(null) }, [session.id])
  const recapOpen =
    !!session.recap &&
    (recapDismissedAt === null || session.recap.generatedAt !== recapDismissedAt)
  /** Anchor for the model picker dropdown. Non-null = picker visible. */
  const [modelMenu, setModelMenu] = useState<{ x: number; y: number } | null>(null)
  /** Anchor for the permission-mode menu. Non-null = menu visible. A
   *  custom menu (rather than a native <select>) gives us full control
   *  over dark-theme styling; the native control's dropdown surface
   *  can't be restyled across browsers. */
  const [permMenu, setPermMenu] = useState<{ x: number; y: number } | null>(null)
  /** Anchor for the effort-level menu. Non-null = menu visible. */
  const [effortMenu, setEffortMenu] = useState<{ x: number; y: number } | null>(null)
  const [thinkingMenu, setThinkingMenu] = useState<{ x: number; y: number } | null>(null)
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
  const chipsDisabled = !session.running || session.terminated
  // Git status powers BOTH the header chip (always-visible summary) and
  // the GitPanel overlay (mounted inside <Chat>). Hoisting the hook here
  // means a single fetch satisfies both consumers; the panel receives
  // status via prop drilling rather than re-fetching on open. Passing
  // session.id wires WS auto-refresh on git-status-changed frames.
  // Git status is a read-only filesystem probe — it's valid whether or not
  // the SDK subprocess is mid-turn. Gating on session.running made the chip
  // vanish (and never return) the moment a session went idle, because the
  // hook resets data to null when disabled. Only the cwd matters here.
  const gitStatus = useGitStatus(session.cwd, session.id, { enabled: !!session.cwd })

  // Side Chat stream — always subscribed so the drawer can mount without
  // replay cost and the collapsed badge gets live permission data.
  // useChatStream gates on a valid sessionId internally (empty string
  // is a safe no-op), so this is free when no side chat exists.
  const effectiveSideChatId = sideChatSession?.id ?? ''
  const sideChatPermissions = usePermissionChannel(effectiveSideChatId)
  const sideChatStream = useChatStream(effectiveSideChatId, {
    onRequest: sideChatPermissions.onRequest,
    onResolved: sideChatPermissions.onResolved,
    onCleared: sideChatPermissions.clearError,
  }, sideChatSession?.running ?? false)

  const commitModel = (next: string) => {
    const value = next.trim()
    setModelMenu(null)
    if (value === (session.model ?? '')) return
    commitWithRollback(
      session,
      `/sessions/${session.id}/model`,
      { model: value || undefined },
      { model: session.model },
      `Couldn't change model`,
      onSessionUpdate,
      toast.error,
    )
  }

  const commitGroup = (groupId: string) => {
    setModelMenu(null)
    if (groupId === (session.modelGroupId ?? '')) return
    commitWithRollback(
      session,
      `/sessions/${session.id}/model-group`,
      { groupId },
      // Restore both the resolved main model AND the group reference on
      // failure — a group switch changes both on the session.
      { model: session.model, modelGroupId: session.modelGroupId },
      `Couldn't change model group`,
      onSessionUpdate,
      toast.error,
    )
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
  const effortLevel = session.effortLevel ?? DEFAULT_EFFORT_LEVEL
  /** Current thinking display mode, or undefined when unset / thinking off. */
  const displayOf = (t: ThinkingSetting | undefined): 'summarized' | 'omitted' | undefined =>
    t && t.type !== 'disabled' ? t.display : undefined
  const currentDisplay = displayOf(session.thinking)

  /** Attach a display mode (no-op when thinking is off — the disabled variant
   *  carries no display, matching SDK ThinkingDisabled). */
  const withDisplay = (t: ThinkingSetting, display: 'summarized' | 'omitted'): ThinkingSetting =>
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
  /** Mode labels vary in width ("default" vs "bypassPermissions"), so the
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
      data-panel-id={session.id}
      className={[
        'chat-panel',
        focused ? 'focused' : '',
        dropActive ? 'drop-target' : '',
        entering ? 'entering' : '',
        `mode-${permMode}`,
      ].filter(Boolean).join(' ')}
      style={accentStyle}
      onAnimationEnd={(e) => {
        if (entering && e.target === e.currentTarget) onAnimEnd?.(session.id)
      }}
      onMouseDownCapture={(e) => {
        // Focus on any mousedown inside the panel (capture phase so we win
        // against children). Clicking the close button still works because
        // onClose stops propagation, but focusing on the way down is harmless.
        if (!focused) onFocus(session.id)
        void e
      }}
      onDragOver={(e) => {
        if (!isInAppDrag(e)) return
        e.preventDefault()
        setDropActive(true)
      }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
        setDropActive(false)
      }}
      onDrop={(e) => {
        setDropActive(false)
        const payload = readDragPayload(e)
        if (!payload) return
        e.preventDefault()
        // Stop bubbling so the outer `.main-body` doesn't ALSO act on this
        // drop (which would open the sidebar card a second time).
        e.stopPropagation()
        if (payload.kind === 'main-panel') {
          onSwap(payload.id, session.id)
        } else if (payload.kind === 'sidebar-card') {
          onAcceptSidebarDrop(payload.id, session.id)
        }
      }}
    >
      <div
        className="chat-panel-header"
        // The header is the drag handle for panel swaps — the body stays
        // non-draggable so textarea text selection and scrolling work.
        draggable={!isMobile}
        onDragStart={(e) => {
          if (isMobile) return
          setDragPayload(e, { kind: 'main-panel', id: session.id })
        }}
      >
        <div className="chat-panel-header-row1">
        <Tooltip label={`Slot ${slot} · Ctrl/Cmd+${slot} to focus`} placement="bottom">
          <span
            className={`chat-panel-slot ${focused ? 'focused' : ''} ${showSlotHints ? 'key-hint' : ''}`}
            aria-label={`slot ${slot}`}
          >
            {slot}
          </span>
        </Tooltip>
        {hasUnread && !focused && (
          <Tooltip label="New turn completed while this panel wasn't focused" placement="bottom">
            <span
              className="chat-panel-unread"
              role="img"
              aria-label="unread"
            />
          </Tooltip>
        )}
        <Tooltip label={session.cwd ?? ''} placement="bottom" disabled={!session.cwd}>
          <span className="chat-panel-title">
            {session.title ?? session.id.slice(0, 8)}
          </span>
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
                <span className="chat-panel-mode-label"><span>{modeTransitionFrom}</span></span>
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
              <span className="chat-panel-mode-label"><span>{permMode}</span></span>
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
          <Tooltip label={`Model: ${session.model ?? 'default'} · click to change`} placement="bottom">
            <button
              type="button"
              className={`chat-panel-model-badge${modelMenu ? ' open' : ''}`}
              disabled={chipsDisabled}
              aria-haspopup="listbox"
              aria-expanded={!!modelMenu}
              aria-label={`Model: ${session.model ?? 'default'} · click to change`}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                // Open only. Closing is handled by the picker's own
                // outside-click / Escape listeners (matching the perm-mode
                // menu). A toggle here can't work: the picker's window
                // mousedown listener fires before this click and has
                // already closed it, so toggling would just reopen.
                const rect = (e.currentTarget as HTMLButtonElement).getBoundingClientRect()
                setModelMenu({ x: rect.left, y: rect.bottom + 4 })
              }}
            >
              <IconSparkles size={13} aria-hidden />
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
                label: m,
                icon: (session.permissionMode ?? 'default') === m ? <IconCheck size={14} /> : ' ',
                onClick: () => commitPermissionMode(m),
              }))}
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
              disabled={chipsDisabled}
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
        </div>
        {session.error && (
          <Tooltip label={session.error}>
            <div className="chat-panel-error">
              <IconAlertTriangle size={12} style={{ marginRight: 4, flexShrink: 0 }} />
              {session.error}
            </div>
          </Tooltip>
        )}
        {/* Second header row — secondary metadata. Muted colour, smaller
            font, skipped when there's literally nothing to show. */}
        {(session.cwd || gitStatus.data?.isRepo === true) && (
          <div className="chat-panel-header-row2">
            {session.cwd && (
              <Tooltip label={session.cwd} placement="bottom">
                <span className="chat-panel-cwd">
                  <IconFolder size={12} />
                  {shortenPath(session.cwd)}
                </span>
              </Tooltip>
            )}
            {/* Git chip — surfaces branch + dirty/ahead/behind/untracked
                counts at a glance. Lives on row 2, right-aligned, so it
                no longer competes with the row-1 badges. Hidden when the
                cwd isn't a git repo or while the status fetch is still
                settling (no data yet). */}
            {gitStatus.data && gitStatus.data.isRepo === true && (
              <Tooltip label={gitChipTitle(gitStatus.data)} placement="bottom">
                <button
                  type="button"
                  className={[
                    'chat-panel-git-badge',
                    gitStatus.data.state !== 'clean' && gitStatus.data.state !== 'dirty' ? 'conflict' : '',
                    gitStatus.data.state === 'dirty' ? 'dirty' : '',
                  ].filter(Boolean).join(' ')}
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
          </div>
        )}
        {/* App Plugin `chat.header` action slot. Renders nothing when no
            enabled plugin contributes an action here. */}
        <PluginContributionSlot location="chat.header" session={session} />
      </div>
      <div className="chat-panel-body">
        {session.running || session.terminated ? (
          <Chat
            key={session.id}
            session={session}
            focused={focused}
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
            onCompactSession={onCompactSession}
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
            recapOpen={recapOpen}
            onCloseRecap={() => setRecapDismissedAt(session.recap?.generatedAt ?? null)}
            onRegisterInterrupt={onRegisterInterrupt}
            onRegisterRecap={onRegisterRecap}
            onRegisterBackground={onRegisterBackground}
            onRegisterTurnActive={onRegisterTurnActive}
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
          />
        ) : (
          <div className="empty-state">
            {isResuming ? (
              <div className="empty-state-loading">
                <div className="app-loading-spinner" />
                <p>Resuming session...</p>
              </div>
            ) : (
              <>
                <h2>Session is dormant</h2>
                {session.error ? (
                  <p>Last resume attempt failed: {session.error}. Click the session in the sidebar to try again.</p>
                ) : (
                  <p>This session is dormant. Resume it to pick up where you left off.</p>
                )}
                {onResume && !session.terminated && (
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
              </>
            )}
          </div>
        )}
      </div>
      {sideChatSession && !sideChatCollapsed && onCloseSideChat && onToggleCollapseSideChat && (
        <SideChatDrawer
          session={sideChatSession}
          parentSession={session}
          stream={sideChatStream}
          permissions={sideChatPermissions}
          onClose={onCloseSideChat}
          onCollapse={onToggleCollapseSideChat}
        />
      )}
    </section>
  )
})
