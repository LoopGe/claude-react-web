/** One column in the 3-up chat grid. Wraps <Chat> with a header bar that
 *  carries the close button, focus click-target, and a dormant/terminated
 *  placeholder when the session's Query isn't live. */

import { useState } from 'react'
import type { CSSProperties } from 'react'
import { Chat } from './Chat'
import { ContextMenu } from './ContextMenu'
import { api } from '../hooks/useApi'
import { isInAppDrag, readDragPayload, setDragPayload } from '../hooks/useDragPayload'
import { statusClass, statusLabel, shortenModel } from '../utils/session-status'
import { readRecentModels } from '../utils/recent-models'
import { shortenPath } from '../utils/paths'
import type { PermissionMode, SessionInfo } from '../types'
import { PERMISSION_MODES } from '../types'

export interface ChatPanelProps {
  session: SessionInfo
  focused: boolean
  /** Slot number (1-indexed) in the main grid. Shown as a pill in the
   *  header so the user can tell this panel apart from the sidebar card
   *  and map it to the Ctrl+<n> shortcut. */
  slot: number
  /** Per-session accent overrides (sets --accent / --accent-strong on the
   *  panel root so all child var() references pick up the session colour). */
  accentStyle?: CSSProperties
  onFocus: () => void
  onClose: () => void
  onSessionUpdate: (s: SessionInfo) => void
  /** Swap this panel with another open panel (called with the dragged id). */
  onSwap: (draggedId: string, targetId: string) => void
  /** A sidebar card was dropped onto this panel — replace it. */
  onAcceptSidebarDrop: (sidebarId: string) => void
  /** Global transcript toggle (forwarded to the inner <Chat>). */
  showSystemEvents?: boolean
  /** When true, render the Settings overlay on top of this panel. */
  settingsOpen?: boolean
  onOpenSettings: () => void
  onCloseSettings: () => void
  /** Forwarded to <Chat> so it can register its interrupt callback with
   *  the parent App. Enables ESC shortcut to trigger the same code-path
   *  as the Composer's interrupt button. */
  onRegisterInterrupt?: (sessionId: string, fn: () => void) => void
}

export function ChatPanel({
  session,
  focused,
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
  onRegisterInterrupt,
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
  /** Inline error toast replacing window.alert for model/permission failures. */
  const [panelError, setPanelError] = useState<string | null>(null)
  const recentModels = readRecentModels()
  const chipsDisabled = !session.running || session.terminated
  // Use the live count from the stream when available; fall back to the
  // server-pushed session.messageCount (updated only at turn boundaries).
  const effectiveMessageCount = Math.max(session.messageCount, liveMessageCount)

  const commitModel = (next: string) => {
    const value = next.trim()
    setEditingModel(false)
    if (value === (session.model ?? '')) return
    const before = session.model
    void api
      .post<{ session: SessionInfo }>(`/sessions/${session.id}/model`, {
        model: value || undefined,
      })
      .then((r) => onSessionUpdate(r.session))
      .catch((err) => {
        setPanelError(`Couldn't change model: ${(err as Error).message}`)
        setTimeout(() => setPanelError(null), 5000)
        onSessionUpdate({ ...session, model: before })
      })
  }

  const commitPermissionMode = (mode: PermissionMode) => {
    if (mode === (session.permissionMode ?? 'default')) return
    const before = session.permissionMode
    void api
      .post<{ session: SessionInfo }>(`/sessions/${session.id}/permission-mode`, { mode })
      .then((r) => onSessionUpdate(r.session))
      .catch((err) => {
        setPanelError(`Couldn't change permission mode: ${(err as Error).message}`)
        setTimeout(() => setPanelError(null), 5000)
        onSessionUpdate({ ...session, permissionMode: before })
      })
  }

  return (
    <section
      className={`chat-panel ${focused ? 'focused' : ''} ${dropActive ? 'drop-target' : ''}`}
      style={accentStyle}
      onMouseDownCapture={(e) => {
        // Focus on any mousedown inside the panel (capture phase so we win
        // against children). Clicking the close button still works because
        // onClose stops propagation, but focusing on the way down is harmless.
        if (!focused) onFocus()
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
          onAcceptSidebarDrop(payload.id)
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
        <span
          className={`chat-panel-slot ${focused ? 'focused' : ''}`}
          title={`Slot ${slot} · Ctrl+${slot} to focus`}
          aria-label={`slot ${slot}`}
        >
          {slot}
        </span>
        <span
          className={`chat-panel-status ${statusClass(session)}`}
          title={statusLabel(session)}
          aria-label={statusLabel(session)}
        />
        <span className="chat-panel-title" title={session.cwd ?? ''}>
          {session.title ?? session.id.slice(0, 8)}
        </span>
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
            <button
              type="button"
              className="chat-panel-chip"
              disabled={chipsDisabled}
              title={`Model: ${session.model ?? 'default'} · click to change`}
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
          )}
          <datalist id="chat-panel-model-datalist">
            {recentModels.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          <button
            type="button"
            className="chat-panel-chip"
            disabled={chipsDisabled}
            title={`Permission mode: ${session.permissionMode ?? 'default'} · click to change`}
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
        <button
          className="chat-panel-settings"
          onClick={(e) => {
            e.stopPropagation()
            onOpenSettings()
          }}
          title="Session settings"
          aria-label="Open settings"
        >
          ⚙
        </button>
        <button
          className="chat-panel-close"
          onClick={(e) => {
            e.stopPropagation()
            onClose()
          }}
          title="Close this panel (Alt+W) · session stays alive"
          aria-label="Close panel"
        >
          ✕
        </button>
        </div>
        {session.error && (
          <div className="chat-panel-error" title={session.error}>
            ⚠ {session.error}
          </div>
        )}
        {/* Second header row — secondary metadata. Muted colour, smaller
            font, skipped when there's literally nothing to show. */}
        {(session.cwd || effectiveMessageCount > 0) && (
          <div className="chat-panel-header-row2">
            {session.cwd && (
              <span className="chat-panel-cwd" title={session.cwd}>
                📁 {shortenPath(session.cwd)}
              </span>
            )}
            <span className="chat-panel-msgcount" title={`${effectiveMessageCount} messages`}>
              {effectiveMessageCount} {effectiveMessageCount === 1 ? 'msg' : 'msgs'}
            </span>
            {session.working && (
              <span className="chat-panel-working-indicator" title="Assistant is working on a turn">
                <span className="chat-panel-working-dot" aria-hidden />
                working…
              </span>
            )}
          </div>
        )}
      </div>
      {panelError && (
        <div className="error-toast">
          {panelError}
          <button className="error-toast-dismiss" onClick={() => setPanelError(null)}>✕</button>
        </div>
      )}
      <div className="chat-panel-body">
        {session.running ? (
          <Chat
            key={session.id}
            session={session}
            focused={focused}
            onSessionUpdate={onSessionUpdate}
            showSystemEvents={showSystemEvents}
            settingsOpen={settingsOpen}
            onCloseSettings={onCloseSettings}
            onLiveMessageCount={setLiveMessageCount}
            onRegisterInterrupt={onRegisterInterrupt}
            headerButtonsRef={headerBtnEl}
          />
        ) : (
          <div className="empty-state">
            <h2>
              {session.error
                ? 'This session errored'
                : session.terminated
                  ? 'This session has ended'
                  : 'Session is dormant'}
            </h2>
            {session.error ? (
              <>
                <p>The underlying SDK Query threw an error and the session was shut down:</p>
                <pre
                  style={{
                    textAlign: 'left',
                    background: 'var(--bg-elev-2)',
                    padding: 10,
                    borderRadius: 4,
                    whiteSpace: 'pre-wrap',
                    color: 'var(--danger)',
                    fontSize: 12,
                  }}
                >
                  {session.error}
                </pre>
                <p>Check the server logs for a full stack trace.</p>
              </>
            ) : (
              <p>
                {session.terminated
                  ? 'The underlying Query has finished. Create a new session to continue.'
                  : 'Click the session again in the sidebar to resume it.'}
              </p>
            )}
          </div>
        )}
      </div>
    </section>
  )
}
