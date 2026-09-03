# Global background image for default/glow skins (host theme-system feature)

Date: 2026-09-03

> **Supersedes** the earlier `background-image-plugin-design` spec (same date, first commit): that version built the feature as a **plugin** — a host Background subsystem plus a `contributes.backgrounds` framework contribution point and a first-party `wallpaper` plugin. After review the user added a product constraint — background + translucency should open **only for the `default` and `glow` skins** — which undercuts the plugin's "generic, any-plugin-contributes" rationale (a background over the branded/a11y skins `anthropic`/`hc`/`soft-hc` is a readability/accessibility regression, and the plugin `when` vocabulary has no `skin` key to express the gate). The plugin form is therefore dropped in favour of the theme-system form below. This is the smaller, more honest home for what is fundamentally an appearance preference like skin/mode/accent.

## Problem

The app theme system owns three appearance axes — `data-theme` (light/dark/system), `data-skin` (`default | glow | anthropic | hc | soft-hc`), and an accent colour — all host-managed, persisted client-side, applied by CSS variables written on `<html>` (`src/hooks/useTheme.ts`, `src/utils/theme.ts`). Two gaps block a user-set app background:

1. **No background-image concept.** `body` paints a single solid `var(--bg)` (`src/styles/tokens.css`); no wallpaper/token exists anywhere.
2. **Chrome is fully opaque.** Even if a full-viewport image were painted on `body`, `.sidebar` / `.main-header` / `.main-body` / `.chat-panel` (`src/styles/layout.css`) are opaque fills that would hide it entirely.

The user wants to set a **global background image** over the app shell with an adjustable frosted-glass translucency — but scoped to the two expressive skins (`default`, `glow`). The branded/a11y skins (`anthropic`, `hc`, `soft-hc`) must stay pristine: they already lock the accent, and a background image there would regress their intent.

This spec is the **host-native theme-system extension** for that. No plugin, no framework-contribution change.

## Goal / non-goals

- **Goal:** a full-viewport background layer on `body`, driven by CSS variables.
- **Goal:** frosted-glass translucency on the chrome surfaces, **only while a background is active**, with a user-adjustable translucency/opacity slider.
- **Goal:** arbitrary image sources — a remote `http(s)` URL, or a **local file upload** stored by the server and served back as a same-origin URL.
- **Goal:** the Background control is available only for the `default` and `glow` skins; switching to `anthropic`/`hc`/`soft-hc` suppresses the effect while preserving the user's choice (accent-lock semantics), so switching back restores it.
- **Non-goal:** a plugin contribution point / any `shared/app-plugins` change / a `wallpaper` plugin / marketplace entry (dropped — see note above).
- **Non-goal:** host-bundled preset images in v1 (the user supplies a URL or file; presets can be added later).
- **Non-goal:** per-session backgrounds, animated/GIF/SVG backgrounds, or a user-adjustable blur radius (fixed token).

## Design

The background is a host-owned appearance preference on the same footing as accent colour: a localStorage-backed setting, applied by writing CSS variables onto `<html>`, edited in the Appearance popover, gated by the active skin exactly like the accent lock.

### 1. State model + constants

**Types + constants** (`src/theme.ts`, beside the accent constants):

```ts
export type BackgroundPref =
  | { kind: 'none' }
  | { kind: 'custom'; src: string }     // http(s) URL, or /api/background/files/<uuid>.<ext>

export interface BackgroundSetting {
  pref: BackgroundPref
  opacity: number    // chrome-surface translucency, 0.55..1 — lower = more of the image shows
}

export const BACKGROUND_KEY = 'claude-react-web:background'
export const BACKGROUND_DEFAULT_OPACITY = 0.85
export const BACKGROUND_OPACITY_MIN = 0.55
export const BACKGROUND_OPACITY_MAX = 1

/** Type-guard for useLocalStorage's `validate` — rejects corrupt/hand-edited
 *  values (mirrors `isHexColorList` in the same file). */
export function isBackgroundSetting(v: unknown): v is BackgroundSetting
```

`none` is the only safe `kind` a corrupt value can collapse to; `custom.src` is validated on write as `http(s):` or a same-origin `/api/background/files/…` path.

### 2. Skin gating helper

`src/utils/theme.ts` already has `isAccentLocked(skin)` (true for `anthropic`/`hc`/`soft-hc`). Add alongside it:

```ts
/** Backgrounds are available only on the expressive skins. The branded /
 *  a11y skins (Anthropic, HC, Soft-HC) stay pristine — kept in lockstep with
 *  the accent lock. */
export function isBackgroundLocked(skin: Skin): boolean {
  return skin === 'anthropic' || skin === 'hc' || skin === 'soft-hc'
}
```

### 3. `useBackground` hook

**New `src/hooks/useBackground.ts`**, called at the App root as `useBackground(skin)` (skin comes from the existing `useTheme()` call in `App.tsx`). Returns `{ setting, setPref, setOpacity, clear, imageActive }`. Persisted via `useLocalStorage<BackgroundSetting>(BACKGROUND_KEY, { pref: { kind: 'none' }, opacity: BACKGROUND_DEFAULT_OPACITY }, isBackgroundSetting)`.

A `useEffect([setting, skin])` writes the effect onto the document, mirroring the accent effect in `useTheme.ts` (lines 116–136):

```ts
const active = setting.pref.kind !== 'none' && !isBackgroundLocked(skin)
const root = document.documentElement.style
if (!active) {
  root.setProperty('--app-bg-image', 'none')
  root.setProperty('--app-chrome-alpha', '100%')
  document.body.classList.remove('has-bg')
  return
}
const src = setting.pref.src          // custom.kind only reachable here
root.setProperty('--app-bg-image', `url("${src}")`)
root.setProperty('--app-chrome-alpha', `${Math.round(setting.opacity * 100)}%`)  // '85%'
document.body.classList.toggle('has-bg', true)
```

Behaviour notes:

- The CSS-var approach needs no React re-render of panels — `ChatPanel`'s `React.memo` is untouched.
- **Skin-lock interplay mirrors the accent lock:** with a background set, switching `default`/`glow` → `anthropic`/`hc`/`soft-hc` suppresses the image (the effect branch above returns to `none` / removes `has-bg`); the localStorage pref is preserved, so switching back re-applies it. Identical in spirit to how `useTheme` removes the inline `--accent` under a locked skin but keeps the stored accent.
- Micro-behaviour: picking an image while `opacity` is at `1.0` (fully opaque → image invisible) auto-sets `opacity` to `BACKGROUND_DEFAULT_OPACITY`.

### 4. CSS: background layer + frosted chrome

**Background layer.** Split the `body` rule (`src/styles/tokens.css`, the `body { background: var(--bg); … }` rule around lines 1073–1084):

```css
body {
  background-color: var(--bg);
  background-image: var(--app-bg-image);   /* new token, default `none` */
  background-size: cover;
  background-position: center;
  background-attachment: fixed;
}
```

`.app` (`src/styles/layout.css`) is already transparent and fills the viewport, so `body` is the paint layer — **no new DOM element**.

**New tokens** in `tokens.css` (`:root`):

```css
--app-bg-image: none;
--app-chrome-alpha: 100%;   /* 100% = current opaque look */
```

**Frosted chrome.** The five shell surfaces that are currently opaque (verified in `layout.css`: `.sidebar` 19–28, `.main-header` ~99–108, `.main-body` 216–224, `.chat-panel` 258–285, `.chat-panel-header` 295–309) become translucent only under `body.has-bg`, so the default (no background, or a locked skin) is byte-for-byte the current look:

```css
body.has-bg { --app-chrome-blur: 24px; }

body.has-bg .sidebar,
body.has-bg .main-header {
  /* background-color, NOT the background shorthand — preserves each skin's
     background-image (glow surface gradients), exactly as glass.css does.
     Each surface keeps its own base fill token (sidebar/header = --bg-elev,
     chat-panel = --bg) so opacity=1 resolves to exactly today's look. */
  background-color: color-mix(in srgb, var(--bg-elev) var(--app-chrome-alpha), transparent);
  backdrop-filter: blur(var(--app-chrome-blur));
  -webkit-backdrop-filter: blur(var(--app-chrome-blur));
}
body.has-bg .chat-panel {
  background-color: color-mix(in srgb, var(--bg) var(--app-chrome-alpha), transparent);
  backdrop-filter: blur(var(--app-chrome-blur));
  -webkit-backdrop-filter: blur(var(--app-chrome-blur));
}
body.has-bg .main-body {
  background: transparent;          /* drop the intermediate fill to avoid nested double-blur */
}
body.has-bg .chat-panel-header {
  /* Accent tint layered over the (already translucent + blurred) panel below. */
  background-color: color-mix(in srgb, var(--accent) 6%, transparent);
}
```

`color-mix(... var(--app-chrome-alpha) ...)` accepts a var holding a percentage; JS writes `85%`-style values. Floating surfaces (modal / palette / settings / git overlays / ctx menus …) are *already* translucent + `backdrop-filter` in `glass.css` and need no change.

**Progressive enhancement** (same as `glass.css`): an `@supports (backdrop-filter: blur(1px))` guard keeps the current fully-opaque fills on browsers without `backdrop-filter`, so text contrast never degrades silently.

**Implementation technique note for the plan:** `backdrop-filter` establishes a containing block for fixed/absolute descendants, which could re-anchor `position: fixed` content inside the affected chrome. Prefer implementing the tint+blur as an absolutely-positioned `::before` overlay layer on each surface (content painted above via `position: relative; z-index`) rather than as the surface's own `background`/`backdrop-filter`, and audit the affected regions for fixed-position descendants during the visual pass. Exact per-surface composition is a visual-tuning task for the implementation step (see Testing), not a schema decision.

### 5. Settings UI — "Background" section in the Appearance popover

`AppearancePanel.tsx` (`src/components/AppearancePanel.tsx`) gains a Background section **rendered only when `!isBackgroundLocked(skin)`** (i.e. for `default` and `glow`). It lives after Accent and is rendered via a new `src/components/BackgroundPicker.tsx` (mirroring how the panel embeds the existing `AccentSwatchGrid`).

Props threaded from `App.tsx` (which calls `useBackground(skin)` alongside `useTheme()`): the current `BackgroundSetting`, `setPref`, `setOpacity`, and `clear`.

Picker contents (no plugin presets in v1):

- **None** / **Custom** rows.
- **Custom:** a text input for an `http(s)` URL and an "Upload image…" button (`<input type="file" accept="image/png,image/jpeg,image/webp">`). Upload → `POST /api/background/upload` (FormData) → on success `setPref({ kind: 'custom', src: url })`.
- **Opacity slider** (`0.55..1`, default 0.85), shown once an image is active — live preview via the CSS-variable effect.
- **Clear** → `setPref({ kind: 'none' })` (also deletes a previously uploaded local file, §6).

### 6. Global background image upload (server)

Existing upload infra is per-session (`server/routes/uploads.ts`, files land under the *session's cwd*). A background is global, so this is a small dedicated router rooted in the app state dir:

- `POST /api/background/upload` — `multipart/form-data`, single image file. Validate content type against an allow-list (`image/jpeg`, `image/png`, `image/webp`) and size against the existing `config.maxUploadBytes`. Write to `<stateDir>/backgrounds/<uuid>.<ext>` (random name; no user-controlled path). Return `{ url: '/api/background/files/<uuid>.<ext>' }`.
- `GET /api/background/files/:name` — serve the file with a content type allow-listed from the extension; containment check on `:name` (no `..`, no separators).
- `DELETE /api/background/files/:name` — delete a previously uploaded file (called on clear / when a custom image is replaced). `ENOENT` → 404.

No registry store is needed for v1: the only reference to an uploaded file is the `custom.src` URL in the client preference. Orphans (localStorage cleared without a DELETE) are small bounded files under the state dir — accepted. Mounted in `server/app.ts` beside the other routers (`app.route('/api/background', …)`), with the store optionally passed in `buildApp` options like `uploadStore` so tests/standalone callers can omit it.

**Security notes:** the route never trusts filenames (server-assigned `uuid`), serves only allow-listed image MIME types, path-containment-checks every read/delete, and caps size. The URL in the preference is either an `http(s)` remote URL or this same-origin `/api/background/files/…` path. The app sets **no CSP header** today (verified: no `Content-Security-Policy` in `server/app.ts`), so CSS `url()` to remote images is not blocked; if a CSP is ever added, `img-src` must allow remote background URLs (see Open questions).

## Behavior matrix

| Scenario | Behavior |
|---|---|
| `default`/`glow`, no background configured | `body` paints `var(--bg)`; `body.has-bg` absent; chrome fully opaque — byte-for-byte current look |
| `default`/`glow`, remote URL set | `--app-bg-image: url("…")`; chrome surfaces translucent + blurred at `opacity`; remote image loads (no CSP) |
| Local file uploaded | Stored under `<stateDir>/backgrounds/<uuid>`; served via `/api/background/files/…`; same rendering as URL |
| Background set, switch `default` → `hc`/`anthropic`/`soft-hc` | Effect suppressed (image hidden, chrome opaque, no `has-bg`); localStorage pref retained |
| Switch back to `default`/`glow` | Background re-applies from the preserved pref |
| `hc`/`anthropic`/`soft-hc` active | Background section not shown in the Appearance popover |
| Opacity slider at 1.0 | Chrome at `100%` alpha — effectively the current opaque look; picking an image at 1.0 auto-sets 0.85 |
| Browser without `backdrop-filter` | `@supports` fallback keeps opaque fills — readable, image not shown through chrome |
| Glow skin | Translucency uses `background-color` only — `--surface-gradient` gradients on chrome surfaces preserved (glass.css recipe) |
| localStorage cleared / corrupt pref | `isBackgroundSetting` guard falls back to `{ kind: 'none', opacity: 0.85 }` |
| Uploaded file replaced/cleared | `DELETE /api/background/files/:name` removes the old file; orphans from a wiped localStorage accepted (small, bounded) |

## Files touched

| File | Change |
|---|---|
| `src/theme.ts` | `BackgroundPref`/`BackgroundSetting`, `BACKGROUND_KEY`, opacity constants, `isBackgroundSetting` guard |
| `src/utils/theme.ts` | `isBackgroundLocked(skin)` next to `isAccentLocked` |
| `src/hooks/useBackground.ts` | **new** — pref state + skin-gated CSS-variable/`has-bg` effect |
| `src/App.tsx` | call `useBackground(skin)`; pass props to `AppearancePanel` |
| `src/components/AppearancePanel.tsx` | Background section (gated by `isBackgroundLocked(skin)`), embeds `BackgroundPicker`; props |
| `src/components/BackgroundPicker.tsx` | **new** — None / Custom (URL + upload) + opacity slider + clear |
| `src/styles/tokens.css` | `--app-bg-image`, `--app-chrome-alpha`; split `body` background rule |
| `src/styles/layout.css` | `body.has-bg` frosted rules for sidebar/main-header/main-body/chat-panel(+header); `@supports` fallback |
| `server/app.ts` | mount `/api/background` router (store optional in `buildApp` opts) |
| `server/background-routes.ts` | **new** — `POST /api/background/upload`, `GET /api/background/files/:name`, `DELETE /api/background/files/:name` |

No `shared/`, no `server/app-plugins/`, no `plugins/` changes — the plugin form is fully dropped.

## Testing (TDD)

1. **client — `useBackground`.** None → no `has-bg`, `--app-bg-image: none`, alpha 100%; custom URL → var set + `has-bg` on + alpha percentage; `skin = 'hc'` with a background set → effect suppressed (no `has-bg`) but pref retained; switching back to `default` re-applies; corrupt stored value collapses to the default. (jsdom; `isBackgroundLocked` exercised through `utils/theme`.)
2. **client — `AppearancePanel` gating.** Background section rendered for `default` and `glow`; absent for `anthropic`/`hc`/`soft-hc`. (jsdom.)
3. **client — `BackgroundPicker`.** URL input + upload callback path; opacity slider bound to `setOpacity`; Clear calls `setPref({kind:'none'})`. (jsdom.)
4. **server — upload route.** Accepts a valid `image/png`; rejects wrong content type and over-size (413); `:name` containment (traversal rejected); DELETE removes then 404s.
5. **Manual e2e (visual).** On `default`: upload a local file and paste a remote URL → sidebar/header/panels go frosted over the image at the set opacity; drag the slider live; switch to `hc` → pristine, no image; switch back → image returns; **no-background default visually identical to pre-change** (screenshot diff against the current build); fixed-position overlays (CommandPalette, context menus, Settings/Git overlays) still anchor correctly with `backdrop-filter` active (containing-block audit).

## Open questions / decisions

- **Decision (pivot):** this spec replaces the earlier plugin-contribution version — the "only `default`/`glow`" constraint makes the feature a theme-system appearance preference, not a plugin surface. Kept in lockstep with the accent lock for the same branded/a11y skins.
- **Confirmed:** the Background section is host-native and always available *within* `default`/`glow`; no plugin needs to be installed.
- **Confirmed:** `body` is the paint layer (no extra fixed `<div>`); translucency scoped under `body.has-bg`; blur fixed at a token (~24 px), not user-adjustable in v1.
- **Confirmed:** raster-only backgrounds (PNG/JPG/WEBP for uploads); no host-bundled presets in v1 (URL/file only).
- **Open:** `backdrop-filter` containing-block side effects on `position: fixed` descendants inside the frosted chrome — mitigate with a `::before` overlay-layer technique and audit fixed overlays during the visual pass; fall back to per-surface `background` swap if the audit is clean.
- **Open:** no CSP today, so remote `url()` backgrounds load; if the app later adds a CSP, `img-src` must allow remote background URLs.
- **Open:** uploaded-file lifecycle is ref-count-free — orphans after a wiped localStorage are accepted. A later sweep-on-boot is possible if they become a problem.
