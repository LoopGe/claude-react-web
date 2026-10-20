// Row-level "Update" control, shared by the two marketplace panels — the
// Claude Plugin Marketplace (MarketplaceTab) and App Plugins / Mods
// (AppPluginMarketplaceSection).
//
// One word for one action — "sync this marketplace from upstream" — so the
// two panels stop drifting apart. What that sync *is* differs per subsystem,
// and that difference is inherent, not a naming mistake:
//   Claude panel: plugins are read live out of the clone, so pulling the repo
//                 IS the update — one click and the plugins are current.
//   App panel:    each plugin is installed as a copy, so pulling refreshes the
//                 catalog and the per-plugin Update buttons then apply it.
// The warn state means the same in both: upstream has commits we don't.
//
// `local` (bundled) marketplaces have NO upstream — callers must not render
// this control for them.

import { IconAlertTriangle } from './icons/ToolIcons'

export function MarketplaceUpdateButton({
  hasUpdate,
  busy,
  disabled,
  error,
  onUpdate,
}: {
  /** Upstream tip differs from the stored SHA → warn state. */
  hasUpdate: boolean
  /** THIS row's sync is in flight — also drives the "Updating…" label. */
  busy: boolean
  /** Blocked for an unrelated reason (a bulk run, or a panel-wide Add /
   *  Remove). Kept separate from `busy` so an unrelated operation never
   *  re-labels every row on the panel to "Updating…". */
  disabled?: boolean
  /** Per-marketplace check failure; renders a warn triangle beside the button. */
  error?: string
  onUpdate: () => void
}) {
  return (
    <>
      {error && (
        <span
          className="marketplace-update-error"
          title={`Couldn't check for updates: ${error}`}
          aria-label={`Couldn't check for updates: ${error}`}
        >
          <IconAlertTriangle size={12} />
        </span>
      )}
      <button
        className={`btn marketplace-update-btn${hasUpdate ? ' marketplace-update-available' : ''}`}
        onClick={onUpdate}
        disabled={busy || disabled}
        title={
          hasUpdate
            ? 'Update available — sync this marketplace from upstream'
            : 'Sync this marketplace from upstream'
        }
      >
        {hasUpdate && <span className="marketplace-update-dot" aria-hidden />}
        {busy ? 'Updating…' : 'Update'}
      </button>
    </>
  )
}
