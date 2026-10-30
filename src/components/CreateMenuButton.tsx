// Header "+" button that opens the create menu (New session… / New group…)
// instead of immediately creating a session. Shared by SessionNavStrip's
// leading + and DesktopTitlebarTabs' titlebar + so both surfaces offer the
// same two-step flow. Owns its own open-state + ContextMenu; the caller
// supplies the actions and the prompt host (same contracts as
// buildCreateMenuItems).
//
// The trigger TOGGLES the menu: ContextMenu gets `triggerRef` so a press on
// the + is not treated as an outside press (see useOutsideMouseDown), and
// the click that follows flips the open state closed.

import { useCallback, useMemo, useRef, useState } from 'react'
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { ContextMenu } from './ContextMenu'
import { buildCreateMenuItems } from './createMenuItems'
import type { PromptRequest } from '../hooks/useDialogHosts'

interface Props extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'children'> {
  onNewSession: () => void
  onCreateGroup: (name: string) => void
  /** Opens the New-group prompt (DialogHosts' askPrompt). Deliberately the
   *  stable callback, not the whole hosts object — dialog open/close/busy
   *  flips that identity and would re-render every header tab. */
  askPrompt: (config: PromptRequest) => void
  /** Park the New session… row (see buildCreateMenuItems). */
  newSessionDisabled?: boolean
  /** The + glyph (or any button content). */
  children?: ReactNode
}

export function CreateMenuButton({
  onNewSession,
  onCreateGroup,
  askPrompt,
  newSessionDisabled,
  children,
  ...buttonProps
}: Props) {
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  const items = useMemo(
    () => buildCreateMenuItems({ onNewSession, onCreateGroup, askPrompt, newSessionDisabled }),
    [onNewSession, onCreateGroup, askPrompt, newSessionDisabled],
  )
  const close = useCallback(() => {
    setAnchor(null)
    // WAI-ARIA menu button: a USER dismissal returns focus to the trigger so
    // the next Tab continues from the +, not from the top of the document.
    // Only when the menu (or trigger) holds focus — a programmatic dismiss
    // (closeAllContextMenus from a sidebar layout shift) must not steal focus
    // from whatever control the user is on (e.g. the resizer mid
    // keyboard-resize).
    const active = document.activeElement
    const inMenuFlow =
      triggerRef.current?.contains(active) || (active instanceof Element && active.closest('[role="menu"]'))
    if (inMenuFlow) triggerRef.current?.focus({ preventScroll: true })
  }, [])

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={anchor != null}
        {...buttonProps}
        onClick={(e) => {
          if (anchor) {
            close()
            return
          }
          const rect = e.currentTarget.getBoundingClientRect()
          setAnchor({ x: rect.left, y: rect.bottom + 4 })
        }}
      >
        {children}
      </button>
      {anchor && (
        <ContextMenu
          x={anchor.x}
          y={anchor.y}
          items={items}
          onClose={close}
          triggerRef={triggerRef}
          autoFocus
          nonPrimary="close"
        />
      )}
    </>
  )
}
