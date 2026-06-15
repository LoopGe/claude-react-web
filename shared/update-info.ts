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

function parseSemver(v: string): ParsedSemver | null {
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
