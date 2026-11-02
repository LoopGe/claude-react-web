// Shared shell for SubagentOverlay and WorkflowOverlay: panel-scoped absolute
// root with a SEPARATE scrim so the virtualized transcript never sits inside a
// backdrop-filtered ancestor. Navigation, dismissal, exit presence and the
// transcript itself deliberately remain with the callers.

import { useRef, type ReactNode } from 'react'
import { useEscapeStack } from '../hooks/useEscapeStack'
import { useFocusTrap } from '../hooks/useFocusTrap'

interface Props {
  variant: 'subagent' | 'workflow'
  ariaLabel: string
  isExiting: boolean
  /** Direct root/scrim press only. */
  onClose: () => void
  /** Caller-specific navigation: pop, unfocus or close. */
  onEscape: () => void
  onExited?: () => void
  header: ReactNode
  children: ReactNode
}

export function TranscriptDrawerShell({
  variant,
  ariaLabel,
  isExiting,
  onClose,
  onEscape,
  onExited,
  header,
  children,
}: Props) {
  const overlayRef = useRef<HTMLDivElement>(null)
  const scrimClass = `${variant}-overlay-scrim`

  // Register before the trap so nested overlays dispatch only to the topmost
  // layer. Exit-window Escape is swallowed but never acted on.
  useEscapeStack({
    active: true,
    onEscape,
    canClose: () => !isExiting,
    getContainer: () => overlayRef.current,
  })

  // Keep the root stable while children change; focus restores on final unmount.
  useFocusTrap(overlayRef, { restoreFocus: true, escapeSelector: '.chat-panel' })

  return (
    <div
      ref={overlayRef}
      className={`${variant}-overlay`}
      role="dialog"
      aria-modal="false"
      aria-label={ariaLabel}
      onMouseDown={(event) => {
        if (isExiting) return
        const target = event.target as HTMLElement
        if (target === event.currentTarget || target.classList.contains(scrimClass)) onClose()
      }}
      data-state={isExiting ? 'closing' : 'open'}
      onAnimationEnd={(event) => {
        // The scrim's fade bubbles here. Check both source and name so a nested
        // overlay's identically-named animation cannot finish this drawer.
        if (!isExiting) return
        const target = event.target as HTMLElement
        if (target.classList.contains(scrimClass) && event.animationName === 'overlay-backdrop-out') {
          onExited?.()
        }
      }}
    >
      {/* Scrim is a sibling, never an ancestor of the transcript panel. */}
      <div className={scrimClass} aria-hidden />
      <div className={`${variant}-overlay-panel`}>
        {header}
        {children}
      </div>
    </div>
  )
}
