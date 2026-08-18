# Design-system finishing: radius tokens, HC refactor + soft-HC skin, tooltip delay, shared EmptyState

Date: 2026-08-18

## Problem

The frontend's token system is unusually complete (colors, typography, spacing, motion, shadows, glass all have `--*` variables in `src/styles/tokens.css`), but three gaps remain:

1. **No `border-radius` tokens.** 294 CSS sites + 21 TSX inline styles hardcode radii (values 1/2/3/4/5/6/7/8/9/10/12/14/18px, `999px`, `50%`). HC is forced to work around this with a universal `[data-skin="hc"] * { border-radius: 0 !important }` override in `src/styles/glass.css` (imported last) plus a spinner-restore hack — a whitelist-vs-blacklist fight that will keep leaking as new radii are added.
2. **No soft high-contrast option.** HC is all-or-nothing: pure black/white, square corners on *everything*, no shadows/blur. There is no middle ground for users who want strong contrast without the stark squaring.
3. **Tooltips appear instantly on mouse-over** with no show-delay (jittery on rapid mouse traversal), and the settings empty-states are inconsistent (`.app-empty-state` is a first-class card; `.settings-empty-note` is plain muted text).

## Goal / non-goals

- **Goal:** tokenize every `border-radius` site so radii are expressed as `var(--radius-*)`, pixel-identical for the main scale, with a documented 1px normalization for 9 one-off sites.
- **Goal:** refactor HC to consume the radius tokens (drop the `!important` universal override), with a deliberate behavior refinement — true circles (`--radius-circle`) stay circular under HC.
- **Goal:** add a new `soft-hc` skin — near-black/near-white, softer-but-strong borders, normal radii, normal focus ring, normal card shadows, no glass blur — wired into `AppearancePanel` / `theme.ts`.
- **Goal:** add a 150ms pure-CSS hover show-delay to tooltips (keyboard focus stays instant, hide stays immediate), no JS/state/portal.
- **Goal:** introduce a shared `EmptyState` component and migrate 7 "no data" sites in the settings/hooks/MCP panels.
- **Non-goal:** converting the CSS architecture to CSS Modules / Tailwind / CSS-in-JS.
- **Non-goal:** a JS/portal tooltip, or programmatic `open`/`close` control (tooltips remain short, non-interactive hints).
- **Non-goal:** unifying `ChatEmptyState` (it carries the triple-click easter-egg logic and stays bespoke) or the `.app-empty-state` landing card into the new component.
- **Non-goal:** changing the `glow` / `anthropic` skins or the default theme.

## Design

### 1. Radius tokens (`src/styles/tokens.css`)

Insert a radius block right after the motion tokens (~line 80), mirroring the existing comment style:

```css
/* Radius tokens — the canonical corner-rounding steps. The main scale is
   pixel-identical to the values it replaces; --radius-3xs exists because
   3px appears 18× (status chips, focus-ring inner corners). --radius-pill
   is for fully rounded pills (999px), --radius-circle for true circles (50%). */
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

**One-off normalization** (the only visual delta in the whole change — 9 sites, ≤1px each):

| literal | → token | sites |
|---|---|---|
| `1px` | `var(--radius-2xs)` | 1 |
| `5px` | `var(--radius-xs)` | 5 |
| `7px` | `var(--radius-sm)` | 1 |
| `9px` | `var(--radius-lg)` | 2 |

Rationale: 100% tokenization is a hard requirement for the HC refactor (once the `!important` override is gone, every non-tokenized radius would leak its corner back under HC). The 9 one-off values are sub-10px radii on tiny elements; the 1px shift is imperceptible.

### 2. Mechanical replacement

- **CSS:** all 294 `border-radius:` declarations in `src/styles/*.css` → `var(--radius-*)` per the table above (`999px` → `--radius-pill`, `50%` → `--radius-circle`).
- **TSX:** 21 inline `borderRadius: <n>` styles → `borderRadius: 'var(--radius-*)'` (string form; React accepts CSS custom properties as strings).
- Verification: after replacement, `grep -rE "border-radius:\s*[0-9]+px" src` must return zero matches (excluding none); `grep -rE "borderRadius:\s*[0-9]" src` likewise.

### 3. HC refactor — consume tokens

**Remove** from `src/styles/glass.css`: the `[data-skin="hc"] * { border-radius: 0 !important }` universal override and the spinner 50% restore block.

**Trim** (do not remove) the `::-webkit-scrollbar-thumb` squaring rules: drop only the `border-radius: 0 !important` lines (now redundant — thumbs use `var(--radius-pill)` → `0` via the token override), but **keep** the `border: 0 !important` + `background-clip: border-box !important` lines. Those are what give HC its "hard-edged fill that meets the track" instead of the default floating pill — that property is skin-specific and not expressible via a radius token. soft-hc gets no scrollbar override (keeps the default floating pill).

**Add** to the `[data-skin="hc"]` block in `src/styles/tokens.css`:

```css
/* HC squares corners via the radius tokens — no universal override needed.
   --radius-circle stays 50%: loading spinners must keep rotating as circles,
   and status dots / avatars / swatches staying circular is a deliberate
   refinement over the old "square everything" behavior. */
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

**Scrollbar thumbs:** the old glass.css rules explicitly squared `::-webkit-scrollbar-thumb`. After step 2 the thumb's radius is `var(--radius-pill)`, which the HC token override drives to `0` — so the `border-radius` line is dropped as redundant while the `border: 0` + `background-clip: border-box` hard-edge lines are retained (see "Trim" above). Firefox's `scrollbar-color` already flows from tokens. Verify visually under HC that thumbs remain square and edge-to-edge.

**Behavior refinement (confirmed):** under HC, true circles (status dots, avatars, swatches, spinners) are no longer squared. This is an intentional, visible change.

### 4. New `soft-hc` skin (`src/styles/tokens.css` + `src/theme.ts` + `src/components/AppearancePanel.tsx`)

A new `[data-skin="soft-hc"]` block (dark + light). Personality: *solid* high-contrast theme — near-black/near-white, borders stronger than default but softer than HC's pure white, normal radii, normal focus ring, normal card shadows, **no glass blur** (opaque surfaces, no translucency).

Dark:

```css
[data-skin="soft-hc"] {
  --bg: #0e0e12;
  --bg-elev: #131318;
  --bg-elev-1: #18181e;
  --bg-elev-2: #1e1e25;
  --bg-elev-3: #26262e;
  --border: #3a3a42;
  --fg: #f2f2f5;
  --fg-muted: #a3a3ad;
  --accent: #7b8cde;        /* locked — matches default accent */
  --accent-strong: #8a9ae6;
  --on-accent: #0e0e12;     /* near-black on accent for max contrast */
  --danger: #ff6b6b;
  --ok: #4ade80;
  --warn: #facc15;
  --fast: #c084fc;
  --focus-ring: 2px solid #7b8cde;
  /* No glass / translucency — solid surfaces, normal shadows stay default. */
  --glass-blur: none;
  --glass-surface-bg: var(--bg-elev);
  --glass-surface-border: var(--border);
  --glass-blur-strong: none;
  --glass-edge-highlight: none;
  --surface-gradient: none;
  --backdrop-color: rgba(0, 0, 0, 0.7);
}
```

Light:

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
  --accent: #3b5bdb;        /* darker blue for light-bg contrast */
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

Notes:
- Message-scoped tokens (`--msg-user-bg`, `--msg-tool-bg`, …) inherit the existing accent-derived `color-mix()` formulas from the locked accent. If any reads too washed on the solid surfaces during visual QA, add explicit opaque overrides in the `soft-hc` block — do not touch the shared formulas.
- The skin **locks the accent** (removes the per-session inline `--accent` override), same as `glow` / `hc` / `anthropic`. Wire this in `src/theme.ts` (Skin type + display name + `locksAccent` flag) and add the option to `src/components/AppearancePanel.tsx` (display name: "Soft high contrast"). Follow the exact pattern the existing three skins use in both files.

### 5. Tooltip show-delay (`src/styles/utilities.css`)

Pure CSS, no component change. The visible-state rules get a show-delay; the base (hidden) rule keeps none so hiding stays immediate:

```css
.tt-wrap:hover > .tt-bubble { transition-delay: 150ms; }
.tt-wrap:focus-within > .tt-bubble { transition-delay: 0ms; }
```

Placement rules: the `:focus-within` rule must come **after** the `:hover` rule in the file (equal specificity → source order decides), so a focused-and-hovered trigger shows the tooltip instantly for keyboard users. The existing `@media (prefers-reduced-motion: reduce)` block already forces `transition: … 0.01ms !important` on `.tt-bubble`, which zeroes the delay automatically.

### 6. Shared `EmptyState` component (`src/components/EmptyState.tsx`)

Props: `{ icon?: ReactNode; title: ReactNode; body?: ReactNode; action?: ReactNode; className?: string }`. Renders a compact, muted empty-state block — optional line-art icon tile (28px, tinted rounded square), title (13px, medium), body (12px, `--fg-muted`), optional action row. No big card, no entrance animation — it slots inline into settings tabs and panels. Uses theme tokens only (no hardcoded colors).

**Migrate 7 "no data" sites** to `<EmptyState>`:

| File:line | Current copy | Icon |
|---|---|---|
| `GlobalSettingsModal.tsx:1142` | "No skills discovered yet." | skill/sparkle |
| `GlobalSettingsModal.tsx:1217` | "Create or import a project/user skill to get started." | skill/sparkle |
| `GlobalSettingsModal.tsx:1314` | MCP empty (`.settings-mcp-empty`) | server |
| `HooksPanel.tsx:321` | "No hooks configured" | hook |
| `HooksPanel.tsx:421` | "No hook runs yet" | hook |
| `SettingsPanel.tsx:938` | "No MCP servers" | server |
| `SettingsPanel.tsx:1193` | "No skills discovered for this workspace." | skill/sparkle |

**Keep as plain muted text** (status notes, not empty states): `SettingsPanel.tsx:1190` "Loading skills…" and `SettingsPanel.tsx:1191` "Couldn't load skills: {error}". The `.settings-empty-note` CSS stays for these.

Icons: reuse existing hand-rolled SVGs from `src/components/icons/ToolIcons.tsx` where they exist (e.g. a server icon for MCP); add `skill` / `hook` glyphs following the same stroke conventions only if absent. `ChatEmptyState` is untouched.

## Testing

- `npm run typecheck && npm run lint && npm test` — plus `npm run build` to confirm the CSS/bundle compile.
- **A1 visual QA matrix:** default / `glow` / `hc` / `soft-hc` × dark/light. Confirm: no radius regressions on default+glow; HC keeps square corners for pills/badges/cards while dots/avatars/spinners stay circular; soft-hc reads as a solid high-contrast theme with rounded corners. Exercise modal, toast, tooltip, code block, session card, message bubbles, sidebar.
- **A1 grep gates:** zero `border-radius:\s*[0-9]+px` and zero `borderRadius:\s*[0-9]` remain in `src`.
- **A2:** hover a trigger → tooltip appears after ~150ms; move away → disappears immediately; Tab-focus a trigger → tooltip appears instantly; `prefers-reduced-motion` → appears with no delay/no slide.
- **A3:** add a small vitest render test for `EmptyState` (title + body + action render; className passes through). Verify each migrated site still renders its message.

## Out of scope / follow-ups

- CSS Modules migration, Tailwind, or CSS-in-JS.
- Interactive / portal tooltips with programmatic control.
- A "soft" variant for the `glow` or `anthropic` skins.
- Unifying `ChatEmptyState` / `.app-empty-state` into `EmptyState` (deliberate: easter-egg and landing-card semantics differ).
