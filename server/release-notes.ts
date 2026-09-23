// Release-notes checker — fetches the project's GitHub Releases and
// narrows them to the version range the What's New dialog renders.
//
// Caching policy mirrors update-checker.ts:
//   - Successful fetches cached for RELEASES_TTL_MS (6h), keyed by the
//     full `(from, to, includeFrom)` triple — the inclusivity is part of
//     the range, so the two shapes never share a slot.
//   - Failed fetches cache the error briefly (FAILED_RETRY_MS) so a
//     transient GitHub hiccup doesn't poison the dialog for 6h.
//   - In-flight fetches are deduped per the same (from, to, includeFrom) key.
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
import { LOG_PREVIEW_CAP } from './constants.js'

const log = createLogger('release-notes')

const RELEASES_TTL_MS = 6 * 60 * 60 * 1000 // 6h between successful fetches
const FAILED_RETRY_MS = 5 * 60 * 1000      // 5 min retry after failure
const FETCH_TIMEOUT_MS = 5_000
const PER_PAGE = 30

/** Parse `owner/repo` out of a package.json `repository` field.
 *  Accepts a plain URL string (`git+https://github.com/o/r.git`,
 *  `https://github.com/o/r`, `git@github.com:o/r.git`)
 *  OR the object form `{ type: 'git', url: '…' }` that npm/popular
 *  tooling emits. Returns null when the URL isn't a GitHub repo we can
 *  extract a slug from. */
export function parseRepoSlug(repository: unknown): string | null {
  const url = typeof repository === 'object' && repository !== null
    ? (repository as { url?: unknown }).url
    : repository
  if (typeof url !== 'string') return null
  const m = /github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?(?:[/#].*)?$/.exec(url)
  return m ? m[1] : null
}

const REPO_SLUG = parseRepoSlug(
  (pkg as { repository?: unknown }).repository,
)

/** Browser URL of the repo derived above. Exported so the update-info payload
 *  and this module name the SAME repository — the client's "browse all
 *  releases" link must match wherever these notes came from. Null when this
 *  build declares no parseable GitHub repository. */
export const REPO_URL: string | null = REPO_SLUG ? `https://github.com/${REPO_SLUG}` : null

interface CacheEntry {
  result: ReleaseNotesResult
  /** Epoch ms after which the entry is stale. */
  expiresAt: number
}

// Per-KEY, not a single slot: two ranges are routinely live at once now (the
// nag dialog's `(current, latest]` and the About tab's `[current, current]`),
// and a single slot would evict one on every open — turning a 6h TTL into a
// GitHub fetch per dialog, and wiping the failure backoff exactly when a
// rate-limited registry needs it. Keyed by the same triple as `inFlight`
// below, and BOUNDED: the old single slot capped this at one result by
// construction, and `from`/`to` arrive from the query string, so an unbounded
// Map would retain every distinct range ever requested — each holding up to
// PER_PAGE release bodies.
const MAX_CACHE_ENTRIES = 20
const cache = new Map<string, CacheEntry>()
const inFlight = new Map<string, Promise<ReleaseNotesResult>>()

export function __resetReleaseNotesForTests(): void {
  cache.clear()
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

async function fetchReleases(from: string, to: string, includeFrom: boolean): Promise<ReleaseNotesResult> {
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
      return errorResult(from, to, `GitHub releases fetch failed: ${res.status}${hint} ${text.slice(0, LOG_PREVIEW_CAP)}`)
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
    // Range: inclusive `to`, and `from` either exclusive (the default — "what
    // did I miss since I'm running `from`") or inclusive (`includeFrom`, the
    // About tab's "what did THIS version bring" query, where from === to).
    const vsFrom = compareSemver(version, from)
    if (includeFrom ? vsFrom < 0 : vsFrom <= 0) continue
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

/** Fetch (or serve from cache) the release notes for `(from, to]` —
 *  or `[from, to]` when `includeFrom` is set. Never throws — failures
 *  land in `result.error`. */
export async function getReleaseNotes(
  from: string,
  to: string,
  includeFrom = false,
): Promise<ReleaseNotesResult> {
  // The inclusivity is part of the key: (0.7.3, 0.7.3] and [0.7.3, 0.7.3]
  // are different ranges and must never share a cache slot.
  const key = `${from}|${to}|${includeFrom ? 'inc' : 'exc'}`
  const hit = cache.get(key)
  if (hit) {
    if (Date.now() < hit.expiresAt) {
      // Refresh its position on hit: eviction below is oldest-first, and
      // `from`/`to` come off the query string, so without this the two ranges
      // that actually matter could be pushed out by traffic to unrelated ones.
      cache.delete(key)
      cache.set(key, hit)
      return hit.result
    }
    // Expired: drop it rather than leave it resident until the same key is
    // asked for again, which may never happen.
    cache.delete(key)
  }
  const pending = inFlight.get(key)
  if (pending) return pending

  const p = (async () => {
    const result = await fetchReleases(from, to, includeFrom)
    const ttl = result.error ? FAILED_RETRY_MS : RELEASES_TTL_MS
    cache.set(key, { result, expiresAt: Date.now() + ttl })
    // Map iterates in insertion order, so the first key is the oldest.
    while (cache.size > MAX_CACHE_ENTRIES) {
      const oldest = cache.keys().next().value
      if (oldest === undefined) break
      cache.delete(oldest)
    }
    // Both ends of the range alone are ambiguous: `0.7.3→0.7.3` is an empty
    // (from, to] query for the nag path but a real single-version query for
    // the About tab, so an empty result and a failure must be distinguishable
    // in the log by the flag.
    const range = `${from}→${to}${includeFrom ? ' (inclusive)' : ''}`
    if (result.error) {
      log.warn(`release notes fetch failed for ${range}: ${result.error}`)
    } else {
      log.debug(`release notes fetched for ${range}: ${result.releases.length} release(s)`)
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
