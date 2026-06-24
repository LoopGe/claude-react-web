// Single source of truth for the UpdateInfo shape returned by
// GET /api/update-info. Imported by both server (server/update-checker.ts)
// and client (src/hooks/useUpdateInfo.ts) so the two ends can't drift.
//
// We deliberately do NOT throw on registry failures — `error` carries the
// human-readable reason and `hasUpdate` falls to false. The UI checks
// `error` to decide whether to render the banner or an About-tab notice.

export interface UpdateInfo {
  /** Always present: the version baked into this build (from package.json).
   *  This is the version of the *running process* — it never changes for the
   *  lifetime of the process, even after an in-app update rewrites the
   *  package on disk. */
  current: string
  /** The version read from the *on-disk* package.json at request time. After
   *  an in-app `npm i -g …@latest`, the package on disk is upgraded while the
   *  running process still reports the old `current`; this field reflects the
   *  new on-disk version immediately. When `installed` is strictly newer than
   *  `current`, an update has been applied and is pending a restart. Undefined
   *  when the on-disk package.json couldn't be located (e.g. unusual install
   *  layout) — the UI then falls back to showing only `current`. */
  installed?: string
  /** The canonical npm package name (from package.json `name`). The UI uses
   *  this to build the upgrade command so the actual published name (scope
   *  or unscoped) is reflected verbatim instead of a hardcoded guess. */
  packageName: string
  /** How this server process was launched, detected at runtime. The client
   *  uses it to decide whether an in-app update is feasible: only `'global'`
   *  installs can be upgraded in place via `npm i -g`. For `'npx'` /
   *  `'unknown'` the UI falls back to showing the copy-command. */
  installMethod: 'global' | 'npx' | 'unknown'
  /** The configured `updateCheckRegistry` the server probed. Echoed back so
   *  the UI can append `--registry=<…>` to the upgrade command — this
   *  package lives on a private registry, so a bare `npx <pkg>@latest`
   *  would hit the public registry and 404. Undefined when update checks
   *  are disabled (no registry configured). */
  registry?: string
  /** Latest version pulled from the npm registry's `latest` dist-tag.
   *  Undefined when the registry hasn't been queried yet, or the query
   *  failed (see `error`). */
  latest?: string
  /** True iff `latest` is strictly newer than `current` under the
   *  three-segment numeric comparison in `isVersionNewer()`.
   *  Pre-release tags on `latest` are ignored — a pre-release never
   *  triggers an update prompt. */
  hasUpdate: boolean
  /** ms epoch when the registry was successfully queried. Undefined
   *  before the first successful probe. */
  checkedAt?: number
  /** Human-readable error from the most recent probe attempt. Set when
   *  the registry fetch failed (offline, mirror down, 5xx, timeout); the
   *  UI surfaces this verbatim in the About tab. */
  error?: string
  /** Message from the npm registry when the running version has been
   *  deprecated (`npm deprecate`). Present only when the current version
   *  carries a deprecation notice; undefined otherwise. The value is either
   *  a string (the maintainer's message) or `true` (deprecated without a
   *  custom message). */
  deprecated?: string | true
  /** Where `latest` came from. Reserved for future "github" source. */
  source: 'npm'
  /** True while a probe is in flight and we have no cached result yet.
   *  Lets the client render a "checking…" state instead of a stale
   *  snapshot. */
  checking?: boolean
  /** Set when the user hasn't configured `updateCheckRegistry`. The
   *  banner stays hidden, the About tab tells the user where to set it.
   *  Distinct from `error` because "no registry configured" isn't a
   *  failure to surface — it's an explicit opt-out. */
  disabled?: boolean
  /** Claude Code CLI binary detected on this server. Populated by the
   *  About tab so the user can confirm which CLI the SDK will spawn and
   *  diagnose ENOENT/EACCES issues without a separate /health/claude
   *  round-trip. Reuses the same probe + module-level cache as
   *  GET /health/claude — only successful results stick, so a transient
   *  failure re-probes on the next request. Undefined when the route
   *  was built without a claudeBinary (older callers). */
  claudeCli?: {
    ok: boolean
    binary?: string
    version?: string
    error?: string
  }
  /** Version of `@anthropic-ai/claude-agent-sdk` resolved at runtime by
   *  reading the package's package.json from node_modules. The SDK doesn't
   *  export a version constant, and we don't bundle it (build.mjs marks it
   *  external) — so this is read on first call and cached for the process
   *  lifetime. Undefined when the SDK can't be resolved (unusual install
   *  layout). */
  agentSdk?: {
    version: string
  }
}

/** Result of POST /api/update — the in-app "Update now" action. */
export interface UpdateActionResult {
  /** True when an install actually ran and succeeded. False when we
   *  short-circuited (non-global install) — see `fallbackToCopyCommand`. */
  performed: boolean
  /** The detected install method at action time. */
  installMethod: 'global' | 'npx' | 'unknown'
  /** True when no install was performed because the install method can't be
   *  upgraded in place (npx / unknown). The client should show / focus the
   *  copy-command instead. */
  fallbackToCopyCommand?: boolean
  /** True after a successful install — the running process is still the old
   *  version, so the user must restart to apply the update. */
  restartRequired?: boolean
  /** The version we installed `@latest` resolved to, when known (echoed from
   *  the cached UpdateInfo.latest). Purely informational for the toast. */
  latest?: string
  /** The version read from the on-disk package.json *after* the install
   *  completed. This is the authoritative "what actually got written" value —
   *  the client compares it to the pre-update running version to confirm the
   *  upgrade landed. Undefined when the on-disk package.json couldn't be read. */
  installedVersion?: string
  /** True when the post-install on-disk version is strictly newer than the
   *  running version — i.e. the update verifiably landed on disk and a restart
   *  will apply it. False when the on-disk version is unchanged (npm reported
   *  "up to date" / install was a no-op) or couldn't be confirmed. */
  updateApplied?: boolean
  /** The version the install targeted, when the caller pinned one (the
   *  version switcher passes `{ version }`). Absent for the no-body "update
   *  to latest" path — there the target is the cached `latest`. */
  targetVersion?: string
  /** True iff the post-install on-disk version differs from the running build
   *  in EITHER direction. `updateApplied` only fires for upgrades
   *  (`isVersionNewer`), so a downgrade — the version switcher's primary use
   *  case — needs its own signal that the on-disk package changed and a
   *  restart will apply it. Also true for a forward pin past `latest`; false
   *  only for a true no-op (installed == running). */
  versionChanged?: boolean
}

// ── Version comparison ───────────────────────────────────────────────
//
// Lives here (not in the server) so both ends compare versions identically.
// The server uses it to compute `hasUpdate` / `updateApplied`; the client
// uses it to decide whether the on-disk `installed` is genuinely ahead of the
// running `current` (a "restart to apply" state) rather than a downgrade.

interface ParsedSemver {
  major: number
  minor: number
  patch: number
  prerelease: boolean
}

/** Parse a semver-ish string into its numeric major.minor.patch segments and
 *  whether it carries a prerelease suffix. Exported so the version-switcher
 *  (which builds the published-versions list) can reuse the same parser the
 *  upgrade comparison uses — one notion of "what is a version" across both
 *  ends. Returns null on malformed input. */
export function parseSemver(v: string): ParsedSemver | null {
  // Match `<major>.<minor>.<patch>` followed optionally by `-prerelease`
  // and/or `+build`. Per semver, build metadata (`+build…`) MUST be
  // ignored for ordering — only `-pre…` marks a prerelease. We don't
  // validate the prerelease token's contents — its mere presence is
  // enough to skip the comparison.
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([^+]+))?(?:\+.+)?$/.exec(v.trim())
  if (!m) return null
  const major = Number(m[1])
  const minor = Number(m[2])
  const patch = Number(m[3])
  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) {
    return null
  }
  return { major, minor, patch, prerelease: !!m[4] }
}

/** Compare two semver-ish version strings using only their numeric
 *  major.minor.patch segments. Pre-release suffixes (`-rc.1`, `-beta`)
 *  on EITHER side make the version count as "not newer" — we never
 *  prompt users to upgrade to a pre-release, and we never count being
 *  on a pre-release as "ahead of" the stable channel.
 *
 *  Returns true iff `latest` is strictly newer than `current`. Returns
 *  false on parse failure (malformed inputs are treated as "not newer"
 *  rather than throwing — a registry serving garbage shouldn't break
 *  the UI). */
export function isVersionNewer(current: string, latest: string): boolean {
  const a = parseSemver(current)
  const b = parseSemver(latest)
  if (!a || !b) return false
  if (a.prerelease || b.prerelease) return false
  if (b.major !== a.major) return b.major > a.major
  if (b.minor !== a.minor) return b.minor > a.minor
  return b.patch > a.patch
}

/** True iff `v` parses to a real major.minor.patch AND has no prerelease
 *  suffix. The version switcher only offers stable releases — a prerelease
 *  (`-rc.1`, `-beta`) is never a rollback target — so this is the filter the
 *  published-versions list applies. Mirrors the prerelease skip in
 *  `isVersionNewer` so "stable" means the same thing everywhere. */
export function isStableVersion(v: string): boolean {
  const p = parseSemver(v)
  return !!p && !p.prerelease
}

/** Numeric major.minor.patch comparison. Returns <0 / 0 / >0 like a normal
 *  comparator, suitable for `Array.sort` to order a list. Prereleases are
 *  treated as their patch-equivalent (we filter them out of the switcher
 *  list anyway, but a stray prerelease still sorts next to its release).
 *  Unparseable inputs sort as "less than" any parseable one and are kept
 *  stable relative to each other — malformed data never throws here. */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a)
  const pb = parseSemver(b)
  if (!pa && !pb) return 0
  if (!pa) return 1 // push unparseable to the end (descending view)
  if (!pb) return -1
  if (pa.major !== pb.major) return pa.major - pb.major
  if (pa.minor !== pb.minor) return pa.minor - pb.minor
  return pa.patch - pb.patch
}

// ── Published-versions list (version switcher) ──────────────────────
//
// Returned by GET /api/update-info/versions and consumed by the About tab's
// "Switch version" section. Separate from UpdateInfo because the list is a
// heavier, on-demand fetch (the full packument `/<pkg>`) that the banner and
// the normal About view never need — it's only pulled when the user expands
// the switcher. The two caches (latest vs versions) are independent in
// update-checker.ts so a versions-fetch failure can't poison the banner.

export interface PublishedVersions {
  /** The version baked into the running build (same `current` as UpdateInfo). */
  current: string
  /** On-disk version read at request time — lets the switcher mark which
   *  published version is "installed" (may differ from `current` after an
   *  in-app install that hasn't been restarted into yet). */
  installed?: string
  /** The `latest` dist-tag, overlaid from the (separate, lighter) latest
   *  probe so the select can label it. Undefined when that probe hasn't run
   *  or failed. */
  latest?: string
  /** Canonical npm package name (mirrors UpdateInfo.packageName). */
  packageName: string
  /** How this server process was launched — only `'global'` can install a
   *  pinned version in place; npx/unknown get the copy-command. */
  installMethod: 'global' | 'npx' | 'unknown'
  /** The probed registry, echoed so the copy-command can carry --registry. */
  registry?: string
  /** Stable published versions, sorted DESCENDING (newest first). Pre-release
   *  versions are filtered out by `isStableVersion`. Empty when the probe
   *  failed or hasn't completed (see `error` / `checking`). */
  versions: string[]
  /** Subset of `versions` that the maintainer has deprecated (via
   *  `npm deprecate`). The UI tags these in the version-switcher dropdown
   *  so the user knows which releases carry a deprecation notice before
   *  pinning one. Empty or absent when no published version is deprecated. */
  deprecatedVersions?: string[]
  /** ms epoch of the last successful probe. Undefined before the first. */
  checkedAt?: number
  /** Human-readable error from the most recent probe; surfaced verbatim in
   *  the switcher. */
  error?: string
  /** True while a probe is in flight with no cached result yet. */
  checking?: boolean
  /** True when no `updateCheckRegistry` is configured — the switcher is
   *  unusable and the UI explains why. */
  disabled?: boolean
}

