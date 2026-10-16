// Alt+↑ / Alt+↓ shortcut entries that drive the focused panel's transcript
// to the previous / next user message.
//
// Extracted from App's shortcuts useMemo so the routing — combo spelling,
// focused-session gate, registry lookup, direction mapping — is
// unit-testable against the real dispatcher (scroll-nav-shortcuts.test.ts).
//
// Both inputs are plain VALUES, not ref-reading closures: react-hooks/refs
// forbids passing refs (or functions that may read them) into a call made
// during render, and the shortcuts array is built during render. The
// contract that makes value-passing correct:
//   - `focusedId` is baked in at build time; App rebuilds the entries
//     whenever it changes (it lists focusedId in the shortcut useMemo's
//     deps), and a keypress always lands on the latest committed render —
//     so the baked value is never stale.
//   - `registry` is a stable mutable instance (App creates it with a lazy
//     useState initializer) read LIVE inside the handlers, so a panel that
//     registers after the entries were built is still routed to.
//
// Combo choice: plain arrows stay line-scroll (scroller focused) and the
// composer's caret / input-history walk (unfocused), and alt+shift+arrows
// move sidebar groups — alt+arrows are free of in-app conflicts.
// allowInInput mirrors alt+r / alt+b: the jump should work mid-typing, and
// the accepted trade-off is the same one those two already make — on macOS
// the dispatcher's preventDefault steals the native Option+↑/↓ caret-to-
// paragraph-start/end bindings while the composer holds focus, just as
// alt+r/alt+b steal Option+R/B special-character insertion. IME composition
// is blocked by the dispatcher itself.
import type { Shortcut } from '../hooks/useKeyboardShortcuts'
import type { CallbackRegistry } from '../utils/callbackRegistry'
import type { ScrollNavigator } from '../components/MessageList'

export function scrollNavShortcuts(
  registry: CallbackRegistry<ScrollNavigator>,
  focusedId: string | null,
): Shortcut[] {
  const jump = (dir: 'prev' | 'next') => {
    if (focusedId == null) return
    registry.get(focusedId)?.[dir]()
  }
  return [
    {
      combo: 'alt+arrowup',
      handler: () => jump('prev'),
      allowInInput: true,
      description: 'Scroll to previous user message',
    },
    {
      combo: 'alt+arrowdown',
      handler: () => jump('next'),
      allowInInput: true,
      description: 'Scroll to next user message',
    },
  ]
}
