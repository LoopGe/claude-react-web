import { useLayoutEffect, useRef } from 'react'

/**
 * Escape-key ownership stack for overlays.
 *
 * Before this hook, "who owns Escape" was a patchwork: capture-phase window
 * handlers (PanelOverlay, CommandPalette, …), bubble-phase window handlers with
 * stopPropagation (ConfirmDialog, …), bubble-phase with NO stopPropagation
 * (SubagentOverlay, WorkflowOverlay — which let Escape fall through to App's
 * interrupt branch), element-level listeners (PermissionDialog, QuestionDialog)
 * and components with no handler at all that relied on App's single ordered
 * chain (Settings, Git). Each variation behaved slightly differently, which was
 * the breeding ground for the P0 nesting bugs.
 *
 * This hook is the single owner. A module-level stack tracks every open
 * overlay; a single lazily-installed window CAPTURE keydown listener dispatches
 * Escape to the correct entry:
 *
 *   1. Scan top → bottom for the first entry whose container contains the
 *      focused element (e.target for keydown). That entry is "the current top
 *      overlay" — most recently opened wins, and nesting resolves by which
 *      layer actually holds focus.
 *   2. If focus is outside every container but the stack is non-empty, consume
 *      anyway (close the topmost entry). This is what stops Escape from falling
 *      through to App's interrupt branch while any overlay is open, and is what
 *      closes a per-panel overlay when focus sits in a sibling panel.
 *   3. Stack empty: no-op, so App's bubble-phase chain runs (interrupt /
 *      idle resume picker).
 *
 * Capture phase is mandatory: App's escape chain is a single bubble-phase
 * window keydown registered once at App mount, so a bubble listener here would
 * lose to registration order. Capture fires before bubble regardless of
 * registration, and createPortal makes no difference — every DOM event still
 * passes through the window capture path, so no React context provider is
 * needed.
 *
 * A `canClose` return of false still swallows the keypress (stopPropagation),
 * so a busy dialog's Escape doesn't close the overlay beneath it — matching the
 * old ConfirmDialog behavior of stopping propagation unconditionally.
 */

export interface EscapeStackEntry {
  /** The overlay's container element. The topmost entry whose container
   *  contains the focused element wins the Escape. */
  getContainer: () => HTMLElement | null
  /** Busy guard, called at dispatch time. false swallows the keypress but
   *  leaves the overlay open. */
  canClose: () => boolean
  /** Handle the Escape (close, or a custom action such as denying a
   *  permission request). */
  onEscape: (e: KeyboardEvent) => void
}

let stack: EscapeStackEntry[] = []
let listenerInstalled = false

function handleEscape(e: KeyboardEvent) {
  if (e.key !== 'Escape') return
  const target = e.target as Node | null

  // Top → bottom: the first entry whose container holds the focused element
  // is the layer the user is interacting with — most recently opened wins.
  let winner: EscapeStackEntry | undefined
  for (let i = stack.length - 1; i >= 0; i--) {
    const entry = stack[i]
    const container = entry.getContainer()
    if (container && target && container.contains(target)) {
      winner = entry
      break
    }
  }
  // Focus is outside every container (app background, a sibling panel, or a
  // non-stack popover) but an overlay is open: still consume so Esc can't fall
  // through to App's interrupt branch. Close the topmost entry.
  if (!winner && stack.length > 0) winner = stack[stack.length - 1]
  if (!winner) return

  e.preventDefault()
  e.stopPropagation()
  if (winner.canClose()) winner.onEscape(e)
}

function installListener() {
  if (listenerInstalled) return
  window.addEventListener('keydown', handleEscape, true)
  listenerInstalled = true
}

function uninstallListener() {
  if (!listenerInstalled) return
  window.removeEventListener('keydown', handleEscape, true)
  listenerInstalled = false
}

function syncListener() {
  if (stack.length > 0) installListener()
  else uninstallListener()
}

/**
 * Register an overlay in the Escape stack while `active` is true. The options
 * are read from a ref updated every render, so a component can register once
 * per open and still see the latest onEscape / canClose / container at dispatch
 * time (same pattern as PanelOverlay's onCloseRef).
 */
export function useEscapeStack(opts: {
  active?: boolean
  onEscape: (e: KeyboardEvent) => void
  canClose?: () => boolean
  getContainer?: () => HTMLElement | null
}): void {
  const optsRef = useRef(opts)
  /* eslint-disable react-hooks/refs -- mirror the PanelOverlay onCloseRef pattern:
     sync the latest opts during render; only read after commit in the listener */
  optsRef.current = opts
  /* eslint-enable react-hooks/refs */

  const active = opts.active ?? true
  // useLayoutEffect, not useEffect: the stack entry must exist BEFORE the
  // owning overlay moves focus into itself, or a parent focus trap observing
  // the resulting `focusin` will find isFocusInsideOtherOverlay(target) false
  // and steal focus back. That mis-location is then read by the Escape
  // dispatch's containment scan, so Esc closes the wrong layer (a parent
  // modal instead of the popover on top). Layout-phase registration runs
  // before every passive effect (autofocus, trap activation, a popover
  // focusing its first item), so the "register before focusing" invariant
  // holds for all consumers. Layout effects that move focus must additionally
  // be declared AFTER this hook call.
  useLayoutEffect(() => {
    if (!active) return
    const entry: EscapeStackEntry = {
      getContainer: () => optsRef.current.getContainer?.() ?? null,
      canClose: () => optsRef.current.canClose?.() ?? true,
      onEscape: (e) => optsRef.current.onEscape(e),
    }
    stack.push(entry)
    syncListener()
    return () => {
      // splice (not filter) so LIFO order survives a mid-stack removal.
      const idx = stack.indexOf(entry)
      if (idx >= 0) stack.splice(idx, 1)
      syncListener()
    }
  }, [active])
}

/** Number of entries currently in the stack (used by tests to know whether an
 *  overlay is open). */
export function getEscapeStackCount(): number {
  return stack.length
}

/**
 * True if `node` is inside any registered overlay container. Used by
 * useFocusTrap to let focus pass to a *portaled* child overlay without being
 * stolen back: a portaled dialog (e.g. McpInstaller → document.body) is not a
 * DOM descendant of the parent trap's container, so the parent's contains()
 * check can't see it — but it IS inside its own stack container, so this tells
 * the parent trap "hands off, a deeper overlay owns focus now". The caller's
 * own container is implicitly excluded: by the time this runs, `node` has
 * already been checked against `el.contains(node)` and failed.
 */
export function isFocusInsideOtherOverlay(node: Node): boolean {
  for (let i = stack.length - 1; i >= 0; i--) {
    const container = stack[i].getContainer()
    if (container && container.contains(node)) return true
  }
  return false
}

/** Test-only reset. Uninstalls any leaked listener so a fresh test starts clean. */
export function __resetForTests(): void {
  if (stack.length > 0) uninstallListener()
  stack = []
  listenerInstalled = false
}
