// Shared dnd-kit payload plumbing — the typed bridge between the drag
// surfaces and the drop targets.
//
// The old HTML5 pipeline carried payloads through a custom dataTransfer MIME;
// dnd-kit replaces dataTransfer with its `data` channel: every draggable/
// droppable stores `{ crw: DragPayload }` under its `data` prop and readers
// unwrap it with `dndPayloadOf`. (OS file drops — folder → "New session" —
// read `dataTransfer` directly and never come through here.)

import type { SyntheticListenerMap } from '@dnd-kit/core/dist/hooks/utilities'


/** The in-app drag payload union. One place owns it and its per-kind
 *  contracts; every drag surface and drop target dispatches on `kind`. */
export type DragPayload =
  /** A session card dragged from the sidebar. Accepted by:
   *   - other sidebar cards  → reorder (live within the same container,
   *     cross-container on drop)
   *   - a group header/body  → move into the group (on drop)
   *   - the main grid        → open the session
   *   - a chat panel         → replace that panel's slot */
  | { kind: 'sidebar-card'; id: string }
  /** A chat panel's header dragged within the main grid. Accepted by:
   *   - other panels → swap positions (on drop) */
  | { kind: 'main-panel'; id: string }
  /** A session group dragged from a sidebar section header (vertical) or the
   *  top pill row (horizontal). Both live-reorder; the collision `axis`
   *  extra on the droppable data picks before/after geometry. */
  | { kind: 'group-card'; id: string }
  /** A model row dragged inside Global Settings → Profiles → Available
   *  Models. `id` is the model id string itself (unique within a profile's
   *  modelList). Accepted only by other model rows in the same list. */
  | { kind: 'profile-model'; id: string }
  /** A model-group card dragged inside Global Settings → Profiles →
   *  Model Groups. `id` is `ModelGroupConfig.id`. Accepted only by other
   *  group cards in the same profile. */
  | { kind: 'profile-model-group'; id: string }
  /** The main panel grid as a whole is a drop zone — dropping a sidebar card
   *  there opens the session. */
  | { kind: 'main-grid' }

const VALID_KINDS = new Set<DragPayload['kind']>([
  'sidebar-card',
  'main-panel',
  'group-card',
  'profile-model',
  'profile-model-group',
  'main-grid',
])

/** Wrapper key stored on every draggable/droppable `data`. Namespaced so a
 *  stray foreign payload can't collide with ours. */
const DATA_KEY = 'crw'

export interface DndItemData {
  crw: DragPayload
  /** Surface-specific extras (e.g. a sidebar card's containerGroupId, a
   *  pill/header's collision axis) ride alongside the payload. */
  [key: string]: unknown
}

/** Build the `data` prop value for a draggable / droppable. */
export function dndData(payload: DragPayload, extra?: Record<string, unknown>): DndItemData {
  return extra ? { [DATA_KEY]: payload, ...extra } : { [DATA_KEY]: payload }
}

/** Unwrap a payload from a dnd-kit `data` record (`active.data.current`,
 *  `over.data.current`, …). Returns null for undefined or foreign shapes —
 *  the `crw` key check guards against drags registered by other code; the
 *  union's own shape is guaranteed at compile time by dndData callers. */
export function dndPayloadOf(
  data: Record<string, unknown> | undefined,
): DragPayload | null {
  const raw = data?.[DATA_KEY]
  if (!raw || typeof raw !== 'object' || !('kind' in raw)) return null
  const p = raw as DragPayload
  if (!VALID_KINDS.has(p.kind)) return null
  if (p.kind !== 'main-grid' && typeof p.id !== 'string') return null
  return p
}

/** Read a surface-specific extra off a dnd-kit `data` record. */
export function dndExtraOf<T>(data: Record<string, unknown> | undefined, key: string): T | undefined {
  return data?.[key] as T | undefined
}

/** dnd-kit sensor listeners minus the KeyboardSensor activator. Surfaces that
 *  are already focusable controls with their own Enter/Space semantics
 *  (cards, pills, group headers, panel headers) must not have Space/Enter
 *  hijacked into a keyboard drag — keyboard reorder lives in the context
 *  menu / shortcuts instead. */
export function pointerOnlyListeners(
  listeners: SyntheticListenerMap | undefined,
): SyntheticListenerMap | undefined {
  if (!listeners) return undefined
  return Object.fromEntries(Object.entries(listeners).filter(([k]) => k !== 'onKeyDown'))
}

/** Maximum tilt (degrees) the drag ghost can reach at any speed. */
export const MAX_TILT_DEG = 4

/** Map horizontal pointer velocity (px/ms) to a ghost tilt angle in degrees.
 *  Sub-linear so gentle nudges stay invisible while flicks read as motion,
 *  hard-clamped at ±MAX_TILT_DEG. Pure so it's unit-testable; DragGhost
 *  feeds it into a spring. */
export function tiltFromVelocity(vx: number): number {
  const sign = vx < 0 ? -1 : 1
  const mag = Math.abs(vx)
  // tanh gives the soft knee: ~0.57° at 0.2 px/ms, ~1.4° at 1 px/ms, →4° asymptote.
  return sign * MAX_TILT_DEG * Math.tanh(mag * 1.5 / MAX_TILT_DEG)
}
