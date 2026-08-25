// Tiny helper around HTML5 drag-and-drop dataTransfer.
//
// The browser's DnD API works but has a terrible ergonomic surface — every
// handler needs to call preventDefault at the right moment, dataTransfer
// only round-trips strings, and there's no type payload. This module
// centralises:
//   - a single custom MIME type used for every in-app drag
//   - JSON (de)serialisation with a discriminated union
//   - helpers for the three places we use DnD (sidebar cards, main
//     panels, cross-region)
//
// We deliberately do NOT wrap this in a context / state machine — each
// draggable source pokes `setDragPayload(e, payload)` in its `onDragStart`,
// and each drop target calls `readDragPayload(e)` in `onDrop`. Less
// machinery, easier to reason about.

/** MIME type for all in-app drags. Custom so we never collide with files,
 *  URLs, or text selections that the browser also flows through DnD. */
export const DRAG_MIME = 'application/x-claude-react-web+json'

export type DragPayload =
  /** A session card dragged from the sidebar. Accepted by:
   *   - other sidebar cards  → reorder
   *   - the main grid        → open / replace a panel */
  | { kind: 'sidebar-card'; id: string }
  /** A chat panel's header dragged within the main grid. Accepted by:
   *   - other panel headers  → swap positions */
  | { kind: 'main-panel'; id: string }
  /** A session group dragged from a sidebar section header (vertical list)
   *  or the top pill row (horizontal). Accepted by:
   *   - other group headers → reorder before/after
   *   - other group pills   → reorder left/right */
  | { kind: 'group-card'; id: string }

/** Call from `onDragStart`. Writes the payload as JSON onto dataTransfer
 *  under our custom MIME; also sets an `effectAllowed` so the browser
 *  shows the right cursor. */
export function setDragPayload(e: React.DragEvent, payload: DragPayload): void {
  try {
    e.dataTransfer.setData(DRAG_MIME, JSON.stringify(payload))
    // Fallback to text/plain for the rare case a drop handler forgets
    // our MIME — never hurts and matches native expectations.
    e.dataTransfer.setData('text/plain', payload.id)
    e.dataTransfer.effectAllowed = 'move'
  } catch {
    /* some browsers throw on dataTransfer mutation outside a real drag —
     *  swallow and let the drag simply not carry a payload. */
  }
}

/** Call from `onDrop` or `onDragOver` (with `peek`) to read the payload.
 *  Returns `null` when the drag isn't one of ours — e.g. an OS file drag,
 *  or the user selected text elsewhere and dragged it in. */
export function readDragPayload(e: React.DragEvent): DragPayload | null {
  const raw = e.dataTransfer.getData(DRAG_MIME)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as DragPayload
    if (parsed && typeof parsed === 'object' && 'kind' in parsed && 'id' in parsed) {
      return parsed
    }
    return null
  } catch {
    return null
  }
}

/** Returns true if the current drag carries one of our payload MIME types
 *  — without consuming it. Use inside `onDragOver` to decide whether to
 *  preventDefault() (which is what unlocks the drop).
 *
 *  NB: some browsers don't populate getData during dragover (only at drop).
 *  `dataTransfer.types` is always readable, so we check membership there. */
export function isInAppDrag(e: React.DragEvent): boolean {
  return e.dataTransfer.types.includes(DRAG_MIME)
}
