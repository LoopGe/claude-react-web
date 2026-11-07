// Shared hover body for a session surface (sidebar card, nav-strip tab,
// titlebar tab). Renders the metadata the compact row no longer draws:
// status, a higher-precedence error, the working directory, and the
// model/message/viewer line.
//
// One component keeps the wording and order identical everywhere a session is
// hovered; the surfaces only choose the trigger and placement.

import { sessionHoverModel } from '../../utils/session-status'
import { HoverValue } from '../HoverPopover'
import type { SessionInfo } from '../../types'

export function SessionHoverContent({
  session,
  statusText,
}: {
  session: SessionInfo
  /** App-only state the SessionInfo does not carry (a resume in flight). */
  statusText?: string
}) {
  const model = sessionHoverModel(session, statusText)
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
    </div>
  )
}