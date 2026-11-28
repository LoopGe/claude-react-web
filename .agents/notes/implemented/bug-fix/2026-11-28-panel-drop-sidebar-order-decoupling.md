# Agent Note: Panel drops decoupled from sidebar order; drop targets announce outcomes

Status: implemented

## Problem

Dragging a sidebar session card slightly to the right and releasing teleported the card to the top of the sidebar. Runtime tracing (temporary `[dnd-debug]` console logs, removed with the fix) proved the chain: chat panels begin ~11px past the sidebar's card edge, so an ordinary rightward drag ends with the pointer inside a panel; `handleDndEnd` took the documented `sidebar-card → main-panel` branch (`handleAcceptSidebarDrop → openAtSlot`); and `openAtSlot`'s "same-group swap" branch exchanged the two sessions' positions in `group.sessionIds` to keep the old synced-workspace invariant (`openIds` order ≡ `sessionIds` order). The sidebar renders group sections in `sessionIds` order, so a panel-targeted drop silently rewrote the user's curated sidebar order — drop a middle card onto the first panel and it becomes the first card. Nothing previewed any of it: panels and the main grid carried zero drop-target feedback, so the gesture was indistinguishable from dragging back to rest until the release fired.

## Decision

One principle per surface, two halves:

1. **Sidebar order belongs to sidebar gestures.** `openAtSlot`'s group transition is the pure, unit-tested `groupsAfterSlotTakeover` (`src/utils/group-panels.ts`): an ungrouped taker still JOINS the target's group at the target's position (the `/resume`-into-panel membership contract, unchanged), but a taker already in ANY group changes nothing — no order swap. `group.sessionIds` is the sidebar/activation order; `openIds` is panel layout and may transiently diverge. Divergence self-heals — `handleActivateGroup`/`openTargetForSession` rebuild `openIds` from `sessionIds` on the next explicit group activation, and every `sameSet`-style check is set-based (order-insensitive), so nothing churns in between. `swapPanels` (panel-header drag) KEEPS mirroring its swap into `sessionIds`: that gesture is an explicit workspace rearrangement. The origin surface decides which order moves.

2. **Drop targets announce their outcome — exactly.** `panelDropHint(active, ownId)` (`src/dnd/payload.ts`, pure) maps the in-flight drag to `'replace' | 'swap' | null`, matching `handleDndEnd`'s branches one-for-one: an already-open dragged session swaps panel slots ("Release to swap panels"), a not-open one takes the slot and the occupant's panel closes ("Release to replace this panel"), a panel-header drag swaps. ChatPanel combines the hint with its own `panelDrop.isOver` to light the accent dashed ring — the sidebar drop targets' existing `.drop-target` vocabulary — plus the `.dnd-drop-pill`. The empty main grid lights the same ring with "Release to open" (nothing to replace there). The hint state reaches the leaves through `ActiveDragContext` (`src/dnd/active-drag.ts`): App memoizes `{ payload, isOpen }` from its existing `dndActive` state + `openIds` — NOT `useDndContext` (its value identity churns on every collision update — ChatPanel is the heaviest component in the tree) and NOT `useDndMonitor` (it throws without a DndContext ancestor, and ChatPanel's unit tests render without one). The context default of `null` keeps those renders inert, and its value flips twice per drag. The grid hint is gated to an empty grid: with panels open, `.main-body` only wins collisions in the few-px gaps between them, where a full-area ring would strobe on every crossing — and a gap drop merely opens/focuses, the lightest outcome. The card-drop slot swap also FLIP-animates now (`snapshotPanelScrolls` + `animatePanels`, the exact `swapPanels` pattern): the same panel mutation glides identically whichever gesture caused it.

## Alternatives considered

**Keep the order sync, add the affordance only.** The ring + pill would have previewed "swap", but the pill names the PANEL outcome — the sidebar teleport would remain an unannounced side effect of a panel gesture, and the reorder was the actual complaint.

**Same-group both-open drop = focus-only (no slot swap).** Most forgiving of accidental boundary crossings, but it deletes the documented `sidebar-card → main-panel` contract ("replaces that panel's slot") for the most common in-workspace case and leaves panel-header drag as the only swap gesture. Rejected: with the ring + pill, crossing the boundary is visible and escapable (release back over the sidebar is a no-op), and the slot semantics stay intact.

**Decouple `swapPanels` too (panel gestures never touch the sidebar).** Symmetric, but speculative scope: the panel-header swap's sidebar mirroring is documented intent and nobody reported it as surprising. Deliberately left alone — revisit if it is ever reported.

**`useDndMonitor` / `useDndContext` for the hint state.** See Decision — one throws in ChatPanel's test renders, the other re-renders the heaviest component on the collision hot path. Both lose to a twice-per-drag context.

## Consequences

Bought: the reported jump-to-first is structurally impossible — a panel drop can no longer rewrite sidebar order; and every main-area drop target states its outcome before the release, closing the affordance gap that made the gesture feel arbitrary.

Cost: after a same-group panel-slot drop, `openIds` order ≠ `sessionIds` order until the next explicit group activation. Sidebar slot pills can read non-monotonic (e.g. 2,1,3 — the pill is the truthful panel slot and Ctrl+N target), and a group re-activation resets panel order to the sidebar's. Both follow from "sidebar is canonical, panel layout is transient view state".

One adjacent flow changed with it: `/resume`-into-panel picking a session that is ALREADY in the target's group no longer moves the picked session to the target's sidebar position (the old order-swap doubled as position inheritance when the replaced session was then deleted). It keeps its own curated position while the deleted target's slot simply closes — consistent with the principle above; the ungrouped pick's membership replacement (joining at the target's position) is unchanged and remains that flow's documented contract.

## Testing

`groupsAfterSlotTakeover` is pinned in `src/utils/group-panels.test.ts` — including the same-group no-op that is this bug's regression pin — and `panelDropHint` in `src/dnd/payload.test.ts` (foreign/self × kinds). The affordance styles live in `src/styles/dnd.css` (`.chat-panel.drop-target`, `.main-body.drop-target`, `.dnd-drop-pill`).
