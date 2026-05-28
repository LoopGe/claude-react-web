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
