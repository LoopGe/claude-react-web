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
import { useCopy } from '../hooks/useCopy'
import { api } from '../hooks/useApi'
import { AnchoredPopover } from './AnchoredPopover'
import { basenameOf, initialOf } from '../utils/paths'
import type { OpenPathTarget } from '../../shared/open-path'
import { IconCheck, IconCopy, IconTerminal } from './icons/ToolIcons'

export interface ProjectPopoverProps {
  /** The session's working directory (the project root). */
  path: string
  /** The chip element — the anchor for positioning and the
   *  useOutsideMouseDown trigger exemption. */
  triggerRef: React.RefObject<HTMLElement | null>
  onClose: () => void
}

/** The actions run on the server machine; when that is this machine (the
 *  local case, and the only case where the buttons render) the client's OS
 *  matches the server's, so the userAgent decides the wording ("Finder" on
 *  a Mac, generic "file manager" elsewhere). Read lazily (not at module
 *  load) so tests can stub navigator.platform. */
function isMacClient(): boolean {
  return /Mac|iPhone|iPad/.test(navigator.platform)
}

export const ProjectPopover = memo(function ProjectPopover({
  path,
  triggerRef,
  onClose,
}: ProjectPopoverProps) {
  const local = useOpenPathCapability()
  const { copied, copy } = useCopy()
  // Which server action is in flight (if any) — disables the buttons so a
  // double-click can't spawn the target app twice, and shows which one is
  // working. The spawn is fast (~ms) but `open` can take ~100ms+.
  const [pendingTarget, setPendingTarget] = useState<OpenPathTarget | null>(null)
  const [openError, setOpenError] = useState<string | null>(null)

  const openOnServer = (target: OpenPathTarget) => {
    if (pendingTarget) return
    setOpenError(null)
    setPendingTarget(target)
    api
      .post('/open-path', { path, target })
      .catch((err: unknown) => {
        const message =
          typeof err === 'object' && err !== null && 'message' in err
            ? String((err as { message: unknown }).message)
            : String(err)
        setOpenError(message)
      })
      .finally(() => setPendingTarget(null))
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
          </>
        )}
      </div>
      {openError && <div className="project-pop-error">{openError}</div>}
    </AnchoredPopover>
  )
})
