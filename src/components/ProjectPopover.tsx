// Project popover for the session-header project chip.
//
// Replaces the old cwd Tooltip: the chip (avatar + project basename) now
// CLICKS open this popover, which carries what the chip can't fit — the full
// cwd path plus quick actions. The actions execute on the SERVER machine
// (where the project files live), so Reveal-in-Finder / Open-in-Terminal are
// gated on the per-request loopback probe (useOpenPathCapability); Copy path
// is client-side and always shown.
//
// Follows the TodoDetailPopover pattern: `position: fixed`, portaled to
// <body> (an ancestor carrying filter/transform/backdrop-filter would
// otherwise become the containing block), measured after layout and re-
// measured while open, Esc via the shared escape stack, outside-mousedown
// via the shared hook with the chip as triggerRef so its own toggle click
// closes cleanly. Anchors BELOW the chip (it sits in the panel header, so
// there is normally room under it) and flips above when there isn't.

import { memo, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'motion/react'
import { usePopoverMotion } from '../utils/transitions'
import { useEscapeStack } from '../hooks/useEscapeStack'
import { useOutsideMouseDown } from '../hooks/useOutsideMouseDown'
import { useOpenPathCapability } from '../hooks/useOpenPathCapability'
import { useCopy } from '../hooks/useCopy'
import { api } from '../hooks/useApi'
import { markPortaledSurface } from '../theme'
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
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const [anchorHidden, setAnchorHidden] = useState(false)
  const local = useOpenPathCapability()
  const { copied, copy } = useCopy()
  // Which server action is in flight (if any) — disables the buttons so a
  // double-click can't spawn the target app twice, and shows which one is
  // working. The spawn is fast (~ms) but `open` can take ~100ms+.
  const [pendingTarget, setPendingTarget] = useState<OpenPathTarget | null>(null)
  const [openError, setOpenError] = useState<string | null>(null)
  const { popover } = usePopoverMotion()

  const measureRef = useRef<() => void>(() => {})

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    markPortaledSurface(el)
    // Measure-and-place, re-run while open (resize / scroll / content churn),
    // same contract as TodoDetailPopover. Anchors below the chip; flips above
    // when the space under it can't fit the popover.
    const measure = () => {
      const chip = triggerRef.current
      if (!chip) return
      const r = chip.getBoundingClientRect()
      // A zero-size chip means the panel went into the keep-alive cache
      // (display:none) or detached — there is nothing to anchor to, so hide
      // instead of clamping to the viewport top-left. (A visible chip never
      // measures 0×0.) Same guard as TodoDetailPopover's anchorHidden.
      const detached = r.width === 0 && r.height === 0
      setAnchorHidden(detached)
      if (detached) return
      const rect = el.getBoundingClientRect()
      const vw = window.innerWidth
      const vh = window.innerHeight
      const x = Math.min(Math.max(8, r.left), vw - rect.width - 8)
      let y = r.bottom + 6
      if (y + rect.height > vh - 8) y = Math.max(8, r.top - rect.height - 6)
      setPos((prev) => (prev !== null && prev.x === x && prev.y === y ? prev : { x, y }))
    }
    measureRef.current = measure
    measure()
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => {
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
      ro.disconnect()
    }
  }, [triggerRef])

  useOutsideMouseDown({ ref, onClose, triggerRef })

  useEscapeStack({
    active: true,
    onEscape: onClose,
    getContainer: () => ref.current,
  })

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

  return createPortal(
    <motion.div
      ref={ref}
      className="project-pop"
      style={{
        left: pos?.x,
        top: pos?.y,
        visibility: pos === null || anchorHidden ? 'hidden' : undefined,
      }}
      role="dialog"
      aria-label={`Project: ${basenameOf(path)}`}
      initial={popover.initial}
      animate={popover.animate}
      exit={popover.exit}
      onAnimationComplete={() => measureRef.current()}
      onMouseDown={(e) => e.stopPropagation()}
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
        <button
          type="button"
          className="project-pop-action"
          onClick={() => void copy(() => path)}
        >
          {copied ? <IconCheck size={13} /> : <IconCopy size={13} aria-hidden />}
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
              <IconTerminal size={13} aria-hidden />
              {isMacClient() ? 'Open in Terminal' : 'Open in terminal'}
            </button>
          </>
        )}
      </div>
      {openError && <div className="project-pop-error">{openError}</div>}
    </motion.div>,
    document.body,
  )
})
