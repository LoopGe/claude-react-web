/** One column in the 3-up chat grid. Wraps <Chat> with a header bar that
 *  carries the close button, focus click-target, and a dormant/terminated
 *  placeholder when the session's Query isn't live. */

import { memo, useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
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
import { statusClass, statusLabel, shortenModel } from '../utils/session-status'
import { useModelOptions } from '../hooks/useModelOptions'
import { usePresenceValue } from '../hooks/useExitPresence'
import { ModelPicker } from './ModelPicker'
import { EffortSlider } from './EffortSlider'
import { shortenPath } from '../utils/paths'
import { IconFolder, IconCheck, IconAlertTriangle, IconSparkles, IconZap } from './icons/ToolIcons'
import { PermissionModeIcon, permissionModeLabel } from './permission-mode-display'
import type { EffortLevel, PermissionMode, SessionInfo, SlashCommand } from '../types'
import type { Skin } from '../utils/theme'
import type { SettingsTabName } from '../local-commands'
import { PERMISSION_MODES, EFFORT_LEVELS, DEFAULT_EFFORT_LEVEL } from '../types'
import type { GitStatus } from '../../shared/git-types'
import type { MessageJumpTarget } from '../../shared/message-jump'
import type { ComposerSnippetsApi } from '../hooks/useComposerSnippets'

/** Chip text generator: "main" when clean, "main ahead 1 dirty 1 ?1" when dirty.
 *  Each suffix is suppressed at zero so the chip stays compact when the
 *  repo is in the common steady state. */
function gitChipText(s: GitStatus): string {
  if (s.detached) return 'detached'
  const branch = s.branch ?? '?'
  const dirty = s.staged.length + s.unstaged.length
  const segments: string[] = [branch]
  if (s.ahead > 0) segments.push(`ahead ${s.ahead}`)
  if (s.behind > 0) segments.push(`behind ${s.behind}`)
  if (dirty > 0) segments.push(`dirty ${dirty}`)
  if (s.untracked.length > 0) segments.push(`?${s.untracked.length}`)
  return segments.join(' ')
}

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
  globalPrefs: { showPinnedUserMessage: boolean; autoRecap: boolean }
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
  /** Per-session accent overrides (sets --accent / --accent-strong on the
   *  panel root so all child var() references pick up the session colour). */
  accentStyle?: CSSProperties
  onFocus: (sessionId: string) => void
  onClose: (sessionId: string) => void
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
  /** `/clear` this panel — the server detaches the pre-clear conversation
   *  as dormant and returns a fresh session; App swaps the panel id. Triggered
   *  by the `/clear` local command. */
  onClearSession: (panelSessionId: string) => void
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
  /** Nonce-stamped request to switch the settings tab (forwarded to <Chat> —
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
  /** Forwarded to <Chat> so it can register its interrupt callback with
   *  the parent App. Enables ESC shortcut to trigger the same code-path
   *  as the Composer's interrupt button. */
  onRegisterInterrupt?: (sessionId: string, fn: () => void) => () => void
  /** Forwarded to <Chat> so it can register its recap-refresh callback. */
  onRegisterRecap?: (sessionId: string, fn: () => void) => () => void
  /** Forwarded to <Chat> so it can register its composer input-injection
   *  callback (used by the Mod+Shift+H input-history panel). */
  onRegisterInjectInput?: (sessionId: string, fn: (text: string) => void) => () => void
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
  accentStyle,
  onFocus,
  onClose,
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
  onClearSession,
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
  onRegisterInterrupt,
  onRegisterRecap,
  onRegisterInjectInput,
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
  /** Live message count reported by <Chat> during streaming. Used to
   *  keep the header "X msgs" label up-to-date without waiting for a
   *  server-pushed session-update (which only fires at turn end). */
  const [liveMessageCount, setLiveMessageCount] = useState(0)
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
  const permMenuPresence = usePresenceValue(permMenu, 120)
  const effortMenuPresence = usePresenceValue(effortMenu, 120)
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
  const confirmPresence = usePresenceValue(confirmState)
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
  const modelMenuPresence = usePresenceValue(modelMenu, 120)
  /** Global toast hub. Model/permission failures used to render an
   *  inline panel banner; they now surface as right-bottom toasts. */
  const toast = useToast()
  // Options for the model picker. We only start fetching when the user
  // opens the picker — no need to ping /sessions/:id/models + /config for
  // every panel that happens to be open. The hook keeps recents from
  // localStorage as a fallback so the list isn't empty during the brief
  // fetch window.
  const modelOptions = useModelOptions(session.id, !!modelMenu && !!session.running)
  const chipsDisabled = !session.running || session.terminated
  // Use the live count from the stream when available; fall back to the
  // server-pushed session.messageCount (updated only at turn boundaries).
  const effectiveMessageCount = Math.max(session.messageCount, liveMessageCount)
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
  })

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
  // Effort chip gating from the model's reported capability (three-state):
  //   undefined — capability unknown — offer all 5 (fallback, chip visible)
  //   []        — model doesn't support effort — hide chip
  //   [subset]  — offer only the supported levels
  const effortCaps = session.effortLevels
  const effortVisible = effortCaps === undefined || effortCaps.length > 0
  const effortChoices = effortCaps && effortCaps.length > 0 ? effortCaps : EFFORT_LEVELS

  const permMode = session.permissionMode ?? 'default'
  const isNonDefaultMode = permMode !== 'default'
  /** Detect permission-mode changes and apply a brief flash animation
   *  class to the header. The class triggers mode-flash and is removed
   *  on animationend so it can replay on the next switch.
   *  Also tracks the previous mode for the badge slide-out transition. */
  const prevPermModeRef = useRef(permMode)
  const [modeChanging, setModeChanging] = useState(false)
  const [modeTransitionFrom, setModeTransitionFrom] = useState<PermissionMode | null>(null)
  useEffect(() => {
    if (prevPermModeRef.current !== permMode) {
      setModeTransitionFrom(prevPermModeRef.current)
      prevPermModeRef.current = permMode
      setModeChanging(true)
    }
  }, [permMode])
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
        isNonDefaultMode ? 'mode-active' : '',
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
        className={`chat-panel-header${modeChanging ? ' mode-changing' : ''}`}
        onAnimationEnd={() => modeChanging && setModeChanging(false)}
        // The header is the drag handle for panel swaps — the body stays
        // non-draggable so textarea text selection and scrolling work.
        draggable={!isMobile}
        onDragStart={(e) => {
          if (isMobile) return
          setDragPayload(e, { kind: 'main-panel', id: session.id })
        }}
      >
        <div className="chat-panel-header-row1">
        <Tooltip label={`Slot ${slot} · Ctrl+${slot} to focus`} placement="bottom">
          <span
            className={`chat-panel-slot ${focused ? 'focused' : ''}`}
            aria-label={`slot ${slot}`}
          >
            {slot}
          </span>
        </Tooltip>
        <Tooltip label={statusLabel(session)} placement="bottom">
          <span
            className={`chat-panel-status ${statusClass(session)}`}
            aria-label={statusLabel(session)}
          />
        </Tooltip>
        {hasUnread && !focused && (
          <Tooltip label="New turn completed while this panel wasn't focused" placement="bottom">
            <span
              className="chat-panel-unread"
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
                {modeTransitionFrom}
              </span>
            )}
            <button
              type="button"
              key={`mode-${permMode}`}
              className={`chat-panel-mode-badge mode-${permMode}${modeTransitionFrom != null ? ' mode-slide-in' : ''}`}
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
              {permMode}
            </button>
          </span>
        </Tooltip>
        {/* Fast-mode control. Only shown when the SDK reports a fast-mode
            runtime state for the current model (undefined — model doesn't
            support it — chip hidden). 'cooldown' means the speedup is
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
              <IconZap size={13} aria-hidden />
              {fastCooldown ? 'cooldown' : 'fast'}
            </button>
          </Tooltip>
        )}
        {/* Effort-level control. Shown when the current model supports
            effort (or its capability is unknown — fallback to offering all
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
              className={`chat-panel-effort-badge effort-${effortLevel}`}
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
              {effortLevel}
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
          {/* Git chip — surfaces branch + dirty/ahead/behind/untracked
              counts at a glance. Hidden when the cwd isn't a git repo
              (so non-git sessions don't get visual noise) or while the
              status fetch is still settling and we have no data yet. */}
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
                <span className="chat-panel-git-badge-icon" aria-hidden>Git</span>
                <span className="chat-panel-git-badge-value">{gitChipText(gitStatus.data)}</span>
              </button>
            </Tooltip>
          )}
          {/* Side Chat collapsed badge — removed from header;
              now rendered as a tab on the panel's right edge below. */}
        </div>
        {permMenuPresence.value && (
          <ContextMenu
            x={permMenuPresence.value.x}
            y={permMenuPresence.value.y}
            isExiting={permMenuPresence.isExiting}
            onClose={() => setPermMenu(null)}
            items={PERMISSION_MODES.map((m) => ({
              label: m,
              icon: (session.permissionMode ?? 'default') === m ? <IconCheck size={14} /> : ' ',
              onClick: () => commitPermissionMode(m),
            }))}
          />
        )}
        {effortMenuPresence.value && (
          <EffortSlider
            anchor={effortMenuPresence.value}
            levels={effortChoices}
            current={effortLevel}
            disabled={chipsDisabled}
            isExiting={effortMenuPresence.isExiting}
            onSelect={(l) => commitEffortLevel(l)}
            onClose={() => setEffortMenu(null)}
          />
        )}
        {modelMenuPresence.value && (
          <ModelPicker
            anchor={modelMenuPresence.value}
            current={session.model}
            options={modelOptions}
            disabled={chipsDisabled}
            isExiting={modelMenuPresence.isExiting}
            onSelect={(model) => commitModel(model)}
            onClose={() => setModelMenu(null)}
          />
        )}
        {confirmPresence.value && (
          <ConfirmDialog
            open={confirmState != null}
            title={confirmPresence.value.title}
            message={confirmPresence.value.message}
            confirmLabel={confirmPresence.value.confirmLabel}
            destructive={confirmPresence.value.destructive}
            busy={confirmBusy}
            onConfirm={confirmPresence.value.onConfirm}
            onCancel={() => { if (!confirmBusy) setConfirmState(null) }}
          />
        )}
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
        {(session.cwd || effectiveMessageCount > 0) && (
          <div className="chat-panel-header-row2">
            {session.cwd && (
              <Tooltip label={session.cwd} placement="bottom">
                <span className="chat-panel-cwd">
                  <IconFolder size={12} />
                  {shortenPath(session.cwd)}
                </span>
              </Tooltip>
            )}
            <Tooltip label={`${effectiveMessageCount} messages`} placement="bottom">
              <span className="chat-panel-msgcount">
                {effectiveMessageCount} {effectiveMessageCount === 1 ? 'msg' : 'msgs'}
              </span>
            </Tooltip>
            {session.working && (
              <Tooltip label="Assistant is working on a turn" placement="bottom">
                <span className="chat-panel-working-indicator">
                  <span className="chat-panel-working-dot" aria-hidden />
                  working...
                </span>
              </Tooltip>
            )}
          </div>
        )}
      </div>
      <div className="chat-panel-body">
        {session.running || session.terminated ? (
          <Chat
            key={session.id}
            session={session}
            focused={focused}
            globalPrefs={globalPrefs}
            clearing={clearing}
            onSessionUpdate={onSessionUpdate}
            onRequestResumeForPanel={onRequestResumeForPanel}
            resumeOpen={resumeOpen}
            onResumeIntoPanel={onResumeIntoPanel}
            onCloseResume={onCloseResume}
            onClearSession={onClearSession}
            onOpenSettingsTab={onOpenSettingsTab}
            onShowHelp={onShowHelp}
            settingsTabRequest={settingsTabRequest}
            messageJumpTarget={messageJumpTarget}
            settingsOpen={settingsOpen}
            onCloseSettings={onCloseSettings}
            gitPanelOpen={gitPanelOpen}
            onCloseGitPanel={onCloseGitPanel}
            gitStatus={gitStatus.data}
            gitLoading={gitStatus.loading}
            gitError={gitStatus.error}
            onGitRefresh={gitStatus.refresh}
            recapOpen={recapOpen}
            onCloseRecap={() => setRecapDismissedAt(session.recap?.generatedAt ?? null)}
            onLiveMessageCount={setLiveMessageCount}
            onRegisterInterrupt={onRegisterInterrupt}
            onRegisterRecap={onRegisterRecap}
            onRegisterInjectInput={onRegisterInjectInput}
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
                <p>Click the session again in the sidebar to resume it.</p>
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
