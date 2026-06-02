/** One column in the 3-up chat grid. Wraps <Chat> with a header bar that
 *  carries the close button, focus click-target, and a dormant/terminated
 *  placeholder when the session's Query isn't live. */

import { memo, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { Chat } from './Chat'
import { ContextMenu } from './ContextMenu'
import { Tooltip } from './Tooltip'
import { api } from '../hooks/useApi'
import { useToast } from '../hooks/useToast'
import { isInAppDrag, readDragPayload, setDragPayload } from '../hooks/useDragPayload'
import { useGitStatus } from '../hooks/useGitStatus'
import { statusClass, statusLabel, shortenModel } from '../utils/session-status'
import { useModelOptions } from '../hooks/useModelOptions'
import { shortenPath } from '../utils/paths'
import { IconSettings, IconX } from './icons/ToolIcons'
import { PermissionModeIcon, permissionModeLabel } from './permission-mode-display'
import type { PermissionMode, SessionInfo } from '../types'
import { PERMISSION_MODES } from '../types'
import type { GitStatus } from '../../shared/git-types'
import type { ComposerSnippetsApi } from '../hooks/useComposerSnippets'

/** Chip text generator: "main" when clean, "main ↑2 ●5 ?1" when dirty.
 *  Each suffix is suppressed at zero so the chip stays compact when the
 *  repo is in the common steady state. */
function gitChipText(s: GitStatus): string {
  if (s.detached) return 'detached'
  const branch = s.branch ?? '?'
  const dirty = s.staged.length + s.unstaged.length
  const segments: string[] = [branch]
  if (s.ahead > 0) segments.push(`↑${s.ahead}`)
  if (s.behind > 0) segments.push(`↓${s.behind}`)
  if (dirty > 0) segments.push(`●${dirty}`)
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
  /** True when a turn has completed on this session since the user last
   *  looked at it. Rendered as a small dot next to the slot pill on
   *  non-focused open panels — so in a 2-up/3-up layout the user notices
   *  a reply landed on a sibling they aren't currently watching. Ignored
   *  when `focused` is true (the user is already looking). */
  hasUnread?: boolean
  /** Slot number (1-indexed) in the main grid. Shown as a pill in the
   *  header so the user can tell this panel apart from the sidebar card
   *  and map it to the Ctrl+<n> shortcut. */
  slot: number
  /** Per-session accent overrides (sets --accent / --accent-strong on the
   *  panel root so all child var() references pick up the session colour). */
  accentStyle?: CSSProperties
  onFocus: (sessionId: string) => void
  onClose: (sessionId: string) => void
  onSessionUpdate: (s: SessionInfo) => void
  /** Swap this panel with another open panel (called with the dragged id). */
  onSwap: (draggedId: string, targetId: string) => void
  /** A sidebar card was dropped onto this panel — replace it. */
  onAcceptSidebarDrop: (sidebarId: string, sessionId: string) => void
  /** Global transcript toggle (forwarded to the inner <Chat>). */
  showSystemEvents?: boolean
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
  onRegisterInterrupt?: (sessionId: string, fn: () => void) => void
  /** Forwarded to <Chat> so it can register its recap-refresh callback. */
  onRegisterRecap?: (sessionId: string, fn: () => void) => void
  /** True while the session is being resumed from dormancy. */
  isResuming?: boolean
  /** Global composer-snippets api (single shared instance owned by App).
   *  Forwarded to the inner <Composer> via <Chat>. */
  snippets: ComposerSnippetsApi
  /** Open the global snippets manager dialog (owned by App). */
  onOpenSnippetsManager: () => void
  /** Capture composer text and ask App to prompt for a snippet label. */
  onSaveCurrentAsSnippet: (content: string) => void
}

export const ChatPanel = memo(function ChatPanel({
  session,
  focused,
  hasUnread,
  slot,
  accentStyle,
  onFocus,
  onClose,
  onSessionUpdate,
  onSwap,
  onAcceptSidebarDrop,
  showSystemEvents,
  settingsOpen,
  onOpenSettings,
  onCloseSettings,
  gitPanelOpen,
  onOpenGitPanel,
  onCloseGitPanel,
  onRegisterInterrupt,
  onRegisterRecap,
  isResuming,
  snippets,
  onOpenSnippetsManager,
  onSaveCurrentAsSnippet,
}: ChatPanelProps) {
  /** State (not ref) so that Chat re-renders once the portal target mounts. */
  const [headerBtnEl, setHeaderBtnEl] = useState<HTMLDivElement | null>(null)
  const [dropActive, setDropActive] = useState(false)
  /** Live message count reported by <Chat> during streaming. Used to
   *  keep the header "X msgs" label up-to-date without waiting for a
   *  server-pushed session-update (which only fires at turn end). */
  const [liveMessageCount, setLiveMessageCount] = useState(0)
  /** When true, the model chip in the header becomes an inline <input>. */
  const [editingModel, setEditingModel] = useState(false)
  const [modelDraft, setModelDraft] = useState('')
  /** Anchor for the permission-mode menu. Non-null = menu visible. A
   *  custom menu (rather than a native <select>) gives us full control
   *  over dark-theme styling; the native control's dropdown surface
   *  can't be restyled across browsers. */
  const [permMenu, setPermMenu] = useState<{ x: number; y: number } | null>(null)
  /** Global toast hub. Model/permission failures used to render an
   *  inline panel banner; they now surface as right-bottom toasts. */
  const toast = useToast()
  // Datalist for the inline model chip. We only start fetching when the
  // user clicks to edit (or has already opened it once on this panel) —
  // no need to ping /sessions/:id/models + /config for every panel that
  // happens to be open. The hook keeps recents from localStorage as a
  // fallback so the dropdown isn't empty during the brief fetch window.
  const modelOptions = useModelOptions(session.id, editingModel && !!session.running)
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

  const commitModel = (next: string) => {
    const value = next.trim()
    setEditingModel(false)
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

  const permMode = session.permissionMode ?? 'default'
  const isNonDefaultMode = permMode !== 'default'

  return (
    <section
      className={[
        'chat-panel',
        focused ? 'focused' : '',
        dropActive ? 'drop-target' : '',
        isNonDefaultMode ? 'mode-active' : '',
        isNonDefaultMode ? `mode-${permMode}` : '',
      ].filter(Boolean).join(' ')}
      style={accentStyle}
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
        draggable
        onDragStart={(e) => {
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
        {isNonDefaultMode && (
          <Tooltip label={`Permission mode: ${permissionModeLabel(permMode)}`} placement="bottom">
            <span
              className={`chat-panel-mode-badge mode-${permMode}`}
              aria-label={`Permission mode: ${permissionModeLabel(permMode)}`}
            >
              <PermissionModeIcon mode={permMode} />
              {permMode}
            </span>
          </Tooltip>
        )}
        <div className="chat-panel-meta">
          {editingModel ? (
            <input
              className="chat-panel-chip-input"
              list="chat-panel-model-datalist"
              autoFocus
              value={modelDraft}
              placeholder="model name"
              disabled={chipsDisabled}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setModelDraft(e.target.value)}
              onBlur={() => commitModel(modelDraft)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  commitModel(modelDraft)
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  setEditingModel(false)
                }
              }}
            />
          ) : (
            <Tooltip label={`Model: ${session.model ?? 'default'} · click to change`} placement="bottom">
              <button
                type="button"
                className="chat-panel-chip"
                disabled={chipsDisabled}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation()
                  setModelDraft(session.model ?? '')
                  setEditingModel(true)
                }}
              >
                <span className="chat-panel-chip-label">model</span>
                <span className="chat-panel-chip-value">{shortenModel(session.model)}</span>
              </button>
            </Tooltip>
          )}
          <datalist id="chat-panel-model-datalist">
            {modelOptions.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          <Tooltip label={`Permission mode: ${session.permissionMode ?? 'default'} · click to change`} placement="bottom">
            <button
              type="button"
              className="chat-panel-chip"
              disabled={chipsDisabled}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                const rect = (e.currentTarget as HTMLButtonElement).getBoundingClientRect()
                setPermMenu({ x: rect.left, y: rect.bottom + 4 })
              }}
            >
              <span className="chat-panel-chip-label">mode</span>
              <span className="chat-panel-chip-value">{session.permissionMode ?? 'default'}</span>
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
                  'chat-panel-chip',
                  'git-chip',
                  gitStatus.data.state !== 'clean' && gitStatus.data.state !== 'dirty' ? 'conflict' : '',
                  gitStatus.data.state === 'dirty' ? 'dirty' : '',
                ].filter(Boolean).join(' ')}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation()
                  onOpenGitPanel(session.id)
                }}
              >
                <span className="chat-panel-chip-label">⎇</span>
                <span className="chat-panel-chip-value">{gitChipText(gitStatus.data)}</span>
              </button>
            </Tooltip>
          )}
        </div>
        {permMenu && (
          <ContextMenu
            x={permMenu.x}
            y={permMenu.y}
            onClose={() => setPermMenu(null)}
            items={PERMISSION_MODES.map((m) => ({
              label: m,
              icon: (session.permissionMode ?? 'default') === m ? '✓' : ' ',
              onClick: () => commitPermissionMode(m),
            }))}
          />
        )}
        <div ref={setHeaderBtnEl} className="chat-panel-header-buttons" />
        <Tooltip label="Session settings" placement="bottom">
          <button
            className="chat-panel-settings"
            onClick={(e) => {
              e.stopPropagation()
              onOpenSettings(session.id)
            }}
            aria-label="Open settings"
          >
            <IconSettings size={16} />
          </button>
        </Tooltip>
        <Tooltip label="Close this panel (Alt+W) · session stays alive" placement="bottom">
          <button
            className="chat-panel-close"
            onClick={(e) => {
              e.stopPropagation()
              onClose(session.id)
            }}
            aria-label="Close panel"
          >
            <IconX size={16} />
          </button>
        </Tooltip>
        </div>
        {session.error && (
          <Tooltip label={session.error}>
            <div className="chat-panel-error">
              ⚠ {session.error}
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
                  📁 {shortenPath(session.cwd)}
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
                  working…
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
            onSessionUpdate={onSessionUpdate}
            showSystemEvents={showSystemEvents}
            settingsOpen={settingsOpen}
            onCloseSettings={onCloseSettings}
            gitPanelOpen={gitPanelOpen}
            onCloseGitPanel={onCloseGitPanel}
            gitStatus={gitStatus.data}
            gitLoading={gitStatus.loading}
            gitError={gitStatus.error}
            onGitRefresh={gitStatus.refresh}
            onLiveMessageCount={setLiveMessageCount}
            onRegisterInterrupt={onRegisterInterrupt}
            onRegisterRecap={onRegisterRecap}
            headerButtonsRef={headerBtnEl}
            snippets={snippets}
            onOpenSnippetsManager={onOpenSnippetsManager}
            onSaveCurrentAsSnippet={onSaveCurrentAsSnippet}
          />
        ) : (
          <div className="empty-state">
            {isResuming ? (
              <>
                <div className="app-loading-spinner" />
                <p>Resuming session…</p>
              </>
            ) : (
              <>
                <h2>Session is dormant</h2>
                <p>Click the session again in the sidebar to resume it.</p>
              </>
            )}
          </div>
        )}
      </div>
    </section>
  )
})
