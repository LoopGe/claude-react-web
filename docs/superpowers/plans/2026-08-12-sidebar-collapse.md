# Sidebar Hide/Show (Collapse) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a desktop-only hide/expand toggle for the left sidebar that collapses the grid column to 0 with a smooth transition, driven by a header button and a Mod+B shortcut, persisted across reloads.

**Architecture:** A `sidebarCollapsed` boolean (via `useLocalStorage`) toggles a `.sidebar-collapsed` class on the `.app` grid. Desktop-scoped CSS animates `grid-template-columns` from `var(--sidebar-width) 1fr` to `0 1fr` using the existing `--motion-*` vars. The `<aside>` is set `inert` when collapsed so hidden sidebar content is removed from the tab order and a11y tree. A header button and a `mod+b` shortcut both flip the same state. The stored sidebar width is never touched, so expanding restores the exact prior width.

**Tech Stack:** React 19 (Vite), TypeScript, CSS grid + CSS transitions, Vitest + Testing Library (jsdom).

## Global Constraints

- **Desktop-only collapse:** every collapse CSS rule lives inside `@media (min-width: 769px)` in `layout.css`; the header toggle button renders only when `!isMobile`. Mobile's drawer (hamburger + `.drawer-open`) is untouched.
- **Persistence:** collapsed state is stored under `claude-react-web:sidebar-collapsed` via `useLocalStorage<boolean>` — same pattern as `SIDEBAR_WIDTH_KEY`. Must survive reload.
- **Width preserved:** collapsing must not change the stored sidebar width; the inline `--sidebar-width` var on `.app` stays as-is.
- **No new dependencies:** icons are hand-rolled inline SVGs in `src/components/icons/ToolIcons.tsx` (no lucide etc.). All CSS uses existing theme variables (`--motion-duration-moderate`, `--motion-ease-standard`, `--border`, …) — no hardcoded hex values.
- **A11y:** collapsed sidebar is `inert` + `aria-hidden` (desktop-only, gated on `!isMobile`) so focus never lands in an invisible list. The gate matters: if the user collapses on desktop then resizes to mobile, the drawer must stay interactive.
- **Commit messages** end with `Co-Authored-By: Claude <noreply@anthropic.com>`.
- **Logging:** none added — this is pure client UI state; do not use `console.*`.

---

### Task 1: `IconSidebar` icon (with test)

**Files:**
- Modify: `src/components/icons/ToolIcons.tsx` (append after `IconMenu`, end of file)
- Create: `src/components/icons/ToolIcons.test.tsx`

**Interfaces:**
- Consumes: the existing internal `Icon` component + `IconProps` type in `ToolIcons.tsx` (already present).
- Produces: `export function IconSidebar(props: IconProps): JSX.Element` — an inline SVG panel-left glyph (rect + vertical divider), the same shape/API as every other exported icon.

- [ ] **Step 1: Write the failing test**

Create `src/components/icons/ToolIcons.test.tsx`:

```tsx
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { IconSidebar } from './ToolIcons'

// vitest runs with `globals: false`, so @testing-library/react's auto-cleanup
// (via afterEach) doesn't register — rendered DOM would otherwise accumulate
// across tests.
afterEach(() => {
  cleanup()
})

describe('IconSidebar', () => {
  it('renders an accessible-hidden svg with the panel-left glyph', () => {
    const { container } = render(<IconSidebar size={16} />)
    const svg = container.querySelector('svg')
    expect(svg).not.toBeNull()
    expect(svg!.getAttribute('aria-hidden')).toBe('true')
    expect(svg!.getAttribute('width')).toBe('16')
    // panel-left: an outer rounded rect + a left vertical divider
    expect(svg!.querySelector('rect')).not.toBeNull()
    expect(svg!.querySelector('path')).not.toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/icons/ToolIcons.test.tsx`
Expected: FAIL — `IconSidebar` is not exported (import resolves to `undefined`), so the render throws.

- [ ] **Step 3: Write minimal implementation**

Append to the end of `src/components/icons/ToolIcons.tsx` (after `IconMenu`):

```tsx
export function IconSidebar(props: IconProps) {
  return (
    <Icon {...props}>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M9 3v18" />
    </Icon>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/icons/ToolIcons.test.tsx`
Expected: PASS (1 test).

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck`
Expected: PASS (both tsconfigs).

```bash
git add src/components/icons/ToolIcons.tsx src/components/icons/ToolIcons.test.tsx
git commit -m "feat: add IconSidebar icon for the sidebar toggle

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Collapse state + `.app` class + `<aside>` inert

**Files:**
- Modify: `src/constants/storageKeys.ts` (add key)
- Modify: `src/App.tsx` (add state; tag `.app` class; make `<aside>` inert)

**Interfaces:**
- Consumes: `useLocalStorage` (already imported in `App.tsx`).
- Produces: `sidebarCollapsed: boolean` state + `_setSidebarCollapsed: (v: boolean | ((prev: boolean) => boolean)) => void` in `App`; a `sidebar-collapsed` class on the `.app` element; `inert`/`aria-hidden` on the `<aside class="sidebar">`. Task 3 renames `_setSidebarCollapsed` → `setSidebarCollapsed` when it adds the first usages.

- [ ] **Step 1: Add the storage key**

In `src/constants/storageKeys.ts`, after `export const SIDEBAR_WIDTH_KEY = 'claude-react-web:sidebar-width'` (line 1), add:

```ts
/** Desktop sidebar hide/show state (true = collapsed/hidden). */
export const SIDEBAR_COLLAPSED_KEY = 'claude-react-web:sidebar-collapsed'
```

- [ ] **Step 2: Import the key in App.tsx**

In `src/App.tsx`, the `./constants/storageKeys` import block currently starts with `SIDEBAR_MIN_KEY`. Add `SIDEBAR_COLLAPSED_KEY` to that import list:

```ts
import {
  SIDEBAR_COLLAPSED_KEY,
  SIDEBAR_MIN_KEY,
  SIDEBAR_MAX_KEY,
  SIDEBAR_MIN_DEFAULT,
  SIDEBAR_MAX_DEFAULT,
  PANEL_MIN_RATIO_KEY,
  PANEL_MIN_RATIO_DEFAULT,
  LAST_SEEN_TURN_KEY,
  clampMaxOpen,
} from './constants/storageKeys'
```

- [ ] **Step 3: Add the state**

In `src/App.tsx`, immediately after the `panelMinRatio` line (`const panelMinRatio = Math.max(0.05, Math.min(0.4, panelMinRatioRaw))`), add:

```ts
/** Desktop sidebar hide/show. Persisted so a reload restores the state;
 *  expanding keeps the drag-resized width (see --sidebar-width below). */
const [sidebarCollapsed, _setSidebarCollapsed] = useLocalStorage<boolean>(SIDEBAR_COLLAPSED_KEY, false)
```

Note: the setter is named `_setSidebarCollapsed` because `noUnusedLocals` (tsconfig.json) rejects an unused binding, and the setter has no callers until Task 3. TypeScript exempts `_`-prefixed names from the unused check. Task 3 renames it back to `setSidebarCollapsed` when it adds the first usages.

- [ ] **Step 4: Tag the `.app` class**

In `src/App.tsx`, change the `.app` className (currently `` `app${isMobile && drawerOpen ? ' drawer-open' : ''}` ``) to:

```tsx
className={`app${isMobile && drawerOpen ? ' drawer-open' : ''}${sidebarCollapsed ? ' sidebar-collapsed' : ''}`}
```

- [ ] **Step 5: Make the `<aside>` inert when collapsed**

In `src/App.tsx`, change the `<aside>` opening tag (currently `<aside className="sidebar" aria-label="Sessions" {...drawerSwipe}>`) to:

```tsx
{/* Desktop-only: a persisted `sidebarCollapsed` must not inert the mobile
    drawer (the user may collapse on desktop, then resize to mobile). */}
<aside
  className="sidebar"
  aria-label="Sessions"
  inert={!isMobile && sidebarCollapsed}
  aria-hidden={!isMobile && sidebarCollapsed}
  {...drawerSwipe}
>
```

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: PASS. (No CSS yet — the `sidebar-collapsed` class is inert until Task 4.)

- [ ] **Step 7: Commit**

```bash
git add src/constants/storageKeys.ts src/App.tsx
git commit -m "feat: add persisted sidebar-collapsed state and inert aside

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Header toggle button + Mod+B shortcut

**Files:**
- Modify: `src/App.tsx` (import `IconSidebar`; render the desktop toggle button in `.main-header`; register `mod+b`)

**Interfaces:**
- Consumes: `sidebarCollapsed` / `setSidebarCollapsed` from Task 2; `IconSidebar` from Task 1; the `useKeyboardShortcuts` `shortcuts` `useMemo` in `App.tsx` (around line 2300).
- Produces: a `btn btn-icon` button (desktop only, `!isMobile`) in the header that toggles the state with `aria-pressed`; a `mod+b` `Shortcut` entry that toggles the same state and carries a `description` so it surfaces in CommandPalette / ShortcutHelp.

- [ ] **Step 1: Import IconSidebar**

In `src/App.tsx`, change the ToolIcons import (currently `import { IconSettings, IconBellToggle, IconMenu } from './components/icons/ToolIcons'`) to:

```tsx
import { IconSettings, IconBellToggle, IconMenu, IconSidebar } from './components/icons/ToolIcons'
```

- [ ] **Step 2: Rename the Task 2 setter**

Task 2 named the setter `_setSidebarCollapsed` (to satisfy `noUnusedLocals` while it had no callers). The button and shortcut in this task introduce its first usages, so rename it back to `setSidebarCollapsed`:

In `src/App.tsx`, change the state declaration (currently at the `panelMinRatio` line) to:

```ts
const [sidebarCollapsed, setSidebarCollapsed] = useLocalStorage<boolean>(SIDEBAR_COLLAPSED_KEY, false)
```

- [ ] **Step 3: Render the desktop toggle button**

In `src/App.tsx`, inside `.main-header`, immediately before the `<div className="main-toolbar" role="group" aria-label="App actions">` element, insert:

```tsx
{/* Desktop sidebar hide/show toggle. Rendered only on desktop — on mobile
    the sidebar is a drawer controlled by the hamburger (drawer-toggle). */}
{!isMobile && (
  <button
    className="btn btn-icon"
    onClick={() => setSidebarCollapsed((v) => !v)}
    aria-pressed={!sidebarCollapsed}
    aria-label={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
    title={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
  >
    <IconSidebar size={16} />
  </button>
)}
```

- [ ] **Step 4: Register the Mod+B shortcut**

In `src/App.tsx`, inside the `shortcuts` `useMemo` array, insert this entry right after the `mod+k` ("Command palette") entry:

```tsx
{
  combo: 'mod+b',
  handler: () => setSidebarCollapsed((v) => !v),
  description: 'Toggle sidebar',
},
```

Then add `setSidebarCollapsed` to that `useMemo`'s dependency array (currently `[closeSession, setGitPanelOpenFor, setHelpOpen, setSettingsOpenFor, toggleShortcutHelp, handleCloseSettings, handleCloseGitPanel]`):

```tsx
[closeSession, setGitPanelOpenFor, setHelpOpen, setSettingsOpenFor, toggleShortcutHelp, handleCloseSettings, handleCloseGitPanel, setSidebarCollapsed]
```

- [ ] **Step 5: Typecheck + lint**

Run: `npm run typecheck`
Expected: PASS.

Run: `npm run lint`
Expected: PASS (no new findings in `src/App.tsx`).

- [ ] **Step 6: Commit**

```bash
git add src/App.tsx
git commit -m "feat: add sidebar toggle button and Mod+B shortcut

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Collapse CSS + header alignment (desktop) + mobile cleanup

**Files:**
- Modify: `src/styles/layout.css` (`.app` transition, `.sidebar` min-width, header alignment, desktop collapse media block)
- Modify: `src/styles/utilities.css` (remove now-redundant mobile header overrides)

**Interfaces:**
- Consumes: the `sidebar-collapsed` class on `.app` from Task 2; the header button from Task 3.
- Produces: the visual collapse — desktop grid column animates `var(--sidebar-width) 1fr` → `0 1fr`; resizer + right border hidden when collapsed; header button sits at the left while the toolbar cluster stays flush-right.

- [ ] **Step 1: Animate the `.app` grid column**

In `src/styles/layout.css`, in the `.app` rule, add the transition line directly after `grid-template-columns: var(--sidebar-width) 1fr;`:

```css
.app {
  --sidebar-width: 280px;
  display: grid;
  grid-template-columns: var(--sidebar-width) 1fr;
  transition: grid-template-columns var(--motion-duration-moderate) var(--motion-ease-standard);
  height: 100vh;
  height: 100dvh;
  overflow: hidden;
}
```

- [ ] **Step 2: Let the sidebar shrink to 0**

In `src/styles/layout.css`, in the `.sidebar` rule, add `min-width: 0;` (grid items default to `min-width: auto` and otherwise won't shrink below their content width):

```css
.sidebar {
  position: relative;
  background: var(--bg-elev);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-width: 0;
  min-height: 0;
}
```

- [ ] **Step 3: Add the desktop collapse rules**

In `src/styles/layout.css`, immediately after the `body.resizing-col, body.resizing-col * { ... }` block (the rule that locks the cursor during a sidebar drag), append:

```css
/* Sidebar hide/show (desktop only). Collapsing sets the grid column to 0 so
   the chat panels fill the window. Scoped to ≥769px — the mobile drawer in
   utilities.css is untouched. `.app.sidebar-collapsed` (0,2,0) outranks the
   base `.app` and the tablet `.app` override (both 0,1,0), so it wins at
   every desktop width. */
@media (min-width: 769px) {
  .app.sidebar-collapsed { grid-template-columns: 0 1fr; }
  .app.sidebar-collapsed .sidebar { border-right: none; }
  .app.sidebar-collapsed .sidebar-resizer { display: none; }
}
```

- [ ] **Step 4: Left-align the header button, keep the toolbar flush-right**

In `src/styles/layout.css`, in the `.main-header` rule change `justify-content: flex-end;` to `justify-content: flex-start;`; in the `.main-toolbar` rule add `margin-left: auto;`:

```css
.main-header {
  min-height: var(--app-header-height);
  display: flex;
  align-items: center;
  justify-content: flex-start;
  padding: 6px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-elev);
}
.main-toolbar {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-left: auto;
}
```

- [ ] **Step 5: Remove the now-redundant mobile header overrides**

In `src/styles/utilities.css`, inside the `@media (max-width: 768px)` block, delete these two rules (their values now come from the base rules in `layout.css`):

```css
  .main-header {
    justify-content: flex-start;
  }
  .main-toolbar {
    margin-left: auto;
  }
```

- [ ] **Step 6: Manual verification**

Run: `npm run dev`
Then verify in the browser:

1. Desktop (≥769px): click the new panel-left button in the header's top-left → the sidebar smoothly collapses to 0 width and the chat area fills the window; the resizer handle disappears.
2. Click again → the sidebar expands back to its prior drag-resized width.
3. Press `Mod+B` (Cmd+B on Mac / Ctrl+B on Windows) → toggles the same way.
4. Reload the page → the collapsed state is remembered.
5. While collapsed, press Tab → focus skips the hidden sidebar entirely.
6. Resize to ≤768px → the hamburger/drawer behavior is unchanged, and no sidebar-toggle button appears.
7. Check the CommandPalette (`Mod+K`) → "Toggle sidebar" appears under Commands with the `Mod+B` hint.

- [ ] **Step 7: Commit**

```bash
git add src/styles/layout.css src/styles/utilities.css
git commit -m "feat: collapse the sidebar grid column on desktop

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full checks**

Run: `npm run typecheck`
Expected: PASS.

Run: `npm run lint`
Expected: PASS.

Run: `npm run test`
Expected: PASS — including the new `IconSidebar` test.

- [ ] **Step 2: Confirm the spec checklist**

Re-run the manual checklist from Task 4, Step 6 against the built app (`npm run preview`) to confirm the feature works in production mode too.

- [ ] **Step 3: No commit** (only if the full suite passed — the feature is already committed per task).
