# Global background image: host appearance subsystem + `contributes.backgrounds` plugin contribution

Date: 2026-09-03

## Problem

The App Plugin framework (v1) is strictly declarative — a contribution carries *only data* (ids, titles, asset paths, a `when` clause, an order), and plugins can never inject HTML/CSS/React or touch the DOM. Verified boundaries:

- Contribution points today: `commands`, `contextMenus`, `actions`, `configuration`, `statusIndicators`, `widgets`. **There is no theme/background/appearance contribution type** (`shared/app-plugins/contributions.ts`).
- The host API (`shared/app-plugins/rpc-protocol.ts`) has no method that touches CSS/DOM/theming; the background subprocess runs in Node while the DOM lives in the browser, separated by WS.
- App theming is entirely host-owned: `data-theme` (light/dark/system), `data-skin` (5 skins), and `--accent` CSS variables written on `<html>` by `src/hooks/useTheme.ts`. The plugin system has zero integration with it.

The user wants a plugin that sets a **global background image** over the whole app shell, with arbitrary image sources (remote URL **or** a local file) and adjustable frosted-glass translucency.

Because plugins cannot touch the shell, this needs a **host seam**: a host-owned background appearance subsystem plus a declarative contribution point through which plugins contribute background images. This is a user-approved override of the v1 "no appearance contribution" cut-down, at the smallest surface that makes the feature expressible.

## Goal / non-goals

- **Goal:** a host "Background" appearance subsystem — a full-viewport background image layer driven by CSS variables, plus frosted-glass translucency on the currently-opaque chrome surfaces, with a user-adjustable translucency/opacity slider.
- **Goal:** a `contributes.backgrounds` contribution point (declarative, `statusIndicators`-shaped): a plugin ships raster image assets and the host lists them in the shared Background picker.
- **Goal:** arbitrary image sources — a remote `http(s)` URL, or a **local file upload** stored by the server and served back as a same-origin URL.
- **Goal:** an official first-party `wallpaper` plugin demonstrating the contribution point.
- **Non-goal:** a plugin pushing a background at runtime (`ui.setBackground` host API / dynamic per-session backgrounds) — deferred; this spec is user-picked-static only.
- **Non-goal:** iframe Views / arbitrary plugin DOM (unchanged, still deferred).
- **Non-goal:** a "config-observed-by-host" pipeline (plugin `configuration` values driving the shell) — rejected for v1; the active background is host-owned local state, plugins contribute *options*.
- **Non-goal:** per-session backgrounds, blur radius adjustment (fixed token), animated/GIF/SVG backgrounds.

## Design

The active background is a **host-owned appearance preference** (like accent colour): stored client-side, applied by writing CSS variables onto `<html>`, surfaced in the Appearance popover. Plugins participate only as **declarative contributors of background images** that appear in the same picker. The custom-URL / local-file paths are host capabilities that exist regardless of any plugin.

### 1. Framework contribution schema — `contributes.backgrounds`

`shared/app-plugins/contributions.ts` — new type, modelled on `PluginStatusIndicatorContribution` (lines 115–124):

```ts
export interface PluginBackgroundContribution {
  /** `<pluginId>.<name>` — must be prefixed by the plugin id. */
  id: string
  /** Human title shown in the picker, e.g. "Aurora". */
  title: string
  description?: string
  /** Relative path to the image under the plugin dir (PNG/JPG/WEBP only —
   *  raster, no SVG/GIF). Same path validation as statusIndicators. */
  asset: string
  /** Optional smaller preview for the picker grid; falls back to `asset`. */
  thumb?: string
  /** When clause, e.g. 'theme == "dark"'. Filters availability in the
   *  picker only; does not auto-switch the active background. */
  when?: string
  order?: number
}
```

- `PluginContributions` gains `backgrounds?: PluginBackgroundContribution[]`.
- `ResolvedPluginContributions` gains `backgrounds: PluginBackgroundContribution[]`.
- `shared/app-plugins/manifest-validator.ts`: clone the `statusIndicators` resolution block (around lines 292–306) — id-prefix check, `asset`/`thumb` via `validateRelativePath`, `checkWhen`, duplicate-id diagnostics — and thread `backgrounds` through `ContributionResolution` + `packageContributions` (lines 174–184).

Because contributions ride the existing `ResolvedPluginContributions` payload, `backgrounds` flows to the client **with no new WS frame** — `AppPluginClientInfo.contributions` already carries the resolved object in the `app-plugins-snapshot` / `app-plugin-state-changed` / `app-plugin-contributions-changed` frames.

### 2. Asset route: allow JPG/JPEG

`GET /api/app-plugins/:id/assets/*` (`server/app-plugins/routes.ts:107-147`) currently serves GIF/SVG/PNG/WEBP. Background images are typically photos, so extend the served extension/content-type allow-list to include **jpg/jpeg**. The backgrounds validator (§1) restricts *contribution* assets to PNG/JPG/WEBP (raster only); the shared route serving `statusIndicators` also benefits from jpg support (harmless). No other route change — path containment, `nosniff`, 1 MB cap, and the asset-response CSP (`default-src 'none'; style-src 'unsafe-inline'`) are unchanged.

### 3. Host state model + `useBackground` hook

**Types + constants** (`src/theme.ts`, beside the accent constants):

```ts
export type BackgroundPref =
  | { kind: 'none' }
  | { kind: 'custom'; src: string }                        // http(s) URL, or /api/background/files/<uuid>.<ext>
  | { kind: 'plugin'; pluginId: string; backgroundId: string }

export interface BackgroundSetting {
  pref: BackgroundPref
  opacity: number        // chrome-surface translucency, 0.55..1 — lower = more image shows
}

export const BACKGROUND_KEY = 'claude-react-web:background'
export const BACKGROUND_DEFAULT_OPACITY = 0.85
export const BACKGROUND_OPACITY_MIN = 0.55
export const BACKGROUND_OPACITY_MAX = 1
```

Persisted as a single JSON object at `BACKGROUND_KEY` via `useLocalStorage` (same mechanism as accent colour).

**New hook `src/hooks/useBackground.ts`**, called at the App root next to `useTheme()`; returns `{ setting, setPref, setOpacity, clear, resolvedImageUrl }`. A `useEffect` writes the effect onto the document whenever `setting` or the plugin registry changes:

- Resolve the image URL:
  - `none` → no image.
  - `custom` → the `src` string itself (validated client-side as `http(s):` or a same-origin `/api/background/files/…` path).
  - `plugin` → look up the enabled plugin `contributions.backgrounds` entry whose `id === backgroundId` (via `useAllContributions()` from `src/app-plugins/usePluginRegistry.ts`, which already filters `enabled && compatible`); URL = `/api/app-plugins/<pluginId>/assets/<asset>`. If the plugin/background is not resolvable, fall back to no image but **keep the stored pref** (so re-enabling the plugin restores it).
- Apply, mirroring the accent effect in `useTheme.ts` (lines 116–136):
  - `--app-bg-image` = `url("…")` or `none`;
  - `--app-chrome-alpha` = `opacity` written as a percentage (`85%`);
  - toggle `document.body.classList.toggle('has-bg', imageActive)`.
- Blur stays a fixed CSS-side token (§4); only alpha is JS-driven.
- The effect depends on the registry list so a plugin preset applies as soon as WS/REST hydrates contributions after mount.

Micro-behaviour: picking any image while `opacity` is at `1` (fully opaque → the image would be invisible) auto-sets `opacity` to `BACKGROUND_DEFAULT_OPACITY`, so enabling a background visibly engages translucency.

### 4. CSS: background layer + frosted chrome

**Background layer.** Split the `body` rule (`src/styles/tokens.css`, the `body { background: var(--bg); … }` rule around lines 1073–1084) into:

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

**Frosted chrome.** The five shell surfaces that are currently opaque (verified in `layout.css`: `.sidebar` 19–28, `.main-header` ~99–108, `.main-body` 216–224, `.chat-panel` 258–285, `.chat-panel-header` 295–309) must become translucent only when a background is active. Scope every change under `body.has-bg` so the default (no background) is byte-for-byte the current look:

```css
body.has-bg { --app-chrome-blur: 24px; }

body.has-bg .sidebar,
body.has-bg .main-header,
body.has-bg .chat-panel {
  /* background-color, NOT the background shorthand — preserves each skin's
     background-image (glow surface gradients), exactly as glass.css does. */
  background-color: color-mix(in srgb, var(--bg-elev) var(--app-chrome-alpha), transparent);
  backdrop-filter: blur(var(--app-chrome-blur));
  -webkit-backdrop-filter: blur(var(--app-chrome-blur));
}
body.has-bg .main-body {
  background: transparent;          /* drop the intermediate fill to avoid nested double-blur */
}
body.has-bg .chat-panel-header {
  /* Accent tint layered over the (already translucent + blurred) panel below —
     the panel supplies the elevation fill, the header just adds the 6% accent wash. */
  background-color: color-mix(in srgb, var(--accent) 6%, transparent);
}
```

`color-mix(... var(--app-chrome-alpha) ...)` accepts a var holding a percentage; JS writes `85%`-style values. Floating surfaces (modal / palette / settings / git overlays / ctx menus …) are *already* translucent + `backdrop-filter` in `glass.css` and need no change — a background image shows and blurs through them automatically.

**Progressive enhancement** (same as `glass.css`): an `@supports (backdrop-filter: blur(1px))` guard keeps the current fully-opaque `var(--bg)` / `var(--bg-elev)` fills on browsers without `backdrop-filter`, so text contrast never degrades silently.

**Implementation technique note for the plan:** `backdrop-filter` establishes a containing block for fixed/absolute descendants, which could re-anchor any `position: fixed` content inside the affected chrome. Prefer implementing the tint+blur as an absolutely-positioned `::before` overlay layer on each surface (content painted above via `position: relative; z-index`) rather than as the surface's own `background`/`backdrop-filter`, and audit the affected regions for fixed-position descendants during the visual pass. Exact per-surface composition is a visual-tuning task for the implementation step (see Testing, manual e2e), not a schema decision.

### 5. Settings UI — "Background" section in the Appearance popover

`AppearancePanel.tsx` (`src/components/AppearancePanel.tsx`) gains a new `Background` section (always present, after Accent; the custom-URL/file capabilities are host-level and not gated on any plugin). To keep the file focused, render it via a new `src/components/BackgroundPicker.tsx` (mirroring how the panel embeds the existing `AccentSwatchGrid`).

Props threaded from `App.tsx` (which calls `useBackground()` alongside `useTheme()`): the current `BackgroundSetting`, `setPref`, `setOpacity`, and the resolved `resolvedImageUrl`. The picker reads the enabled-plugin preset list itself with `useAllContributions()`.

Picker contents:

- **None / Custom / Plugin-presets** rows.
- **Custom:** a text input for an `http(s)` URL and a "Upload image…" button (`<input type="file" accept="image/png,image/jpeg,image/webp">`). Upload → `POST /api/background/upload` (FormData) → on success `setPref({ kind: 'custom', src: url })`.
- **Plugin presets:** from each enabled plugin's `contributions.backgrounds`, filtered by `when` against `buildWhenContext({ theme: resolvedDarkOrLight })` (client `when` helpers in `src/app-plugins/when.ts`), grouped by plugin name, each shown as a swatch/thumbnail whose `src` is the plugin asset URL (`thumb` ?? `asset`). Selecting stores `{ kind: 'plugin', pluginId, backgroundId }`. If the stored selection is not resolvable in the current list (plugin disabled / background removed), no swatch renders as active and the live effect is `none` (§3).
- **Opacity slider** (`0.55..1`, default 0.85), shown once an image is active — live preview via the CSS-variable effect.
- **Clear** affordance → `setPref({ kind: 'none' })` (also deletes the previously uploaded local file, §6).

`App.tsx` passes the current resolved dark/light for the `when` context (resolve `system` via `matchMedia('(prefers-color-scheme: light)')`, the same resolution `applyTheme` uses).

### 6. Global background image upload (server)

Existing upload infra is per-session (`server/routes/uploads.ts`, files land under the *session's cwd*). A background is global, so this is a small dedicated store + router, mirroring the upload store's shape but rooted in the app state dir:

- `POST /api/background/upload` — `multipart/form-data`, single image file. Validate content type against an allow-list (`image/jpeg`, `image/png`, `image/webp`) and size against the existing `config.maxUploadBytes`. Write to `<stateDir>/backgrounds/<uuid>.<ext>` (random name; no user-controlled path). Return `{ url: '/api/background/files/<uuid>.<ext>' }`.
- `GET /api/background/files/:name` — serve the file with a content-type allow-listed from the extension; containment check on `:name` (no `..`, no separators).
- `DELETE /api/background/files/:name` — delete a previously uploaded file (called when the user clears/custom image is replaced). `ENOENT` → 404.

No registry store is needed for v1: the only reference to an uploaded file is the `custom.src` URL in the client's localStorage preference. Orphans (localStorage cleared without a DELETE) are small, bounded files under the state dir; acceptable. Mounted in `server/app.ts` beside the other routers (`app.route('/api/background', …)`), with the store optionally passed in `buildApp` options like `uploadStore` so tests/standalone callers can omit it.

**Security notes:** the upload route never trusts filenames (server-assigned `uuid`), serves only allow-listed image MIME types, path-containment-checks on every read/delete, and caps size. The URL stored in the preference is either an `http(s)` remote URL or this same-origin `/api/background/files/…` path. The app sets **no CSP header** today (verified: no `Content-Security-Policy` in `server/app.ts`), so CSS `url()` to remote images is not blocked; if a CSP is ever added, `img-src` must allow remote background URLs (see Open questions).

### 7. Official `wallpaper` plugin

```
plugins/wallpaper/
  crw-plugin.json
  dist/service.mjs        # minimal idle JSON-RPC child loop (no commands, no activation)
  dist/assets/*.webp      # 4–5 preset raster backgrounds (+ optional *_thumb.webp)
  manifest.test.ts        # validateManifest() passes
```

`crw-plugin.json` sketch:

```json
{
  "manifestVersion": 1,
  "id": "wallpaper.claude-react-web",
  "name": "Wallpaper",
  "description": "Curated background images for the app shell",
  "version": "0.1.0",
  "publisher": "claude-react-web",
  "engines": { "claudeReactWeb": "^0.6.0", "pluginApi": "^1.0.0", "node": ">=20" },
  "runtime": { "service": "dist/service.mjs" },
  "permissions": [],
  "contributes": {
    "backgrounds": [
      { "id": "wallpaper.claude-react-web.aurora", "title": "Aurora", "asset": "dist/assets/aurora.webp", "thumb": "dist/assets/aurora_thumb.webp", "order": 1 }
    ]
  }
}
```

Pure declarative asset contribution — no permission, no `activationEvents`, subprocess idles (same fixture/service shape as `plugins/translator`). Images are committed raster files under the plugin `dist/`; the first-party build (`build.mjs`) already copies `plugins/` → `dist/plugins/` dropping test files and local `package.json`. Register the catalog entry in `plugins/app-plugins-marketplace.json`; `plugins/marketplace-catalog.test.ts` covers it automatically.

## Behavior matrix

| Scenario | Behavior |
|---|---|
| No background configured (default) | `body` paints `var(--bg)`; `body.has-bg` absent; chrome fully opaque — byte-for-byte current look |
| Custom remote URL set | `--app-bg-image: url("…")`; chrome surfaces translucent + blurred at `opacity`; remote image loads (no CSP) |
| Local file uploaded | Stored under `<stateDir>/backgrounds/<uuid>`; served via `/api/background/files/…`; same rendering as URL |
| Plugin preset chosen | Image served from `/api/app-plugins/<pluginId>/assets/<asset>`; requires plugin enabled |
| Chosen plugin later disabled/uninstalled | Live effect falls back to `none`; stored pref kept; no swatch active in the picker until re-enabled |
| Plugin background declares `when: 'theme == "dark"'` | Swatch shown only in dark mode (picker availability); does not auto-switch the active background on theme change |
| Multiple plugins contribute backgrounds | Picker groups presets by plugin name, ordered by `order` |
| Opacity slider at 1.0 | Chrome at `100%` alpha — effectively the current opaque look (image mostly hidden); picking an image at opacity 1.0 auto-sets 0.85 |
| Browser without `backdrop-filter` | `@supports` fallback keeps opaque fills — readable, image not shown through chrome |
| Skins (glow/anthropic/etc.) active | Translucency uses `background-color` only — skin `background-image` gradients preserved (glass.css recipe) |
| localStorage cleared / corrupt pref | `useLocalStorage` validation falls back to `{ kind: 'none', opacity: 0.85 }` |
| Uploaded file replaced/cleared | `DELETE /api/background/files/:name` removes the old file; orphans from a wiped localStorage are accepted (small, bounded) |

## Files touched

| File | Change |
|---|---|
| `shared/app-plugins/contributions.ts` | `PluginBackgroundContribution`; `PluginContributions.backgrounds`; `ResolvedPluginContributions.backgrounds` |
| `shared/app-plugins/manifest-validator.ts` | resolve + validate `backgrounds` (prefix, asset/thumb path, when, dup-id); thread through `ContributionResolution` / `packageContributions` |
| `server/app-plugins/routes.ts` | asset allow-list += `jpg`/`jpeg` |
| `server/app.ts` | mount `/api/background` router (store optional in `buildApp` opts) |
| `server/background-routes.ts` | **new** — `POST /api/background/upload`, `GET /api/background/files/:name`, `DELETE /api/background/files/:name` |
| `src/theme.ts` | `BackgroundPref`/`BackgroundSetting`, `BACKGROUND_KEY`, opacity defaults/constants |
| `src/hooks/useBackground.ts` | **new** — pref state + registry resolution + CSS-variable/`has-bg` effect |
| `src/App.tsx` | call `useBackground()`; pass props + resolved theme to `AppearancePanel` |
| `src/components/AppearancePanel.tsx` | Background section (embeds `BackgroundPicker`); props |
| `src/components/BackgroundPicker.tsx` | **new** — none/custom(URL+upload)/plugin-presets + opacity slider |
| `src/styles/tokens.css` | `--app-bg-image`, `--app-chrome-alpha`; split `body` background rule |
| `src/styles/layout.css` | `body.has-bg` frosted rules for sidebar/main-header/main-body/chat-panel(+header); `@supports` fallback |
| `plugins/wallpaper/crw-plugin.json` | **new** — manifest |
| `plugins/wallpaper/dist/service.mjs` | **new** — idle JSON-RPC child loop |
| `plugins/wallpaper/dist/assets/*.webp` | **new** — preset background images + thumbs |
| `plugins/wallpaper/manifest.test.ts` | **new** — `validateManifest` passes |
| `plugins/app-plugins-marketplace.json` | add `wallpaper` catalog entry |

## Testing (TDD)

1. **shared — manifest validation.** A manifest with `backgrounds` entries resolves to prefixed ids; bad `asset`/`thumb` (absolute, `..`, wrong type) → diagnostic + entry dropped; a non-raster extension (`.svg`/`.gif`) → diagnostic; a malformed `when` → entry dropped; duplicate id → diagnostic. Extend `shared/app-plugins/manifest-validator.test.ts`.
2. **shared — regression.** Existing `ResolvedPluginContributions` consumers (fixture manifests, `packageContributions`) still compile/pass with the new required `backgrounds` array.
3. **server — upload route.** Accepts a valid `image/png`; rejects wrong content type and over-size (413); `:name` containment (traversal rejected); DELETE removes then 404s.
4. **client — `useBackground`.** None → no `has-bg`, `--app-bg-image: none`; custom URL → var set + `has-bg` on; plugin pref resolves to the enabled plugin's asset URL; unresolvable plugin pref → no image but pref preserved; opacity writes `--app-chrome-alpha` percentage. (jsdom + registry mock, mirroring `PluginWidgetSlot.test.tsx`.)
5. **client — `BackgroundPicker`.** Renders plugin presets grouped by plugin, filtered by `when`/theme; URL input + upload callback path; opacity slider bound to `setOpacity`. (jsdom.)
6. **plugin — manifest.** `plugins/wallpaper/manifest.test.ts` calls `validateManifest`; `plugins/marketplace-catalog.test.ts` auto-covers the new dir.
7. **Manual e2e (visual).** Enable `wallpaper` → pick a preset → sidebar/header/panels go frosted over the image at the set opacity; pick a remote URL; upload a local file; switch light/dark (when-filtered presets appear/disappear); disable the plugin → preset unresolvable → effect `none`, pref retained; **no-background default visually identical to pre-change** (screenshot diff against the current build); fixed-position overlays (CommandPalette, context menus, Settings/Git overlays) still anchor correctly with `backdrop-filter` active (containing-block audit).

## Open questions / decisions

- **Confirmed:** the active background is host-owned local state; plugins contribute declarative options. This deliberately overrides the v1 "no appearance contribution" cut-down at the smallest surface (a data-only contribution + host rendering), consistent with `statusIndicators`.
- **Confirmed:** Background section always present in the Appearance popover; custom URL/file are host capabilities not gated on any plugin. (Alternative — gating the section on a background-capable plugin being enabled — was offered and declined.)
- **Confirmed:** `body` is the paint layer (no extra fixed `<div>`); translucency scoped under `body.has-bg`; blur fixed at a token (~24 px) and not user-adjustable in v1.
- **Confirmed:** raster-only backgrounds (PNG/JPG/WEBP); asset route gains JPG; SVG/GIF excluded (no animated/vector wallpapers in v1).
- **Open:** `backdrop-filter` containing-block side effects on `position: fixed` descendants inside the frosted chrome — mitigate with a `::before` overlay-layer technique and audit fixed overlays during the visual pass; fall back to per-surface `background` swap if the audit is clean.
- **Open:** no CSP today, so remote `url()` backgrounds load; if the app later adds a CSP, `img-src` must allow remote background URLs (and any `data:` variant if ever used).
- **Open:** uploaded-file lifecycle is ref-count-free — orphans after a wiped localStorage are accepted. A later sweep-on-boot (delete files older than N days with no matching localStorage) is possible if they ever become a problem.
