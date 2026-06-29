# Close Group Panels — Design

Date: 2026-06-29

## Problem

When a session belongs to a group, the only way to put the group's open panels
away is to close them one by one — and closing a member panel is a *synced*
operation (`App.closeSession` removes the session from the group). There is no
single gesture for "collapse the whole group's panels for now, but keep the
group and its membership intact so I can re-activate it later."

## Goal

Add a **Close all panels in "<group>"** action to the panel header context menu
(`Chat.tsx`), placed under the existing **Settings** item. Clicking it
deactivates the group: every open panel belonging to that group is closed, but
the group and its member list are preserved. Re-activating the group (clicking
its sidebar header) reopens the panels.

## Semantic distinction (intentional)

| Gesture | Effect |
|---|---|
| Close one panel (`closeSession`, × button, "Remove from group") | Synced: closes the panel **and** removes the session from the group. |
| Close all panels (new) | Deactivate: closes all the group's open panels, **keeps membership**. |

These coexist by design. The single-panel close means "I'm done with this one —
drop it from the group"; the bulk close means "put this group away for now."

## Approach (A — approved)

A new, independent `closeGroupPanels(groupId)` handler in `App.tsx` that filters
`openIds` without touching `groups` state. It is a separate path from
`closeSession` precisely because the semantics differ. Rejected alternatives:

- **B (loop `closeSession`)** — wrong: each call ungroups its member, emptying
  the group (the Close+ungroup-all semantics the user explicitly did not want).
- **C (a `minimized` flag on `SessionGroup`)** — YAGNI: `openIds` already
  represents "which panels are open"; a second flag duplicates that state.

## Components & data flow

### 1. `App.tsx` — `closeGroupPanels`

```ts
const closeGroupPanels = useCallback((groupId: string) => {
  const group = groupsRef.current.find((g) => g.id === groupId)
  if (!group) return
  const members = new Set(group.sessionIds)
  const prevOpen = openIdsRef.current
  const survivors = prevOpen.filter((id) => !members.has(id))
  if (survivors.length !== prevOpen.length) {
    animatePanelsRef.current?.(...survivors) // FLIP any non-group panels left
  }
  setOpenIds((prev) => prev.filter((id) => !members.has(id)))
  setFocusedId((f) =>
    f && members.has(f) ? (survivors[survivors.length - 1] ?? null) : f,
  )
}, [])
```

- Does **not** call `setGroups` — membership preserved.
- `focusedId` fallback mirrors `closeSession`: if the focused panel was a group
  member, fall back to the last surviving panel or `null`.
- Empty `openIds` is already a legal state (it occurs when the last panel is
  closed today); the center area renders its existing empty state, so no new
  edge case is introduced.

### 2. Prop chain `App → ChatPanel → Chat`

- **`App.tsx`** (near the `<ChatPanel>` render, ~line 2544): derive the owning
  group id alongside `groupLabel`, and pass
  `onCloseGroupPanels={groupId ? () => closeGroupPanels(groupId) : undefined}`.
- **`ChatPanel.tsx`**: add `onCloseGroupPanels?: () => void` to the props and
  forward it to `<Chat>` unchanged (mirrors how `groupLabel` / `onClose` are
  forwarded today).
- **`Chat.tsx`**: add `onCloseGroupPanels?: () => void` to `ChatProps`.

### 3. `Chat.tsx` — menu item

Insert into the panel header context menu **after the `Settings` item and before
the `Remove from "<group>"` / `Close panel` item** (around line 1136):

```tsx
...(onCloseGroupPanels && groupLabel
  ? [{
      label: `Close all panels in "${groupLabel}"`,
      icon: <IconX size={14} />,
      onClick: () => onCloseGroupPanels(),
    } as ContextMenuItem]
  : []),
```

- Shown only when the session is in a group (`groupLabel` truthy) and the
  callback is wired.
- The menu only appears on an already-open panel, so at least one group member
  is open — the action always has effect.
- Label follows the existing quoted-name convention (`Remove from "<group>"`).
  "Close all panels in" is preferred over "Close group panels" because it
  stresses closing *panels* (deactivate), not deleting the *group*.

## Edge cases

- **Group has more members than `maxOpen`**: only the first `maxOpen` are open
  panels. Filtering `openIds` by membership naturally closes only those that are
  open; the rest are unaffected.
- **Group not currently active**: the menu lives on an open panel, so this state
  is not reachable for the triggering session — at least one member is open.
- **No server / WS involvement**: this is pure client state (`openIds` /
  `focusedId`). `groups` persistence is untouched.

## Testing

- **App layer (vitest)**: after `closeGroupPanels(groupId)`, `openIds` contains
  no group members; `groups` is unchanged; `focusedId` falls back to the last
  survivor or `null` when the focused panel was a member. Cover the
  focused-is-member and focused-is-not-member branches.
- **Menu rendering**: the item renders when `groupLabel` is set and
  `onCloseGroupPanels` is provided, and is absent otherwise. Add a lightweight
  render assertion if no existing Chat menu test covers it.
- **Verify**: `npm run typecheck`, `npm run lint`, `npm run test`.
