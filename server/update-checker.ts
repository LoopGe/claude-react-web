// Update checker — queries the configured npm registry for the package's
// `latest` dist-tag and compares to the version baked into this build.
//
// The current version comes from `package.json` via a JSON import.
// esbuild's `bundle: true` mode (see build.mjs) inlines JSON imports at
// build time, so the bundled dist/cli.mjs does NOT need package.json
// alongside it at runtime.
//
// Registry source: `config.updateCheckRegistry`, which defaults to the
// public npm registry (https://registry.npmjs.org) and can be overridden
// in the About tab to point at a private registry. When the user clears
// it (empty string) the checker returns `{ disabled: true }` and the UI
// hides the banner / shows a "registry not configured" hint in About.
//
// Caching policy:
//   - Successful probes are cached for CACHE_TTL_MS (6 hours). Within
//     that window, GET /api/update-info returns the cached snapshot.
//   - In-flight probes are deduped via the `inFlight` promise — concurrent
//     callers (CLI startup + first browser request) share one HTTP fetch.
//   - Failed probes write the error to the cache snapshot but DO NOT
//     poison the TTL — a transient DNS hiccup shouldn't lock us out for
//     6h. Failed probes get a short retry window (FAILED_RETRY_MS).
//   - `force` bypasses cache entirely (used by the "Check now" button).
//
// Failure mode: registry fetch errors are caught and recorded in
// `info.error`; we never throw out of `checkForUpdates()`. The UI uses
// the presence of `error` to decide whether to surface a "couldn't check"
// notice in the About view.

import pkg from '../package.json' with { type: 'json' }
import { createRequire } from 'node:module'
import type { PublishedVersions, UpdateInfo } from '../shared/update-info.js'
import { compareSemver, isStableVersion, isVersionNewer } from '../shared/update-info.js'
import { config } from './config.js'
import { detectInstallMethod } from './install-method.js'
import { readInstalledVersion } from './installed-version.js'
import { createLogger } from './log.js'

const log = createLogger('update-checker')

const CACHE_TTL_MS = 6 * 60 * 60 * 1000  // 6h between successful probes
const FAILED_RETRY_MS = 5 * 60 * 1000    // 5 min between retries after failure
const FETCH_TIMEOUT_MS = 5_000

// The `name` field in package.json is the canonical npm name. Reading
// from the bundled JSON (rather than hardcoding the string here) means
// rename or scope changes only need to be done in one place.
const PACKAGE_NAME: string = pkg.name
const CURRENT_VERSION: string = pkg.version

let cached: UpdateInfo = {
  current: CURRENT_VERSION,
  packageName: PACKAGE_NAME,
  installMethod: detectInstallMethod(),
  hasUpdate: false,
  source: 'npm',
}
let inFlight: Promise<UpdateInfo> | null = null
// Tracks the in-flight call's force flag so a later `force=true` caller
// doesn't get silently joined to an unforced probe (which may still be
// answering from a partial cache window). When mismatched, we wait for
// the unforced probe to finish, then start a fresh forced one.
let inFlightForce = false

/** Return the current package version baked into this build. */
export function getCurrentVersion(): string {
  return CURRENT_VERSION
}

// ── @anthropic-ai/claude-agent-sdk version (process-lifetime cache) ──
//
// The SDK doesn't export a `version` constant, and build.mjs marks it as
// `external` so it's not bundled — at runtime it lives in node_modules
// next to either dist/cli.mjs or the source tree. We resolve its
// package.json on first call via createRequire and cache the result for
// the rest of the process: the on-disk SDK version cannot change without
// a server restart, so a one-shot read is enough.
//
// Failures (unusual install layout, package missing) are logged once and
// cached as `null` so we don't retry on every /update-info request.

let agentSdkVersionCache: string | null | undefined = undefined

/** Read the @anthropic-ai/claude-agent-sdk package version from
 *  node_modules. Returns null if it can't be resolved (logged once). */
export function getAgentSdkVersion(): string | null {
  if (agentSdkVersionCache !== undefined) return agentSdkVersionCache
  try {
    const requireFn = createRequire(import.meta.url)
    const sdkPkg = requireFn('@anthropic-ai/claude-agent-sdk/package.json') as {
      version?: unknown
    }
    agentSdkVersionCache =
      typeof sdkPkg.version === 'string' && sdkPkg.version ? sdkPkg.version : null
  } catch (err) {
    log.warn(
      `could not resolve @anthropic-ai/claude-agent-sdk version: ${(err as Error).message ?? err}`,
    )
    agentSdkVersionCache = null
  }
  return agentSdkVersionCache
}

/** Return the latest cached UpdateInfo without triggering a network probe.
 *  Used by the GET /api/update-info route as the "fast path" — if the
 *  cache is fresh, no fetch is performed.
 *
 *  The `installed` (on-disk) version is overlaid fresh on every call rather
 *  than served from the cached snapshot: it changes the instant an in-app
 *  update rewrites the package on disk, and we want the UI to reflect that
 *  without waiting out the 6h registry-probe TTL. */
export function getCachedUpdateInfo(): UpdateInfo {
  const installed = readInstalledVersion(PACKAGE_NAME)
  return installed ? { ...cached, installed } : cached
}

// `isVersionNewer` (and the sibling semver helpers) now live in
// shared/update-info.ts so the client compares versions identically.
// Re-exported here to keep existing server/test imports
// (`import { isVersionNewer } from './update-checker.js'`) working.
export { isVersionNewer, isStableVersion, compareSemver } from '../shared/update-info.js'

/** Hit the configured registry's "latest" dist-tag endpoint. Returns the
 *  registry's reported version on success, or throws on any HTTP / network
 *  / parse failure. The caller wraps this in try/catch and records the
 *  error in the cached UpdateInfo.
 *
 *  `registry` is concatenated verbatim with `/<package>/latest`. We do
 *  NOT normalize trailing slashes — some private registries have quirky
 *  path components (e.g. an artifactory `/api/npm/<repo>` mount) where
 *  silently rewriting the URL would surprise the user. They wrote the
 *  value into the config; we use it as-is. */
async function fetchLatestFromNpm(packageName: string, registry: string): Promise<string> {
  // Use the scope name with a literal `/` between scope and name. We
  // tried encoding the slash to `%2F` (the form the npm CLI uses for the
  // package metadata root), but Artifactory's npm endpoint returns 404
  // for `/<scope>%2F<name>/latest` — its dist-tag handler only accepts
  // the literal-slash form. The literal form also works for the official
  // npm registry, Verdaccio, and Nexus, so it's the safer wire format
  // here. We DO still encode the `@` defensively in case some registry
  // mishandles it, but in practice every registry we test against keeps
  // `@` literal too — leave it as-is for readability and parity with
  // what `npm install` sends.
  const encoded = packageName
  // Trim ONE trailing slash off the registry base so we don't end up
  // with `https://host//pkg/latest`. We don't strip multiple — a path
  // the user actually type (e.g. `/api/npm/mi-npm/`) keeps its shape
  // beyond that single defensive trim.
  const base = registry.endsWith('/') ? registry.slice(0, -1) : registry
  const url = `${base}/${encoded}/latest`

  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: {
      // The "abbreviated" Accept header asks the registry for a smaller
      // payload — we only need the version field.
      Accept: 'application/vnd.npm.install-v1+json, application/json',
    },
  })
  if (!res.ok) {
    throw new Error(`registry returned ${res.status} ${res.statusText}`)
  }
  const body = (await res.json()) as { version?: unknown }
  if (typeof body.version !== 'string' || !body.version) {
    throw new Error('registry response missing version field')
  }
  return body.version
}

/** Check whether the running version has been deprecated by the package
 *  maintainer (`npm deprecate`). Fetches the abbreviated packument
 *  (`/<pkg>` with the install-v1 accept header) and inspects the per-version
 *  manifest for `currentVersion`. Returns the deprecation message (string or
 *  `true`) when present, or `undefined` if the version is not deprecated.
 *
 *  The abbreviated manifest includes `deprecated` per version when set, so
 *  this is a single lightweight GET — no heavier than the dist-tag probe.
 *
 *  Throws on HTTP / network / parse failure; the caller handles gracefully
 *  (deprecation info is best-effort — a transient failure shouldn't block
 *  the update banner). */
async function fetchDeprecatedFromNpm(
  packageName: string,
  registry: string,
  currentVersion: string,
): Promise<string | true | undefined> {
  const encoded = packageName
  const base = registry.endsWith('/') ? registry.slice(0, -1) : registry
  const url = `${base}/${encoded}`

  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: {
      Accept: 'application/vnd.npm.install-v1+json, application/json',
    },
  })
  if (!res.ok) {
    throw new Error(`registry returned ${res.status} ${res.statusText}`)
  }
  const body = (await res.json()) as {
    versions?: Record<string, { deprecated?: unknown }>
  }
  if (!body.versions || typeof body.versions !== 'object') {
    throw new Error('registry response missing versions field')
  }
  const manifest = body.versions[currentVersion]
  if (!manifest) return undefined
  const dep = manifest.deprecated
  if (typeof dep === 'string' && dep) return dep
  if (dep === true) return true
  return undefined
}

/** Fetch the full set of published version strings for `packageName` from the
 *  registry's packument (`/<pkg>`), filter to stable releases, and sort
 *  descending. Used by the About-tab version switcher to populate its
 *  `<select>`.
 *
 *  Unlike `fetchLatestFromNpm` (which hits the lightweight `/<pkg>/latest`
 *  dist-tag endpoint), this reads the whole packument's `versions` map. We
 *  request the abbreviated install manifest (`Accept:
 *  application/vnd.npm.install-v1+json`) so npm serves a slimmed body — we
 *  only need the version keys, not the tarball hashes / deps. Throws on any
 *  HTTP / network / parse failure; the caller records the error in the
 *  versions cache rather than poisoning it. */
async function fetchPublishedVersionsFromNpm(
  packageName: string,
  registry: string,
): Promise<{ versions: string[]; deprecatedVersions: string[] }> {
  const encoded = packageName
  const base = registry.endsWith('/') ? registry.slice(0, -1) : registry
  const url = `${base}/${encoded}`

  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: {
      Accept: 'application/vnd.npm.install-v1+json, application/json',
    },
  })
  if (!res.ok) {
    throw new Error(`registry returned ${res.status} ${res.statusText}`)
  }
  const body = (await res.json()) as {
    versions?: Record<string, { deprecated?: unknown }>
  }
  if (!body.versions || typeof body.versions !== 'object') {
    throw new Error('registry response missing versions field')
  }
  // The packument's `versions` is a map keyed by version string; each value
  // is the per-version manifest (we care about keys and the deprecated field).
  const deprecatedVersions: string[] = []
  const keys = Object.keys(body.versions)
    .filter(isStableVersion)
    .sort((a, b) => compareSemver(b, a)) // descending: newest first

  for (const v of keys) {
    const dep = body.versions[v]?.deprecated
    if (dep === true || (typeof dep === 'string' && dep)) {
      deprecatedVersions.push(v)
    }
  }

  return { versions: keys, deprecatedVersions }
}

/** Probe the configured registry for the latest version. See module
 *  header for caching policy. */
export async function checkForUpdates(force = false): Promise<UpdateInfo> {
  const registry = config.updateCheckRegistry

  // No registry configured → feature disabled. Surface that as a stable
  // snapshot the UI can branch on, instead of an error or a fake
  // "checking…" state. Reset cached so a previous probe (if the user
  // cleared the field after a successful check) doesn't keep shouting
  // "update available!" with stale data.
  if (!registry) {
    cached = {
      current: CURRENT_VERSION,
      packageName: PACKAGE_NAME,
      installMethod: detectInstallMethod(),
      hasUpdate: false,
      source: 'npm',
      disabled: true,
    }
    return cached
  }

  const now = Date.now()

  // Cache hit — within TTL on success, or within FAILED_RETRY_MS on
  // failure. `force=true` bypasses both windows. `disabled` snapshots
  // are never served as cache hits because they have no `checkedAt`.
  if (!force && cached.checkedAt && !cached.disabled) {
    const age = now - cached.checkedAt
    const ttl = cached.error ? FAILED_RETRY_MS : CACHE_TTL_MS
    if (age < ttl) return cached
  }

  // Dedupe concurrent callers. Without this, the CLI's startup probe
  // and the first browser GET would race two fetches.
  //
  // BUT: a `force=true` caller (the user clicking "Check now") must NOT
  // be silently joined to an unforced probe. If the unforced probe is
  // already mid-flight, wait for it to settle, then start a fresh
  // forced probe so the user actually sees a fresh registry hit.
  if (inFlight) {
    if (!force || inFlightForce) return inFlight
    return inFlight.then(() => checkForUpdates(true))
  }

  inFlightForce = force
  const probe = (async (): Promise<UpdateInfo> => {
    try {
      // Fetch latest version and deprecation status in parallel — the
      // deprecation check is best-effort (a failure there shouldn't block
      // the "update available" banner).
      const [latest, deprecated] = await Promise.all([
        fetchLatestFromNpm(PACKAGE_NAME, registry),
        fetchDeprecatedFromNpm(PACKAGE_NAME, registry, CURRENT_VERSION).catch(
          (err) => {
            log.warn(`deprecation probe failed: ${(err as Error).message ?? err}`)
            return undefined
          },
        ),
      ])
      cached = {
        current: CURRENT_VERSION,
        packageName: PACKAGE_NAME,
        installMethod: detectInstallMethod(),
        registry,
        latest,
        hasUpdate: isVersionNewer(CURRENT_VERSION, latest),
        deprecated,
        checkedAt: Date.now(),
        source: 'npm',
      }
    } catch (err) {
      log.warn(`registry probe failed: ${(err as Error).message ?? err}`)
      cached = {
        current: CURRENT_VERSION,
        packageName: PACKAGE_NAME,
        installMethod: detectInstallMethod(),
        registry,
        // Preserve the previously-known `latest` so a transient network
        // failure doesn't make the UI suddenly forget there's an update
        // available. Skip if the previous snapshot was a `disabled`
        // marker — that had no real `latest`.
        latest: cached.disabled ? undefined : cached.latest,
        hasUpdate: cached.disabled ? false : cached.hasUpdate,
        // Preserve previously-known deprecation status on transient failure.
        deprecated: cached.disabled ? undefined : cached.deprecated,
        checkedAt: Date.now(),
        error: err instanceof Error ? err.message : String(err),
        source: 'npm',
      }
    } finally {
      inFlight = null
      inFlightForce = false
    }
    return cached
  })()
  inFlight = probe
  return probe
}

/** One-off probe of a caller-supplied registry URL that does NOT read or
 *  write the module cache, and does NOT touch `config.updateCheckRegistry`.
 *
 *  Used by the "Check now" affordance in the setup wizard and the About
 *  tab: there the user has TYPED a registry into the form but not yet saved
 *  it to config. They want to validate *that* URL, not whatever the server
 *  currently has persisted. Routing this through `checkForUpdates()` would
 *  probe the stale saved value (and poison the shared cache with an
 *  unsaved URL's result), which is exactly the bug this avoids.
 *
 *  An empty `registry` yields a `disabled` snapshot — symmetric with
 *  `checkForUpdates()` so the UI can branch identically. */
export async function probeRegistry(registry: string): Promise<UpdateInfo> {
  const trimmed = registry.trim()
  if (!trimmed) {
    return {
      current: CURRENT_VERSION,
      packageName: PACKAGE_NAME,
      installMethod: detectInstallMethod(),
      hasUpdate: false,
      source: 'npm',
      disabled: true,
    }
  }
  try {
    const [latest, deprecated] = await Promise.all([
      fetchLatestFromNpm(PACKAGE_NAME, trimmed),
      fetchDeprecatedFromNpm(PACKAGE_NAME, trimmed, CURRENT_VERSION).catch(
        (err) => {
          log.warn(`probeRegistry deprecation check failed: ${(err as Error).message ?? err}`)
          return undefined
        },
      ),
    ])
    return {
      current: CURRENT_VERSION,
      packageName: PACKAGE_NAME,
      installMethod: detectInstallMethod(),
      registry: trimmed,
      latest,
      hasUpdate: isVersionNewer(CURRENT_VERSION, latest),
      deprecated,
      checkedAt: Date.now(),
      source: 'npm',
    }
  } catch (err) {
    log.warn(`probeRegistry failed: ${(err as Error).message ?? err}`)
    return {
      current: CURRENT_VERSION,
      packageName: PACKAGE_NAME,
      installMethod: detectInstallMethod(),
      registry: trimmed,
      hasUpdate: false,
      checkedAt: Date.now(),
      error: err instanceof Error ? err.message : String(err),
      source: 'npm',
    }
  }
}

/** Test hook — resets module state between unit tests. Not exported
 *  from the package's public surface. */
export function __resetUpdateCheckerForTests(): void {
  cached = {
    current: CURRENT_VERSION,
    packageName: PACKAGE_NAME,
    installMethod: detectInstallMethod(),
    hasUpdate: false,
    source: 'npm',
  }
  inFlight = null
  inFlightForce = false
  versionsCached = null
  inFlightVersions = null
  inFlightVersionsForce = false
}

// ── Published-versions cache (version switcher) ─────────────────────
//
// A SEPARATE cache from the `latest` one above. The versions fetch reads the
// full packument (heavier than the dist-tag endpoint) and is only needed on
// demand — when the user opens the switcher — so it must never block or
// poison the banner's lightweight `latest` probe. Same TTL policy (6h on
// success, 5min retry on failure) so the two behave consistently.

let versionsCached: PublishedVersions | null = null
let inFlightVersions: Promise<PublishedVersions> | null = null
let inFlightVersionsForce = false

/** Return the cached PublishedVersions overlaid with the live on-disk
 *  `installed` (which changes the moment an in-app install rewrites the
 *  package) and the `latest` from the (separate) latest probe. Returns null
 *  when no probe has ever completed — the caller decides whether to kick one
 *  off. Mirrors `getCachedUpdateInfo`'s installed-overlay rationale. */
export function getCachedVersions(): PublishedVersions | null {
  if (!versionsCached) return null
  const installed = readInstalledVersion(PACKAGE_NAME)
  const latest = getCachedUpdateInfo().latest
  return {
    ...versionsCached,
    ...(installed ? { installed } : {}),
    ...(latest ? { latest } : {}),
  }
}

/** Probe the configured registry for the full published-versions list. Same
 *  caching/dedup policy as `checkForUpdates`: successful probes cached 6h,
 *  failed probes retry after 5min, `force` bypasses both, concurrent callers
 *  share one fetch via `inFlightVersions`. A `force=true` caller is NOT
 *  silently joined to an unforced probe (same race fix as the latest path).
 *  No registry configured → a `disabled` snapshot, no fetch. Never throws. */
export async function checkForVersions(force = false): Promise<PublishedVersions> {
  const registry = config.updateCheckRegistry

  if (!registry) {
    versionsCached = {
      current: CURRENT_VERSION,
      packageName: PACKAGE_NAME,
      installMethod: detectInstallMethod(),
      versions: [],
      disabled: true,
    }
    return versionsCached
  }

  const now = Date.now()

  if (!force && versionsCached?.checkedAt && !versionsCached.disabled) {
    const age = now - versionsCached.checkedAt
    const ttl = versionsCached.error ? FAILED_RETRY_MS : CACHE_TTL_MS
    if (age < ttl) return versionsCached
  }

  if (inFlightVersions) {
    if (!force || inFlightVersionsForce) return inFlightVersions
    return inFlightVersions.then(() => checkForVersions(true))
  }

  inFlightVersionsForce = force
  const probe = (async (): Promise<PublishedVersions> => {
    try {
      const { versions, deprecatedVersions } = await fetchPublishedVersionsFromNpm(PACKAGE_NAME, registry)
      versionsCached = {
        current: CURRENT_VERSION,
        packageName: PACKAGE_NAME,
        installMethod: detectInstallMethod(),
        registry,
        versions,
        deprecatedVersions,
        checkedAt: Date.now(),
      }
    } catch (err) {
      log.warn(`versions probe failed: ${(err as Error).message ?? err}`)
      versionsCached = {
        current: CURRENT_VERSION,
        packageName: PACKAGE_NAME,
        installMethod: detectInstallMethod(),
        registry,
        // Preserve the previously-known list so a transient failure doesn't
        // empty the switcher. Skip if the previous snapshot was `disabled`
        // (no real list existed).
        versions: versionsCached?.disabled ? [] : versionsCached?.versions ?? [],
        deprecatedVersions: versionsCached?.disabled
          ? []
          : versionsCached?.deprecatedVersions ?? [],
        checkedAt: Date.now(),
        error: err instanceof Error ? err.message : String(err),
      }
    } finally {
      inFlightVersions = null
      inFlightVersionsForce = false
    }
    return versionsCached
  })()
  inFlightVersions = probe
  return probe
}

/** Synchronously check whether `version` is in the cached published-versions
 *  list (the route uses this to validate a POST /update `{ version }` body
 *  without awaiting). Returns false when the cache is cold or `disabled` —
 *  the caller then forces a probe and re-checks. */
export function isPublishedVersion(version: string): boolean {
  if (!versionsCached || versionsCached.disabled) return false
  return versionsCached.versions.includes(version)
}
