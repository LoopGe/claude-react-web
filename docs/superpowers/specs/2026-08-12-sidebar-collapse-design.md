# Sidebar Hide/Show (Collapse) — Design

## Goal

Add a hide/expand toggle for the **desktop** left sidebar (the `SessionList`
column). When collapsed, the sidebar is fully hidden (grid column → 0) so the
chat panels fill the window; a button and a `Mod+B` shortcut bring it back.

**Decisions locked in with the user:**
- Collapse form: **full hide** (width 0), not an icon rail.
- Toggle button: **top toolbar, left side** (desktop only).
- Scope: **desktop only** (≥769px). Mobile keeps its existing hamburger + drawer.
- Keyboard shortcut: **Cmd/Ctrl+B**, wired through `useKeyboardShortcuts` so it
  auto-appears in the CommandPalette / ShortcutHelp.

## Scope

- Client-only (`src/`). No server changes.
- Desktop collapse/expand of the sidebar column.
- Persist the collapsed state across reloads (localStorage).
- No auto-expand on session open; no collapsed-mode indicators (YAGNI).
- Not applicable to mobile (≤768px) — the drawer behavior is untouched.

## Current layout (for reference)

`.app` is a CSS grid: `grid-template-columns: var(--sidebar-width) 1fr`
(`src/styles/layout.css`). `--sidebar-width` is set inline on `.app`
(`App.tsx`) from `useSidebarResize`, persisted under `SIDEBAR_WIDTH_KEY`.
`<aside class="sidebar">` holds the brand row + `<SessionList>` + a drag
resizer (`.sidebar-resizer`). The `.main` region (toolbar + chat panels) is
the second grid column.

Mobile (≤768px) re-declares `.app` as a single `1fr` column and turns
`.sidebar` into a `position: fixed` drawer toggled by `drawerOpen` /
`.drawer-open` (`src/styles/utilities.css`). That path is out of scope.

## Design (Approach A: collapse the grid column)

### State & persistence

- `src/constants/storageKeys.ts`: add
  `SIDEBAR_COLLAPSED_KEY = 'claude-react-web:sidebar-collapsed'`.
- `App.tsx`: `const [sidebarCollapsed, setSidebarCollapsed] =
  useLocalStorage<boolean>(SIDEBAR_COLLAPSED_KEY, false)` — same persistence
  pattern as `SIDEBAR_WIDTH_KEY`.
- Collapsing does **not** touch the stored sidebar width; expanding restores
  the exact prior width (the inline `--sidebar-width` var stays as-is).

### Layout / CSS (`src/styles/layout.css`)

Scope the collapse to desktop so mobile is untouched:

```css
/* base — animate the collapse/expand */
.app {
  transition: grid-template-columns var(--motion-duration-moderate) var(--motion-ease-standard);
}
.sidebar {
  min-width: 0; /* grid items default to min-width:auto and won't shrink below content */
}

@media (min-width: 769px) {
  .app.sidebar-collapsed { grid-template-columns: 0 1fr; }
  .app.sidebar-collapsed .sidebar { border-right: none; }
  .app.sidebar-collapsed .sidebar-resizer { display: none; }
}
```

- `.app.sidebar-collapsed` (specificity 0,2,0) beats both the base `.app`
  rule and the tablet media-query `.app` override (0,1,0), so it wins at every
  desktop width. On mobile the rules are absent, so the drawer behavior is
  unchanged even if `sidebarCollapsed` is persisted as `true`.
- The transition is on the base `.app` rule; `grid-template-columns` only
  changes on collapse/expand, so nothing else animates.
- `.sidebar` already has `overflow: hidden`, so a 0-width column clips its
  content visually.

### Toggle button (top toolbar left, desktop only)

- `App.tsx` `.main-header`: render a `btn btn-icon` button as the first child
  (before `.main-toolbar`), only when `!isMobile`.
- New icon `IconSidebar` (left-panel glyph) in
  `src/components/icons/ToolIcons.tsx`, matching the existing stroke-icon
  pattern.
- `aria-pressed={!sidebarCollapsed}`; `title` / `aria-label` switch between
  "Hide sidebar" / "Show sidebar".
- Header alignment: change desktop `.main-header` from `justify-content:
  flex-end` to `flex-start`, and move `.main-toolbar { margin-left: auto }`
  from the mobile media query into the base rule — this puts the button at the
  left edge while the existing cluster stays flush-right (matches the mobile
  header layout).

### Keyboard shortcut

- Add to the `useKeyboardShortcuts` array in `App.tsx`:
  `{ combo: 'mod+b', description: 'Toggle sidebar', handler: () => setSidebarCollapsed(v => !v) }`.
- Because it carries a `description`, CommandPalette auto-lists it under
  Commands and ShortcutHelp shows it — no extra wiring.

### Accessibility

- On the `<aside class="sidebar">`, set `inert={sidebarCollapsed}` and
  `aria-hidden={sidebarCollapsed}` (React 19 supports `inert`). A collapsed
  sidebar is removed from the tab order and the a11y tree, so keyboard users
  can't Tab into an invisible list.

## Edge cases

- **Mobile**: collapse CSS scoped to ≥769px; button renders only on desktop.
  A user who collapses on desktop and resizes to mobile sees the normal
  hamburger/drawer; resizing back restores the collapsed state.
- **Drag-resize**: `.sidebar-resizer` is `display: none` when collapsed (not
  focusable, not draggable). Width is preserved.
- **Keyboard resize**: the `onSidebarResizerKeyDown` handler lives on the
  resizer element, which is hidden when collapsed.
- **No auto-expand**: opening a session via CommandPalette / notifications
  while collapsed still works — the sidebar is only a list.
- **Skip-link / `#main`**: unaffected; the skip link targets the main region.

## Testing / verification

- `npm run typecheck` (both tsconfigs), `npm run lint`, `npm run test`.
- Manual (`npm run dev`):
  1. Collapse on desktop → smooth 0-width animation, chat fills window.
  2. Expand → prior width restored.
  3. Reload → collapsed state persists.
  4. `Mod+B` toggles; visible in CommandPalette + ShortcutHelp.
  5. Tab through while collapsed → focus skips the hidden sidebar.
  6. Mobile viewport (≤768px) → hamburger drawer unchanged; no toggle button.
