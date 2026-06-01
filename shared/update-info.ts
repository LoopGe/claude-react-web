// Single source of truth for the UpdateInfo shape returned by
// GET /api/update-info. Imported by both server (server/update-checker.ts)
// and client (src/hooks/useUpdateInfo.ts) so the two ends can't drift.
//
// We deliberately do NOT throw on registry failures — `error` carries the
// human-readable reason and `hasUpdate` falls to false. The UI checks
// `error` to decide whether to render the banner or an About-tab notice.

export interface UpdateInfo {
  /** Always present: the version baked into this build (from package.json). */
  current: string
  /** The canonical npm package name (from package.json `name`). The UI uses
   *  this to build the upgrade command so a scoped name (e.g.
   *  `@mi/claude-react-web`) is reflected verbatim instead of a hardcoded
   *  unscoped guess. */
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
}
