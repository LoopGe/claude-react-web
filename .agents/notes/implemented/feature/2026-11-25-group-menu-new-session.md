# Agent Note: New session in this group (group-menu create + per-open dialog remount)

Status: implemented

## Problem

The group right-click menu (sidebar group header and the nav-strip group chip) offered only Move up / Move down / Rename / Delete. Creating a session into a specific group meant first activating that group — which swaps the whole panel grid — then opening `+ New`. The dialog's group picker already pre-selected the *active* group, but there was no way to pre-target an arbitrary group without disturbing the current view.

Separately, `NewSessionDialog` seeds its form state on mount, while `SessionList` keeps it mounted through a 180 ms exit animation (`useExitPresence`). A reopen inside that window reused the previous open's form state — the group pick, a pending inline new-group name, the folder-drop cwd prefill, and the `submitting` latch — so a stale pick could silently override a fresh explicit pre-target (and a stuck `submitting` disabled Create).

The dialog also labelled full groups ` — will replace oldest`, a promise the code stopped keeping when full-group handling became refuse-not-evict (commit `1304a08b`): the session is created but the group join is refused with a toast, nothing is evicted.

## Decision

`buildGroupContextMenuItems` emits a first row **New session in this group…** wired to an `onNewSession(groupId)` callback, followed by a separator and the existing management rows. At capacity (`group.sessionIds.length >= maxGroupSize`) the row is disabled and its label carries the count (`… (full n/max)`), matching `handleAddToGroup`'s refuse-not-evict rule. Both menu surfaces share the one builder.

App owns the pre-target (`newSessionInitialGroupId`) because the sidebar header and the nav-strip chip open the *same* dialog instance rendered by `SessionList`. `openNewSessionInGroup(groupId)` sets the pre-target and opens the dialog; `handleNewSessionDialogChange` clears the pre-target whenever the dialog closes, so a cancelled pick never leaks into the next open. `SessionList` passes `newSessionInitialGroupId ?? activeGroupId` to the dialog's `initialGroupId`, preserving the active-group fallback for ordinary opens.

`SessionList` remounts the dialog on every open via a per-open `key`. The key bumps on the `showDialog` rising edge using React's "adjust state when a prop changes" pattern: the previous value is **state** (`prevDialogShow`), not a ref, so a discarded concurrent render rolls the edge back with it. The render-phase `setState` runs before paint, so a reopen inside the exit-presence window mounts a fresh instance whose every field seeds from the current props at one decision point. `NewSessionDialog` stays mount-only; its props interface documents that a host keeping it mounted across opens MUST remount it per open.

The full-group copy is corrected to ` — full, will stay ungrouped` in both the picker row and the selected-trigger suffix, and in both manual editions. The manual's group rows now describe the header (not the removed "pill") and `+ New → New group…` (not the removed `+ Group` button), and list the new menu row.

Creation still flows through `App.handleCreate`, whose invocation-time view-preservation rules are unchanged (see [default-session quick create](./2026-11-17-default-session-quick-create.md)): a create into the active group appends to its grid; a create into a different group from an active group view stays out of the grid (the sidebar shows the new card); a create into a group from an ungrouped view opens the new session solo.

## Alternatives considered

- **Reset individual fields on the dialog's `open` rising edge.** Rejected: a `groupId`-only effect was built first and review proved it incomplete — a pending `newGroupName` still overrides the pre-target on submit, and `cwd`/`submitting` leak the same way. Per-field resets accumulate branches (CLAUDE.md's architectural-fix rule); the per-open remount resets the whole form at one point.
- **Ref-based render-phase edge detection.** Rejected: a ref write survives a discarded concurrent render, consuming the rising edge without committing the key bump and re-introducing the leak. The state-based pattern is the React-documented safe form and needs no `react-hooks/refs` suppression.
- **Activate the target group view on create.** Rejected: it swaps the whole panel grid as a side effect of a context-menu action. The existing `handleCreate` view-preservation rule deliberately keeps cross-group creates out of the current grid; the sidebar membership change is the feedback.
- **Evict the oldest session when the target group is full.** Rejected historically by `1304a08b` (silent eviction lost work) and reaffirmed here: the menu disables full groups, the picker labels them honestly, and `handleAddToGroup` refuses the join with a toast.

## Consequences

One click creates a session into any group without disturbing the current view, and every dialog open starts from a clean form seeded by the current props. The capacity story is consistent across menu (disabled), picker (honest label), and create (refuse-not-evict toast).

The remount trades away the accidental draft keep-alive within the 180 ms exit window: a rapid reopen loses the previous form and cuts the old instance's exit animation. This is acceptable — the dialog form is not persisted (a normal close/reopen already loses it), and a new open intent wants a fresh form. The render-phase key bump adds one local re-render of the memo'd `SessionList` per open.

A create into a non-active group from an active group view still does not auto-open a panel; that is the deliberate view-preservation rule, not a gap. The new menu row's `onNewSessionInGroup` prop is optional, mirroring the sibling `onMoveGroup` convention; App (the only production host) always wires it.

## Testing

`groupMenuItems.test.tsx` pins the row order, the create callback, and the disabled full-count label. `App.default-session.test.tsx` drives the real sidebar group menu end-to-end (mocked dialog capturing `initialGroupId`): pre-target wins over the active group, cancel clears the pre-target, and a full group disables the row. `SessionList.new-session-dialog.test.tsx` drives the real dialog through a rapid close/reopen inside the exit window, asserting the pre-target re-seeds and a pending new-group name cannot override it. `NewSessionDialog.test.tsx` pins the honest full-group label on both the picker row and the trigger.
