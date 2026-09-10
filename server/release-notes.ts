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
