# Group Reorder Research — claude-react-web

## TL;DR

The user is correct: **the project has NO ability to reorder groups in the sidebar.** Groups are stored as an array whose index IS the display order, and the only mutations today are create (append to end) / rename / delete. There is no reorder handler, no drag affordance on group headers/pills, no up/down arrows, no keyboard shortcut, and no context-menu item for moving a group. Crucially, **the server needs no changes** — the existing `PUT /api/ui-state` is a full-state replace, so reordering the `groups` array client-side and PUTting persists automatically. The entire gap is client-side.

## 1. Data model

### Server store — `server/ui-state-store.ts`

The whole UI layout state is one JSON blob (`ui-state.json`), single-document pattern (read as a unit, debounced write). Lines 22-33:

```ts
export interface StoredSessionGroup {
  id: string
  name: string
  sessionIds: string[]
  panelRatios?: Record<string, number>
}

export interface UiState {
  groups: StoredSessionGroup[]
  sidebarOrder: string[]
  collapsedGroups: Record<string, boolean>
}
```

Key observations:
- A `StoredSessionGroup` has **no `order` field**. Order is purely positional in the `groups` array.
- `sidebarOrder: string[]` is **for SESSIONS, not groups** — it's the user's chosen ordering of session IDs in the flat sidebar list. Confirmed by `src/App.tsx:2633-2655` (`orderedSessions` memo) and the `useUiState` hook comment ("session groups, sidebar order, collapsed groups").
- `coerceUiState` (lines 41-70) preserves array order as-read; no sorting is applied.

### Client type — `src/types.ts:84-95`

```ts
export interface SessionGroup {
  id: string
  name: string
  sessionIds: string[]
  panelRatios?: Record<string, number>
}

export type SidebarSection =
  | { kind: 'group'; group: SessionGroup; sessions: SessionInfo[] }
  | { kind: 'ungrouped'; sessions: SessionInfo[] }
```

Mirrors the server shape — again, **no order field**. Position in `groups` is the order.

### Client hook — `src/hooks/useUiState.ts`

`useUiState()` returns `{ groups, setGroups, sidebarOrder, setSidebarOrder, collapsedGroups, setCollapsedGroups, loading }` (lines 76-84, 194-203). `setGroups(fn)` takes a functional updater, mutates state, and debounces a `PUT /ui-state` with the full merged snapshot (lines 159-170, 92-106). On mount it loads from `GET /ui-state` and does one-time legacy localStorage migration (lines 109-157).

### Group display order is the `groups` array order

`sidebarSections` is built in `src/App.tsx:2782-2810`:

```ts
const sidebarSections = useMemo((): SidebarSection[] => {
  const byId = new Map(orderedSessions.map((s) => [s.id, s]))
  const sections: SidebarSection[] = []
  const groupedIds = new Set<string>()
  for (const g of groups) {           // ← groups array order = section order
    ...
    sections.push({ kind: 'group', group: g, sessions: groupSessions })
  }
  // ungrouped appended at the end
}, [orderedSessions, groups, pendingGroupInheritance])
```

Group pills row (`SessionList.tsx:669-741`) also iterates `groups.map((g, i) => ...)` in array order. New groups are appended at creation (`handleCreateGroup`, `App.tsx:2899`): `setGroups((prev) => [...prev, { id, name: res.name, sessionIds: [] }])`. So display order = creation order, and there is currently no way to change it short of delete + recreate.

## 2. Server API (`/api/ui-state`)

Router mounted at `server/app.ts:254`: `app.route('/api/ui-state', buildUiStateRouter(opts.uiStateStore))`. Route file `server/routes/ui-state-routes.ts` defines exactly three endpoints:

| Method + path | Purpose | Body |
|---|---|---|
| `GET /api/ui-state` | Return full snapshot (lines 19-21) | — |
| `PUT /api/ui-state` | Full-state replace (lines 28-39) | entire `{ groups, sidebarOrder, collapsedGroups }` |
| `POST /api/ui-state/import` | One-time legacy localStorage migration (lines 43-51) | `UiState` |

`PUT` validates only that `body.groups` and `body.sidebarOrder` are arrays (line 34), then calls `store.update(body)` which does `this.state = next; this.schedule()` (`ui-state-store.ts:115-118`) — a blind replace of the entire blob, debounced 500ms to disk.

**Implication for group reordering:** Because `PUT` is a full-replace, a client that reorders its `groups` array and calls `setGroups` will already persist correctly through the existing endpoint. **No server-side changes are required** — no new route, no new field. The store's `update()`/`flush()`/`coerceUiState()` all preserve array order as-given.

Sessions are ordered within a group by `StoredSessionGroup.sessionIds` array order (positional). Groups are ordered relative to each other by position in `UiState.groups`. Neither has an explicit numeric `order` field.

## 3. Client UI — `src/components/SessionList.tsx`

### What exists for groups

- **Group pills row** (lines 669-741): `groups.map((g, i) => <button ...>)`. Each pill: `onClick → onActivateGroup`, `onContextMenu → opens menu`, `title` shows `Alt+<n>` activate hint. Not `draggable`. Has `showGroupHints` number badge (first 9) for Alt shortcuts.
- **Group section headers** (lines 776-869): `role="button"`, `onClick → onActivateGroup` (desktop) / `onToggleGroupCollapse` (mobile). Has `onDragOver`/`onDrop` **but only for dropping SESSION CARDS into the group** (lines 812-831, 875-907) — reads `readDragPayload(e)` and requires `payload.kind === 'sidebar-card'`. The header itself is **not `draggable`** and has no `onDragStart`.
- **Group pill context menu** (lines 1044-1095): exactly two items — "Rename group…" and "Delete group". **No "Move up/down", no "Reorder".**
- **Group management props** (lines 101-119): `onActivateGroup`, `onCreateGroup`, `onDeleteGroup`, `onRenameGroup`, `onAddToGroup`, `onToggleGroupCollapse`. **No `onReorderGroups`.**

### What exists for reordering SESSIONS (the existing in-group / flat reorder)

- `onReorder(draggedId, targetId, 'before'|'after')` — flat sidebar reorder (prop lines 72-73, handler `handleReorderSidebar` at `App.tsx:2815-2866`, mutates `sidebarOrder`).
- `onReorderInGroup(draggedId, targetId, 'before'|'after', groupId)` — within-group reorder (prop lines 83-88, handler `handleReorderInGroup` at `App.tsx:2965-3077`, mutates `group.sessionIds`).
- `onDropIntoGroup(sessionId, groupId)` / `onAddToGroup` — move session into a group (prop lines 76-77, handler `handleAddToGroup` at `App.tsx:1360-1438`).
- Drag-and-drop uses **native HTML5 DnD** via `src/hooks/useDragPayload.ts` (custom MIME `application/x-claude-react-web+json`, `DragPayload = { kind: 'sidebar-card'; id } | { kind: 'main-panel'; id }`). `SessionCard` sets `draggable={!isMobile && !isResuming && !isDeleting && !!onReorder}` (`SessionCard.tsx:178`) and `onDragStart` writes the payload (`SessionCard.tsx:180-183`).
- Keyboard Move up/down is also wired via the session context menu (`handleMove`, `SessionList.tsx:580-603`, calling the same `onReorder`/`onReorderInGroup`).

### No drag-and-drop library

`package.json` has **no** `@dnd-kit`, `react-beautiful-dnd`, or `react-dnd`. All DnD is native HTML5 via `useDragPayload.ts`.

## 4. Existing reorder pattern elsewhere (the convention to mirror)

The clearest in-codebase reorder UX is the **Models** settings tab: `src/components/GlobalSettingsModal.tsx`, `ModelsTab` (lines 686-803).

**Implementation** (lines 337-347):

```ts
const moveModel = (index: number, direction: -1 | 1) => {
  const target = index + direction
  if (target < 0 || target >= modelList.length) return
  const next = [...modelList]
  ;[next[index], next[target]] = [next[target], next[index]]
  setModelList(next)
}

const sortModels = () => {
  setModelList([...modelList].sort((a, b) => a.localeCompare(b)))
}
```

**UI** (lines 720-757): each row has a rank label (`Default` / `2` / `3`…), an up arrow (`disabled={i === 0}`, `IconArrowUp`), a down arrow (`disabled={i === modelList.length - 1}`, `IconArrowDown`), and a remove button. A toolbar above the list has an "A→Z" sort button shown when `modelList.length > 1`.

**Persistence**: `modelList` is local `useState<string[]>` loaded from `GET /api/config` (line 203) and saved back as part of a config PUT (line 265). Different storage path than groups, but the **UX convention** (up/down arrows + optional A→Z sort, with `disabled` at boundaries) is the pattern a group-reorder feature should match for consistency.

A second reference: `src/components/SettingsPanel.tsx:618` ("Move built-in group to end") and `src/components/WorkflowOverlay.tsx:130` ("Move UNGROUPED to the end") confirm the codebase's idiom for "reorder a section" is array-splice manipulation, not a DnD library.

## 5. Gap analysis — what's missing for group reordering

### Server side: NOTHING to change

`PUT /api/ui-state` already full-replaces the blob; `useUiState.setGroups` already PUTs on a 500ms debounce; `coerceUiState` preserves order. Reordering the `groups` array client-side persists for free.

### Client side — concrete files/functions to add or change

1. **`src/App.tsx`** — add a `handleReorderGroups` (or `handleMoveGroup`) `useCallback`, mirroring `handleReorderSidebar` (lines 2815-2866) and `moveModel` (GlobalSettingsModal:337). It should splice the `groups` array via `setGroups((prev) => { const next = [...prev]; ... return next })`. Then wire it as `onReorderGroups={...}` on `<SessionList>` (around line 3586-3599, next to `onReorder`/`onReorderInGroup`).

2. **`src/components/SessionList.tsx`** —
   - Add `onReorderGroups?: (groupId: string, direction: 'up'|'down') => void` (or a `(fromId, targetId, position)` signature) to `Props` (lines 101-119).
   - Add affordance. Cheapest, convention-matching option: extend the **group pill context menu** (lines 1044-1095) with "Move up" / "Move down" items, disabling the first/last. Optional: add small up/down arrow buttons to the group section header (lines 776-869) mirroring `ModelsTab`.
   - Optional DnD route: make the group header `draggable` and add `onDragStart`/`onDragOver`/`onDrop` that reorder groups. This requires a new payload variant in `useDragPayload.ts` (see below). This is heavier and diverges from the existing up/down-arrow convention; the menu/arrow approach is more in keeping with `ModelsTab`.

3. **`src/hooks/useDragPayload.ts`** — only if choosing the drag-and-drop route: add a `{ kind: 'group-header'; id: string }` to the `DragPayload` union (lines 21-28). Not needed for the up/down-arrow approach.

4. **`src/types.ts`** — no change. `SessionGroup` needs no `order` field; array position is the order (consistent with how `sidebarOrder` works for sessions and `modelList` works for models).

5. **`src/components/session-list/SessionCard.tsx`** — no change (session cards only).

6. **`server/ui-state-store.ts` / `server/routes/ui-state-routes.ts`** — no change.

7. **Keyboard shortcut (optional)** — `src/App.tsx:2406-2419` currently registers `Alt+1..9` to *activate* the Nth group. A group-reorder shortcut (e.g. `Alt+Shift+Up/Down`) could be added to the same `shortcuts` array if desired; not required.

### Exact functions that would change

| File | Function / location | Change |
|---|---|---|
| `src/App.tsx` | new `handleReorderGroups` (near line 2815, after `handleReorderSidebar`) | new — splice `groups` via `setGroups` |
| `src/App.tsx` | `<SessionList>` JSX (lines ~3586-3599) | add `onReorderGroups={handleReorderGroups}` |
| `src/components/SessionList.tsx` | `Props` (lines 101-119) | add `onReorderGroups` prop |
| `src/components/SessionList.tsx` | group pill context menu (lines 1044-1095) | add "Move up"/"Move down" items (or up/down arrow buttons on the header, lines 776-869) |
| `src/hooks/useDragPayload.ts` | `DragPayload` union (lines 21-28) | only if DnD route: add `group-header` variant |

## Summary

- Groups are stored positionally in `UiState.groups` (`server/ui-state-store.ts:30`); there is no `order` field. Display order = array order (`App.tsx:2788`, `SessionList.tsx:670`).
- The server API (`GET`/`PUT`/`POST import` on `/api/ui-state`) is a full-state replace — reordering the `groups` array client-side persists automatically; **no server changes needed**.
- The client has handlers to create/rename/delete/activate groups and to reorder **sessions** (flat and within-group via native HTML5 DnD + keyboard Move up/down), but **no handler, UI, or shortcut to reorder groups**. The group pill context menu (`SessionList.tsx:1044-1095`) offers only Rename and Delete; group headers are not `draggable`.
- The existing reorder convention to mirror is the Models settings tab (`GlobalSettingsModal.tsx:337-347, 720-757`): adjacent-swap `moveModel(index, ±1)` with up/down arrow buttons (disabled at boundaries) plus an optional A→Z sort. No drag-and-drop library is installed; all DnD is native HTML5 via `useDragPayload.ts`.
- Implementation is ~2 client files minimum (`src/App.tsx` + `src/components/SessionList.tsx`), optionally `src/hooks/useDragPayload.ts` if a drag route is chosen. Server and types are untouched.
