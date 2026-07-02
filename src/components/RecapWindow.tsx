// Floating session-recap window — slides in from the top of the ChatPanel.
// Non-modal: occupies only the top portion (~45% max height) so the chat
// stays visible and scrollable beneath it. Frosted-glass backdrop matches
// the SettingsPanel/GitPanel overlays. A close (X) button dismisses it;
// once dismissed it stays hidden until a NEW recap arrives (new generatedAt)
// or the user reopens it via the header button.
//
// Three states share the same shell (ready / pending / error), mirroring the
// old RecapFooter that lived in the Virtuoso footer slot.

import { memo } from 'react'
import type { SessionRecap } from '../../shared/session-info'
import { Markdown } from './Markdown'
import { IconSparkles, IconAlertTriangle, IconX } from './icons/ToolIcons'

interface Props {
  recap: SessionRecap
  /** True while the exit animation is playing; drives data-state="closing". */
  isExiting?: boolean
  /** True while a /clear is in flight. Reuses the transcript's
   *  `clear-blur-fade` exit animation so the recap dissolves in sync with
   *  the message list instead of snapping out when the server confirms. */
  clearing?: boolean
  onClose: () => void
}

export const RecapWindow = memo(function RecapWindow({ recap, isExiting, clearing, onClose }: Props) {
  return (
    <div
      className={`recap-window${clearing ? ' recap-window-clearing' : ''}`}
      role="dialog"
      aria-label="Session recap"
      data-state={isExiting ? 'closing' : 'open'}
    >
      <div className="recap-window-header">
        <span className="recap-window-title">
          {recap.status === 'error' ? (
            <IconAlertTriangle size={14} />
          ) : (
            <IconSparkles size={14} />
          )}
          {recap.status === 'error' ? 'Recap unavailable' : 'Session recap'}
        </span>
        <button
          type="button"
          className="recap-window-close"
          onClick={onClose}
          aria-label="Close recap"
        >
          <IconX size={14} />
        </button>
      </div>
      <div className="recap-window-body">
        <div key={recap.status} className="recap-window-body-inner">
          {recap.status === 'pending' ? (
            <div className="recap-msg-loading-body">
              <span className="recap-msg-loading-bar" aria-hidden />
              <span>Catching you up on this session…</span>
            </div>
          ) : recap.status === 'error' ? (
            <div className="recap-window-error">{recap.error ?? 'Unknown error'}</div>
          ) : (
            <RecapBody recap={recap} />
          )}
        </div>
      </div>
    </div>
  )
})

function RecapBody({ recap }: { recap: SessionRecap }) {
  // status === 'ready' — summary may still legitimately be missing if the
  // server constructed the ready frame defensively; bail rather than render a
  // half-card.
  if (!recap.summary) return null
  return <Markdown text={recap.summary} />
}
