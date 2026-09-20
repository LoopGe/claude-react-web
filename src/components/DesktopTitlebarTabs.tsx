// Open-panel tabs in the desktop titlebar strip.
//
// Windows/macOS custom chrome has no OS tab strip, so the open Chat panels
// surface as tabs in the drag row: click focuses that panel, × closes it,
// + starts a new session. The sidebar still lists ALL sessions — these tabs
// mirror only what is currently open as a panel (openSessions).
//
// The whole strip is a no-drag island inside the drag region so clicks land
// on tabs, not on window-move.

import { memo } from 'react'
import type { SessionInfo } from '../types'

interface Props {
  sessions: SessionInfo[]
  focusedId: string | null
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onNew: () => void
  maxOpen: number
}

function tabLabel(s: SessionInfo): string {
  const title = s.title?.trim()
  if (title) return title
  // Fall back to cwd basename so an untitled session is still identifiable.
  const cwd = s.cwd?.split(/[\\/]/).filter(Boolean).pop()
  return cwd || 'Session'
}

export const DesktopTitlebarTabs = memo(function DesktopTitlebarTabs({
  sessions,
  focusedId,
  onSelect,
  onClose,
  onNew,
  maxOpen,
}: Props) {
  if (sessions.length === 0) {
    // Still render the + so the empty titlebar offers a start path.
    return (
      <div className="titlebar-tabs" role="group" aria-label="Open sessions">
        <button
          type="button"
          className="titlebar-tab-new btn btn-icon"
          onClick={onNew}
          aria-label="New session"
          title="New session"
        >
          +
        </button>
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
        return (
          <div
            key={s.id}
            className={`titlebar-tab${selected ? ' active' : ''}${s.working ? ' working' : ''}`}
            role="button"
            aria-pressed={selected}
            tabIndex={0}
            title={tabLabel(s)}
            onClick={() => onSelect(s.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onSelect(s.id)
              }
            }}
          >
            <span className="titlebar-tab-label">{tabLabel(s)}</span>
            {s.working && <span className="titlebar-tab-dot" aria-hidden />}
            <button
              type="button"
              className="titlebar-tab-close"
              aria-label={`Close ${tabLabel(s)}`}
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
      {sessions.length < maxOpen && (
        <button
          type="button"
          className="titlebar-tab-new btn btn-icon"
          onClick={onNew}
          aria-label="New session"
          title="New session"
        >
          +
        </button>
      )}
    </div>
  )
})
