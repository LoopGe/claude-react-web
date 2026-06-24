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
import {
  IconSparkles,
  IconAlertTriangle,
  IconX,
  IconMessageCircle,
  IconDollar,
  IconClock,
  IconWrench,
} from './icons/ToolIcons'
import { formatElapsed } from '../utils/format'

interface Props {
  recap: SessionRecap
  /** True while the exit animation is playing; drives data-state="closing". */
  isExiting?: boolean
  onClose: () => void
}

export const RecapWindow = memo(function RecapWindow({ recap, isExiting, onClose }: Props) {
  return (
    <div
      className="recap-window"
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
  // status === 'ready' — summary and stats may still legitimately be missing
  // if the server constructed the ready frame defensively; bail rather than
  // render a half-card.
  if (!recap.summary || !recap.stats) return null
  const { summary, stats } = recap
  return (
    <>
      <Markdown text={summary} />
      <div className="recap-msg-stats">
        {stats.userTurns > 0 && (
          <span className="recap-msg-stat">
            <IconMessageCircle size={12} /> {stats.userTurns} turn{stats.userTurns === 1 ? '' : 's'}
          </span>
        )}
        {stats.totalCostUsd > 0 && (
          <span className="recap-msg-stat"><IconDollar size={12} /> {formatCost(stats.totalCostUsd)}</span>
        )}
        {stats.durationMs > 0 && (
          <span className="recap-msg-stat"><IconClock size={12} /> {formatElapsed(stats.durationMs)}</span>
        )}
        {stats.toolsUsed.length > 0 && (
          <span className="recap-msg-stat"><IconWrench size={12} /> {stats.toolsUsed.length} tool{stats.toolsUsed.length === 1 ? '' : 's'}</span>
        )}
      </div>
    </>
  )
}

function formatCost(usd: number): string {
  if (usd === 0) return '$0'
  if (usd < 0.01) return '<$0.01'
  return `$${usd.toFixed(2)}`
}
