import { useEffect, type RefObject } from 'react'

const DEFAULT_SELECTOR =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'

const DISABLED_EXCLUDING_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Trap keyboard focus inside a container element. Auto-focuses the first
 * focusable child on mount and wraps Tab/Shift+Tab at the boundaries.
 *
 * @param ref   Ref to the container element (e.g. a dialog).
 * @param opts.restoreFocus  Save and restore `document.activeElement` on unmount.
 * @param opts.excludeDisabled  Exclude `[disabled]` elements from the focus trap.
 */
export function useFocusTrap(
  ref: RefObject<HTMLElement | null>,
  opts?: { restoreFocus?: boolean; excludeDisabled?: boolean },
): void {
  useEffect(() => {
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
    el.addEventListener('keydown', handleKey)
    el.querySelector<HTMLElement>(selector)?.focus()
    return () => {
      el.removeEventListener('keydown', handleKey)
      previouslyFocused?.focus?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}
