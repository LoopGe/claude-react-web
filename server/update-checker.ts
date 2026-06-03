// Update checker — queries the configured npm registry for the package's
// `latest` dist-tag and compares to the version baked into this build.
//
// The current version comes from `package.json` via a JSON import.
// esbuild's `bundle: true` mode (see build.mjs) inlines JSON imports at
// build time, so the bundled dist/cli.mjs does NOT need package.json
// alongside it at runtime.
//
// Registry source: `config.updateCheckRegistry`, configured by the user
// in the About tab. There is NO default — this package is published on
// a private registry, so blindly probing npmjs.org would just return
// 404s and clutter the UI with errors. When unset the checker returns
// `{ disabled: true }` and the UI hides the banner / shows a "registry
// not configured" hint in About.
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
import type { UpdateInfo } from '../shared/update-info.js'
import { isVersionNewer } from '../shared/update-info.js'
import { config } from './config.js'
import { detectInstallMethod } from './install-method.js'
import { readInstalledVersion } from './installed-version.js'

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

// `isVersionNewer` now lives in shared/update-info.ts so the client compares
// versions identically. Re-exported here to keep existing server/test imports
// (`import { isVersionNewer } from './update-checker.js'`) working.
export { isVersionNewer } from '../shared/update-info.js'

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
  // Use the scoped name with a literal `/` between scope and name. We
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
  // the user actually typed (e.g. `/api/npm/mi-npm/`) keeps its shape
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
      const latest = await fetchLatestFromNpm(PACKAGE_NAME, registry)
      cached = {
        current: CURRENT_VERSION,
        packageName: PACKAGE_NAME,
        installMethod: detectInstallMethod(),
        registry,
        latest,
        hasUpdate: isVersionNewer(CURRENT_VERSION, latest),
        checkedAt: Date.now(),
        source: 'npm',
      }
    } catch (err) {
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
    const latest = await fetchLatestFromNpm(PACKAGE_NAME, trimmed)
    return {
      current: CURRENT_VERSION,
      packageName: PACKAGE_NAME,
      installMethod: detectInstallMethod(),
      registry: trimmed,
      latest,
      hasUpdate: isVersionNewer(CURRENT_VERSION, latest),
      checkedAt: Date.now(),
      source: 'npm',
    }
  } catch (err) {
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
}
