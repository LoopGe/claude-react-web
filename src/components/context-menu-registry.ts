// Single-open registry for ContextMenu — kept out of ContextMenu.tsx so the
// file's exports stay component-only (react-refresh) and the dismissal entry
// point is importable without pulling the component module.
//
// ONE OPEN MENU AT A TIME: a mounting ContextMenu closes every other open
// menu via this registry. Owners can't see each other's state (App's
// header-strip menus vs SessionList's card/group menus), and outside
// right-clicks deliberately don't dismiss (a right-click must REPLACE its
// own menu — see ContextMenu's `nonPrimary`), so without this a cross-owner
// right-click would stack two live portals and the buried one's items stay
// clickable at its peeking edges. Same-owner replacement is a plain anchor
// swap (no remount), so it never trips the registry.

/** Close callbacks of every open ContextMenu. A fresh entry per mount
 *  (stable across re-renders), removed on unmount. */
const openMenuCloses = new Set<() => void>()

/** Register a mounted menu's dismiss; returns the unregister for the
 *  effect cleanup. Closes every other open menu first (layout timing keeps
 *  the buried menu from painting under the new one). */
export function claimExclusiveOpen(close: () => void): () => void {
  for (const other of [...openMenuCloses]) other()
  openMenuCloses.add(close)
  return () => {
    openMenuCloses.delete(close)
  }
}

/** Dismiss every open ContextMenu, regardless of owner. For layout shifts
 *  that detach every pinned anchor at once (sidebar toggle, keyboard sidebar
 *  resize) — no owner can be reached from the shift source (the + create
 *  menu's state lives inside CreateMenuButton), so the registry exposes the
 *  global dismiss. */
export function closeAllContextMenus(): void {
  for (const close of [...openMenuCloses]) close()
}
