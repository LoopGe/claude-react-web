// Open-panel tabs in the desktop titlebar strip.
//
// Windows/macOS custom chrome has no OS tab strip, so the open Chat panels
// surface as tabs in the drag row: click focuses that panel, × closes it,
// + opens the create menu (New session… / New group…) — same two-step flow
// as SessionNavStrip's leading +. The sidebar still lists ALL sessions —
// these tabs mirror only what is currently open as a panel (openSessions).
//
// The whole strip is a no-drag island inside the drag region so clicks land
// on tabs, not on window-move.

import { memo } from 'react'
import type { SessionInfo } from '../types'
import { tabDotStatus, tabTitle } from '../utils/session-status'
import { CreateMenuButton } from './CreateMenuButton'
import type { PromptRequest } from '../hooks/useDialogHosts'

interface Props {
  sessions: SessionInfo[]
  focusedId: string | null
  onSelect: (id: string) => void
  onClose: (id: string) => void
  /** Create-menu actions (the + opens the menu first). */
  onNewSession: () => void
  onCreateGroup: (name: string) => void
  askPrompt: (config: PromptRequest) => void
  maxOpen: number
  /** Resume in flight (App's transient `resuming` set) — folds the tab to
   *  'working' so a session the user just woke up pulses instead of sitting
   *  dormant-dimmed for the spawn's duration. Same prop the nav strip takes. */
  resumingIds?: ReadonlySet<string>
}

function tabLabel(s: SessionInfo): string {
  const title = s.title?.trim()
  if (title) return title
  // Fall back to cwd basename so an untitled session is still identifiable.
  const cwd = s.cwd?.split(/[\\/]/).filter(Boolean).pop()
  return cwd || 'Session'
}

function NewButton(props: {
  onNewSession: () => void
  onCreateGroup: (name: string) => void
  askPrompt: (config: PromptRequest) => void
  newSessionDisabled: boolean
}) {
  return (
    <CreateMenuButton
      className="titlebar-tab-new btn btn-icon"
      aria-label="Create"
      title="New session or group"
      onNewSession={props.onNewSession}
      onCreateGroup={props.onCreateGroup}
      askPrompt={props.askPrompt}
      newSessionDisabled={props.newSessionDisabled}
    >
      +
    </CreateMenuButton>
  )
}

export const DesktopTitlebarTabs = memo(function DesktopTitlebarTabs({
  sessions,
  focusedId,
  onSelect,
  onClose,
  onNewSession,
  onCreateGroup,
  askPrompt,
  maxOpen,
  resumingIds,
}: Props) {
  // New session… is parked at panel capacity; the + itself stays so
  // New group… (no panel slot) remains reachable from the titlebar.
  const newSessionDisabled = sessions.length >= maxOpen

  if (sessions.length === 0) {
    // Still render the + so the empty titlebar offers a create path.
    return (
      <div className="titlebar-tabs" role="group" aria-label="Open sessions">
        <NewButton
          onNewSession={onNewSession}
          onCreateGroup={onCreateGroup}
          askPrompt={askPrompt}
          newSessionDisabled={false}
        />
      </div>
    )
  }

  return (
    // role="group" not "tablist": the ARIA tab pattern promises Left/Right
    // roving focus, which this strip does not implement (same call as
    // App.tsx's .main-toolbar). Tabs remain clickable/focusable buttons.
    <div className="titlebar-tabs" role="group" aria-label="Open sessions">
      {sessions.map((s) => {
        const selected = s.id === focusedId
        const label = tabLabel(s)
        // ONE fold per tab: 'working' covers an active turn, a crash recovery
        // (statusClass's documented fold) and a resume in flight — all three
        // pulse instead of reading dead. 'dormant' dims the label, the rest
        // carry a status dot. No unread concept here — the titlebar mirrors
        // open panels, and unread state lives on the sidebar/strip surfaces.
        const status = resumingIds?.has(s.id) ? 'working' : tabDotStatus(s)
        const working = status === 'working'
        return (
          <div
            key={s.id}
            className={`titlebar-tab${selected ? ' active' : ''}${working ? ' working' : ''}${status === 'dormant' ? ' dormant' : ''}`}
            role="button"
            aria-pressed={selected}
            tabIndex={0}
            title={tabTitle(label, s)}
            onClick={() => onSelect(s.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onSelect(s.id)
              }
            }}
          >
            <span className="titlebar-tab-label">{label}</span>
            {working && <span className="titlebar-tab-dot" aria-hidden />}
            {!working && status && <span className={`session-status-dot status-${status}`} aria-hidden />}
            <button
              type="button"
              className="titlebar-tab-close"
              aria-label={`Close ${label}`}
              title="Close panel"
              onClick={(e) => {
                e.stopPropagation()
                onClose(s.id)
              }}
            >
              ×
            </button>
          </div>
        )
      })}
      <NewButton
        onNewSession={onNewSession}
        onCreateGroup={onCreateGroup}
        askPrompt={askPrompt}
        newSessionDisabled={newSessionDisabled}
      />
    </div>
  )
})
