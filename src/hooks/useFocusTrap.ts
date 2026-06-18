import { useEffect, type RefObject } from 'react'

const DEFAULT_SELECTOR =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'

const DISABLED_EXCLUDING_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Trap keyboard focus inside a container element and wrap Tab/Shift+Tab at
 * the boundaries.
 *
 * On activation focus is moved *into* the trap so Tab is captured, but we
 * deliberately do NOT grab the first focusable child: for panel-style
 * overlays (Git, Settings) the first focusable is an action button (e.g.
 * Refresh), and auto-focusing it both highlights it and shows its tooltip,
 * which reads as a spurious "why did it focus that?" jump. Instead:
 *   - If something inside the container already holds focus — e.g. an
 *     `autoFocus` input/button placed during React's commit phase, which
 *     runs before this effect — we leave it alone. Form dialogs that want a
 *     specific field focused keep working unchanged.
 *   - Otherwise we focus the container element itself (making it
 *     programmatically focusable via tabindex=-1 if needed). Focus enters
 *     the trap without landing on any one control.
 *
 * @param ref   Ref to the container element (e.g. a dialog).
 * @param opts.restoreFocus  Save and restore `document.activeElement` on unmount.
 * @param opts.excludeDisabled  Exclude `[disabled]` elements from the focus trap.
 * @param opts.escapeSelector  CSS selector. When focus lands on an element
 *   matching this selector — or any descendant of such an element — the trap
 *   releases it instead of pulling it back. Use for per-panel overlays that
 *   should allow the user to interact with sibling panels.
 */
export function useFocusTrap(
  ref: RefObject<HTMLElement | null>,
  opts?: { restoreFocus?: boolean; excludeDisabled?: boolean; active?: boolean; escapeSelector?: string },
): void {
  const active = opts?.active ?? true
  useEffect(() => {
    if (!active) return
    const previouslyFocused = opts?.restoreFocus
      ? (document.activeElement as HTMLElement | null)
      : null
    const el = ref.current
    if (!el) return
    const selector = opts?.excludeDisabled
      ? DISABLED_EXCLUDING_SELECTOR
      : DEFAULT_SELECTOR
    const handleKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return
      const focusable = el.querySelectorAll<HTMLElement>(selector)
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (e.shiftKey ? document.activeElement === first : document.activeElement === last) {
        e.preventDefault()
        ;(e.shiftKey ? last : first).focus()
      }
    }
    // Re-guard focus that escapes the trap by means other than Tab — a
    // mouse click on the backdrop, or a programmatic .focus() landing
    // outside the container. Without this the Tab-boundary handler is the
    // only mechanism, and a click-away leaves `document.activeElement` on
    // <body> while the dialog is still open; the next Tab starts from the
    // top of the document, defeating the trap. We pull stray focus back
    // to the container (matching the activation behaviour) rather than to
    // the first focusable, so we don't spuriously highlight an action.
    //
    // Exception: if focus moves to a portaled child modal (e.g. McpInstaller
    // inside SettingsPanel), we allow it. These modals render via
    // createPortal to document.body and manage their own focus. Without
    // this exemption the trap would immediately steal focus back, making
    // the child modal's inputs unusable.
    const handleFocusIn = (e: FocusEvent) => {
      const target = e.target as Node | null
      if (target && el.contains(target)) return
      // Allow focus to remain inside a portaled modal overlay. These sit
      // at a higher z-index than the trap container and represent a
      // deliberate user interaction with a child dialog.
      if (target instanceof HTMLElement && target.closest('.modal-backdrop')) return
      // Allow focus to escape to a *different* element matching
      // `escapeSelector`. Typical use: a per-panel overlay (permission dialog,
      // question dialog) that should let the user click into a sibling panel
      // without the trap pulling focus back. The caller passes e.g.
      // '.chat-panel'; focus is released only when the target belongs to a
      // different panel than the one hosting the trap.
      if (opts?.escapeSelector && target instanceof HTMLElement) {
        const escapee = target.closest(opts.escapeSelector)
        if (escapee && escapee !== el.closest(opts.escapeSelector)) return
      }
      // Focus escaped the trap. Bring it back.
      if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1')
      el.focus()
    }
    el.addEventListener('keydown', handleKey)
    document.addEventListener('focusin', handleFocusIn)
    // Only pull focus in if it isn't already inside the container. An
    // `autoFocus` child has its focus applied during commit (before this
    // effect), so `el.contains(activeElement)` is already true and we skip.
    if (!el.contains(document.activeElement)) {
      // Focus the container, not its first focusable child, so panel
      // overlays don't spuriously highlight their first action button.
      // A plain <div> can't receive focus without a tabindex, so set -1
      // (keeps it out of the Tab order while allowing .focus()).
      if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1')
      el.focus()
    }
    return () => {
      el.removeEventListener('keydown', handleKey)
      document.removeEventListener('focusin', handleFocusIn)
      previouslyFocused?.focus?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])
}
