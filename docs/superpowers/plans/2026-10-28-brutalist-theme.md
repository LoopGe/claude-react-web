# Brutalist Skin (粗野主义主题) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a switchable `brutalist` skin (light = paper C, dark = inverted-paper A) to the app: zero radius, hard shadows, sticker badges, fixed yellow/orange/blue accent triad, glass/gradients off.

**Architecture:** Two token blocks in `tokens.css` (`[data-skin="brutalist"]` + `[data-skin="brutalist"][data-theme="light"]`, following the hc/glow block pattern) carry the entire palette and structural overrides; one new `brutalist.css` (imported after `glass.css`) adds the component-level sticker language (rotation, display type, hard sticker shadows, border-width bumps) scoped under the skin attribute. TS side registers `'brutalist'` in the `Skin` union and the three lock helpers.

**Tech Stack:** CSS custom-property theming (tokens.css), React 19 + TS, vitest (node env for `src/utils/**` and `src/styles/**` tests, happy-dom for hooks).

**Spec:** `docs/superpowers/specs/2026-10-28-brutalist-theme-design.md` (executors read both; where this plan and the spec differ on a value, the spec's §7 tables win, reproduced verbatim in Task 2).

## Global Constraints

- No hardcoded hex in component CSS (`src/styles/*.css` outside `tokens.css`) — colors only via CSS variables. Enforced by test in Task 4.
- Every new color token is defined in **both** brutalist blocks (dark `[data-skin="brutalist"]` and light `[data-skin="brutalist"][data-theme="light"]`).
- Message body text keeps the normal sans stack (`--sans`); the display font (`--bt-display`) applies only to buttons/labels/badges/section bars (spec anti-goal: no display font in prose).
- No new webfonts (`@font-face`) — system stacks only.
- Radius is **fully** zeroed including `--radius-circle` (spec §7 "圆角：全部 0" is explicit; the hc `50%` exception does NOT apply here).
- Motion stays: existing animations keep playing (sticker rotation uses the standalone `rotate` property, never `transform: rotate()`, so transform-based motion is untouched).
- Before every commit: `npm run typecheck` (both tsconfigs) and `npm run lint` clean; task tests green. Per repo policy every diff gets reviewed before its commit, and `code-review` runs on the full branch before the work is declared done.
- Commit messages end with: `Co-Authored-By: Claude Code <noreply@anthropic.com>`

## Review Focus

1. **Inline accent leak** — a user-picked accent is written as inline style on `<html>` (`useTheme.ts` accent effect) and beats skin CSS; if brutalist doesn't clear it, the skin renders the wrong accent with tests green. Pinned by `useTheme.test.tsx` (Task 1).
2. **Status-ink AA on the new surfaces** — paper `#f5f1e6`/`#e5e0d0` and near-black `#141312` change every contrast ratio; blue as text fails on dark (`3.6:1`), orange as text fails on paper (`3.1:1`). Pinned by `status-ink-contrast.test.ts` with brutalist contexts added to `NAMED_CONTEXTS` (Task 2).
3. **Radius-literal residue** — 13 sites hardcode `border-radius: Npx`, so token zeroing alone leaves rounded corners (spec anti-goal #1). Pinned by the `radius-literals` guard test (Task 3).
4. **Glass wash / decorative-gradient residue** — `glass.css`'s top-wash `linear-gradient` selectors exclude only glow/hc, so brutalist would still get a gradient wash. Pinned by `brutalist-css.test.ts` assertion on the wash blocks (Task 4).
5. **CJK fallback in the display stack** — `Arial Black` has no CJK glyphs; if `PingFang SC`/`Microsoft YaHei` are missing or ordered before the Latin faces, Chinese labels regress to a serif default. Pinned by the `--bt-display` string assertion in `brutalist-tokens.test.ts` (Task 2) + visual check (Task 5).

---

### Task 1: Register the `brutalist` skin and its locks

**Files:**
- Modify: `src/utils/theme.ts` (Skin union line 17, `getStoredSkin` line 28, lock helpers lines 43–60)
- Modify: `src/utils/theme.test.ts`
- Modify: `src/hooks/useTheme.ts` (accent effect, line 108)
- Create: `src/hooks/useTheme.test.tsx`
- Modify: `src/components/AppearancePanel.tsx` (`SKIN_OPTIONS` line 42, accent section lines 218–261)

**Interfaces:**
- Consumes: nothing.
- Produces: `Skin` union includes `'brutalist'`; `isAccentLocked(skin)` / `isBackgroundLocked(skin)` / `isTransparencyLocked(skin)` all return `true` for `'brutalist'` (and stay in lockstep for existing skins); `SKIN_OPTIONS` gains the entry `{ value: 'brutalist', label: 'Brutalist', desc: 'Neo-brutalist stickers · hard edges' }`. Later tasks rely only on the attribute name `data-skin="brutalist"`.

- [ ] **Step 1: Write the failing tests**

Add to `src/utils/theme.test.ts`:

```ts
describe('brutalist skin registration', () => {
  it('getStoredSkin accepts "brutalist"', () => {
    localStorage.setItem(SKIN_KEY, 'brutalist')
    expect(getStoredSkin()).toBe('brutalist')
  })
  it('applySkin sets data-skin="brutalist" and persists it', () => {
    applySkin('brutalist')
    expect(document.documentElement.getAttribute('data-skin')).toBe('brutalist')
    expect(localStorage.getItem(SKIN_KEY)).toBe('brutalist')
  })
  it('locks accent, background AND transparency (strictest skin)', () => {
    expect(isAccentLocked('brutalist')).toBe(true)
    expect(isBackgroundLocked('brutalist')).toBe(true)
    expect(isTransparencyLocked('brutalist')).toBe(true)
  })
})
```

Create `src/hooks/useTheme.test.tsx` (happy-dom via `environmentMatchGlobs`, `@testing-library/react` `renderHook` + `act`). Seed the accent through the hook itself (no localStorage key guessing):

```tsx
it('clears inline accent overrides when the skin locks the accent', () => {
  const { result } = renderHook(() => useTheme())
  act(() => result.current.setAccentColor('#ff0000'))
  expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#ff0000')
  act(() => result.current.setSkin('brutalist'))
  const root = document.documentElement.style
  expect(root.getPropertyValue('--accent')).toBe('')
  expect(root.getPropertyValue('--accent-strong')).toBe('')
  expect(root.getPropertyValue('--on-accent')).toBe('')
})
it('restores the user accent when switching back to an unlocked skin', () => {
  const { result } = renderHook(() => useTheme())
  act(() => result.current.setAccentColor('#ff0000'))
  act(() => result.current.setSkin('brutalist'))
  act(() => result.current.setSkin('default'))
  expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#ff0000')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/utils/theme.test.ts src/hooks/useTheme.test.tsx`
Expected: FAIL — `'brutalist'` not assignable / not accepted; `isTransparencyLocked('brutalist')` false; inline `--accent` still set.

- [ ] **Step 3: Implement the registration**

In `src/utils/theme.ts`:
1. Extend the union: `export type Skin = 'default' | 'glow' | 'anthropic' | 'hc' | 'soft-hc' | 'brutalist'`.
2. Add `|| v === 'brutalist'` to `getStoredSkin`'s accept list.
3. Add `|| skin === 'brutalist'` to `isAccentLocked`, `isBackgroundLocked`, `isTransparencyLocked` (keep the three helpers in lockstep per their doc comments; update the comments to mention brutalist).

In `src/hooks/useTheme.ts` line 108: replace the raw triple compare `skin === 'anthropic' || skin === 'hc' || skin === 'soft-hc'` with `isAccentLocked(skin)` (import it from `../utils/theme`) — the comment there already says gating is centralized in theme.ts.

In `src/components/AppearancePanel.tsx`:
1. Append to `SKIN_OPTIONS`: `{ value: 'brutalist', label: 'Brutalist', desc: 'Neo-brutalist stickers · hard edges' }`.
2. In the Accent section, add a `skin === 'brutalist' ?` branch before the others rendering a locked display mirroring the `ANTHROPIC_ACCENT` pattern but with three swatches (`const BRUTALIST_ACCENTS = ['#ffe600', '#ff4d00', '#3b5bff']`, same pattern as line 55's constant) and label `Locked to brutalist sticker palette`. Background/transparency sections need no change — their gating sites already consume `isBackgroundLocked` / `isTransparencyLocked`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/utils/theme.test.ts src/hooks/useTheme.test.tsx`
Expected: PASS. Also run `npx vitest run src/utils` (whole folder, catches lockstep regressions).

- [ ] **Step 5: Commit**

```bash
git add src/utils/theme.ts src/utils/theme.test.ts src/hooks/useTheme.ts src/hooks/useTheme.test.tsx src/components/AppearancePanel.tsx
git commit -m "feat(theme): register brutalist skin with accent/background/transparency locks

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: Brutalist token blocks + contrast coverage

**Files:**
- Modify: `src/styles/tokens.css` (add two blocks after the soft-hc blocks, before the glow blocks — order inside the skin section is free; also add `--msg-tool-fg: var(--fg);` to `:root` (~line 223) and to `[data-theme="light"]` (~line 390) as the no-op default)
- Modify: `src/styles/status-ink-contrast.test.ts` (`NAMED_CONTEXTS`, line 75)
- Create: `src/styles/brutalist-tokens.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (Task 4 depends on every name here):
  - Palette tokens `--bt-yellow: #ffe600`, `--bt-orange: #ff4d00`, `--bt-blue: #3b5bff`, `--bt-on-yellow: #111111`, `--bt-shadow-color` (`#111111` light / `#5f5a52` dark), `--bt-display` (font stack)
  - Overridden existing tokens: `--bg`, `--bg-elev`, `--bg-elev-1`, `--bg-elev-2`, `--bg-elev-3`, `--fg`, `--fg-muted`, `--border`, `--btn-hover-bg`, `--code-bg`, `--accent`, `--accent-strong`, `--accent-text`, `--on-accent`, `--fast`, `--msg-user-bg/border/fg`, `--msg-tool-bg/border/fg`, all `--radius-*`, all shadow tokens, all `--glass-*`, `--surface-gradient`, `--accent-glow`, `--focus-glow`, `--dot-glow`, `--font-head`, full status families (`--danger` + adjacent `--on-danger` + `--danger-text`, `--warn` + `--warn-text`, `--ok` + `--ok-text`)

- [ ] **Step 1: Write the failing tests**

Create `src/styles/brutalist-tokens.test.ts` using `parseBlocks/readCss/contextsOf/effectiveToken` from `./contrast-test-utils` (same pattern as `status-ink-contrast.test.ts`):

```ts
const DARK = '[data-skin="brutalist"]'
const LIGHT = '[data-skin="brutalist"][data-theme="light"]'

describe('brutalist token blocks', () => {
  const blocks = parseBlocks(readCss('tokens.css'))
  const contexts = contextsOf(blocks)

  it('declares both brutalist contexts', () => {
    expect(contexts).toContain(DARK)
    expect(contexts).toContain(LIGHT)
  })

  it('zeroes every radius token in both contexts (spec: 圆角全部归零)', () => {
    for (const sel of [DARK, LIGHT]) {
      for (const t of ['--radius-3xs','--radius-2xs','--radius-xs','--radius-sm','--radius-md','--radius-lg','--radius-xl','--radius-2xl','--radius-3xl','--radius-pill','--radius-circle']) {
        expect(effectiveToken(blocks, sel, t), `${sel} ${t}`).toBe('0')
      }
    }
  })

  it('kills glass, gradients and glow in both contexts', () => {
    for (const sel of [DARK, LIGHT]) {
      expect(effectiveToken(blocks, sel, '--glass-blur')).toBe('none')
      expect(effectiveToken(blocks, sel, '--glass-blur-strong')).toBe('none')
      expect(effectiveToken(blocks, sel, '--glass-edge-highlight')).toBe('none')
      expect(effectiveToken(blocks, sel, '--surface-gradient')).toBe('none')
      expect(effectiveToken(blocks, sel, '--accent-glow')).toBe('none')
      expect(effectiveToken(blocks, sel, '--focus-glow')).toBe('none')
      expect(effectiveToken(blocks, sel, '--dot-glow')).toBe('none')
    }
  })

  it('pins the spec palette', () => {
    expect(effectiveToken(blocks, LIGHT, '--bg')).toBe('#f5f1e6')
    expect(effectiveToken(blocks, LIGHT, '--bg-elev')).toBe('#ffffff')
    expect(effectiveToken(blocks, LIGHT, '--border')).toBe('#111111')
    expect(effectiveToken(blocks, LIGHT, '--fg')).toBe('#111111')
    expect(effectiveToken(blocks, DARK, '--bg')).toBe('#141312')
    expect(effectiveToken(blocks, DARK, '--bg-elev')).toBe('#1e1c19')
    expect(effectiveToken(blocks, DARK, '--border')).toBe('#f2ede0')
    expect(effectiveToken(blocks, DARK, '--fg')).toBe('#f2ede0')
    for (const sel of [DARK, LIGHT]) {
      expect(effectiveToken(blocks, sel, '--bt-yellow')).toBe('#ffe600')
      expect(effectiveToken(blocks, sel, '--bt-orange')).toBe('#ff4d00')
      expect(effectiveToken(blocks, sel, '--bt-blue')).toBe('#3b5bff')
      expect(effectiveToken(blocks, sel, '--msg-user-bg')).toBe('#3b5bff')
      expect(effectiveToken(blocks, sel, '--msg-user-fg')).toBe('#ffffff')
    }
    // tool card inversion (spec §7): light = ink bg + yellow text, dark = cream bg + ink text
    expect(effectiveToken(blocks, LIGHT, '--msg-tool-bg')).toBe('#111111')
    expect(effectiveToken(blocks, LIGHT, '--msg-tool-fg')).toBe('#ffe600')
    expect(effectiveToken(blocks, DARK, '--msg-tool-bg')).toBe('#f2ede0')
    expect(effectiveToken(blocks, DARK, '--msg-tool-fg')).toBe('#141312')
  })

  it('uses only hard offset shadows (no blur, no rgba)', () => {
    for (const sel of [DARK, LIGHT]) {
      for (const t of ['--card-shadow','--modal-shadow','--overlay-shadow','--toast-shadow','--tooltip-shadow']) {
        expect(effectiveToken(blocks, sel, t), `${sel} ${t}`).toMatch(/^\d+px \d+px 0 #([0-9a-f]{6})$/i)
      }
    }
  })

  it('keeps CJK fallbacks in the display stack', () => {
    for (const sel of [DARK, LIGHT]) {
      const v = effectiveToken(blocks, sel, '--bt-display')!
      expect(v).toContain('PingFang SC')
      expect(v).toContain('Microsoft YaHei')
      expect(v.indexOf('PingFang SC')).toBeGreaterThan(v.indexOf('Arial'))
    }
  })
})
```

Also add to `status-ink-contrast.test.ts` `NAMED_CONTEXTS` (after the soft-hc pair):

```ts
  '[data-skin="brutalist"]',
  '[data-skin="brutalist"][data-theme="light"]',
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/styles/brutalist-tokens.test.ts src/styles/status-ink-contrast.test.ts`
Expected: FAIL — brutalist contexts missing from `tokens.css` (and thus from `NAMED_CONTEXTS` coverage).

- [ ] **Step 3: Implement the two token blocks**

Add `--msg-tool-fg: var(--fg);` beside `--msg-tool-bg` in `:root` and in `[data-theme="light"]` (no-op default for existing skins).

Add to `tokens.css`, mirroring the hc block structure (dark bare, light with `[data-theme="light"]`):

**`[data-skin="brutalist"]`** (dark — A 反色纸面) and **`[data-skin="brutalist"][data-theme="light"]`** (light — C 纸面). Values (spec §7 tables, verbatim; unlisted ladder/ink values are this plan's call):

| token | light C | dark A |
|---|---|---|
| `--bg` | `#f5f1e6` | `#141312` |
| `--bg-elev` | `#ffffff` | `#1e1c19` |
| `--bg-elev-1` | `#ffffff` | `#1e1c19` |
| `--bg-elev-2` | `#f0ece0` | `#26231f` |
| `--bg-elev-3` | `#e5e0d0` | `#26231f` |
| `--fg` | `#111111` | `#f2ede0` |
| `--fg-muted` | `#5c574c` | `#a39d8f` |
| `--border` | `#111111` | `#f2ede0` |
| `--btn-hover-bg` | `#ebe6d8` | `#2a2620` |
| `--code-bg` | `#f0ece0` | `#100f0d` |
| `--accent` | `#3b5bff` | `#3b5bff` |
| `--accent-strong` | `#2c46e0` | `#8ea6ff` |
| `--accent-text` | `var(--accent-strong)` | `var(--accent-strong)` |
| `--on-accent` | `#ffffff` | `#ffffff` |
| `--fast` | `#ff4d00` | `#ff4d00` |
| `--bt-yellow` | `#ffe600` | `#ffe600` |
| `--bt-orange` | `#ff4d00` | `#ff4d00` |
| `--bt-blue` | `#3b5bff` | `#3b5bff` |
| `--bt-on-yellow` | `#111111` | `#111111` |
| `--bt-shadow-color` | `#111111` | `#5f5a52` |
| `--msg-user-bg` | `#3b5bff` | `#3b5bff` |
| `--msg-user-border` | `#111111` | `#f2ede0` |
| `--msg-user-fg` | `#ffffff` | `#ffffff` |
| `--msg-tool-bg` | `#111111` | `#f2ede0` |
| `--msg-tool-border` | `#111111` | `#f2ede0` |
| `--msg-tool-fg` | `#ffe600` | `#141312` |
| status fills | keep hue, bump saturation: `--danger #d92b2b`, `--warn #c79518`, `--ok #2e9e56` | `--danger #ff5c5c`, `--warn #e6b450`, `--ok #4ade80` |
| `--on-danger` (adjacent!) | `#ffffff` | `#141312` |
| `--danger-text` | `#a31212` | `#ff9d9d` |
| `--warn-text` | `#7b5b0c` | `#f0cd7e` |
| `--ok-text` | `#1f6e3b` | `#9fe8bb` |
| `--font-head`, `--bt-display` | `var(--bt-display)` / `'Arial Black', 'Arial', 'Helvetica Neue', 'PingFang SC', 'Microsoft YaHei', sans-serif` | same |

Structural (both blocks): all `--radius-*` (incl. `--radius-pill`, `--radius-circle`) → `0`; `--card-shadow: 7px 7px 0 <bt-shadow-color>`, `--modal-shadow: 8px 8px 0 …`, `--overlay-shadow: 7px 7px 0 …`, `--drawer-shadow: -7px 0 0 …`, `--toast-shadow: 5px 5px 0 …`, `--tooltip-shadow: 3px 3px 0 …`, `--handle-shadow: none` (write the hex literally in the shadow value, as tokens.css does elsewhere); `--glass-blur/--glass-blur-strong/--glass-edge-highlight: none`; `--glass-surface-bg: var(--bg-elev)`; `--glass-surface-border: var(--border)`; `--surface-gradient/--accent-glow/--focus-glow/--dot-glow: none`.

Status-family ordering rule (test-enforced): every `--danger: …;` must be **immediately** followed by `--on-danger: …;`, and every block declaring a fill must also declare its `-text` sibling. If `status-ink-contrast` or `plugin-inactive-contrast` names a failing pair on these surfaces, adjust the ink hex in the same hue (the failure message prints the exact ratio) — do not change the test.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/styles/`
Expected: PASS (brutalist-tokens + status-ink with the new contexts + plugin-inactive + muted-ink + focus-indicator all green).

- [ ] **Step 5: Commit**

```bash
git add src/styles/tokens.css src/styles/status-ink-contrast.test.ts src/styles/brutalist-tokens.test.ts
git commit -m "feat(theme): brutalist skin token blocks (paper/inverted-paper palettes)

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: Retokenize hardcoded border-radius values

**Files:**
- Modify: every `src/styles/*.css` site with a literal radius (known px sites: `messages.css:1192` 6px, `overlays.css:890` 10px, `overlays.css:1038` 999px, `structured-panel.css:101` 6px, `uploads-manager.css:71` 6px / `:105` 4px / `:135` 4px / `:172` 2px / `:179` 2px, `update-dialog.css:52` 8px / `:123` 6px / `:131` 6px, `utilities.css:3916` 1px — plus any `50%` literals the guard test finds)
- Create: `src/styles/radius-literals.test.ts`

**Interfaces:**
- Consumes: existing `--radius-*` scale (`--radius-2xs: 2px`, `--radius-xs: 4px`, `--radius-sm: 6px`, `--radius-md: 8px`, `--radius-lg: 10px`, `--radius-pill: 999px`, `--radius-circle: 50%`).
- Produces: no stylesheet outside `tokens.css` declares a literal `border-radius` value; zeroing the tokens zeroes every corner (also fixes the same leak for hc).

- [ ] **Step 1: Write the failing guard test**

Create `src/styles/radius-literals.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { readCss, stylesheets } from './contrast-test-utils'

describe('border-radius goes through tokens', () => {
  it('no stylesheet hardcodes a border-radius value', () => {
    for (const file of stylesheets()) {
      const css = readCss(file)
      for (const m of css.matchAll(/border(?:-[a-z]+)?-radius\s*:\s*([^;}]+)/g)) {
        const v = m[1].trim()
        const ok = v === '0' || v === 'inherit' || v === 'initial' || v === 'unset' || v.startsWith('var(')
        expect(ok, `${file}: border-radius: ${v} — use var(--radius-*)`).toBe(true)
      }
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/styles/radius-literals.test.ts`
Expected: FAIL listing each literal site (px and `%` alike).

- [ ] **Step 3: Retokenize every flagged site**

Value-preserving mapping (no visual change on existing skins): `2px→var(--radius-2xs)`, `4px→var(--radius-xs)`, `6px→var(--radius-sm)`, `8px→var(--radius-md)`, `10px→var(--radius-lg)`, `999px→var(--radius-pill)`, `50%→var(--radius-circle)`. The single `1px` at `utilities.css:3916` maps to `var(--radius-3xs)` (3px — a 2px delta on one hairline element, accepted). Longhand forms (`border-top-left-radius` etc.) map the same way.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/styles/radius-literals.test.ts && npm run test`
Expected: PASS, full suite still green.

- [ ] **Step 5: Commit**

```bash
git add src/styles/*.css src/styles/radius-literals.test.ts
git commit -m "refactor(css): route all border-radius through --radius-* tokens

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: brutalist.css sticker layer + glass-wash exclusion

**Files:**
- Create: `src/styles/brutalist.css`
- Modify: `src/styles/index.css` (add `@import './brutalist.css';` immediately after the `glass` import, line ~26)
- Modify: `src/styles/glass.css` (wash chains at lines 197–206 and 215–224)
- Modify: `src/styles/messages.css` (line 1: `.msg.tool` gains `color: var(--msg-tool-fg);`)
- Create: `src/styles/brutalist-css.test.ts`

**Interfaces:**
- Consumes: every `--bt-*` and overridden token from Task 2.
- Produces: the visible skin — sticker rotation, display type on chrome labels, hard sticker shadows, 2–3px borders on key surfaces, `.btn-primary` remapped to the orange sticker.

- [ ] **Step 1: Write the failing tests**

Create `src/styles/brutalist-css.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { parseBlocks, readCss } from './contrast-test-utils'

describe('brutalist component layer', () => {
  it('glass wash gradient blocks exclude the brutalist skin', () => {
    for (const b of parseBlocks(readCss('glass.css'))) {
      const bg = b.decls['background-image'] ?? ''
      if (bg.includes('linear-gradient')) {
        expect(b.sel, 'wash block must exclude brutalist').toContain(':not([data-skin="brutalist"])')
      }
    }
  })

  it('brutalist.css hardcodes no colors (CLAUDE.md: colors via variables)', () => {
    const css = readCss('brutalist.css')
    expect(css).not.toMatch(/(?:^|[;{\s])(?:color|background|border-color|box-shadow|outline)\s*:[^;}]*#[0-9a-f]{3,8}/i)
  })

  it('sticker rotation uses the rotate property, not transform', () => {
    const css = readCss('brutalist.css')
    expect(css).toContain('rotate:')
    expect(css).not.toMatch(/transform\s*:[^;}]*rotate\(/)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/styles/brutalist-css.test.ts`
Expected: FAIL — wash blocks don't exclude brutalist; `brutalist.css` missing.

- [ ] **Step 3: Implement `brutalist.css` and the wash exclusion**

All rules scoped `html[data-skin="brutalist"]` (or bare `[data-skin="brutalist"]` where no ancestor selector is needed). Group contents (selectors are the verified class names; colors only via the Task 2 tokens):

1. **Sticker rotation** (spec: decorative badges only): `.chat-panel-mode-badge`, `.chat-panel-model-badge`, `.chat-panel-fast-badge` get `rotate: -2deg` (mode), `rotate: 1.5deg` (model), `rotate: -1.5deg` (fast) — property `rotate`, never `transform: rotate()`.
2. **Display type** (spec: labels/buttons/badges uppercase heavy; prose untouched): `.btn`, the three badge classes above, `.session-group-header`, `.appearance-heading`, `.working-bar` get `font-family: var(--bt-display); font-weight: 900; text-transform: uppercase; letter-spacing: 0.02em;`. Do NOT touch `.msg` prose or `.md` content.
3. **Sticker surfaces**: badges + `.working-bar` + `.composer-card` + `.msg` get `border-width: 2px` (`.composer-card`, floating surfaces `3px`) and `box-shadow: 2px 2px 0 var(--bt-shadow-color)` (bubbles `3px 3px 0`, composer `4px 4px 0`). `.session-item` selected/open state: `background: var(--bt-yellow); color: var(--bt-on-yellow); border-color: var(--border); box-shadow: 2px 2px 0 var(--bt-shadow-color);`.
4. **Section bars** (spec: 蓝底白字): `.session-group-header` `background: var(--bt-blue); color: var(--on-accent);`.
5. **Primary button sticker**: `.btn-primary` `background: var(--bt-orange); color: var(--on-accent); border-color: var(--border); box-shadow: 2px 2px 0 var(--bt-shadow-color);` and its `:active` shifts `translate(2px, 2px)` with shadow removed (sticker press). Toggle checked fill: grep `controls.css` for the toggle's checked-state accent fill and remap it to `var(--bt-orange)` here (spec fallback: 开关开启态 = 橙).
   **Accent bucket rule** (spec §7 兜底映射, applies while doing items 1–7): wherever a component uses `var(--accent)` as a *fill/highlight surface* (e.g. context-usage progress fill, highlight blocks), remap to `var(--bt-yellow)` + `var(--bt-on-yellow)` ink; wherever it is *text-level or thin line* (links, `::selection` text side, active underline, focus ring), keep `--accent` (blue); yellow is never text or thin stroke.
6. **Floating surfaces** (reuse the exact selector list from `glass.css:197–206` — `.modal`, `.palette`, `.settings-overlay > .settings-panel`, `.git-overlay > .git-panel`, `.panel-overlay > .panel-overlay-card`, `.perm-overlay > .perm-card`, `.ctx-menu`, `.model-picker`, `.cmd-picker`, `.appearance-panel`): `border-width: 3px; box-shadow: var(--modal-shadow); background-image: none;`.
7. **Decorator audit rule** (spec §5, bounded): for any *decorative* `linear-gradient`/`radial-gradient` surface wash or `backdrop-filter` outside keyframe animations and `mask-image` scroll-fades found in `chat.css`/`layout.css`/`messages.css`/`overlays.css`, add a brutalist override to the flat token value. Keep motion keyframes (`blur()` inside `@keyframes`) and `mask-image` fold fades untouched (spec: 动效照旧).

In `glass.css` add `:not([data-skin="brutalist"])` to both wash selector chains (the `html:not([data-skin="glow"]):not([data-skin="hc"])…` groups), keeping the existing `:not([data-transparency="off"])` parts.

In `messages.css` line 1 add `color: var(--msg-tool-fg);` to `.msg.tool`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/styles/ && npm run typecheck && npm run lint`
Expected: PASS (brutalist-css guards + all contrast suites + typecheck both tsconfigs + lint clean).

- [ ] **Step 5: Commit**

```bash
git add src/styles/brutalist.css src/styles/index.css src/styles/glass.css src/styles/messages.css src/styles/brutalist-css.test.ts
git commit -m "feat(theme): brutalist sticker layer (rotation, display type, hard shadows)

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 5: Acceptance pass

**Files:** none new (fixes only if the gate finds issues).

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces: a branch that satisfies spec §9.

- [ ] **Step 1: Full gate**

Run: `npm run typecheck && npm run lint && npm run test`
Expected: all green.

- [ ] **Step 2: Visual acceptance checklist (spec §9)**

With the dev server running (`npm run dev`), for **both** `data-theme` values with skin `Brutalist`, and one spot-check with skin `Default` (zero regression):
1. SKIN row shows `Brutalist`; switching is instant; switching back restores the previous look exactly.
2. Light = paper C mockup: 米黄底, 2–3px 黑边, hard offset shadows, sticker chips (±rotation), selected session = yellow sticker, user bubble = blue sticker, tool card = 黑底黄字, SEND = orange sticker. Dark = A 反色纸面 (cream borders, tool card inverted).
3. No rounded corner anywhere (scrollbars, dots, avatars, spinners — square is intended), no blur/gradient/glow on surfaces (motion blur in keyframes is fine).
4. Prose in messages stays normal sans; buttons/labels/badges uppercase heavy; Chinese labels render in PingFang/YaHei bold, not a serif fallback.
5. Accent picker shows the locked triad; Background and Transparency sections are hidden.
6. Status colors readable everywhere (error/deny red, success green) — spot an error toast, a denied-permission card, and a diff panel.

- [ ] **Step 3: Fix anything the checklist finds, re-run the gate, commit**

```bash
git add -A
git commit -m "fix(theme): brutalist acceptance fixes

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

- [ ] **Step 4: Run `code-review` on the full branch diff and fix confirmed findings before declaring done.**
