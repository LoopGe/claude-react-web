# Global Background Image (default/glow skins) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users of the `default` and `glow` skins set a full-app background image (remote URL or uploaded local file) with an adjustable frosted-glass opacity, as a host appearance preference.

**Architecture:** A client-side `useBackground(skin)` hook owns a localStorage `BackgroundSetting` (`none` | `custom.src` + `opacity`) and writes `--app-bg-image` / `--app-chrome-alpha` CSS variables onto `<html>` and toggles `body.has-bg`. CSS under `body.has-bg` makes the chrome surfaces translucent (`color-mix`) + blurred (`backdrop-filter`) over a `body`-painted background layer. `isBackgroundLocked(skin)` (true for `anthropic`/`hc`/`soft-hc`) hides the Background control and suppresses the effect, preserving the stored choice. A small global upload router (`/api/background`) stores local files under `<stateDir>/backgrounds/`. No plugin/framework changes.

**Tech Stack:** React 19 + Vite client, Hono server, vitest (node for server, jsdom for client), existing CSS token system.

**Spec:** `docs/superpowers/specs/2026-09-03-background-image-plugin-design.md` (theme-system form — default/glow only, no plugin).

## Global Constraints

- CSS: never hardcode color hex — use theme tokens only (`var(--fg)`, `var(--bg-elev-2)`, `var(--border)`, `var(--accent)`, `var(--fs-sm)`, `var(--radius-sm)`, …). (CLAUDE.md rule.)
- All server diagnostic logging goes through `createLogger(scope)` from `server/log.ts` — no bare `console.*`.
- Typecheck runs BOTH `tsconfig.json` (browser) and `tsconfig.node.json` (server): `npm run typecheck`.
- Tests: `npm test` runs vitest. Vitest env: `server/**` node; `src/**` jsdom (narrow node overrides exist for `src/utils/**`, `src/session-store/*`, etc. — our new tests target `src/**` general → jsdom, except `src/utils/theme.test.ts` which is node via the existing `['src/utils/**/*.test.ts', 'node']` rule).
- Do NOT modify anything under `shared/`, `server/app-plugins/`, or `plugins/` — this feature is host-only.
- `isBackgroundLocked` must stay in lockstep with the accent lock: `skin === 'anthropic' || skin === 'hc' || skin === 'soft-hc'`.

---

### Task 1: Background types + constants + storage guard in `src/theme.ts`

**Files:**
- Modify: `src/theme.ts`
- Test: `src/theme.test.ts`

**Interfaces:**
- Produces: `export type BackgroundPref` (`'none'` | `{ kind: 'custom'; src: string }`); `export interface BackgroundSetting { pref: BackgroundPref; opacity: number }`; `export const BACKGROUND_KEY = 'claude-react-web:background'`; `BACKGROUND_DEFAULT_OPACITY = 0.85`; `BACKGROUND_OPACITY_MIN = 0.55`; `BACKGROUND_OPACITY_MAX = 1`; `export function isBackgroundSetting(v: unknown): v is BackgroundSetting`.

- [ ] **Step 1: Write the failing test**

Create `src/theme.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { isBackgroundSetting } from './theme'

describe('isBackgroundSetting', () => {
  it('accepts a none setting', () => {
    expect(isBackgroundSetting({ pref: { kind: 'none' }, opacity: 0.85 })).toBe(true)
  })
  it('accepts a custom setting with an http(s) src', () => {
    expect(isBackgroundSetting({ pref: { kind: 'custom', src: 'https://example.com/bg.png' }, opacity: 0.7 })).toBe(true)
  })
  it('rejects a corrupt / hand-edited value', () => {
    expect(isBackgroundSetting(null)).toBe(false)
    expect(isBackgroundSetting({ pref: { kind: 'custom' }, opacity: 0.7 })).toBe(false) // missing src
    expect(isBackgroundSetting({ pref: { kind: 'none' }, opacity: 2 })).toBe(false)      // opacity out of range
    expect(isBackgroundSetting({ pref: { kind: 'weird' }, opacity: 0.5 })).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/theme.test.ts`
Expected: FAIL — `isBackgroundSetting` is not exported from `./theme`.

- [ ] **Step 3: Implement types, constants, guard**

Append to `src/theme.ts` (it already imports `type { Skin }` from `./utils/theme` at the top — `Skin` is not needed here, leave existing imports untouched):

```ts
// ── Global background image (default/glow skins only) ──────────────────
//
// A host appearance preference on the same footing as the accent colour:
// stored client-side, applied by useBackground() as CSS variables on <html>.
// Only the `default` and `glow` skins expose it (see isBackgroundLocked in
// utils/theme.ts); the branded/a11y skins suppress the effect but preserve
// the stored choice.

export type BackgroundPref =
  | { kind: 'none' }
  | { kind: 'custom'; src: string }     // http(s) URL, or /api/background/files/<uuid>.<ext>

export interface BackgroundSetting {
  pref: BackgroundPref
  /** Chrome-surface translucency, 0.55..1 — lower = more of the image shows. */
  opacity: number
}

export const BACKGROUND_KEY = 'claude-react-web:background'
export const BACKGROUND_DEFAULT_OPACITY = 0.85
export const BACKGROUND_OPACITY_MIN = 0.55
export const BACKGROUND_OPACITY_MAX = 1

/** Type-guard for useLocalStorage's `validate` — rejects corrupt /
 *  hand-edited values so a bad localStorage entry collapses to the default. */
export function isBackgroundSetting(v: unknown): v is BackgroundSetting {
  if (!v || typeof v !== 'object') return false
  const s = v as { pref?: unknown; opacity?: unknown }
  if (typeof s.opacity !== 'number' || Number.isNaN(s.opacity)) return false
  if (s.opacity < BACKGROUND_OPACITY_MIN || s.opacity > BACKGROUND_OPACITY_MAX) return false
  const p = s.pref as { kind?: unknown; src?: unknown } | null
  if (!p || typeof p !== 'object') return false
  if (p.kind === 'none') return true
  if (p.kind === 'custom') return typeof p.src === 'string' && p.src.length > 0 && p.src.length <= 4096
  return false
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/theme.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add src/theme.ts src/theme.test.ts
git commit -m "feat(theme): background setting types, constants, storage guard"
```

---

### Task 2: `isBackgroundLocked` in `src/utils/theme.ts`

**Files:**
- Modify: `src/utils/theme.ts`
- Test: `src/utils/theme.test.ts` (node env)

**Interfaces:**
- Consumes: `type Skin` from `src/utils/theme.ts` (same file).
- Produces: `export function isBackgroundLocked(skin: Skin | undefined | null): boolean`.

- [ ] **Step 1: Write the failing test**

Create `src/utils/theme.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { isBackgroundLocked, isAccentLocked } from './theme'

describe('isBackgroundLocked', () => {
  it('is false for the expressive skins', () => {
    expect(isBackgroundLocked('default')).toBe(false)
    expect(isBackgroundLocked('glow')).toBe(false)
  })
  it('is true for the branded / a11y skins', () => {
    expect(isBackgroundLocked('anthropic')).toBe(true)
    expect(isBackgroundLocked('hc')).toBe(true)
    expect(isBackgroundLocked('soft-hc')).toBe(true)
  })
  it('stays in lockstep with the accent lock', () => {
    for (const s of ['default', 'glow', 'anthropic', 'hc', 'soft-hc'] as const) {
      expect(isBackgroundLocked(s)).toBe(isAccentLocked(s))
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/utils/theme.test.ts`
Expected: FAIL — `isBackgroundLocked` is not exported.

- [ ] **Step 3: Implement**

In `src/utils/theme.ts`, immediately after `isAccentLocked` (line 45):

```ts
/** Backgrounds are available only on the expressive skins. The branded /
 *  a11y skins (Anthropic, HC, Soft-HC) stay pristine — kept in lockstep with
 *  the accent lock (same skins) so gating sites agree. */
export function isBackgroundLocked(skin: Skin | undefined | null): boolean {
  return skin === 'anthropic' || skin === 'hc' || skin === 'soft-hc'
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/utils/theme.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/utils/theme.ts src/utils/theme.test.ts
git commit -m "feat(theme): isBackgroundLocked skin gating helper"
```

---

### Task 3: Global background upload router (server)

**Files:**
- Create: `server/background-routes.ts`
- Modify: `server/app.ts`
- Test: `server/background-routes.test.ts`

**Interfaces:**
- Consumes: `config as serverConfig` (`server/config.ts`, `.maxUploadBytes`), `createLogger` (`server/log.ts`).
- Produces: `export function buildBackgroundRouter(opts: { dir: string; maxUploadBytes?: number }): Hono` — routes `POST /upload`, `GET /files/:name`, `DELETE /files/:name`. `dir` is where uploaded files are stored (caller passes `<stateDir>/backgrounds`).

- [ ] **Step 1: Write the failing tests**

Create `server/background-routes.test.ts` (mirrors `server/routes/uploads.test.ts` conventions — `tempDir` from `../__test-utils__/index.js`):

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'
import { rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createErrorHandler } from './errors.js'
import { buildBackgroundRouter } from './background-routes.js'
import { tempDir } from './__test-utils__/index.js'

function makeApp(dir: string, maxUploadBytes = 1024) {
  const app = new Hono()
  app.onError(createErrorHandler('[test]'))
  app.route('/api/background', buildBackgroundRouter({ dir, maxUploadBytes }))
  return app
}

describe('background routes', () => {
  let root: string
  let dir: string
  let app: Hono

  beforeEach(() => {
    root = tempDir('bg')
    dir = join(root, 'backgrounds')
    app = makeApp(dir)
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  describe('POST /api/background/upload', () => {
    it('writes an allowed image and returns its URL', async () => {
      const form = new FormData()
      form.append('file', new File(['fake-png'], 'wall.png', { type: 'image/png' }))
      const res = await app.request('/api/background/upload', { method: 'POST', body: form })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { url: string }
      expect(body.url).toMatch(/^\/api\/background\/files\/[0-9a-f-]+\.png$/)
      const name = body.url.split('/').pop()!
      expect(existsSync(join(dir, name))).toBe(true)
    })

    it('rejects a disallowed content type', async () => {
      const form = new FormData()
      form.append('file', new File(['x'], 'a.gif', { type: 'image/gif' }))
      const res = await app.request('/api/background/upload', { method: 'POST', body: form })
      expect(res.status).toBe(400)
    })

    it('rejects an over-size file (413)', async () => {
      const form = new FormData()
      form.append('file', new File([new Uint8Array(1025)], 'big.png', { type: 'image/png' }))
      const res = await app.request('/api/background/upload', { method: 'POST', body: form })
      expect(res.status).toBe(413)
    })
  })

  describe('GET /api/background/files/:name', () => {
    it('serves an uploaded file with its content type', async () => {
      const form = new FormData()
      form.append('file', new File(['fake-png'], 'wall.png', { type: 'image/png' }))
      const posted = (await (await app.request('/api/background/upload', { method: 'POST', body: form })).json()) as { url: string }
      const res = await app.request(posted.url)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('image/png')
    })

    it('400s on a traversal / bad name', async () => {
      const res = await app.request('/api/background/files/..%2Fsecret.png')
      expect(res.status).toBe(400)
    })

    it('404s on a missing file', async () => {
      const res = await app.request('/api/background/files/00000000-0000-0000-0000-000000000000.png')
      expect(res.status).toBe(404)
    })
  })

  describe('DELETE /api/background/files/:name', () => {
    it('removes the file, then 404s on a second GET', async () => {
      const form = new FormData()
      form.append('file', new File(['fake-png'], 'wall.png', { type: 'image/png' }))
      const posted = (await (await app.request('/api/background/upload', { method: 'POST', body: form })).json()) as { url: string }
      const del = await app.request(posted.url, { method: 'DELETE' })
      expect(del.status).toBe(200)
      const again = await app.request(posted.url)
      expect(again.status).toBe(404)
    })

    it('404s deleting a missing file', async () => {
      const res = await app.request('/api/background/files/00000000-0000-0000-0000-000000000000.png', { method: 'DELETE' })
      expect(res.status).toBe(404)
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/background-routes.test.ts`
Expected: FAIL — cannot find module `./background-routes.js`.

- [ ] **Step 3: Implement the router**

Create `server/background-routes.ts`:

```ts
// Global background-image upload routes. Unlike session uploads (which land
// in the session's cwd, server/routes/uploads.ts), a background is a global
// appearance file stored under <stateDir>/backgrounds/ and served back as a
// same-origin URL. Filenames are server-assigned <uuid>.<ext> — user-supplied
// names are never trusted. Every read/delete is containment-checked.

import { Hono } from 'hono'
import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { config as serverConfig } from './config.js'
import { createLogger } from './log.js'

const log = createLogger('background')

/** Acceptable upload content types → file extension. */
const ALLOWED_UPLOAD: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
}

/** Served extension (lowercase, no dot) → Content-Type for GET. */
const EXT_TYPE: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
}

/** Server-assigned names only: a uuid + a raster extension. */
function isSafeName(name: string): boolean {
  return name.length > 0 && name.length <= 80 && /^[0-9a-f-]+\.(jpg|jpeg|png|webp)$/i.test(name)
}

function isInside(base: string, target: string): boolean {
  const b = resolve(base)
  const t = resolve(target)
  return t === b || t.startsWith(b.endsWith('/') ? b : b + '/')
}

export function buildBackgroundRouter(opts: { dir: string; maxUploadBytes?: number }): Hono {
  const app = new Hono()
  const dir = opts.dir
  const maxBytes = opts.maxUploadBytes ?? serverConfig.maxUploadBytes

  app.post('/upload', async (c) => {
    const ct = c.req.header('content-type') ?? ''
    if (!ct.toLowerCase().startsWith('multipart/form-data')) {
      return c.json({ error: 'expected multipart/form-data' }, 400)
    }
    const body = await c.req.parseBody({ all: true }).catch(() => null)
    if (!body) return c.json({ error: 'invalid multipart payload' }, 400)

    let file: File | undefined
    for (const v of Object.values(body)) {
      if (v instanceof File) { file = v; break }
    }
    if (!file) return c.json({ error: 'no file in request' }, 400)

    const ext = ALLOWED_UPLOAD[file.type]
    if (!ext) return c.json({ error: `unsupported image type '${file.type}'` }, 400)
    if (file.size > maxBytes) {
      return c.json({ error: `file exceeds ${maxBytes} bytes` }, 413 as 400 | 404 | 410 | 500)
    }

    await mkdir(dir, { recursive: true })
    const name = `${randomUUID()}${ext}`
    await writeFile(join(dir, name), Buffer.from(await file.arrayBuffer()))
    log.info(`upload background name=${name} bytes=${file.size}`)
    return c.json({ url: `/api/background/files/${name}` })
  })

  app.get('/files/:name', async (c) => {
    const name = c.req.param('name')
    if (!isSafeName(name)) return c.json({ error: 'invalid filename' }, 400)
    const target = join(dir, name)
    if (!isInside(dir, target)) return c.json({ error: 'invalid filename' }, 400)
    const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
    try {
      const data = await readFile(target)
      return new Response(new Uint8Array(data), {
        headers: { 'Content-Type': EXT_TYPE[ext] ?? 'application/octet-stream', 'Cache-Control': 'no-store' },
      })
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return c.json({ error: 'not found' }, 404)
      log.error(`read background name=${name}: ${(e as Error).message}`)
      return c.json({ error: (e as Error).message }, 500)
    }
  })

  app.delete('/files/:name', async (c) => {
    const name = c.req.param('name')
    if (!isSafeName(name)) return c.json({ error: 'invalid filename' }, 400)
    const target = join(dir, name)
    if (!isInside(dir, target)) return c.json({ error: 'invalid filename' }, 400)
    try {
      await unlink(target)
      log.info(`delete background name=${name}`)
      return c.json({ ok: true })
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return c.json({ error: 'not found' }, 404)
      log.error(`delete background name=${name}: ${(e as Error).message}`)
      return c.json({ error: (e as Error).message }, 500)
    }
  })

  return app
}
```

- [ ] **Step 4: Wire into `server/app.ts`**

`server/app.ts` already imports `join` from `node:path` and receives `configDir` in `AppOptions` (passed as `configDir: stateDir` by `server/cli.ts`). Add an import for the new router, then mount beside the other `/api` routers (after the `app.route('/api/git', …)` line ~257):

```ts
import { buildBackgroundRouter } from './background-routes.js'
// ...existing code...
  app.route('/api/edit-locate', buildEditLocateRouter())
  if (opts.configDir) {
    app.route('/api/background', buildBackgroundRouter({ dir: join(opts.configDir, 'backgrounds') }))
  }
```

(If the `if (opts.configDir)` block is not the surrounding style, gate the single `app.route` on `opts.configDir` truthiness exactly as above — standalone/test callers without a config dir simply don't get the route.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run server/background-routes.test.ts`
Expected: PASS (all background route cases).

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no new errors.

- [ ] **Step 7: Commit**

```bash
git add server/background-routes.ts server/background-routes.test.ts server/app.ts
git commit -m "feat(server): global background image upload router"
```

---

### Task 4: `useBackground` hook

**Files:**
- Create: `src/hooks/useBackground.ts`
- Test: `src/hooks/useBackground.test.ts` (jsdom)

**Interfaces:**
- Consumes: `useLocalStorage` (`src/hooks/useLocalStorage.ts`, options `{ validate }`), `BACKGROUND_KEY`, `BackgroundSetting`, `isBackgroundSetting`, `BACKGROUND_OPACITY_*`, `BACKGROUND_DEFAULT_OPACITY` (`src/theme.ts`), `isBackgroundLocked` + `type Skin` (`src/utils/theme.ts`).
- Produces:
  ```ts
  export interface UseBackgroundResult {
    setting: BackgroundSetting
    /** Persist a whole new setting. When the user transitions none → an
     *  image while opacity is at its max (which would render the image
     *  invisible), opacity is auto-set to BACKGROUND_DEFAULT_OPACITY. */
    setSetting: (next: BackgroundSetting) => void
  }
  export function useBackground(skin: Skin): UseBackgroundResult
  ```

- [ ] **Step 1: Write the failing test**

Create `src/hooks/useBackground.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useBackground } from './useBackground'

function cssVar(name: string): string {
  return document.documentElement.style.getPropertyValue(name)
}

describe('useBackground', () => {
  beforeEach(() => {
    window.localStorage.clear()
    document.documentElement.style.removeProperty('--app-bg-image')
    document.documentElement.style.removeProperty('--app-chrome-alpha')
    document.body.classList.remove('has-bg')
  })
  afterEach(() => {
    window.localStorage.clear()
    document.body.classList.remove('has-bg')
  })

  it('defaults to none and leaves the document untouched', () => {
    const { result } = renderHook(() => useBackground('default'))
    expect(result.current.setting).toEqual({ pref: { kind: 'none' }, opacity: 0.85 })
    expect(cssVar('--app-bg-image')).toBe('none')
    expect(cssVar('--app-chrome-alpha')).toBe('100%')
    expect(document.body.classList.contains('has-bg')).toBe(false)
  })

  it('does not enable the effect while a custom pref has an empty src', () => {
    const { result } = renderHook(() => useBackground('default'))
    act(() => result.current.setSetting({ pref: { kind: 'custom', src: '' }, opacity: 0.7 }))
    expect(document.body.classList.contains('has-bg')).toBe(false)
    expect(cssVar('--app-bg-image')).toBe('none')
  })

  it('applies a custom URL under the default skin', () => {
    const { result } = renderHook(() => useBackground('default'))
    act(() => result.current.setSetting({ pref: { kind: 'custom', src: 'https://ex.com/bg.png' }, opacity: 0.7 }))
    expect(cssVar('--app-bg-image')).toBe('url("https://ex.com/bg.png")')
    expect(cssVar('--app-chrome-alpha')).toBe('70%')
    expect(document.body.classList.contains('has-bg')).toBe(true)
  })

  it('suppresses the effect under a locked skin but keeps the pref', () => {
    const { result, rerender } = renderHook(({ skin }: { skin: 'default' | 'hc' }) => useBackground(skin), {
      initialProps: { skin: 'default' },
    })
    act(() => result.current.setSetting({ pref: { kind: 'custom', src: 'https://ex.com/bg.png' }, opacity: 0.7 }))
    expect(document.body.classList.contains('has-bg')).toBe(true)
    rerender({ skin: 'hc' })
    expect(document.body.classList.contains('has-bg')).toBe(false)
    expect(cssVar('--app-bg-image')).toBe('none')
    expect(result.current.setting.pref).toEqual({ kind: 'custom', src: 'https://ex.com/bg.png' })
  })

  it('auto-sets default opacity when picking an image at max opacity', () => {
    const { result } = renderHook(() => useBackground('default'))
    act(() => result.current.setSetting({ pref: { kind: 'custom', src: 'https://ex.com/bg.png' }, opacity: 1 }))
    expect(result.current.setting.opacity).toBe(0.85)
  })

  it('persists and restores a corrupt value as the default', () => {
    window.localStorage.setItem('claude-react-web:background', JSON.stringify({ pref: { kind: 'bogus' }, opacity: 9 }))
    const { result } = renderHook(() => useBackground('default'))
    expect(result.current.setting).toEqual({ pref: { kind: 'none' }, opacity: 0.85 })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/hooks/useBackground.test.ts`
Expected: FAIL — cannot find module `./useBackground`.

- [ ] **Step 3: Implement the hook**

Create `src/hooks/useBackground.ts`:

```ts
// Global background-image appearance preference (default/glow skins only).
//
// Owns the localStorage BackgroundSetting (src/theme.ts) and applies it to
// the document the same way useTheme applies accent colour: write CSS custom
// properties onto <html> and toggle body.has-bg. Under a background-locked
// skin (Anthropic / HC / Soft-HC) the effect is suppressed but the stored
// choice is preserved, so switching back to default/glow restores it.

import { useCallback, useEffect } from 'react'
import { useLocalStorage } from './useLocalStorage'
import {
  BACKGROUND_KEY,
  BACKGROUND_DEFAULT_OPACITY,
  BACKGROUND_OPACITY_MAX,
  type BackgroundSetting,
  isBackgroundSetting,
} from '../theme'
import { isBackgroundLocked, type Skin } from '../utils/theme'

const DEFAULT_SETTING: BackgroundSetting = { pref: { kind: 'none' }, opacity: BACKGROUND_DEFAULT_OPACITY }

/** Strip characters that would break a CSS url("…") string. */
function sanitizeCssUrl(src: string): string {
  return src.replace(/["'\\\n\r]/g, '')
}

export interface UseBackgroundResult {
  setting: BackgroundSetting
  /** Persist a whole new setting. Transitioning none → an image while
   *  opacity is at its max (image would be invisible) auto-sets the default. */
  setSetting: (next: BackgroundSetting) => void
}

export function useBackground(skin: Skin): UseBackgroundResult {
  const [setting, setStored] = useLocalStorage<BackgroundSetting>(
    BACKGROUND_KEY,
    DEFAULT_SETTING,
    { validate: isBackgroundSetting },
  )

  const setSetting = useCallback((next: BackgroundSetting) => {
    setStored((prev) => {
      const picking = prev.pref.kind === 'none' && next.pref.kind !== 'none'
      return picking && next.opacity >= BACKGROUND_OPACITY_MAX
        ? { ...next, opacity: BACKGROUND_DEFAULT_OPACITY }
        : next
    })
  }, [setStored])

  useEffect(() => {
    const root = document.documentElement.style
    // An active image requires a non-empty src for `custom` — selecting
    // "Custom image" before a URL/upload lands must not frost the chrome.
    const hasImage =
      setting.pref.kind === 'custom' ? setting.pref.src.length > 0 : setting.pref.kind !== 'none'
    const active = hasImage && !isBackgroundLocked(skin)
    if (!active) {
      root.setProperty('--app-bg-image', 'none')
      root.setProperty('--app-chrome-alpha', '100%')
      document.body.classList.remove('has-bg')
      return
    }
    if (setting.pref.kind === 'custom') {
      const clean = sanitizeCssUrl(setting.pref.src)
      root.setProperty('--app-bg-image', `url("${clean}")`)
    } else {
      root.setProperty('--app-bg-image', 'none')
    }
    root.setProperty('--app-chrome-alpha', `${Math.round(setting.opacity * 100)}%`)
    document.body.classList.add('has-bg')
  }, [setting, skin])

  return { setting, setSetting }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/hooks/useBackground.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck`

```bash
git add src/hooks/useBackground.ts src/hooks/useBackground.test.ts
git commit -m "feat(theme): useBackground hook applies background CSS vars"
```

---

### Task 5: `BackgroundPicker` component

**Files:**
- Create: `src/components/BackgroundPicker.tsx`
- Test: `src/components/BackgroundPicker.test.tsx` (jsdom)
- Modify: `src/styles/session-list.css` (small new classes near `.appearance-panel`)

**Interfaces:**
- Consumes: `BackgroundSetting`, `BACKGROUND_OPACITY_MIN/MAX` (`src/theme.ts`).
- Produces: `export function BackgroundPicker({ setting, onChange }: { setting: BackgroundSetting; onChange: (next: BackgroundSetting) => void })`.

Behaviour: None/Custom toggle; when Custom active show an image-URL text row + an "Upload image…" file button; when an image is active show an opacity slider (range MIN..MAX step 0.05) and a Clear button. Selecting a custom URL validates `http(s)://` before calling `onChange`. Uploading POSTs the file to `/api/background/upload` (raw `fetch`, NOT the `api` wrapper — it forces JSON), then calls `onChange` with the returned URL; if the *previous* pref was an uploaded file (`/api/background/files/…`), it best-effort DELETEs that old file. Clear resets to `{ pref: { kind: 'none' }, opacity }` and best-effort DELETEs a previous uploaded file.

- [ ] **Step 1: Write the failing test**

Create `src/components/BackgroundPicker.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { BackgroundPicker } from './BackgroundPicker'
import type { BackgroundSetting } from '../theme'

function setting(pref: BackgroundSetting['pref'], opacity = 0.85): BackgroundSetting {
  return { pref, opacity }
}

describe('BackgroundPicker', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('renders None/Custom and defaults to None active', () => {
    render(<BackgroundPicker setting={setting({ kind: 'none' })} onChange={() => {}} />)
    expect(screen.getByRole('button', { name: 'None' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Custom image' })).toBeTruthy()
  })

  it('applies a valid http(s) URL on submit', () => {
    const onChange = vi.fn()
    render(<BackgroundPicker setting={setting({ kind: 'none' })} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Custom image' }))
    fireEvent.change(screen.getByLabelText('Image URL'), { target: { value: 'https://ex.com/bg.png' } })
    fireEvent.click(screen.getByRole('button', { name: 'Use URL' }))
    expect(onChange).toHaveBeenCalledWith({ pref: { kind: 'custom', src: 'https://ex.com/bg.png' }, opacity: 0.85 })
  })

  it('rejects a non-http(s) URL', () => {
    const onChange = vi.fn()
    render(<BackgroundPicker setting={setting({ kind: 'none' })} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Custom image' }))
    fireEvent.change(screen.getByLabelText('Image URL'), { target: { value: 'file:///etc/passwd' } })
    fireEvent.click(screen.getByRole('button', { name: 'Use URL' }))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('uploads a file and applies the returned URL, deleting the old file', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ url: '/api/background/files/new.png' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) }) // DELETE old
    vi.stubGlobal('fetch', fetchMock)
    const onChange = vi.fn()
    render(<BackgroundPicker setting={setting({ kind: 'custom', src: '/api/background/files/old.png' }, 0.7)} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Upload image…' }))
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!
    fireEvent.change(input, { target: { files: [new File(['x'], 'a.png', { type: 'image/png' })] } })
    await screen.findByText('Applied')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(onChange).toHaveBeenCalledWith({ pref: { kind: 'custom', src: '/api/background/files/new.png' }, opacity: 0.7 })
  })

  it('Clear resets to none and deletes a previous uploaded file', () => {
    const onChange = vi.fn()
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) })
    vi.stubGlobal('fetch', fetchMock)
    render(<BackgroundPicker setting={setting({ kind: 'custom', src: '/api/background/files/old.png' })} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect(onChange).toHaveBeenCalledWith({ pref: { kind: 'none' }, opacity: 0.85 })
    expect(fetchMock).toHaveBeenCalledWith('/api/background/files/old.png', { method: 'DELETE' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/BackgroundPicker.test.tsx`
Expected: FAIL — cannot find module `./BackgroundPicker`.

- [ ] **Step 3: Implement the component**

Create `src/components/BackgroundPicker.tsx`:

```tsx
// Background section body for the Appearance popover (default/glow skins).
// Lets the user pick None or a Custom image — via a remote http(s) URL or a
// local file uploaded to /api/background — and adjust the frosted opacity.

import { useState } from 'react'
import {
  BACKGROUND_OPACITY_MIN,
  BACKGROUND_OPACITY_MAX,
  type BackgroundPref,
  type BackgroundSetting,
} from '../theme'

interface Props {
  setting: BackgroundSetting
  onChange: (next: BackgroundSetting) => void
}

function isUploadedUrl(src: string): boolean {
  return src.startsWith('/api/background/files/')
}

export function BackgroundPicker({ setting, onChange }: Props) {
  const isCustom = setting.pref.kind === 'custom'
  const [urlText, setUrlText] = useState(isCustom ? setting.pref.src : '')
  const [applied, setApplied] = useState(false)

  const selectCustom = (src: string) => onChange({ ...setting, pref: { kind: 'custom', src } })

  const applyUrl = () => {
    const trimmed = urlText.trim()
    if (!/^https?:\/\/.+/i.test(trimmed)) return
    setApplied(true)
    selectCustom(trimmed)
  }

  const deleteIfUploaded = (src: string) => {
    if (isUploadedUrl(src)) {
      fetch(src, { method: 'DELETE' }).catch(() => {})
    }
  }

  const handleUpload = async (file: File) => {
    const form = new FormData()
    form.append('file', file, file.name)
    try {
      const res = await fetch('/api/background/upload', { method: 'POST', body: form })
      const body = (await res.json().catch(() => ({}))) as { url?: string; error?: string }
      if (!res.ok || !body.url) throw new Error(body.error || `upload failed (HTTP ${res.status})`)
      if (isCustom) deleteIfUploaded(setting.pref.src)
      setApplied(true)
      selectCustom(body.url)
    } catch (e) {
      // Surface transiently; the picker remains usable.
      setApplied(false)
      console.warn('[background] upload failed:', (e as Error).message)
    }
  }

  const clear = () => {
    if (isCustom) deleteIfUploaded(setting.pref.src)
    setApplied(false)
    onChange({ pref: { kind: 'none' }, opacity: setting.opacity })
  }

  const pref: BackgroundPref = isCustom ? setting.pref : { kind: 'none' }

  return (
    <div className="appearance-bg">
      <div className="appearance-mode-row" role="radiogroup" aria-label="Background">
        <button
          type="button"
          className={`appearance-mode-btn${!isCustom ? ' active' : ''}`}
          onClick={() => { setApplied(false); onChange({ ...setting, pref: { kind: 'none' } }) }}
          role="radio"
          aria-checked={!isCustom}
        >
          <span>None</span>
        </button>
        <button
          type="button"
          className={`appearance-mode-btn${isCustom ? ' active' : ''}`}
          onClick={() => { if (!isCustom) { setUrlText(''); onChange({ ...setting, pref: { kind: 'custom', src: '' } }) } }}
          role="radio"
          aria-checked={isCustom}
        >
          <span>Custom image</span>
        </button>
      </div>

      {isCustom && (
        <div className="appearance-bg-body">
          <label className="appearance-bg-label" htmlFor="appearance-bg-url">Image URL</label>
          <div className="appearance-bg-url-row">
            <input
              id="appearance-bg-url"
              className="appearance-bg-url"
              value={urlText}
              placeholder="https://…"
              onChange={(e) => { setUrlText(e.target.value); setApplied(false) }}
              aria-label="Image URL"
            />
            <button type="button" className="btn" onClick={applyUrl}>Use URL</button>
          </div>
          <div className="appearance-bg-upload-row">
            <label className="btn">
              Upload image…
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) void handleUpload(f)
                  e.target.value = ''
                }}
              />
            </label>
            {applied && <span className="appearance-bg-hint">Applied</span>}
          </div>
          {pref.kind === 'custom' && pref.src && (
            <div className="appearance-bg-current">
              <span className="appearance-bg-hint">{isUploadedUrl(pref.src) ? 'Uploaded image' : 'Remote image'}</span>
            </div>
          )}
        </div>
      )}

      <div className="appearance-bg-opacity">
        <label className="appearance-bg-label" htmlFor="appearance-bg-opacity">
          Opacity <span className="appearance-bg-hint">{Math.round(setting.opacity * 100)}%</span>
        </label>
        <input
          id="appearance-bg-opacity"
          className="appearance-bg-slider"
          type="range"
          min={BACKGROUND_OPACITY_MIN}
          max={BACKGROUND_OPACITY_MAX}
          step={0.05}
          value={setting.opacity}
          disabled={!isCustom || !pref.src}
          onChange={(e) => onChange({ ...setting, opacity: Number(e.target.value) })}
        />
      </div>

      {isCustom && pref.src && (
        <button type="button" className="appearance-bg-clear" onClick={clear}>Clear</button>
      )}
    </div>
  )
}
```

Notes for the implementer:
- The "Custom image" radio transitions none → custom by storing an empty `src`; the effect treats an empty src as no image (guard in `useBackground`). Do not auto-`onChange` with an empty URL — the `pref.src` falsy check keeps the effect off until a real URL/upload lands.
- `console.warn` here is a transient UI surface for an upload error, not a diagnostic log; acceptable in client code. Keep it single-line and user-action-scoped.

- [ ] **Step 4: Add minimal styles (theme tokens only)**

In `src/styles/session-list.css` near the `.appearance-panel` block (line ~717), append:

```css
/* Background section (Appearance popover). Theme tokens only — no hex. */
.appearance-bg {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.appearance-bg-body,
.appearance-bg-opacity {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.appearance-bg-label {
  font-size: var(--fs-sm);
  color: var(--fg-muted);
  display: flex;
  justify-content: space-between;
}
.appearance-bg-url-row {
  display: flex;
  gap: 6px;
}
.appearance-bg-url {
  flex: 1;
  min-width: 0;
  background: var(--bg-elev-2);
  color: var(--fg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 4px 8px;
  font-size: var(--fs-sm);
}
.appearance-bg-upload-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.appearance-bg-hint {
  font-size: var(--fs-sm);
  color: var(--fg-muted);
}
.appearance-bg-slider {
  width: 100%;
  accent-color: var(--accent);
}
.appearance-bg-clear {
  align-self: flex-start;
  font-size: var(--fs-sm);
  color: var(--fg-muted);
  background: none;
  border: none;
  padding: 2px 4px;
  cursor: pointer;
}
.appearance-bg-clear:hover {
  color: var(--fg);
  text-decoration: underline;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/components/BackgroundPicker.test.tsx`
Expected: PASS (5 tests). The upload test asserts, in order: `fetchMock.mock.calls[0]` is the `POST /api/background/upload` and `fetchMock.mock.calls[1]` is the `DELETE` of the previous uploaded file (the DELETE fires only after the POST resolves, so the order is deterministic).

- [ ] **Step 6: Typecheck + commit**

Run: `npm run typecheck`

```bash
git add src/components/BackgroundPicker.tsx src/components/BackgroundPicker.test.tsx src/styles/session-list.css
git commit -m "feat(theme): BackgroundPicker UI for URL/upload/opacity"
```

---

### Task 6: Background section in the Appearance popover (skin-gated)

**Files:**
- Modify: `src/components/AppearancePanel.tsx`
- Test: `src/components/AppearancePanel.test.tsx` (jsdom)

**Interfaces:**
- Consumes: `BackgroundPicker` (Task 5), `isBackgroundLocked` (`src/utils/theme.ts`), `BackgroundSetting` (`src/theme.ts`).
- Produces: `AppearancePanel` gains two props — `background: BackgroundSetting; onBackgroundChange: (s: BackgroundSetting) => void` — and renders a "Background" section (with heading `Background`) only when `!isBackgroundLocked(skin)`.

- [ ] **Step 1: Write the failing test**

Create `src/components/AppearancePanel.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { AppearancePanel } from './AppearancePanel'
import type { BackgroundSetting } from '../theme'

const noBg: BackgroundSetting = { pref: { kind: 'none' }, opacity: 0.85 }

function renderPanel(skin: 'default' | 'glow' | 'anthropic' | 'hc' | 'soft-hc') {
  return render(
    <AppearancePanel
      skin={skin}
      mode="dark"
      accentColor="#7b8cde"
      onSkin={() => {}}
      onMode={() => {}}
      onAccent={() => {}}
      background={noBg}
      onBackgroundChange={() => {}}
    />,
  )
}

async function openPanel() {
  fireEvent.click(screen.getByRole('button', { name: 'Appearance' }))
  await screen.findByRole('dialog', { name: 'Appearance' })
}

describe('AppearancePanel background section', () => {
  it('shows the Background section for default skin', async () => {
    renderPanel('default')
    await openPanel()
    expect(screen.getByText('Background')).toBeTruthy()
  })
  it('shows the Background section for glow skin', async () => {
    renderPanel('glow')
    await openPanel()
    expect(screen.getByText('Background')).toBeTruthy()
  })
  it('hides the Background section for hc / anthropic / soft-hc', async () => {
    for (const skin of ['anthropic', 'hc', 'soft-hc'] as const) {
      const { unmount } = renderPanel(skin)
      await openPanel()
      expect(screen.queryByText('Background')).toBeNull()
      unmount()
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/AppearancePanel.test.tsx`
Expected: FAIL — `background`/`onBackgroundChange` props are not in `AppearancePanel` (TS + runtime).

- [ ] **Step 3: Implement**

Modify `src/components/AppearancePanel.tsx`:

1. Imports: add `import { BackgroundPicker } from './BackgroundPicker'`, `import { isBackgroundLocked } from '../utils/theme'`, `import type { BackgroundSetting } from '../theme'`.

2. Extend the `Props` interface (lines 22–30) and `AppearancePopover` props with:

```ts
  background: BackgroundSetting
  onBackgroundChange: (next: BackgroundSetting) => void
```

3. Add the section at the end of the popover (after the Accent `</div>`, before the closing `</div>` of the portal root), gated by skin:

```tsx
      {!isBackgroundLocked(skin) && (
        <div className="appearance-section">
          <div className="appearance-heading">Background</div>
          <BackgroundPicker setting={background} onChange={onBackgroundChange} />
        </div>
      )}
```

4. Thread `background`/`onBackgroundChange` through the outer `AppearancePanel` → `AppearancePopover` props.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/components/AppearancePanel.test.tsx`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck`

```bash
git add src/components/AppearancePanel.tsx src/components/AppearancePanel.test.tsx
git commit -m "feat(theme): skin-gated Background section in Appearance popover"
```

---

### Task 7: Wire `useBackground` into `App.tsx`

**Files:**
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: `useBackground` (Task 4), `BackgroundSetting` type.
- Produces: `App.tsx` calls `useBackground(skin)` and passes `background`/`onBackgroundChange` to the `<AppearancePanel>`.

- [ ] **Step 1: Add the hook call**

In `src/App.tsx`, immediately after the `useTheme()` destructure (ends ~line 274), add:

```ts
  // Global background image (default/glow skins). Depends on `skin` so a
  // switch to a background-locked skin suppresses the effect but keeps the
  // stored choice (see useBackground).
  const { setting: backgroundSetting, setSetting: setBackgroundSetting } = useBackground(skin)
```

Add the import near the other hook imports:

```ts
import { useBackground } from './hooks/useBackground'
```

- [ ] **Step 2: Thread props into `<AppearancePanel>`**

In `src/App.tsx` the `<AppearancePanel …>` element (~line 3730) gains two props:

```tsx
              background={backgroundSetting}
              onBackgroundChange={setBackgroundSetting}
```

- [ ] **Step 3: Verify**

Run: `npm run typecheck`
Expected: no errors. (Visual behaviour is verified in Task 9.)

- [ ] **Step 4: Commit**

```bash
git add src/App.tsx
git commit -m "feat(theme): wire useBackground through App"
```

---

### Task 8: CSS tokens + frosted chrome + body background layer

**Files:**
- Modify: `src/styles/tokens.css`
- Modify: `src/styles/layout.css`

**Interfaces:**
- Consumes: the CSS variables written by `useBackground` (`--app-bg-image`, `--app-chrome-alpha`) and the `body.has-bg` class toggle.
- Produces: a full-viewport background layer on `body`, and frosted chrome only under `body.has-bg`.

- [ ] **Step 1: Add tokens in `tokens.css`**

In `:root` (after the `--bg-elev-2: #1c2029;` line ~20), add:

```css
  /* App background layer + chrome translucency (useBackground). Alpha is
     written by JS as a percentage ('85%'); 100% = fully opaque = today's
     look. Only has an effect under body.has-bg. */
  --app-bg-image: none;
  --app-chrome-alpha: 100%;
```

- [ ] **Step 2: Split the `body` rule in `tokens.css`**

In the `body { … }` rule (~lines 1073–1084), replace the shorthand `background: var(--bg);` with the longhand layer (image default `none` keeps today's solid fill):

```css
body {
  font-family: var(--sans);
  background-color: var(--bg);
  background-image: var(--app-bg-image);
  background-size: cover;
  background-position: center;
  background-attachment: fixed;
  color: var(--fg);
  /* …remaining existing declarations unchanged… */
}
```

- [ ] **Step 3: Add the frosted-chrome block to `layout.css`**

Append to the end of `src/styles/layout.css`:

```css
/* ── Frosted chrome when a background image is active ───────────────────
   Toggled by useBackground (body.has-bg). Each surface keeps its own base
   fill token (sidebar/header = --bg-elev, chat-panel = --bg) so opacity
   100% resolves to exactly today's look. Guarded by @supports so browsers
   without backdrop-filter keep fully-opaque fills. */
@supports (backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px)) {
  body.has-bg {
    --app-chrome-blur: 24px;
  }
  body.has-bg .sidebar,
  body.has-bg .main-header {
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
    background: transparent;
  }
  body.has-bg .chat-panel-header {
    background-color: color-mix(in srgb, var(--accent) 6%, transparent);
  }
}
```

- [ ] **Step 4: Verify the build parses the CSS**

Run: `npm run build`
Expected: build succeeds (vite/postcss parses the CSS; a syntax error would fail it). Visual verification is Task 9.

- [ ] **Step 5: Commit**

```bash
git add src/styles/tokens.css src/styles/layout.css
git commit -m "feat(theme): background layer + frosted chrome under body.has-bg"
```

---

### Task 9: Manual end-to-end visual verification

**Files:** none (verification only). Use the project `run` skill or a browser (Playwright) against a dev server.

- [ ] **Step 1: Run the app**

Run: `npm run dev` (server :3456 + client :5174), open http://localhost:5174.

- [ ] **Step 2: No-background identity check (regression)**

With the default skin and no background set, screenshot the app. Confirm the shell looks identical to the pre-change build — `body.has-bg` absent, chrome opaque, no image.

- [ ] **Step 3: Uploaded local image**

Appearance → Background (visible on `default`): upload a local PNG/WEBP. Confirm: the image paints behind the app, sidebar/header/chat panels turn translucent + blurred at the default 0.85 opacity, and messages/bubbles remain readable. Confirm the slider changes translucency live (toward 1 → near-opaque; toward 0.55 → image strongly visible).

- [ ] **Step 4: Remote URL**

Paste a remote `https://…` image URL → Use URL. Confirm it loads (no CSP blocks it) and renders like the upload.

- [ ] **Step 5: Skin gating + lock interplay**

- Switch skin to `glow` — Background section still present; effect still applies (glow surface gradients preserved over the translucent fills).
- Switch to `hc`, `anthropic`, or `soft-hc` — Background section disappears; the image is suppressed and the app looks pristine; the stored choice is retained.
- Switch back to `default`/`glow` — the image re-applies.

- [ ] **Step 6: Fixed-position containment audit**

With a background active, open the Command Palette (Mod+K), a message context menu, and the Settings/Git overlays; confirm each anchors and renders correctly (no re-anchor/clipping from `backdrop-filter`'s containing-block effect). If a fixed overlay mis-anchors, implement the `::before` overlay-layer technique from the spec (§4 implementation note) instead of the surface's own `backdrop-filter`, and re-run this step.

- [ ] **Step 7: Clear + delete**

Clear the background; confirm the uploaded file returns 404 on `GET /api/background/files/…` (deleted).

- [ ] **Step 8: Full suite**

Run: `npm test`
Expected: all suites pass (existing + new).

## Post-implementation review checklist

- [ ] No files under `shared/`, `server/app-plugins/`, or `plugins/` were modified.
- [ ] No hardcoded hex colours added to CSS.
- [ ] `npm run typecheck` and `npm test` are green.
- [ ] Server logging goes through `createLogger`; no stray `console.*` in server code (the one `console.warn` is client-side upload-error surfacing).
- [ ] No-background default is visually identical to pre-change (screenshot compared).
