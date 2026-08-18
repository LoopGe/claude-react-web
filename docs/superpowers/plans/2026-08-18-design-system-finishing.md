# Design-System Finishing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tokenize every `border-radius`, refactor the High-Contrast skin to consume the radius tokens and add a new soft-HC skin, give tooltips a pure-CSS hover delay, and introduce a shared `EmptyState` component for the settings panels.

**Architecture:** All radii become `var(--radius-*)` tokens defined in `src/styles/tokens.css`. HC stops squaring corners via a global `!important` override and instead overrides the radius tokens to `0` (keeping `--radius-circle: 50%` so true circles stay circular); a new `[data-skin="soft-hc"]` block provides a near-black/near-white high-contrast look with normal radii. Tooltips get a `transition-delay` on the hover state only (keyboard focus stays instant). A new `EmptyState` component replaces 7 text-only "no data" notes in the settings/hooks/MCP panels.

**Tech Stack:** React 19 + Vite, plain CSS with theme tokens (`src/styles/*.css`), vitest + @testing-library/react (no jest-dom), Node ≥ 20.

## Global Constraints

- **Radius rule:** after this work, every `border-radius` in `src/` must be a `var(--radius-*)` reference. The grep gates below must pass with **zero** matches — if any literal `Npx`/`50%` radius remains, the HC token override would leak rounded corners and the work is incomplete.
- **Colors:** no new hardcoded hex values in components. The only permitted hex additions are the soft-hc skin's palette inside `tokens.css` and the `SOFT_HC_ACCENT` mirror constant in `AppearancePanel.tsx` (both documented brand/accent constants, following the `ANTHROPIC_ACCENT`/`HC_ACCENT` precedent).
- **Test style:** follow existing tests — vitest + `@testing-library/react`, assert with `expect(x).toBeTruthy()`, call `cleanup()` in `afterEach`. Do **not** use jest-dom matchers (`toBeInTheDocument` is not installed).
- **Working tree hygiene:** the repo currently has unrelated uncommitted changes (`src/components/PermissionDialog.tsx`, `src/components/PermissionDialog.test.tsx`, `src/components/QuestionDialog.tsx`, and an untracked `Python/`). Each task must `git add` only its own files — never `git add -A`.
- **Commit style:** one commit per task, message prefix matching the work (`feat:`, `refactor:`, `style:`, `test:`), body ending with `Co-Authored-By: Claude <noreply@anthropic.com>`.
- **Skin accent lock:** `soft-hc` must be treated as accent-locking everywhere (the per-session accent picker and `<html>` inline `--accent` are suppressed), exactly like `hc`.
- **Codemod scripts:** `scripts/migrate-radii.mjs` is one-shot. It is deleted in the final task. Never reuse it after the migration.

---

### Task 1: Radius tokens + HC override + soft-hc skin CSS

**Files:**
- Modify: `src/styles/tokens.css`

**Interfaces:**
- Produces: the `--radius-*` custom properties (consumed by every later task), the `[data-skin="hc"]` radius overrides, and the `[data-skin="soft-hc"]` / `[data-skin="soft-hc"][data-theme="light"]` blocks.

- [ ] **Step 1: Add the radius token block**

Insert after the motion tokens block (after line 80, the `--motion-scale-press` line) in `src/styles/tokens.css`:

```css
  /* Radius tokens — canonical corner-rounding steps. The main scale is
     pixel-identical to the values it replaces; --radius-3xs exists because
     3px appears 18× (status chips, focus-ring inner corners). --radius-pill
     is fully rounded pills (999px), --radius-circle true circles (50%). */
  --radius-3xs: 3px;
  --radius-2xs: 2px;
  --radius-xs: 4px;
  --radius-sm: 6px;
  --radius-md: 8px;
  --radius-lg: 10px;
  --radius-xl: 12px;
  --radius-2xl: 14px;
  --radius-3xl: 18px;
  --radius-pill: 999px;
  --radius-circle: 50%;
```

- [ ] **Step 2: Add HC radius overrides to the existing `[data-skin="hc"]` block**

In the `[data-skin="hc"]` block (starts around line 277, after the `--fast: #ff00ff;` line at ~293), add:

```css
  /* HC squares corners via the radius tokens — no universal override needed
     (the old `border-radius: 0 !important` in glass.css is removed in a later
     task). --radius-circle stays 50%: loading spinners must keep rotating as
     circles, and status dots / avatars / swatches staying circular is a
     deliberate refinement over the old "square everything" behavior. */
  --radius-3xs: 0;
  --radius-2xs: 0;
  --radius-xs: 0;
  --radius-sm: 0;
  --radius-md: 0;
  --radius-lg: 0;
  --radius-xl: 0;
  --radius-2xl: 0;
  --radius-3xl: 0;
  --radius-pill: 0;
  --radius-circle: 50%;
```

- [ ] **Step 3: Add the soft-hc skin (dark)**

Append a new block after the HC light block (find the end of the `[data-skin="hc"][data-theme="light"]` block near line ~460; add after its closing brace):

```css
/* ════════════════════════════════════════════════════════════════════
   SOFT HIGH CONTRAST — near-black/near-white with softer borders and
   normal radii. The middle ground between the default theme and the stark
   all-square HC skin: solid (no glass translucency), strong-but-not-white
   borders, normal rounded corners, normal focus ring and card shadows.
   Accent is locked (brand blue) for guaranteed contrast, like HC. */
[data-skin="soft-hc"] {
  --bg: #0e0e12;
  --bg-elev: #131318;
  --bg-elev-1: #18181e;
  --bg-elev-2: #1e1e25;
  --bg-elev-3: #26262e;
  --border: #3a3a42;
  --fg: #f2f2f5;
  --fg-muted: #a3a3ad;
  --accent: #7b8cde;
  --accent-strong: #8a9ae6;
  --on-accent: #0e0e12;
  --danger: #ff6b6b;
  --ok: #4ade80;
  --warn: #facc15;
  --fast: #c084fc;
  --focus-ring: 2px solid #7b8cde;
  /* No glass / translucency — solid surfaces; normal shadows stay default. */
  --glass-blur: none;
  --glass-surface-bg: var(--bg-elev);
  --glass-surface-border: var(--border);
  --glass-blur-strong: none;
  --glass-edge-highlight: none;
  --surface-gradient: none;
  --backdrop-color: rgba(0, 0, 0, 0.7);
}
```

- [ ] **Step 4: Add the soft-hc skin (light)**

Append immediately after the soft-hc dark block:

```css
[data-skin="soft-hc"][data-theme="light"] {
  --bg: #f5f5f7;
  --bg-elev: #fafafa;
  --bg-elev-1: #ffffff;
  --bg-elev-2: #ececf0;
  --bg-elev-3: #e0e0e6;
  --border: #8a8a94;
  --fg: #141419;
  --fg-muted: #5c5c66;
  --accent: #3b5bdb;
  --accent-strong: #2f4bc4;
  --on-accent: #ffffff;
  --danger: #d64545;
  --ok: #1f9d55;
  --warn: #b8860b;
  --fast: #7c3aed;
  --focus-ring: 2px solid #3b5bdb;
  --glass-blur: none;
  --glass-surface-bg: var(--bg-elev);
  --glass-surface-border: var(--border);
  --glass-blur-strong: none;
  --glass-edge-highlight: none;
  --surface-gradient: none;
  --backdrop-color: rgba(0, 0, 0, 0.4);
}
```

- [ ] **Step 5: Verify tokens exist and build compiles**

Run:
```bash
grep -c -- "--radius-pill:" src/styles/tokens.css   # expect: 1
grep -c -- "data-skin=\"soft-hc\"" src/styles/tokens.css   # expect: 2 (dark + light)
npm run build
```
Expected: both greps return the counts above; `npm run build` exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/styles/tokens.css
git commit -m "style: add radius tokens, HC token overrides, and soft-hc skin

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Codemod — tokenize CSS border-radius

**Files:**
- Create: `scripts/migrate-radii.mjs` (one-shot; deleted in Task 9)
- Modify: `src/styles/*.css` (all files under `src/styles/`)

**Interfaces:**
- Consumes: `--radius-*` tokens from Task 1.
- Produces: tokenized `border-radius` across all CSS; later the grep gates in Task 9 rely on zero remaining literals.

- [ ] **Step 1: Write the codemod script**

Create `scripts/migrate-radii.mjs`:

```js
// ONE-SHOT codemod: tokenize border-radius literals in src/styles (css mode)
// and src inline-style objects (tsx mode). Run then delete.
// Usage: node scripts/migrate-radii.mjs css|tsx
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'

const RADIUS_MAP = {
  '1px': 'var(--radius-2xs)',
  '2px': 'var(--radius-2xs)',
  '3px': 'var(--radius-3xs)',
  '4px': 'var(--radius-xs)',
  '5px': 'var(--radius-xs)',
  '6px': 'var(--radius-sm)',
  '7px': 'var(--radius-sm)',
  '8px': 'var(--radius-md)',
  '9px': 'var(--radius-lg)',
  '10px': 'var(--radius-lg)',
  '12px': 'var(--radius-xl)',
  '14px': 'var(--radius-2xl)',
  '18px': 'var(--radius-3xl)',
  '999px': 'var(--radius-pill)',
}

// Map a single CSS <length> token; 0 / unknown / !important pass through.
function mapLength(part) {
  if (part === '0') return '0'
  if (part === '50%') return 'var(--radius-circle)'
  if (RADIUS_MAP[part]) return RADIUS_MAP[part]
  return part
}

function rewrite(value) {
  return value.trim().split(/\s+/).map(mapLength).join(' ')
}

// border-radius: 4px | 6px 6px 0 0 | 50% !important | 999px
const CSS_RADIUS_RE = /(border-radius:\s*)([^;}]*)([;}])/g
// border-top-left-radius: 4px (corner-specific longhands)
const CSS_CORNER_RE = /(border-(?:top|bottom)-(?:left|right)-radius:\s*)([^;}]*)([;}])/g
// Inline style { borderRadius: 6 }
const TSX_NUM_RE = /(borderRadius:\s*)(\d+)(\s*[,}])/g
// Inline style { borderRadius: '50%' } or { borderRadius: '4px' }
const TSX_STR_RE = /(borderRadius:\s*['"])([^'"]+)(['"])/g

const [, , mode] = process.argv

function collect() {
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules') continue
      const full = join(dir, entry)
      const st = statSync(full)
      if (st.isDirectory()) walk(full)
      else if (st.isFile()) {
        const ext = extname(entry)
        if (mode === 'css' && ext === '.css') out.push(full)
        if (mode === 'tsx' && (ext === '.tsx' || ext === '.ts')) out.push(full)
      }
    }
  }
  walk('src')
  return out
}

const files = collect()
let changed = 0
for (const file of files) {
  const before = readFileSync(file, 'utf8')
  let after = before
  if (mode === 'css') {
    after = after
      .replace(CSS_RADIUS_RE, (_m, pre, value, end) => pre + rewrite(value) + end)
      .replace(CSS_CORNER_RE, (_m, pre, value, end) => pre + rewrite(value) + end)
  } else {
    after = after
      .replace(TSX_NUM_RE, (_m, pre, num, end) => {
        const token = RADIUS_MAP[`${num}px`]
        return token ? `${pre}'${token}'${end}` : _m
      })
      .replace(TSX_STR_RE, (_m, pre, val, quote) => {
        if (val === '50%') return `${pre}var(--radius-circle)${quote}`
        if (RADIUS_MAP[val]) return `${pre}${RADIUS_MAP[val]}${quote}`
        return _m
      })
  }
  if (after !== before) {
    writeFileSync(file, after)
    console.log('migrated', file)
    changed++
  }
}
console.log(`changed ${changed} files`)
```

- [ ] **Step 2: Run the codemod in css mode**

Run:
```bash
node scripts/migrate-radii.mjs css
```
Expected: prints one line per modified CSS file and a final `changed N files` count. Expect roughly 15 CSS files touched (every file under `src/styles/` with a literal radius).

- [ ] **Step 3: Verify the CSS grep gate**

Run:
```bash
grep -rnE "border-radius:\s*(50%|[0-9]+px)" src/styles
```
Expected: **zero** matches. (The glass.css `border-radius: 0 !important` universal override is literal `0`, which this pattern does not match; it is removed in Task 4.)

Run:
```bash
grep -rnE "border-(top|bottom)-(left|right)-radius:\s*[0-9]" src/styles
```
Expected: **zero** matches (corner-specific longhands tokenized).

- [ ] **Step 4: Spot-check the diff**

Run:
```bash
git diff --stat src/styles
git diff src/styles/layout.css | head -60
```
Expected: diff shows only `border-radius` lines changing; every replacement value is a `var(--radius-*)`. No other property changed. If any `var(--radius-*)` maps a value the diff shows as a *different* number than the original, fix that mapping in the script by hand in the affected files (the map is fixed; hand-correct the file).

- [ ] **Step 5: Commit**

```bash
git add scripts/migrate-radii.mjs src/styles
git commit -m "refactor: tokenize border-radius across src/styles

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Codemod — tokenize TSX/TS inline border-radius

**Files:**
- Modify: `src/**/*.tsx` and `src/**/*.ts` (inline style `borderRadius` values)

**Interfaces:**
- Consumes: `--radius-*` tokens from Task 1; the codemod script from Task 2.

- [ ] **Step 1: Run the codemod in tsx mode**

Run:
```bash
node scripts/migrate-radii.mjs tsx
```
Expected: prints one line per modified TS/TSX file. Expect the ~4 files known to have inline `borderRadius` (MarketplaceTab.tsx, SetupPage.tsx, and 2-3 others with numeric values).

- [ ] **Step 2: Verify the TSX grep gate**

Run:
```bash
grep -rnE "borderRadius:\s*([0-9]+|'50%')" src
```
Expected: **zero** matches.

- [ ] **Step 3: Spot-check the diff**

Run:
```bash
git diff src/components/MarketplaceTab.tsx src/components/SetupPage.tsx | head -80
```
Expected: `borderRadius: '50%'` became `borderRadius: 'var(--radius-circle)'`; any numeric `borderRadius: 6` became `borderRadius: 'var(--radius-sm)'`. Nothing else changed.

- [ ] **Step 4: Typecheck**

Run:
```bash
npm run typecheck
```
Expected: exits 0 (string CSS custom properties are valid in `CSSProperties`).

- [ ] **Step 5: Commit**

```bash
git add src
git commit -m "refactor: tokenize inline border-radius in components

Co-Authored-By: Claude <noreply@anthropic.com>"
```

> Note for the engineer: if `git add src` would sweep in the unrelated pre-existing modifications to `PermissionDialog.tsx` / `QuestionDialog.tsx`, stage only the files the codemod actually changed instead:
> ```bash
> git add $(git diff --name-only src | grep -E '\.(tsx|ts)$')
> ```

---

### Task 4: Remove the HC universal radius override from glass.css

**Files:**
- Modify: `src/styles/glass.css`

**Interfaces:**
- Consumes: `--radius-*` token overrides in the `[data-skin="hc"]` block (Task 1) and the fully tokenized radii (Tasks 2-3).

- [ ] **Step 1: Remove the universal override and spinner restore**

In `src/styles/glass.css`, delete the entire `HIGH CONTRAST SKIN — square corners on ALL UI` comment block plus the two rules under it, i.e. everything from `/* ═══...` (line ~188) through the `[data-skin="hc"] .composer-send-spinner, ... { border-radius: 50% !important; }` rule (~line 216). This includes:

```css
[data-skin="hc"] *,
[data-skin="hc"] *::before,
[data-skin="hc"] *::after {
  border-radius: 0 !important;
}
```
and
```css
/* Restore circular spinners (rotation on a square is illegible). */
[data-skin="hc"] .composer-send-spinner,
[data-skin="hc"] .msg-sending-spinner,
[data-skin="hc"] .app-loading-spinner,
[data-skin="hc"] .session-resuming-spinner {
  border-radius: 50% !important;
}
```
(These are now redundant: HC's `--radius-*` token overrides square everything except `--radius-circle`, which stays 50%, so spinners — now `var(--radius-circle)` — remain circular automatically.)

- [ ] **Step 2: Trim the scrollbar-thumb rules (keep the hard edge)**

In the `html[data-skin="hc"]::-webkit-scrollbar-thumb …` rules (lines ~230-239), delete only the `border-radius: 0 !important;` line from each selector block. **Keep** the `border: 0 !important;` and `background-clip: border-box !important;` lines — those are what give HC its hard-edged thumb that meets the track (the default floating pill is not expressible via a radius token). The thumb radius is now `var(--radius-pill)` → `0` via the token override.

- [ ] **Step 3: Verify glass.css has no radius overrides left**

Run:
```bash
grep -c "border-radius" src/styles/glass.css
```
Expected: **0**.

Run:
```bash
npm run build
```
Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add src/styles/glass.css
git commit -m "refactor: HC squares corners via radius tokens, drop !important override

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: Wire the soft-hc skin into the theme system

**Files:**
- Modify: `src/utils/theme.ts`
- Modify: `src/utils/theme.test.ts`
- Modify: `src/hooks/useTheme.ts`
- Modify: `src/components/AppearancePanel.tsx`

**Interfaces:**
- Consumes: `[data-skin="soft-hc"]` CSS from Task 1.
- Produces: `Skin` now includes `'soft-hc'`; `isAccentLocked('soft-hc') === true`; the picker can select it; `<html>` no longer gets inline `--accent` under soft-hc.

- [ ] **Step 1: Write the failing test**

In `src/utils/theme.test.ts`, inside the `describe('isAccentLocked', …)` block (around line 153), add:

```ts
    it('locks the accent for soft-hc', () => {
      expect(isAccentLocked('soft-hc')).toBe(true)
    })
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
npx vitest run src/utils/theme.test.ts
```
Expected: FAIL — `isAccentLocked('soft-hc')` returns `false` (the type also doesn't yet include `'soft-hc'`, so the call may be a type error at the `as Skin` boundary; that's fine — it fails).

- [ ] **Step 3: Update the Skin type, stored-skin guard, and isAccentLocked**

In `src/utils/theme.ts`:

Line 16:
```ts
export type Skin = 'default' | 'glow' | 'anthropic' | 'hc' | 'soft-hc'
```

`getStoredSkin` guard (line 30):
```ts
    if (v === 'default' || v === 'glow' || v === 'anthropic' || v === 'hc' || v === 'soft-hc') return v
```

`isAccentLocked` (line 44):
```ts
  return skin === 'anthropic' || skin === 'hc' || skin === 'soft-hc'
```

Also update the doc comment above `isAccentLocked` to mention soft-hc (brand blue) alongside Anthropic terracotta / HC blue.

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
npx vitest run src/utils/theme.test.ts
```
Expected: PASS.

- [ ] **Step 5: Update the useTheme accent-lock effect**

In `src/hooks/useTheme.ts`, the effect at ~line 116. Update the condition on line 124:

```ts
    if (skin === 'anthropic' || skin === 'hc' || skin === 'soft-hc') {
```
and extend the comment (lines 118-123) to read:

```ts
    // The Anthropic, High-Contrast, and Soft High-Contrast skins lock the
    // accent (brand terracotta / bright blue / indigo respectively). Remove
    // any inline accent overrides so the values defined in the
    // [data-skin="…"] blocks take effect — inline styles on <html> would
    // otherwise win. Switching back re-runs this effect and writes the
    // user's accent again.
```

- [ ] **Step 6: Add the soft-hc option to AppearancePanel**

In `src/components/AppearancePanel.tsx`:

Add to `SKIN_OPTIONS` (after the `hc` entry, line 36):
```ts
  { value: 'soft-hc', label: 'Soft High Contrast', desc: 'Near-B/W · rounded · contrast' },
```

Add a locked-accent mirror constant after `HC_ACCENT` (line 48):
```ts
/** soft-hc locked accent (indigo). Mirrors the dark variant in tokens.css's
 *  [data-skin="soft-hc"] block. The light variant uses #3b5bdb; the swatch
 *  shows the dark-variant colour and the lock message clarifies it is fixed. */
const SOFT_HC_ACCENT = '#7b8cde'
```

In the Accent section (the ternary at line 167), add a `soft-hc` branch before the final `else`:
```tsx
        ) : skin === 'soft-hc' ? (
          <div className="appearance-accent-locked">
            <span
              className="appearance-accent-locked-swatch"
              style={{ background: SOFT_HC_ACCENT }}
              aria-hidden
            />
            <span className="appearance-accent-locked-label">
              Locked to soft high-contrast accent
            </span>
          </div>
        ) : (
```

- [ ] **Step 7: Typecheck + test**

Run:
```bash
npm run typecheck
npx vitest run src/utils/theme.test.ts
```
Expected: both pass.

- [ ] **Step 8: Commit**

```bash
git add src/utils/theme.ts src/utils/theme.test.ts src/hooks/useTheme.ts src/components/AppearancePanel.tsx
git commit -m "feat: add soft-hc skin to the theme system and appearance picker

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: Tooltip hover show-delay (pure CSS)

**Files:**
- Modify: `src/styles/utilities.css`

**Interfaces:**
- Consumes: none (self-contained).
- Produces: hover-triggered tooltips appear after 150ms; keyboard focus shows them instantly; hiding stays immediate.

- [ ] **Step 1: Add the transition-delay rules**

In `src/styles/utilities.css`, immediately after the `.tt-wrap:hover > .tt-bubble, .tt-wrap:focus-within > .tt-bubble { … }` rule (the shared visible rule ending around line 843), add:

```css
/* Hover tooltips delay ~150ms so rapid mouse traversal doesn't flash
   bubbles; keyboard focus (focus-within) shows them instantly. Source order
   matters: :focus-within is after :hover so a focused-and-hovered trigger
   gets the 0ms delay. The hidden base rule keeps no delay, so hiding is
   immediate. Reduced-motion zeroes transitions below, killing the delay. */
.tt-wrap:hover > .tt-bubble {
  transition-delay: 150ms;
}
.tt-wrap:focus-within > .tt-bubble {
  transition-delay: 0ms;
}
```

- [ ] **Step 2: Verify**

Run:
```bash
npm run build
```
Expected: exits 0. Manual check (see Task 9 QA matrix for full pass): hover a button with a tooltip → bubble appears after a short delay; Tab-focus it → appears instantly; move away → disappears immediately.

- [ ] **Step 3: Commit**

```bash
git add src/styles/utilities.css
git commit -m "feat: tooltip hover show-delay via pure CSS transition-delay

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: EmptyState component + test

**Files:**
- Create: `src/components/EmptyState.tsx`
- Create: `src/components/EmptyState.test.tsx`
- Modify: `src/styles/utilities.css`

**Interfaces:**
- Produces: `<EmptyState icon title body action className />` — used by Task 8.

- [ ] **Step 1: Write the failing test**

Create `src/components/EmptyState.test.tsx`:

```tsx
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { EmptyState } from './EmptyState'

describe('EmptyState', () => {
  afterEach(cleanup)

  it('renders title, body and action', () => {
    render(
      <EmptyState
        title="No servers"
        body="Add one to start"
        action={<button>Add</button>}
      />,
    )
    expect(screen.getByText('No servers')).toBeTruthy()
    expect(screen.getByText('Add one to start')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Add' })).toBeTruthy()
  })

  it('renders an icon tile when provided', () => {
    render(<EmptyState title="Empty" icon={<svg data-testid="ico" />} />)
    expect(document.querySelector('[data-testid="ico"]')).toBeTruthy()
    expect(document.querySelector('.empty-state-ui-icon')).toBeTruthy()
  })

  it('omits body/action when not provided', () => {
    render(<EmptyState title="Only title" />)
    expect(document.querySelector('.empty-state-ui-body')).toBeNull()
    expect(document.querySelector('.empty-state-ui-action')).toBeNull()
  })

  it('passes className through to the root', () => {
    const { container } = render(<EmptyState title="Empty" className="extra" />)
    expect((container.firstChild as HTMLElement).className).toContain('extra')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
npx vitest run src/components/EmptyState.test.tsx
```
Expected: FAIL — module `./EmptyState` not found.

- [ ] **Step 3: Create the component**

Create `src/components/EmptyState.tsx`:

```tsx
import type { ReactNode } from 'react'

interface EmptyStateProps {
  /** Optional line-art icon tile (use an icon from icons/ToolIcons). */
  icon?: ReactNode
  /** Primary heading. */
  title: ReactNode
  /** Secondary muted explanation. */
  body?: ReactNode
  /** Optional action button / link rendered under the body. */
  action?: ReactNode
  /** Extra classes passed through to the root. */
  className?: string
}

/** Compact inline empty-state block for settings tabs / panels. Distinct
 *  from the chat first-run state (ChatEmptyState) and the landing card
 *  (.app-empty-state) — this is the "no items yet" slot inside a panel. */
export function EmptyState({ icon, title, body, action, className }: EmptyStateProps) {
  return (
    <div className={`empty-state-ui${className ? ` ${className}` : ''}`}>
      {icon && (
        <div className="empty-state-ui-icon" aria-hidden="true">
          {icon}
        </div>
      )}
      <div className="empty-state-ui-title">{title}</div>
      {body && <div className="empty-state-ui-body">{body}</div>}
      {action && <div className="empty-state-ui-action">{action}</div>}
    </div>
  )
}
```

- [ ] **Step 4: Add the EmptyState styles**

In `src/styles/utilities.css`, after the `.settings-empty-note` block (ends around line 991), add:

```css
/* ── EmptyState (shared inline empty-state block) ────────────────────────
 * Compact "no items yet" block used inside settings tabs / panels via the
 * EmptyState component. Left-aligned to match .settings-empty-note; distinct
 * from the chat first-run state and the landing .app-empty-state card. */
.empty-state-ui {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: 8px 2px;
}
.empty-state-ui-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  margin-bottom: 6px;
  border-radius: var(--radius-md);
  background: var(--bg-elev-2);
  color: var(--fg-muted);
}
.empty-state-ui-icon svg {
  width: 16px;
  height: 16px;
}
.empty-state-ui-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--fg);
}
.empty-state-ui-body {
  margin-top: 2px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--fg-muted);
}
.empty-state-ui-action {
  margin-top: 8px;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run:
```bash
npx vitest run src/components/EmptyState.test.tsx
```
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/components/EmptyState.tsx src/components/EmptyState.test.tsx src/styles/utilities.css
git commit -m "feat: add shared EmptyState component

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 8: Migrate the "no data" empty states to EmptyState

**Files:**
- Modify: `src/components/GlobalSettingsModal.tsx`
- Modify: `src/components/HooksPanel.tsx`
- Modify: `src/components/SettingsPanel.tsx`

**Interfaces:**
- Consumes: `<EmptyState>` from Task 7 and existing icons from `src/components/icons/ToolIcons.tsx` (`IconSparkles`, `IconTerminal`, `IconZap`, `IconClock`).

- [ ] **Step 1: GlobalSettingsModal — add imports**

`src/components/GlobalSettingsModal.tsx` already imports from `./icons/ToolIcons` (it uses `IconRefresh`). Add `IconSparkles` and `IconTerminal` to that import, and add:

```tsx
import { EmptyState } from './EmptyState'
```

- [ ] **Step 2: GlobalSettingsModal — migrate three sites**

Site A (line ~1142):
```tsx
            {skillNames.length === 0 && <div className="settings-empty-note">No skills discovered yet.</div>}
```
becomes:
```tsx
            {skillNames.length === 0 && <EmptyState icon={<IconSparkles size={16} />} title="No skills discovered yet" />}
```

Site B (line ~1217):
```tsx
          {skills.length === 0 && <div className="settings-empty-note">Create or import a project/user skill to get started.</div>}
```
becomes:
```tsx
          {skills.length === 0 && <EmptyState icon={<IconSparkles size={16} />} title="Create or import a project/user skill to get started" />}
```

Site C (lines ~1313-1317):
```tsx
      {servers.length === 0 && (
        <div className="settings-empty-note settings-mcp-empty">
          No MCP servers configured. Click "Add Server" to get started.
        </div>
      )}
```
becomes:
```tsx
      {servers.length === 0 && (
        <EmptyState
          icon={<IconTerminal size={16} />}
          title="No MCP servers configured"
          body='Click "Add Server" to get started.'
        />
      )}
```

- [ ] **Step 3: HooksPanel — add imports and migrate two sites**

Add to `src/components/HooksPanel.tsx`:
```tsx
import { EmptyState } from './EmptyState'
import { IconZap, IconClock } from './icons/ToolIcons'
```
(If HooksPanel already imports from `./icons/ToolIcons`, merge these into that import instead of adding a second one.)

Line ~321:
```tsx
          <div className="settings-empty-note">No hooks configured</div>
```
becomes:
```tsx
          <EmptyState icon={<IconZap size={16} />} title="No hooks configured" />
```

Line ~421:
```tsx
        {runs.length === 0 && <div className="settings-empty-note">No hook runs yet</div>}
```
becomes:
```tsx
        {runs.length === 0 && <EmptyState icon={<IconClock size={16} />} title="No hook runs yet" />}
```

- [ ] **Step 4: SettingsPanel — add imports and migrate two sites**

`src/components/SettingsPanel.tsx` already imports icons (it uses `IconRefresh` / tool icons). Add `IconSparkles` and `IconTerminal` to the existing `./icons/ToolIcons` import, and add:

```tsx
import { EmptyState } from './EmptyState'
```

Line ~938:
```tsx
        {!loadingMeta && effectiveMcpWithOverride.length === 0 && <div className="settings-empty-note">No MCP servers</div>}
```
becomes:
```tsx
        {!loadingMeta && effectiveMcpWithOverride.length === 0 && <EmptyState icon={<IconTerminal size={16} />} title="No MCP servers" />}
```

Line ~1193 (inside the allowlist branch):
```tsx
            <div className="settings-empty-note">No skills discovered for this workspace.</div>
```
becomes:
```tsx
            <EmptyState icon={<IconSparkles size={16} />} title="No skills discovered for this workspace" />
```

**Do NOT touch** the `Loading skills…` (line ~1190) or `Couldn't load skills: {error}` (line ~1191) notes — those are status text, not empty states.

- [ ] **Step 5: Verify**

Run:
```bash
npm run typecheck
npx vitest run src/components/EmptyState.test.tsx
```
Expected: both pass. Confirm `grep -c "settings-empty-note" src/components` no longer counts the migrated sites (only the loading/error notes remain).

- [ ] **Step 6: Commit**

```bash
git add src/components/GlobalSettingsModal.tsx src/components/HooksPanel.tsx src/components/SettingsPanel.tsx
git commit -m "feat: use shared EmptyState in settings/hooks/MCP empty states

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 9: Final verification + cleanup

**Files:**
- Delete: `scripts/migrate-radii.mjs`

- [ ] **Step 1: Delete the one-shot codemod**

Run:
```bash
rm scripts/migrate-radii.mjs
```
(If the directory `scripts/` becomes empty, remove it too: `rmdir scripts`.)

- [ ] **Step 2: Run the full grep gates**

Run:
```bash
grep -rnE "border-radius:\s*(50%|[0-9]+px)" src/styles || true
grep -rnE "border-radius:\s*(50%|[0-9]+)" src/components src/session-store || true
grep -rnE "borderRadius:\s*([0-9]+|'50%')" src || true
grep -rnE "border-(top|bottom)-(left|right)-radius:\s*[0-9]" src/styles || true
grep -c "border-radius" src/styles/glass.css || true
```
Expected: every command prints nothing (or `0` for the last). Any literal radius remaining is a gap — fix it before continuing.

- [ ] **Step 3: Run the full verification suite**

Run:
```bash
npm run typecheck && npm run lint && npm test && npm run build
```
Expected: all exit 0.

- [ ] **Step 4: Visual QA matrix**

Manually verify in the running app (`npm run dev`) across each skin × both themes:

| Skin | Dark | Light |
|---|---|---|
| default | radii look identical to before (no regressions) | same |
| glow | radii identical; glow halos intact | same |
| hc | pills/badges/cards square; status dots, avatars, spinners stay **circular**; scrollbar thumbs square and edge-to-edge | same |
| soft-hc | near-black surfaces, rounded corners, strong-but-not-white borders, accent locked to indigo, no glass blur | near-white surfaces, same properties |

Specifically exercise: a modal, a toast, a tooltip, a code block, a session card in the sidebar, message bubbles, and the MCP/skills empty states (should show the icon tile).

- [ ] **Step 5: Commit the cleanup**

```bash
git add -u scripts 2>/dev/null || git add scripts 2>/dev/null || true
git commit -m "chore: remove one-shot radius migration script

Co-Authored-By: Claude <noreply@anthropic.com>"
```
If there is nothing to commit (script was already untracked and deleted, and `scripts/` is gone), skip the commit.

---

## Out of scope (do not do in this plan)

- CSS Modules / Tailwind / CSS-in-JS migration.
- JS/portal tooltips or programmatic tooltip control.
- A "soft" variant for the `glow` / `anthropic` skins.
- Unifying `ChatEmptyState` or `.app-empty-state` into `EmptyState`.
- Migrating the remaining loading/error `.settings-empty-note` notes.
