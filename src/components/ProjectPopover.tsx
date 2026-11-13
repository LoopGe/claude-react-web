// Project popover for the session-header project chip.
//
// Replaces the old cwd Tooltip: the chip (avatar + project basename) now
// CLICKS open this popover, which carries what the chip can't fit — the full
// cwd path plus quick actions. The actions execute on the SERVER machine
// (where the project files live), so Reveal-in-Finder / Open-in-Terminal are
// gated on the per-request loopback probe (useOpenPathCapability); Copy path
// is client-side and always shown.
//
// Positioning, portal, animation and dismissal live in AnchoredPopover.
// This file owns only the project identity and server/client actions. The
// shared shell anchors BELOW the chip and flips above when space runs out.

import { memo, useState } from 'react'
import { useOpenPathCapability } from '../hooks/useOpenPathCapability'
import { useOpenPathApps } from '../hooks/useOpenPathApps'
import { useOpenPath } from '../hooks/useOpenPath'
import { useCopy } from '../hooks/useCopy'
import { isMacClient } from '../utils/client-platform'
import { AnchoredPopover } from './AnchoredPopover'
import { basenameOf, initialOf } from '../utils/paths'
import { OPEN_PATH_APP_LABELS, type OpenPathTarget } from '../../shared/open-path'
import { IconCheck, IconCopy, IconTerminal } from './icons/ToolIcons'
import { BRAND_ICONS } from './icons/BrandIcons'

export interface ProjectPopoverProps {
  /** The session's working directory (the project root). */
  path: string
  /** The chip element — the anchor for positioning and the
   *  useOutsideMouseDown trigger exemption. */
  triggerRef: React.RefObject<HTMLElement | null>
  onClose: () => void
}

export const ProjectPopover = memo(function ProjectPopover({
  path,
  triggerRef,
  onClose,
}: ProjectPopoverProps) {
  const local = useOpenPathCapability()
  const apps = useOpenPathApps()
  const { copied, copy } = useCopy()
  // The launch helper is shared with the session context-menu's "Open in …"
  // items (useOpenPath owns the in-flight guard and outcome normalization);
  // this popover keeps its inline error row as the presentation.
  const { open, pending: pendingTarget } = useOpenPath()
  const [openError, setOpenError] = useState<string | null>(null)

  const openOnServer = (target: OpenPathTarget) => {
    if (pendingTarget) return
    setOpenError(null)
    void open(target, path).then((outcome) => {
      if (!outcome.ok) setOpenError(outcome.message ?? 'open failed')
    })
  }

  return (
    <AnchoredPopover
      className="project-pop"
      ariaLabel={`Project: ${basenameOf(path)}`}
      triggerRef={triggerRef}
      placement="below"
      onClose={onClose}
    >
      <div className="project-pop-head">
        <span className="project-pop-avatar" aria-hidden>
          {initialOf(path)}
        </span>
        <span className="project-pop-name">{basenameOf(path)}</span>
      </div>
      <code className="project-pop-path" title={path}>
        {path}
      </code>
      <div className="project-pop-actions">
        <button type="button" className="project-pop-action" onClick={() => void copy(() => path)}>
          {copied ? <IconCheck /> : <IconCopy aria-hidden />}
          {copied ? 'Copied' : 'Copy path'}
        </button>
        {local && (
          <>
            <button
              type="button"
              className="project-pop-action"
              disabled={pendingTarget !== null}
              onClick={() => openOnServer('finder')}
            >
              {isMacClient() ? 'Reveal in Finder' : 'Open in file manager'}
            </button>
            <button
              type="button"
              className="project-pop-action"
              disabled={pendingTarget !== null}
              onClick={() => openOnServer('terminal')}
            >
              <IconTerminal aria-hidden />
              {isMacClient() ? 'Open in Terminal' : 'Open in terminal'}
            </button>
            {/* Brand "Open in …" buttons — the targets the /apps probe
                reports installed on the server machine, rendered with their
                brand glyphs (filled by the themed --brand-* variables). Same
                gates and launch helper as the generic entries above, and the
                same wording as the session context-menu's open-in group. */}
            {apps?.map((target) => {
              const BrandIcon = BRAND_ICONS[target]
              if (BrandIcon === undefined) return null
              return (
                <button
                  key={target}
                  type="button"
                  className="project-pop-action"
                  disabled={pendingTarget !== null}
                  onClick={() => openOnServer(target)}
                >
                  <BrandIcon size={14} aria-hidden />
                  {OPEN_PATH_APP_LABELS[target]}
                </button>
              )
            })}
          </>
        )}
      </div>
      {openError && <div className="project-pop-error">{openError}</div>}
    </AnchoredPopover>
  )
})
