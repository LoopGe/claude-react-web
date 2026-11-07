// Shared hover body for a session surface (sidebar card, nav-strip tab,
// titlebar tab). Renders the metadata the compact row no longer draws:
// status, a higher-precedence error, the working directory, and the
// model/message/viewer line.
//
// One component keeps the wording and order identical everywhere a session is
// hovered; the surfaces only choose the trigger and placement.

import { sessionHoverModel } from '../../utils/session-status'
import { HoverValue } from '../HoverPopover'
import { permissionModeLabel } from '../permission-mode-display'
import type { SessionInfo } from '../../types'

export function SessionHoverContent({
  session,
  statusText,
  slot,
}: {
  session: SessionInfo
  /** App-only state the SessionInfo does not carry (a resume in flight). */
  statusText?: string
  /** The sidebar card's open-panel slot; omitted on header-tab surfaces. */
  slot?: { index: number; focused: boolean } | null
}) {
  const model = sessionHoverModel(session, statusText)
  const pending = session.pendingPermissionCount ?? 0
  return (
    <div className="hover-pop-stack">
      <div className="hover-pop-status">{model.status}</div>
      {model.error !== null && <div className="hover-pop-error">Error: {model.error}</div>}
      {model.cwd !== null && <div className="hover-pop-path">{model.cwd}</div>}
      <div className="hover-pop-meta">
        <HoverValue>{model.meta.model}</HoverValue>
        {' · '}
        <HoverValue>{model.meta.messages}</HoverValue>
        {model.meta.viewers !== null && (
          <>
            {' · '}
            <HoverValue>{model.meta.viewers}</HoverValue>
          </>
        )}
      </div>
      {slot != null && (
        <div>
          Slot <HoverValue>{slot.index}</HoverValue> · {slot.focused ? 'focused' : 'open'}
          {` · Ctrl+${slot.index} to ${slot.focused ? 'refocus' : 'focus'}`}
        </div>
      )}
      <div>
        Permission mode: <HoverValue>{permissionModeLabel(session.permissionMode ?? 'default')}</HoverValue>
      </div>
      {pending > 0 && (
        <div>
          <HoverValue>{pending}</HoverValue> request{pending === 1 ? '' : 's'} awaiting your response
        </div>
      )}
    </div>
  )
}