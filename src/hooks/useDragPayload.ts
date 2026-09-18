// Tiny helper around HTML5 drag-and-drop dataTransfer.
//
// The browser's DnD API works but has a terrible ergonomic surface — every
// handler needs to call preventDefault at the right moment, dataTransfer
// only round-trips strings, and there's no type payload. This module
// centralises:
//   - a single custom MIME type used for every in-app drag
//   - JSON (de)serialisation with a discriminated union
//   - helpers for every place we use DnD (sidebar cards, main
//     panels, cross-region, settings profile lists)
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
  /** A model row dragged inside Global Settings → Profiles → Available
   *  Models. `id` is the model id string itself (unique within a profile's
   *  modelList). Accepted only by other model rows in the same list. */
  | { kind: 'profile-model'; id: string }
  /** A model-group card dragged inside Global Settings → Profiles →
   *  Model Groups. `id` is `ModelGroupConfig.id`. Accepted only by other
   *  group cards in the same profile. */
  | { kind: 'profile-model-group'; id: string }

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

/** Vertical midpoint split used by list drop targets: pointer above the
 *  midline inserts before the hovered item, below inserts after. Shared so
 *  the gesture is the same across sidebar cards and settings lists. */
export function dropPositionOf(e: React.DragEvent, el: HTMLElement): 'before' | 'after' {
  const rect = el.getBoundingClientRect()
  return e.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
}

/** Insert-before/after reorder over a list, keyed by `getId`. Returns a new
 *  array; returns the SAME reference when the move is a no-op (equal ids, or
 *  the item is already in that slot) so callers can skip a state write.
 *  Removes only the FIRST match of `draggedId` — duplicate ids are not
 *  addressable by this drag model, but they are not silently dropped either. */
export function reorderById<T>(
  list: T[],
  getId: (item: T) => string,
  draggedId: string,
  targetId: string,
  position: 'before' | 'after',
): T[] {
  if (draggedId === targetId) return list
  const fromIdx = list.findIndex((item) => getId(item) === draggedId)
  if (fromIdx < 0) return list
  const dragged = list[fromIdx]
  const without = [...list.slice(0, fromIdx), ...list.slice(fromIdx + 1)]
  const targetIdx = without.findIndex((item) => getId(item) === targetId)
  if (targetIdx < 0) return list
  const insertAt = position === 'before' ? targetIdx : targetIdx + 1
  if (insertAt === fromIdx) return list
  return [...without.slice(0, insertAt), dragged, ...without.slice(insertAt)]
}

/** Element-wise order equality — so a drop that doesn't change the order
 *  doesn't mark a settings form dirty. */
export function sameOrder<T>(a: T[], b: T[]): boolean {
  return a.length === b.length && a.every((v, i) => Object.is(v, b[i]))
}
