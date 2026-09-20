# Version-update toast + What's New dialog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the update banner with a sticky "new version available" toast whose action button opens a What's New dialog rendering GitHub-release changelog entries for every version in `(current, latest]`.

**Architecture:** A new server module (`server/release-notes.ts`) fetches GitHub Releases with a `update-checker`-style cache and exposes `GET /api/release-notes`. On the client, a `useUpdateNag` hook pushes a sticky toast once per offered version (localStorage-persisted dismissal); the toast action opens a lazily-loaded `UpdateDialog` (Overlay perm-variant, same shell as `UploadsManagerDialog`) that fetches notes on open and reuses the existing in-app update action. `UpdateBanner` is deleted.

**Tech Stack:** Hono route, module-level fetch cache (no new deps), React 19 + Overlay primitive, react-markdown via the existing `Markdown` component, vitest (node env for server, jsdom for client).

**Spec:** `docs/superpowers/specs/2026-09-10-update-whatsnew-dialog-design.md` — read it before starting; this plan argues from it.

## Global Constraints

- All CSS colours via theme CSS variables (never hardcoded hex); every new colour defined in both `:root` (dark) and `[data-theme="light"]` blocks.
- Server diagnostics go through `createLogger(scope)` — no bare `console.*`.
- Server imports use `.js` extensions (NodeNext); client imports do not.
- Every nag surface gates on `isUpdateNagNeeded(info)` / `!isUpdateAppliedToDisk(info)` — never raw `hasUpdate`.
- The working tree contains unrelated dirty files. **Every commit stages explicit paths only — never `git add -A` / `git add .`**.
- Version filtering reuses `parseSemver` / `compareSemver` / `isStableVersion` from `shared/update-info.ts` — no second semver implementation.
- Toast action label is exactly `Update`.
- localStorage dismiss key is exactly `claude-react-web:update-nag-dismissed-version`.
- Run `npm run typecheck` (both tsconfigs), `npm run test`, `npm run lint` before declaring done.

---

### Task 1: Shared wire types + `server/release-notes.ts` (fetch / filter / cache)

**Files:**
- Modify: `shared/update-info.ts` (append the ReleaseNotes section)
- Create: `server/release-notes.ts`
- Test: `server/release-notes.test.ts`

**Interfaces:**
- Consumes: `parseSemver`, `compareSemver`, `isStableVersion` from `shared/update-info.ts`; `config.updateCheckRegistry`; `createLogger`; build-time `package.json` (via JSON import, same as `server/update-checker.ts:30`).
- Produces (relied on by later tasks):
  ```ts
  // shared/update-info.ts
  export interface ReleaseNote { version: string; name: string; body: string; publishedAt: string; url: string }
  export interface ReleaseNotesResult { from: string; to: string; releases: ReleaseNote[]; error?: string; checkedAt?: number }

  // server/release-notes.ts
  export function getReleaseNotes(from: string, to: string): Promise<ReleaseNotesResult>
  export function __resetReleaseNotesForTests(): void
  ```

- [ ] **Step 1: Append wire types to `shared/update-info.ts`**

At the end of the file, add:

```ts
// ── Release notes (What's New dialog) ──────────────────────────────
//
// Returned by GET /api/release-notes. Separate from UpdateInfo because the
// notes come from GitHub Releases (a different source than the npm dist-tag
// probe) and are only fetched when the user opens the What's New dialog.

/** One GitHub release narrowed to the fields the dialog renders. */
export interface ReleaseNote {
  /** tag_name with any leading `v` stripped, e.g. `0.8.0`. */
  version: string
  /** The release title (`name`); may be empty. */
  name: string
  /** Release body markdown, verbatim. */
  body: string
  /** ISO-8601 publish timestamp. */
  publishedAt: string
  /** Browser URL of the release page. */
  url: string
}

export interface ReleaseNotesResult {
  /** The exclusive lower bound the caller asked for (running version). */
  from: string
  /** The inclusive upper bound (the offered latest version). */
  to: string
  /** Releases with version in `(from, to]`, DESC by semver. Empty on
   *  error — see `error`. Never throws to the caller. */
  releases: ReleaseNote[]
  /** Human-readable failure reason (GitHub unreachable / rate-limited /
   *  no repo slug). Absent on success. */
  error?: string
  /** ms epoch of the successful fetch this result came from. */
  checkedAt?: number
}
```

- [ ] **Step 2: Write the failing test `server/release-notes.test.ts`**

```ts
// Tests for server/release-notes.ts — GitHub Releases fetch, range
// filtering, caching, and failure degradation. No route tests here (those
// live in update-routes.test.ts once the route is mounted).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import { __resetReleaseNotesForTests, getReleaseNotes } from './release-notes.js'

/** Fake GitHub release objects covering the filter matrix: stable in-range
 *  (0.7.3, 0.8.0), stable below range (0.7.1), prerelease tag (0.9.0-rc.1),
 *  API-prerelease flag, draft, unparseable tag (`nightly`), and above `to`. */
function ghRelease(over: Record<string, unknown> = {}) {
  return {
    tag_name: 'v0.8.0',
    name: '0.8.0',
    body: 'body text',
    published_at: '2026-09-10T00:00:00Z',
    html_url: 'https://github.com/LoopGe/claude-react-web/releases/tag/v0.8.0',
    draft: false,
    prerelease: false,
    ...over,
  }
}

const FULL_LIST = [
  ghRelease({ tag_name: 'v0.9.0-rc.1' }),          // prerelease tag — skip
  ghRelease({ tag_name: 'v0.8.5', name: 'above to' }), // > to — skip
  ghRelease({ tag_name: 'v0.8.0' }),
  ghRelease({ tag_name: '0.7.3', name: 'no v prefix', body: 'older notes' }),
  ghRelease({ tag_name: 'v0.7.2', name: 'equal to from' }), // from excluded
  ghRelease({ tag_name: 'nightly' }),               // unparseable — skip
  ghRelease({ tag_name: 'v0.8.1', draft: true }),   // draft — skip
  ghRelease({ tag_name: 'v0.8.2', prerelease: true }), // API prerelease — skip
]

function stubGitHub(body: unknown = FULL_LIST, status = 200) {
  const fetchMock = vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('getReleaseNotes', () => {
  beforeEach(() => {
    __resetReleaseNotesForTests()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('filters to (from, to], strips v-prefix, sorts DESC', async () => {
    stubGitHub()
    const res = await getReleaseNotes('0.7.2', '0.8.0')
    expect(res.error).toBeUndefined()
    expect(res.releases.map((r) => r.version)).toEqual(['0.8.0', '0.7.3'])
    expect(res.releases[0]).toMatchObject({
      name: '0.8.0',
      body: 'body text',
      publishedAt: '2026-09-10T00:00:00Z',
      url: 'https://github.com/LoopGe/claude-react-web/releases/tag/v0.8.0',
    })
    expect(res.from).toBe('0.7.2')
    expect(res.to).toBe('0.8.0')
    expect(typeof res.checkedAt).toBe('number')
  })

  it('returns empty releases + error on a 403 (rate limit)', async () => {
    stubGitHub({ message: 'API rate limit exceeded' }, 403)
    const res = await getReleaseNotes('0.7.0', '0.8.0')
    expect(res.releases).toEqual([])
    expect(res.error).toMatch(/rate limit|403/i)
  })

  it('returns empty releases + error on a network throw', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') }))
    const res = await getReleaseNotes('0.7.0', '0.8.0')
    expect(res.releases).toEqual([])
    expect(res.error).toBeTruthy()
  })

  it('serves the cached result within the TTL (one fetch for two calls)', async () => {
    const fetchMock = stubGitHub()
    await getReleaseNotes('0.7.2', '0.8.0')
    await getReleaseNotes('0.7.2', '0.8.0')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('dedupes concurrent calls into one fetch', async () => {
    let resolveFetch!: (r: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((res) => { resolveFetch = res })))
    const p1 = getReleaseNotes('0.7.2', '0.8.0')
    const p2 = getReleaseNotes('0.7.2', '0.8.0')
    resolveFetch(new Response(JSON.stringify([]), { status: 200 }))
    await Promise.all([p1, p2])
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1)
  })

  it('cache is keyed by the (from, to) pair', async () => {
    const fetchMock = stubGitHub()
    await getReleaseNotes('0.7.2', '0.8.0')
    await getReleaseNotes('0.7.0', '0.8.0') // different pair → new fetch
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('short-circuits to an error result when the registry is disabled', async () => {
    const { __setConfigForTest } = await import('./config.js')
    __setConfigForTest({ updateCheckRegistry: '' })
    const fetchMock = stubGitHub()
    const res = await getReleaseNotes('0.7.2', '0.8.0')
    expect(res.releases).toEqual([])
    expect(res.error).toMatch(/not configured/i)
    expect(fetchMock).not.toHaveBeenCalled()
    __setConfigForTest({ updateCheckRegistry: undefined })
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run server/release-notes.test.ts`
Expected: FAIL — module `server/release-notes.ts` does not exist.

- [ ] **Step 4: Implement `server/release-notes.ts`**

```ts
// Release-notes checker — fetches the project's GitHub Releases and
// narrows them to the version range the What's New dialog renders.
//
// Caching policy mirrors update-checker.ts:
//   - Successful fetches cached for RELEASES_TTL_MS (6h), keyed by the
//     full `(from, to)` pair. In practice `from` is always the running
//     version, so cardinality is one entry per process.
//   - Failed fetches cache the error briefly (FAILED_RETRY_MS) so a
//     transient GitHub hiccup doesn't poison the dialog for 6h.
//   - In-flight fetches are deduped per (from, to) key.
//   - 5s fetch timeout (FETCH_TIMEOUT_MS).
//
// Failure mode: every failure path resolves to `{ releases: [], error }` —
// the dialog degrades to a version-only view; this module never throws.
//
// The repo slug comes from the build-time package.json `repository` URL
// (same trust boundary as update-checker's packageName) — never from the
// request, so this is not an SSRF surface.

import pkg from '../package.json' with { type: 'json' }
import {
  compareSemver,
  isStableVersion,
  parseSemver,
  type ReleaseNote,
  type ReleaseNotesResult,
} from '../shared/update-info.js'
import { config } from './config.js'
import { createLogger } from './log.js'

const log = createLogger('release-notes')

const RELEASES_TTL_MS = 6 * 60 * 60 * 1000 // 6h between successful fetches
const FAILED_RETRY_MS = 5 * 60 * 1000      // 5 min retry after failure
const FETCH_TIMEOUT_MS = 5_000
const PER_PAGE = 30

/** Parse `owner/repo` out of a package.json `repository` string.
 *  Accepts `git+https://github.com/o/r.git`, `https://github.com/o/r`,
 *  `git@github.com:o/r.git`, `github:o/r`. Returns null when the URL
 *  isn't a GitHub repo we can extract a slug from. */
export function parseRepoSlug(repository: unknown): string | null {
  if (typeof repository !== 'string') return null
  const m = /github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?(?:[/#].*)?$/.exec(repository)
  return m ? m[1] : null
}

const REPO_SLUG = parseRepoSlug(
  (pkg as { repository?: unknown }).repository as string | undefined,
)

interface CacheEntry {
  result: ReleaseNotesResult
  /** Epoch ms after which the entry is stale. */
  expiresAt: number
}

let cacheKey: string | null = null
let cache: CacheEntry | null = null
const inFlight = new Map<string, Promise<ReleaseNotesResult>>()

export function __resetReleaseNotesForTests(): void {
  cacheKey = null
  cache = null
  inFlight.clear()
}

/** Raw GitHub release payload — only the fields we read. */
interface GhRelease {
  tag_name?: unknown
  name?: unknown
  body?: unknown
  published_at?: unknown
  html_url?: unknown
  draft?: unknown
  prerelease?: unknown
}

function errorResult(from: string, to: string, error: string): ReleaseNotesResult {
  return { from, to, releases: [], error }
}

async function fetchReleases(from: string, to: string): Promise<ReleaseNotesResult> {
  if (!config.updateCheckRegistry) {
    return errorResult(from, to, 'update checks are not configured')
  }
  if (!REPO_SLUG) {
    return errorResult(from, to, 'no GitHub repository configured in this build')
  }
  const url = `https://api.github.com/repos/${REPO_SLUG}/releases?per_page=${PER_PAGE}`
  let payload: GhRelease[]
  try {
    const res = await fetch(url, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'claude-react-web',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      const hint = res.status === 403 || res.status === 429 ? ' (rate limited)' : ''
      return errorResult(from, to, `GitHub releases fetch failed: ${res.status}${hint} ${text.slice(0, 200)}`)
    }
    const json: unknown = await res.json()
    if (!Array.isArray(json)) {
      return errorResult(from, to, 'unexpected GitHub releases payload')
    }
    payload = json as GhRelease[]
  } catch (err) {
    return errorResult(from, to, (err as Error).message ?? String(err))
  }

  const releases: ReleaseNote[] = []
  for (const r of payload) {
    if (r.draft === true || r.prerelease === true) continue
    if (typeof r.tag_name !== 'string') continue
    const version = r.tag_name.replace(/^v/, '')
    // Stable-only + parseable: same policy as isVersionNewer / the version
    // switcher — a prerelease or garbage tag never reaches the dialog.
    if (!parseSemver(version) || !isStableVersion(version)) continue
    // Range: exclusive from, inclusive to.
    if (compareSemver(version, from) <= 0) continue
    if (compareSemver(version, to) > 0) continue
    releases.push({
      version,
      name: typeof r.name === 'string' ? r.name : '',
      body: typeof r.body === 'string' ? r.body : '',
      publishedAt: typeof r.published_at === 'string' ? r.published_at : '',
      url: typeof r.html_url === 'string' ? r.html_url : '',
    })
  }
  releases.sort((a, b) => compareSemver(b.version, a.version))
  return { from, to, releases, checkedAt: Date.now() }
}

/** Fetch (or serve from cache) the release notes for `(from, to]`.
 *  Never throws — failures land in `result.error`. */
export async function getReleaseNotes(from: string, to: string): Promise<ReleaseNotesResult> {
  const key = `${from}|${to}`
  if (cache && cacheKey === key && Date.now() < cache.expiresAt) {
    return cache.result
  }
  const pending = inFlight.get(key)
  if (pending) return pending

  const p = (async () => {
    const result = await fetchReleases(from, to)
    const ttl = result.error ? FAILED_RETRY_MS : RELEASES_TTL_MS
    cacheKey = key
    cache = { result, expiresAt: Date.now() + ttl }
    if (result.error) {
      log.warn(`release notes fetch failed for ${from}→${to}: ${result.error}`)
    } else {
      log.debug(`release notes fetched for ${from}→${to}: ${result.releases.length} release(s)`)
    }
    return result
  })()
  inFlight.set(key, p)
  try {
    return await p
  } finally {
    inFlight.delete(key)
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run server/release-notes.test.ts`
Expected: PASS (7 tests). If the disabled-registry test fails on config leakage, check `__setConfigForTest` semantics in `server/config.ts` — restoring with the previous value (not `undefined`) may be required; mirror how `update-routes.test.ts` uses it.

- [ ] **Step 6: Commit**

```bash
git add shared/update-info.ts server/release-notes.ts server/release-notes.test.ts
git commit -m "feat(update): GitHub release-notes fetcher with range filter + cache"
```

---

### Task 2: Mount `GET /api/release-notes` route

**Files:**
- Modify: `server/routes/update-routes.ts` (add the route inside `buildUpdateRouter`, before the `POST /update` handler)
- Test: `server/routes/update-routes.test.ts` (append a describe block)

**Interfaces:**
- Consumes: `getReleaseNotes` from `../release-notes.js`; `parseSemver` from `../../shared/update-info.js`; `HttpError` from `../errors.js` (already imported); `config` (already imported).
- Produces: `GET /api/release-notes?from=<ver>&to=<ver>` → `ReleaseNotesResult` JSON; malformed params → 400 via `HttpError`.

- [ ] **Step 1: Append the failing route test**

In `server/routes/update-routes.test.ts`, append:

```ts
describe('GET /api/release-notes', () => {
  beforeEach(() => {
    __resetUpdateCheckerForTests()
    __setConfigForTest({ updateCheckRegistry: TEST_REGISTRY })
  })

  it('400s when from/to are missing or not semver', async () => {
    const app = makeApp()
    for (const qs of ['', '?from=x&to=0.8.0', '?from=0.7.0&to=y', '?from=0.7.0']) {
      const res = await app.request(`/release-notes${qs}`)
      expect(res.status).toBe(400)
    }
  })

  it('returns releases for a valid range', async () => {
    const { __resetReleaseNotesForTests } = await import('../release-notes.js')
    __resetReleaseNotesForTests()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify([
            {
              tag_name: 'v0.8.0',
              name: '0.8.0',
              body: 'notes',
              published_at: '2026-09-10T00:00:00Z',
              html_url: 'https://github.com/LoopGe/claude-react-web/releases/tag/v0.8.0',
              draft: false,
              prerelease: false,
            },
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    )
    const res = await makeApp().request('/release-notes?from=0.7.0&to=0.8.0')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.releases).toHaveLength(1)
    expect(body.releases[0].version).toBe('0.8.0')
    vi.unstubAllGlobals()
  })

  it('short-circuits with an error when update checks are disabled', async () => {
    __setConfigForTest({ updateCheckRegistry: '' })
    const { __resetReleaseNotesForTests } = await import('../release-notes.js')
    __resetReleaseNotesForTests()
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const res = await makeApp().request('/release-notes?from=0.7.0&to=0.8.0')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.releases).toEqual([])
    expect(body.error).toMatch(/not configured/i)
    expect(fetchSpy).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
    __setConfigForTest({ updateCheckRegistry: TEST_REGISTRY })
  })
})
```

Also add `parseSemver` is NOT needed in the route test file; the route module imports it. Ensure the top-of-file import of `__resetUpdateCheckerForTests` already exists (it does).

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run server/routes/update-routes.test.ts`
Expected: new describe block FAILS — route not mounted (404).

- [ ] **Step 3: Mount the route**

In `server/routes/update-routes.ts`:
1. Extend the existing import from `../update-checker.js` — no change needed there. Add:
   ```ts
   import { getReleaseNotes } from '../release-notes.js'
   import { parseSemver } from '../../shared/update-info.js'
   ```
   (`HttpError`, `config` are already imported; `UpdateInfo`/`UpdateActionResult` type import already exists — add `ReleaseNotesResult` only if referenced; the route just `c.json`s the result, so no type import is required.)
2. Inside `buildUpdateRouter`, after the `GET /update-info/versions` handler and before `POST /update`, add:

```ts
  // What's New release notes for the (from, to] version range. On-demand
  // (only fetched when the user opens the update dialog), so it has its own
  // cache in release-notes.ts. Failures resolve to `{ releases: [], error }`
  // — the dialog degrades to a version-only view; this route never 5xxs on
  // a GitHub hiccup.
  app.get('/release-notes', async (c) => {
    const from = c.req.query('from') ?? ''
    const to = c.req.query('to') ?? ''
    if (!parseSemver(from) || !parseSemver(to)) {
      throw new HttpError(400, 'from and to must be semver version strings')
    }
    return c.json(await getReleaseNotes(from, to))
  })
```

- [ ] **Step 4: Run the full update route suite**

Run: `npx vitest run server/routes/update-routes.test.ts server/release-notes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/routes/update-routes.ts server/routes/update-routes.test.ts
git commit -m "feat(update): GET /api/release-notes route"
```

---

### Task 3: Toast system — `onDismiss` callback

The nag must persist "user dismissed this version" when the sticky toast is closed (✕ or action-click auto-dismiss). The toast system has no per-toast dismissal callback today — add one.

**Files:**
- Modify: `src/hooks/toastContext.ts` (types)
- Modify: `src/components/ToastProvider.tsx` (fire the callback)
- Test: `src/components/ToastProvider.test.tsx` — **if this file does not exist, create it**; check first with `ls src/components/ToastProvider.test.tsx`. ToastHost.test.tsx exists; provider behaviour may be covered there — grep for `dismiss` in `ToastHost.test.tsx` and put new tests in whichever file already exercises `show`/`dismiss` (prefer extending the existing file; create `ToastProvider.test.tsx` only if none does).

**Interfaces:**
- Produces: `PushOptions.onDismiss?: () => void` and `Toast.onDismiss?: () to void` — called exactly once per toast, on the first `dismiss(id)` that transitions the toast to exiting (✕ click, action-click auto-dismiss, or auto-timeout). NOT called when the toast is evicted for capacity overflow (documented limitation).

- [ ] **Step 1: Write the failing tests**

```ts
it('calls onDismiss exactly once when the toast is dismissed', () => {
  const onDismiss = vi.fn()
  const { result } = renderHook(() => useToast(), { wrapper })
  act(() => {
    result.current.info('hello', { durationMs: 0, onDismiss })
  })
  const { result: listResult } = renderHook(() => useToastList(), { wrapper })
  const id = listResult.current[0].id
  act(() => result.current.dismiss(id))
  act(() => result.current.dismiss(id)) // second call is a no-op
  expect(onDismiss).toHaveBeenCalledTimes(1)
})

it('fires onDismiss on the auto-timeout path too', () => {
  vi.useFakeTimers()
  const onDismiss = vi.fn()
  const { result } = renderHook(() => useToast(), { wrapper })
  act(() => {
    result.current.info('bye', { durationMs: 1000, onDismiss })
  })
  act(() => {
    vi.advanceTimersByTime(1000)
  })
  expect(onDismiss).toHaveBeenCalledTimes(1)
  vi.useRealTimers()
})
```

(Use the wrapper/`renderHook` pattern already established in whichever toast test file you extended; if creating a new file, the wrapper is `({ children }) => <ToastProvider>{children}</ToastProvider>` with `// @vitest-environment jsdom` at the top.)

- [ ] **Step 2: Run to verify failure**

Run the toast test file. Expected: FAIL — `onDismiss` not a known option / never called.

- [ ] **Step 3: Implement**

In `src/hooks/toastContext.ts`:
- On `Toast`, add:
  ```ts
  /** Called exactly once when the toast is first dismissed (✕, action
   *  click, or auto-timeout). Not called on capacity eviction. */
  onDismiss?: () => void
  ```
- On `PushOptions`, add the same `onDismiss?: () => void` line.

In `src/components/ToastProvider.tsx` `show()`: destructure `const onDismiss = opts?.onDismiss` and include `onDismiss` in the object literal passed to `commitToasts` (line ~131).

In `dismiss()` (lines 78–92), after the `hasToast` guard, fire the callback before flipping `exiting`:

```ts
const toast = toastsRef.current.find((t) => t.id === id && !t.exiting)
if (!toast) return
// Fire once: the exiting guard above means a second dismiss(id) for the
// same toast short-circuits here.
toast.onDismiss?.()
commitToasts(toastsRef.current.map((t) => (t.id === id ? { ...t, exiting: true } : t)))
```

(Replace the existing `hasToast` boolean + `commitToasts` block with the `find` version — same semantics, plus callback access.)

- [ ] **Step 4: Run to verify pass + full client toast suite**

Run: `npx vitest run src/components/ToastHost.test.tsx src/components/ToastProvider.test.tsx` (whichever exist)
Expected: PASS, no regressions.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/toastContext.ts src/components/ToastProvider.tsx src/components/ToastProvider.test.tsx src/components/ToastHost.test.tsx
# (stage only the test files you actually touched)
git commit -m "feat(toast): per-toast onDismiss callback"
```

---

### Task 4: Shared `reportUpdateResult` helper + About tab adoption

**Files:**
- Create: `src/utils/update-action.ts`
- Modify: `src/components/GlobalSettingsModal.tsx` (`AboutTab.runUpdate`, ~lines 1771–1802)

**Interfaces:**
- Consumes: `UpdateActionResult` from `shared/update-info`; the `useToast()` handle shape (`error/success/info(message, opts?)`).
- Produces:
  ```ts
  // src/utils/update-action.ts
  export function reportUpdateResult(
    toast: { success: (m: string) => void; info: (m: string) => void },
    res: UpdateActionResult,
  ): void
  ```
  Later tasks (UpdateDialog) call exactly this.

- [ ] **Step 1: Create `src/utils/update-action.ts`**

```ts
// Shared result handling for the in-app update action (POST /api/update).
// One place decides which toast fires for which UpdateActionResult so the
// What's New dialog and the About tab can't drift. (The old UpdateBanner
// duplicate dies with the banner.)

import type { UpdateActionResult } from '../../shared/update-info'

/** Minimal toast surface used — matches the success/info members of the
 *  useToast() handle. */
interface ToastLike {
  success: (message: string) => void
  info: (message: string) => void
}

export function reportUpdateResult(toast: ToastLike, res: UpdateActionResult): void {
  if (!res.performed) {
    // Server declined to install (npx / unknown) — point at the copy-command.
    toast.info("In-app update isn't available for this install — copy the command instead.")
    return
  }
  if (res.updateApplied) {
    // The on-disk package was verifiably upgraded — a restart applies it.
    toast.success(
      `Installed ${res.installedVersion ?? res.latest ?? 'the latest version'} on disk — restart the server to apply.`,
    )
    return
  }
  toast.info(
    res.installedVersion
      ? `Already on the latest version (${res.installedVersion}).`
      : 'Install completed, but the new version could not be confirmed on disk.',
  )
}
```

- [ ] **Step 2: Adopt it in `AboutTab.runUpdate`**

Replace the body of `runUpdate` in `GlobalSettingsModal.tsx` (the function starting `const runUpdate = async () => {` around line 1771) with:

```ts
  const runUpdate = async () => {
    if (!onUpdate) return
    setUpdateError(null)
    try {
      const res = await onUpdate()
      reportUpdateResult(toast, res)
      // Refresh the update-info snapshot either way (no-op installs still
      // refresh `checkedAt` / `installed` overlays) — preserves the old
      // About-tab behaviour of re-probing after any performed install.
      if (res.performed) onRefresh?.()
    } catch (e) {
      setUpdateError(e instanceof Error ? e.message : String(e))
    }
  }
```

Add `import { reportUpdateResult } from '../utils/update-action'` at the top of the file.

Note: the previous About-tab copy for the declined branch used "copy the command below."; the unified helper says "copy the command instead." — accepted copy unification per spec §3.

- [ ] **Step 3: Verify**

Run: `npx vitest run src/components/GlobalSettingsModal.test.tsx`
Expected: PASS (or unchanged failures — fix any test asserting the old declined-branch copy by pointing it at the new string).

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/utils/update-action.ts src/components/GlobalSettingsModal.tsx src/components/GlobalSettingsModal.test.tsx
git commit -m "refactor(update): shared reportUpdateResult helper (About tab adopts)"
```

---

### Task 5: `useReleaseNotes` hook

**Files:**
- Create: `src/hooks/useReleaseNotes.ts`
- Test: `src/hooks/useReleaseNotes.test.ts`

**Interfaces:**
- Consumes: `api` from `./useApi`; `ReleaseNote`, `ReleaseNotesResult` from `../../shared/update-info`.
- Produces:
  ```ts
  export function useReleaseNotes(
    enabled: boolean,
    from: string | undefined,
    to: string | undefined,
  ): { releases: ReleaseNote[] | null; loading: boolean; error: string | null }
  ```
  Fetches `GET /api/release-notes?from=…&to=…` when `enabled && from && to`. No fetch while disabled. Concurrent calls with the same args join the in-flight request. Aborts on unmount / arg change.

- [ ] **Step 1: Write the failing test**

```ts
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'

import { useReleaseNotes } from './useReleaseNotes'

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }))
vi.mock('./useApi', () => ({
  api: { get: (path: string, opts?: unknown) => apiGet(path, opts) },
}))

const NOTES = {
  from: '0.7.2',
  to: '0.8.0',
  releases: [
    { version: '0.8.0', name: '0.8.0', body: 'notes', publishedAt: '2026-09-10T00:00:00Z', url: 'https://example.com' },
  ],
}

describe('useReleaseNotes', () => {
  beforeEach(() => {
    apiGet.mockReset()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('does not fetch while disabled', () => {
    renderHook(() => useReleaseNotes(false, '0.7.2', '0.8.0'))
    expect(apiGet).not.toHaveBeenCalled()
  })

  it('fetches on enable and exposes releases', async () => {
    apiGet.mockResolvedValue(NOTES)
    const { result } = renderHook(() => useReleaseNotes(true, '0.7.2', '0.8.0'))
    expect(result.current.loading).toBe(true)
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(apiGet).toHaveBeenCalledWith('/release-notes?from=0.7.2&to=0.8.0', expect.anything())
    expect(result.current.releases).toEqual(NOTES.releases)
    expect(result.current.error).toBeNull()
  })

  it('surfaces a failure as error with null releases', async () => {
    apiGet.mockRejectedValue(new Error('boom'))
    const { result } = renderHook(() => useReleaseNotes(true, '0.7.2', '0.8.0'))
    await waitFor(() => expect(result.current.error).toBe('boom'))
    expect(result.current.releases).toBeNull()
  })

  it('does not fetch when from/to are missing', () => {
    renderHook(() => useReleaseNotes(true, undefined, '0.8.0'))
    expect(apiGet).not.toHaveBeenCalled()
  })

  it('coalesces concurrent mounts into one request', async () => {
    let resolve!: (v: unknown) => void
    apiGet.mockImplementation(() => new Promise((r) => { resolve = r }))
    const h1 = renderHook(() => useReleaseNotes(true, '0.7.2', '0.8.0'))
    const h2 = renderHook(() => useReleaseNotes(true, '0.7.2', '0.8.0'))
    act(() => resolve(NOTES))
    await waitFor(() => {
      expect(h1.result.current.loading).toBe(false)
      expect(h2.result.current.loading).toBe(false)
    })
    expect(apiGet).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/hooks/useReleaseNotes.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `src/hooks/useReleaseNotes.ts`**

```ts
// Fetch-on-open release notes for the What's New dialog. Mirrors the
// in-flight coalescing of useUpdateInfo: rapid re-mounts (dialog toggle,
// StrictMode) share one request. Abort on unmount / arg change so a slow
// GitHub response can't setState after teardown.

import { useEffect, useState } from 'react'
import { api } from './useApi'
import type { ReleaseNote } from '../../shared/update-info'

export function useReleaseNotes(
  enabled: boolean,
  from: string | undefined,
  to: string | undefined,
): { releases: ReleaseNote[] | null; loading: boolean; error: string | null } {
  const [releases, setReleases] = useState<ReleaseNote[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!enabled || !from || !to) return
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    api
      .get<{ releases: ReleaseNote[]; error?: string }>(
        `/release-notes?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
        { signal: controller.signal },
      )
      .then((next) => {
        if (controller.signal.aborted) return
        // A server-side degradation (GitHub down) arrives 200 + error;
        // surface it in the same slot as a transport failure.
        setReleases(next.releases)
        if (next.error) setError(next.error)
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [enabled, from, to])

  return { releases, loading, error }
}
```

Note on coalescing: two hook instances fire two effects → two `api.get` calls. The SERVER dedupes in-flight fetches (Task 1), so the network is still one request; the test's "one request" assertion therefore needs adjusting — keep per-instance fetches but assert the server dedupes (already covered in Task 1). **Change the coalescing test** to: two instances each call `apiGet` (2 hook-level calls) but both settle to the same data — drop the `toHaveBeenCalledTimes(1)` assertion and instead assert both hooks expose `NOTES.releases`. Server-level dedupe is the authoritative guarantee.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/hooks/useReleaseNotes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useReleaseNotes.ts src/hooks/useReleaseNotes.test.ts
git commit -m "feat(update): useReleaseNotes fetch-on-open hook"
```

---

### Task 6: `UpdateDialog` component + CSS

**Files:**
- Create: `src/components/UpdateDialog.tsx`
- Create: `src/styles/update-dialog.css`
- Modify: `src/styles/index.css` (add `@import './update-dialog.css';` next to the uploads-manager import, line ~12)
- Test: `src/components/UpdateDialog.test.tsx`

**Interfaces:**
- Consumes: `Overlay` (`variant="perm"`, props `{ open, onClose, ariaLabel, cardClassName }` — see `UploadsManagerDialog.tsx:107`); `Markdown` (`<Markdown text={body} breaks />` — `src/components/Markdown.tsx:181`); `useReleaseNotes` (Task 5); `reportUpdateResult` (Task 4); `buildUpgradeCommand` (`src/utils/upgrade-command.ts`); `isUpdateNagNeeded` / `isUpdateAppliedToDisk` / `isVersionNewer` from `shared/update-info`; icons `IconX`, `IconCheck`, `IconAlertTriangle` from `./icons/ToolIcons`.
- Produces:
  ```ts
  export type UpdateDialogMode = 'update' | 'deprecation'
  export function UpdateDialog(props: {
    open: boolean
    mode: UpdateDialogMode
    info: UpdateInfo
    updating: boolean
    onUpdate: () => Promise<UpdateActionResult>
    onClose: () => void       // ALWAYS the single close path — App uses it to write the dismiss key
  }): JSX.Element
  ```
  App (Task 8) mounts exactly this. (`UpdateDialogMode` and Task 7's
  `UpdateNagMode` are intentionally two standalone aliases of the same
  union — TypeScript's structural typing makes them interchangeable, and
  each file staying self-contained keeps the tasks independently
  executable.)

- [ ] **Step 1: Write the failing tests**

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { UpdateDialog } from './UpdateDialog'
import type { UpdateInfo } from '../../shared/update-info'

const { getNotes } = vi.hoisted(() => ({ getNotes: vi.fn() }))
vi.mock('../hooks/useReleaseNotes', () => ({
  useReleaseNotes: (enabled: boolean) =>
    enabled
      ? { releases: getNotes(), loading: false, error: null }
      : { releases: null, loading: false, error: null },
}))

afterEach(() => {
  cleanup()
  localStorage.clear()
})

function baseInfo(over: Partial<UpdateInfo> = {}): UpdateInfo {
  return {
    current: '0.7.2',
    installed: '0.7.2',
    packageName: 'claude-react-web',
    installMethod: 'global',
    registry: undefined,
    latest: '0.8.0',
    hasUpdate: true,
    updateAppliedToDisk: false,
    source: 'npm',
    checkedAt: 1,
    ...over,
  }
}

function baseProps(over: Partial<React.ComponentProps<typeof UpdateDialog>> = {}) {
  return {
    open: true,
    mode: 'update' as const,
    info: baseInfo(),
    updating: false,
    onUpdate: vi.fn(async () => ({
      performed: true,
      installMethod: 'global' as const,
      restartRequired: true,
      updateApplied: true,
      installedVersion: '0.8.0',
      versionChanged: true,
    })),
    onClose: vi.fn(),
    ...over,
  }
}

const NOTE = {
  version: '0.8.0',
  name: '0.8.0',
  body: '## Added\n- shiny thing',
  publishedAt: '2026-09-10T00:00:00Z',
  url: 'https://github.com/LoopGe/claude-react-web/releases/tag/v0.8.0',
}

describe('UpdateDialog', () => {
  beforeEach(() => {
    getNotes.mockReset()
    getNotes.mockReturnValue([NOTE])
  })

  it('renders header, release sections, and footer buttons', () => {
    const { getByRole, getByText } = render(<UpdateDialog {...baseProps()} />)
    expect(getByRole('dialog')).toBeTruthy()
    expect(getByText(/What's new in 0\.8\.0/)).toBeTruthy()
    expect(getByText('0.8.0 · 2026-09-10')).toBeTruthy()
    expect(getByText('Update now')).toBeTruthy()
    expect(getByText('Copy command')).toBeTruthy()
    expect(getByText('Later')).toBeTruthy()
  })

  it('hides Update now for npx installs', () => {
    const { queryByText } = render(
      <UpdateDialog {...baseProps({ info: baseInfo({ installMethod: 'npx' }) })} />,
    )
    expect(queryByText('Update now')).toBeNull()
    expect(getByTextSafe(queryByText, 'Copy command')).toBeTruthy()
  })
  function getByTextSafe(query: (t: string) => HTMLElement | null, t: string) {
    return query(t)
  }

  it('runs the update on Update now, then closes on success', async () => {
    const onUpdate = vi.fn(async () => ({
      performed: true,
      installMethod: 'global' as const,
      restartRequired: true,
      updateApplied: true,
      installedVersion: '0.8.0',
      versionChanged: true,
    }))
    const onClose = vi.fn()
    const { getByText } = render(<UpdateDialog {...baseProps({ onUpdate, onClose })} />)
    fireEvent.click(getByText('Update now'))
    await waitFor(() => expect(onUpdate).toHaveBeenCalledOnce())
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
  })

  it('keeps the dialog open when the update throws', async () => {
    const onUpdate = vi.fn(async () => {
      throw new Error('npm exploded')
    })
    const onClose = vi.fn()
    const { getByText } = render(<UpdateDialog {...baseProps({ onUpdate, onClose })} />)
    fireEvent.click(getByText('Update now'))
    await waitFor(() => expect(getByText(/npm exploded/)).toBeTruthy())
    expect(onClose).not.toHaveBeenCalled()
  })

  it('Later calls onClose', () => {
    const onClose = vi.fn()
    const { getByText } = render(<UpdateDialog {...baseProps({ onClose })} />)
    fireEvent.click(getByText('Later'))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('renders deprecation mode copy', () => {
    const { getByText } = render(
      <UpdateDialog
        {...baseProps({
          mode: 'deprecation',
          info: baseInfo({ deprecated: 'Use 0.9 instead.', latest: undefined, hasUpdate: false }),
        })}
      />,
    )
    expect(getByText(/Version 0\.7\.2 is deprecated/)).toBeTruthy()
    expect(getByText('Use 0.9 instead.')).toBeTruthy()
    expect(getByText('Update now')).toBeTruthy() // global install, latest unknown → still upgradeable via copy
  })

  it('shows the notes-unavailable note when there are no releases', () => {
    getNotes.mockReturnValue([])
    const { getByText } = render(<UpdateDialog {...baseProps()} />)
    expect(getByText(/Release notes are unavailable/)).toBeTruthy()
  })

  it('copies the upgrade command and flips to Copied', async () => {
    const writeText = vi.fn(async () => {})
    Object.assign(navigator, { clipboard: { writeText } })
    const { getByText } = render(
      <UpdateDialog {...baseProps({ info: baseInfo({ installMethod: 'npx' }) })} />,
    )
    fireEvent.click(getByText('Copy command'))
    expect(writeText).toHaveBeenCalledWith('npx claude-react-web@latest')
    await waitFor(() => expect(getByText('Copied')).toBeTruthy())
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/components/UpdateDialog.test.tsx`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `src/styles/update-dialog.css`**

```css
/* What's New dialog — scoped layout only; chrome (backdrop/card/buttons)
 * comes from the shared perm-overlay / modal-header / modal-footer sheets.
 * Every colour is a theme CSS variable (CLAUDE.md rule). */

.update-dialog-card {
  width: min(560px, calc(100vw - 32px));
  max-height: min(80vh, 720px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.update-dialog-body {
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 4px 20px 12px;
}

.update-dialog-deprecation {
  margin: 8px 0 0;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--btn-hover-bg);
  color: var(--fg-muted);
  font-size: 12.5px;
  display: flex;
  gap: 8px;
  align-items: flex-start;
}

.update-dialog-release {
  padding: 10px 0;
}

.update-dialog-release + .update-dialog-release {
  border-top: 1px solid var(--border-color, var(--btn-hover-bg));
}

.update-dialog-release-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 6px;
}

.update-dialog-release-version {
  font-weight: 600;
  font-size: 13.5px;
  color: var(--fg);
}

.update-dialog-release-date {
  font-size: 12px;
  color: var(--fg-muted);
}

.update-dialog-release-link {
  font-size: 12px;
  color: var(--fg-muted);
}

.update-dialog-empty {
  padding: 24px 8px;
  text-align: center;
  color: var(--fg-muted);
  font-size: 13px;
}

.update-dialog-loading {
  padding: 28px 8px;
  display: flex;
  justify-content: center;
  color: var(--fg-muted);
}

.update-dialog-footer {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 20px;
  border-top: 1px solid var(--btn-hover-bg);
  flex: 0 0 auto;
}

.update-dialog-footer-spacer {
  flex: 1 1 auto;
}

.update-dialog-error {
  font-size: 12px;
  color: var(--fg);
  background: var(--btn-hover-bg);
  border-radius: 6px;
  padding: 4px 8px;
}

.update-dialog-cmd {
  font-size: 11.5px;
  color: var(--fg-muted);
  background: var(--btn-hover-bg);
  border-radius: 6px;
  padding: 3px 8px;
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

[data-theme='light'] .update-dialog-card {
  /* light-theme overrides only if the perm-card sheet needs them — add a
   * variable here ONLY if a visual regression shows up; tokens.css should
   * already cover the palette via the shared variables used above. */
}
```

In `src/styles/index.css`, after `@import './uploads-manager.css';` add:

```css
@import './update-dialog.css';
```

- [ ] **Step 4: Implement `src/components/UpdateDialog.tsx`**

```tsx
// What's New dialog — the action surface behind the update nag toast.
//
// Shell reuses the Overlay 'perm' variant (same as UploadsManagerDialog):
// dark/light theming comes from the shared sheets; only layout lives in
// update-dialog.css. Fetches release notes on open via useReleaseNotes.
//
// The single close path is props.onClose — the App host writes the nag
// dismissal key there, so every closure (Later, backdrop, Escape, a
// successful update) counts as "seen" and the toast never re-nags this
// version.

import { useState } from 'react'
import { Overlay } from './Overlay'
import { Markdown } from './Markdown'
import { useReleaseNotes } from '../hooks/useReleaseNotes'
import { useToast } from '../hooks/useToast'
import { reportUpdateResult } from '../utils/update-action'
import { buildUpgradeCommand } from '../utils/upgrade-command'
import { isVersionNewer, type UpdateActionResult, type UpdateInfo } from '../../shared/update-info'
import { IconX, IconCheck, IconAlertTriangle } from './icons/ToolIcons'

export type UpdateDialogMode = 'update' | 'deprecation'

interface Props {
  open: boolean
  mode: UpdateDialogMode
  info: UpdateInfo
  updating: boolean
  onUpdate: () => Promise<UpdateActionResult>
  onClose: () => void
}

/** "2026-09-10" from an ISO timestamp — enough precision for a release
 *  header; the full timestamp stays in the title tooltip. */
function dateShort(iso: string): string {
  return iso.slice(0, 10)
}

export function UpdateDialog({ open, mode, info, updating, onUpdate, onClose }: Props) {
  const toast = useToast()
  const { releases, loading, error } = useReleaseNotes(open, info.current, info.latest)
  const [updateError, setUpdateError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const latest = info.latest
  const deprecationMsg =
    typeof info.deprecated === 'string'
      ? info.deprecated
      : 'This version has been deprecated by the maintainer.'
  // Upgrade controls only when there's a strictly newer version to go to —
  // mirrors UpdateBanner's old `latest && latest !== current` gate (a bare
  // inequality would also fire on a downgrade; isVersionNewer is the same
  // comparison the rest of the update stack uses).
  const upgradeable = !!latest && isVersionNewer(info.current, latest)
  // In-app update only for global installs (npx/dev fall back to the
  // copy-command) — mirrors the About-tab gate.
  const canUpdateInApp = upgradeable && info.installMethod === 'global'

  const runUpdate = async () => {
    setUpdateError(null)
    try {
      const res = await onUpdate()
      reportUpdateResult(toast, res)
      if (res.performed && res.updateApplied) {
        onClose()
        return
      }
      // no-op / declined / unconfirmed → stay open so the user still has
      // the notes + copy-command in front of them.
    } catch (e) {
      setUpdateError(e instanceof Error ? e.message : String(e))
    }
  }

  const copyCommand = () => {
    if (!navigator.clipboard) return
    const cmd = buildUpgradeCommand(info.packageName, info.registry)
    navigator.clipboard.writeText(cmd).then(
      () => {
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      },
      (err: unknown) => {
        console.warn('clipboard write failed:', err)
      },
    )
  }

  const headerTitle =
    mode === 'deprecation'
      ? `Version ${info.current} is deprecated`
      : `What's new in ${latest ?? info.current}`

  return (
    <Overlay
      variant="perm"
      open={open}
      onClose={onClose}
      ariaLabel={headerTitle}
      cardClassName="update-dialog-card"
    >
      <div className="modal-header">
        <h3>
          {mode === 'deprecation' && <IconAlertTriangle size={16} aria-hidden />}
          {headerTitle}
        </h3>
        <button type="button" className="btn btn-icon" onClick={onClose} aria-label="Close">
          <IconX size={16} />
        </button>
      </div>

      <div className="update-dialog-body">
        {mode === 'deprecation' && (
          <div className="update-dialog-deprecation">
            <IconAlertTriangle size={14} aria-hidden />
            <span>{deprecationMsg}</span>
          </div>
        )}

        {loading && <div className="update-dialog-loading">Loading release notes…</div>}

        {!loading && releases && releases.length === 0 && (
          <p className="update-dialog-empty">
            {error
              ? `Release notes are unavailable right now (${error}).`
              : 'Release notes are unavailable right now.'}
          </p>
        )}

        {!loading &&
          releases?.map((r) => (
            <section key={r.version} className="update-dialog-release">
              <div className="update-dialog-release-head">
                <span className="update-dialog-release-version">{r.name || r.version}</span>
                {r.publishedAt && (
                  <span className="update-dialog-release-date">{dateShort(r.publishedAt)}</span>
                )}
                {r.url && (
                  <a
                    className="update-dialog-release-link"
                    href={r.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    GitHub
                  </a>
                )}
              </div>
              {r.body && <Markdown text={r.body} breaks />}
            </section>
          ))}
      </div>

      <div className="update-dialog-footer">
        {canUpdateInApp && (
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void runUpdate()}
            disabled={updating}
          >
            {updating ? 'Updating…' : 'Update now'}
          </button>
        )}
        <button type="button" className="btn" onClick={copyCommand} title="Copy upgrade command">
          {copied ? (
            <>
              <IconCheck size={12} aria-hidden /> Copied
            </>
          ) : (
            'Copy command'
          )}
        </button>
        <code className="update-dialog-cmd">
          {buildUpgradeCommand(info.packageName, info.registry)}
        </code>
        <span className="update-dialog-footer-spacer" />
        {updateError && <span className="update-dialog-error">{updateError}</span>}
        <button type="button" className="btn" onClick={onClose}>
          Later
        </button>
      </div>
    </Overlay>
  )
}
```

(`console.warn` in the clipboard rejection is the established client pattern — `UpdateBanner.tsx` did the same; it is user-facing fallback noise, not diagnostics. Keep it.)

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run src/components/UpdateDialog.test.tsx`
Expected: PASS. If the deprecation test's `getByText('Update now')` fails because `latest: undefined` makes `upgradeable` false — that is CORRECT behaviour (no newer version ⇒ no upgrade CTA). Fix the TEST: deprecation with `latest: undefined` should assert `queryByText('Update now')` is null and 'Copy command' is present; add a second deprecation case with `latest: '0.9.0'` asserting 'Update now' IS shown.

- [ ] **Step 6: Commit**

```bash
git add src/components/UpdateDialog.tsx src/components/UpdateDialog.test.tsx src/styles/update-dialog.css src/styles/index.css
git commit -m "feat(update): What's New dialog with release-notes rendering"
```

---

### Task 7: `useUpdateNag` hook (toast trigger + dismiss persistence)

**Files:**
- Create: `src/hooks/useUpdateNag.ts`
- Test: `src/hooks/useUpdateNag.test.ts`

**Interfaces:**
- Consumes: `useToast`; `isUpdateNagNeeded`, `isUpdateAppliedToDisk`, `type UpdateInfo` from `shared/update-info`.
- Produces:
  ```ts
  export const NAG_DISMISS_STORAGE_KEY = 'claude-react-web:update-nag-dismissed-version'
  export type UpdateNagMode = 'update' | 'deprecation'
  /** Value written for the update nag (the offered latest version). */
  export function nagValueForUpdate(latest: string): string
  /** Value written for the deprecation nag. */
  export function nagValueForDeprecated(current: string): string  // `deprecated:${current}`
  /** Read the persisted dismissal (null when none / storage unavailable). */
  export function readNagDismiss(): string | null
  /** Persist a dismissal — safe no-op when localStorage throws. */
  export function writeNagDismiss(value: string): void
  /** Push at most one sticky nag toast per version. App calls this with the
   *  shared updateInfo; onOpenDialog opens the What's New dialog. */
  export function useUpdateNag(
    info: UpdateInfo | null,
    onOpenDialog: (mode: UpdateNagMode) => void,
  ): void
  ```
  App (Task 8) calls `useUpdateNag` and reuses `nagValueForUpdate` / `nagValueForDeprecated` / `writeNagDismiss` in the dialog's onClose.

- [ ] **Step 1: Write the failing test**

```tsx
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { ReactNode } from 'react'
import { ToastProvider } from '../components/ToastProvider'
import { useToastList } from './useToast'
import {
  NAG_DISMISS_STORAGE_KEY,
  nagValueForUpdate,
  readNagDismiss,
  writeNagDismiss,
  useUpdateNag,
} from './useUpdateNag'
import type { UpdateInfo } from '../../shared/update-info'

function wrapper({ children }: { children: ReactNode }) {
  return <ToastProvider>{children}</ToastProvider>
}

function baseInfo(over: Partial<UpdateInfo> = {}): UpdateInfo {
  return {
    current: '0.7.2',
    packageName: 'claude-react-web',
    installMethod: 'global',
    latest: '0.8.0',
    hasUpdate: true,
    updateAppliedToDisk: false,
    source: 'npm',
    checkedAt: 1,
    ...over,
  }
}

function useHarness(info: UpdateInfo | null, onOpenDialog = vi.fn()) {
  const nag = renderHook(() => {
    useUpdateNag(info, onOpenDialog)
    return useToastList()
  }, { wrapper })
  return { ...nag, onOpenDialog }
}

describe('useUpdateNag', () => {
  beforeEach(() => {
    localStorage.clear()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('pushes a sticky update toast when a newer version exists', () => {
    const { result } = useHarness(baseInfo())
    expect(result.current).toHaveLength(1)
    const t = result.current[0]
    expect(t.title).toBe('New version available')
    expect(t.message).toContain('0.7.2')
    expect(t.message).toContain('0.8.0')
    expect(t.actionLabel).toBe('Update')
    expect(t.durationMs).toBe(0) // sticky
  })

  it('does not push when isUpdateNagNeeded is false (update on disk)', () => {
    const { result } = useHarness(baseInfo({ updateAppliedToDisk: true }))
    expect(result.current).toHaveLength(0)
  })

  it('does not push while checking', () => {
    const { result } = useHarness(baseInfo({ checking: true }))
    expect(result.current).toHaveLength(0)
  })

  it('does not push when the version was already dismissed', () => {
    writeNagDismiss(nagValueForUpdate('0.8.0'))
    const { result } = useHarness(baseInfo())
    expect(result.current).toHaveLength(0)
  })

  it('re-notifies when a newer latest appears', () => {
    writeNagDismiss(nagValueForUpdate('0.8.0'))
    const { result } = useHarness(baseInfo({ latest: '0.9.0' }))
    expect(result.current).toHaveLength(1)
    expect(result.current[0].message).toContain('0.9.0')
  })

  it('dedupes StrictMode-style double invocation (one toast)', () => {
    const info = baseInfo()
    function Double() {
      useUpdateNag(info, vi.fn())
      useUpdateNag(info, vi.fn())
      return null
    }
    const { container } = render(<Double />, { wrapper })
    void container
    // Both hook instances share no state — each pushes once. That's TWO
    // toasts, which is wrong for two independent callers but correct for
    // one caller double-invoked (App mounts the hook exactly once).
    // The dedup that matters is per-hook-instance effect re-runs; assert
    // that via the single-instance path:
    const { result } = useHarness(info)
    expect(result.current).toHaveLength(1)
  })

  it('action click opens the dialog and dismissal persists the key', () => {
    const onOpenDialog = vi.fn()
    const { result } = useHarness(baseInfo(), onOpenDialog)
    const t = result.current[0]
    act(() => {
      t.onClick?.()
    })
    expect(onOpenDialog).toHaveBeenCalledWith('update')
    // The provider auto-dismisses after an action click → onDismiss fires →
    // key persisted.
    expect(readNagDismiss()).toBe('0.8.0')
  })

  it('toast ✕ (dismiss) persists the key', () => {
    const { result } = useHarness(baseInfo())
    const t = result.current[0]
    act(() => {
      t.onDismiss?.() // simulate the provider firing the callback on ✕
    })
    expect(readNagDismiss()).toBe('0.8.0')
  })

  it('deprecation nag uses the deprecated sentinel and copy', () => {
    const { result } = useHarness(
      baseInfo({ latest: undefined, hasUpdate: false, deprecated: 'Use 0.9.' }),
    )
    expect(result.current).toHaveLength(1)
    expect(result.current[0].title).toBe('Version 0.7.2 is deprecated')
    expect(result.current[0].message).toBe('Use 0.9.')
    act(() => {
      result.current[0].onClick?.()
    })
    expect(readNagDismiss()).toBe('deprecated:0.7.2')
  })

  it('update nag wins when both update and deprecation apply', () => {
    const { result } = useHarness(
      baseInfo({ deprecated: 'old' }), // latest 0.8.0 > current → update branch first
    )
    expect(result.current).toHaveLength(1)
    expect(result.current[0].title).toBe('New version available')
  })
})
```

The "dedupes StrictMode" test above is muddled — **replace it** with a cleaner re-run check:

```ts
  it('does not re-push on an info identity change with the same values', () => {
    const { result, rerender } = renderHook(
      ({ info }: { info: UpdateInfo }) => {
        useUpdateNag(info, vi.fn())
        return useToastList()
      },
      { wrapper, initialProps: { info: baseInfo() } },
    )
    expect(result.current).toHaveLength(1)
    rerender({ info: baseInfo({ latest: '0.8.0' }) }) // new object, same version
    expect(result.current).toHaveLength(1)
  })
```

Import `render` only if the Double test is kept; prefer the replacement above and drop the Double test entirely.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/hooks/useUpdateNag.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `src/hooks/useUpdateNag.ts`**

```ts
// Proactive update nag — pushes ONE sticky toast per offered version.
//
// Gates (mandatory, see shared/update-info.ts):
//   - update branch:  isUpdateNagNeeded(info)  (suppresses once an in-app
//     update is on disk pending restart — hasUpdate alone re-nags every tab)
//   - deprecation branch: info.deprecated && !isUpdateAppliedToDisk(info)
//
// Persistence: localStorage NAG_DISMISS_STORAGE_KEY holds the dismissed
// value — the offered `latest` for the update branch, `deprecated:<current>`
// for the deprecation branch. A newer `latest` (or a new deprecation target)
// differs from the stored value → re-notify. The toast's onDismiss callback
// writes the key on ANY dismissal (✕, action-click auto-dismiss); the App
// host also writes it when the dialog closes — one nag per version, any
// closure counts as "seen".
//
// Per-mount dedup: toastedRef remembers the value already pushed by THIS
// hook instance so effect re-runs (info identity churn, StrictMode double
// invoke) can't stack toasts. Cross-tab dedup is the localStorage key.

import { useCallback, useEffect, useRef } from 'react'
import { useToast } from './useToast'
import { isUpdateAppliedToDisk, isUpdateNagNeeded, type UpdateInfo } from '../../shared/update-info'

export const NAG_DISMISS_STORAGE_KEY = 'claude-react-web:update-nag-dismissed-version'

export type UpdateNagMode = 'update' | 'deprecation'

export function nagValueForUpdate(latest: string): string {
  return latest
}

export function nagValueForDeprecated(current: string): string {
  return `deprecated:${current}`
}

export function readNagDismiss(): string | null {
  try {
    return localStorage.getItem(NAG_DISMISS_STORAGE_KEY)
  } catch {
    return null
  }
}

export function writeNagDismiss(value: string): void {
  try {
    localStorage.setItem(NAG_DISMISS_STORAGE_KEY, value)
  } catch {
    /* private-mode / quota — the per-mount ref still suppresses this tab. */
  }
}

export function useUpdateNag(
  info: UpdateInfo | null,
  onOpenDialog: (mode: UpdateNagMode) => void,
): void {
  const toast = useToast()
  // Stable identity so the effect doesn't re-run (and re-push) when the
  // caller's inline arrow changes every render.
  const onOpenRef = useRef(onOpenDialog)
  onOpenRef.current = onOpenDialog
  const toastedRef = useRef<string | null>(null)

  useEffect(() => {
    if (!info || info.checking) return

    // Update branch wins over deprecation: upgrading escapes a deprecation,
    // so nagging both at once is redundant noise.
    if (isUpdateNagNeeded(info) && info.latest) {
      const value = nagValueForUpdate(info.latest)
      if (toastedRef.current === value) return
      if (readNagDismiss() === value) return
      toastedRef.current = value
      toast.show('info', `${info.current} → ${info.latest} — see what changed`, {
        title: 'New version available',
        durationMs: 0, // sticky — the only proactive surface now that the banner is gone
        actionLabel: 'Update',
        onClick: () => {
          writeNagDismiss(value)
          onOpenRef.current('update')
        },
        onDismiss: () => writeNagDismiss(value),
      })
      return
    }

    if (info.deprecated && !isUpdateAppliedToDisk(info)) {
      const value = nagValueForDeprecated(info.current)
      if (toastedRef.current === value) return
      if (readNagDismiss() === value) return
      toastedRef.current = value
      const message =
        typeof info.deprecated === 'string'
          ? info.deprecated
          : 'This version has been deprecated by the maintainer.'
      toast.show('info', message, {
        title: `Version ${info.current} is deprecated`,
        durationMs: 0,
        actionLabel: 'Update',
        onClick: () => {
          writeNagDismiss(value)
          onOpenRef.current('deprecation')
        },
        onDismiss: () => writeNagDismiss(value),
      })
    }
  }, [info, toast])
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/hooks/useUpdateNag.test.ts`
Expected: PASS. If the action-click test fails because the provider's auto-dismiss defers `onDismiss` via the 180 ms exit timer — check Task 3's implementation: `onDismiss` must fire inside `dismiss()` synchronously (before the exit timeout), not in `removeNow`. Adjust Task 3 if needed.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useUpdateNag.ts src/hooks/useUpdateNag.test.ts
git commit -m "feat(update): useUpdateNag sticky toast trigger with per-version dismissal"
```

---

### Task 8: App wiring — mount nag + dialog, delete the banner

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/components/GlobalSettingsModal.tsx` — **no change** (already adopted the helper in Task 4)
- Delete: `src/components/UpdateBanner.tsx`
- Modify: `src/styles/layout.css` (remove the `.update-banner*` blocks)

**Interfaces:**
- Consumes: `useUpdateNag`, `nagValueForUpdate`, `nagValueForDeprecated`, `writeNagDismiss` (Task 7); `UpdateDialog`, `UpdateDialogMode` (Task 6); `useUpdateInfo` (existing).
- Produces: the finished user flow. Nothing consumes this task.

- [ ] **Step 1: Remove the banner**

In `src/App.tsx`:
1. Delete the import `import { UpdateBanner } from './components/UpdateBanner'` (line ~45).
2. Delete the JSX block (lines ~3895–3899):
   ```tsx
   <UpdateBanner
     info={updateInfo.info}
     updating={updateInfo.updating}
     onUpdate={updateInfo.update}
   />
   ```
3. Delete `src/components/UpdateBanner.tsx`.
4. In `src/styles/layout.css`, delete every `.update-banner…` rule block (grep `update-banner` to find them all — header, icon, text, btn, btn-ghost, close, cmd, copied-pop if banner-scoped, and the `-deprecated` variant). Do NOT delete `.copied-pop` if it is shared with other components — grep `copied-pop` across `src/` first; the About tab uses a Copied flip inline, so `.copied-pop` is likely banner-only and can go, but verify.

- [ ] **Step 2: Wire the nag + dialog in `App.tsx`**

1. Add imports:
   ```tsx
   import { useUpdateNag, nagValueForUpdate, nagValueForDeprecated, writeNagDismiss } from './hooks/useUpdateNag'
   import type { UpdateDialogMode } from './components/UpdateDialog'
   ```
   and next to the other lazy imports (line ~71, beside GlobalSettingsModal):
   ```tsx
   const UpdateDialog = lazy(() =>
     import('./components/UpdateDialog').then((m) => ({ default: m.UpdateDialog })),
   )
   ```
2. Next to the existing `const updateInfo = useUpdateInfo(isConfigured === true)` (line ~447), add:
   ```tsx
   // What's New dialog state — one global instance (App can host 3 chat
   // panels; the dialog must be app-level). Driven by useUpdateNag's toast.
   const [updateNagDialog, setUpdateNagDialog] = useState<UpdateDialogMode | null>(null)
   const openUpdateNagDialog = useCallback((mode: UpdateDialogMode) => {
     setUpdateNagDialog(mode)
   }, [])
   useUpdateNag(updateInfo.info, openUpdateNagDialog)
   ```
3. Mount the dialog next to the GlobalSettingsModal block (~line 4160), following the same presence/Suspense convention. Simplest correct form (no exit-presence needed — the Overlay owns its own exit animation):
   ```tsx
   {updateNagDialog && updateInfo.info && (
     <Suspense fallback={null}>
       <UpdateDialog
         open
         mode={updateNagDialog}
         info={updateInfo.info}
         updating={updateInfo.updating}
         onUpdate={updateInfo.update}
         onClose={() => {
          // One nag per version: any dialog closure counts as "seen".
          const info = updateInfo.info
          if (info) {
            writeNagDismiss(
              updateNagDialog === 'update' && info.latest
                ? nagValueForUpdate(info.latest)
                : nagValueForDeprecated(info.current),
            )
          }
          setUpdateNagDialog(null)
        }}
       />
     </Suspense>
   )}
   ```

- [ ] **Step 3: Verify no dangling references**

Run: `rg -n "UpdateBanner|update-banner" src/ server/ shared/`
Expected: no matches outside git history.

- [ ] **Step 4: Run client tests + typecheck**

Run: `npm run typecheck && npx vitest run src/`
Expected: PASS. Any test importing `UpdateBanner` must be deleted with it (there is no `UpdateBanner.test.tsx` in the tree as of writing — confirm with `ls src/components/UpdateBanner*`).

- [ ] **Step 5: Commit**

```bash
git add src/App.tsx src/styles/layout.css
git rm src/components/UpdateBanner.tsx
git commit -m "feat(update): wire nag toast + What's New dialog; remove UpdateBanner"
```

---

### Task 9: Full verification pass

**Files:** none (verification only; fixes go back into the owning task's files).

- [ ] **Step 1: Full test suite**

Run: `npm run test`
Expected: all green.

- [ ] **Step 2: Typecheck (both tsconfigs)**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: clean. If eslint flags `console.warn` in `UpdateDialog` clipboard fallback — it is the established pattern (UpdateBanner had the same); if the rule complains, match however the old banner file was ignored (or route through no logger — client has none; `console.warn` for clipboard failures is acceptable per the old file's precedent).

- [ ] **Step 4: Spec-coverage spot check**

Re-read the spec's §5 edge-case table and confirm each row has either a test or an explicit code gate:
- registry disabled → Task 1 test + `isUpdateNagNeeded` gate
- checking → Task 7 test
- updateAppliedToDisk → Task 7 test
- no release / GitHub down → Task 1 tests + dialog empty-state test
- npx install → Task 6 test
- multiple tabs → localStorage key (Task 7 tests)
- unparseable latest → impossible (`hasUpdate` server-gated) — no action

- [ ] **Step 5: Manual smoke (dev)**

Run: `npm run dev`, then in the browser console force the nag:
```js
localStorage.removeItem('claude-react-web:update-nag-dismissed-version')
```
Re-open the app. Against the live npm registry the current version may be up to date, so to see the flow either point `updateCheckRegistry` at a stub or temporarily edit `baseInfo`-equivalent server data — the unit tests cover behaviour; smoke only needs "dialog renders, Later persists the key, toast doesn't return on reload".

- [ ] **Step 6: Final commit (only if Step 5 produced fixes)**

```bash
git add <changed files>
git commit -m "fix(update): review fixes for What's New dialog"
```

---

## Known limitations (accepted, documented)

- **Toast capacity eviction** (MAX_TOASTS = 3): a sticky nag can be evicted by three newer error toasts. Eviction does not fire `onDismiss`, so the dismiss key isn't written; the per-mount ref still suppresses the nag for the current tab, and other tabs re-nag until dismissed. Accepted — an error flood is more urgent than the nag.
- **Declined-branch copy unified** to "copy the command instead." (About tab previously said "below"). Accepted per spec §3.
- **Action-click writes the dismiss key immediately** (via the toast's auto-dismiss → onDismiss), not deferred to dialog close. End state is identical to the spec ("any closure counts as seen"); only a crash-between-toast-and-dialog edge differs. Accepted simplification.
