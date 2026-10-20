// App Plugin Marketplace section — add GitHub-hosted marketplaces, browse,
// and install App Plugins from them. Rendered at the top of AppPluginsTab.
//
// The App Plugin analogue of the Claude Plugin Marketplace (MarketplaceTab) —
// deliberately a separate subsystem (own store/parser/routes) but the SAME
// update surface: one row-level `Update` control (MarketplaceUpdateButton) and
// the same status-line wording, so the two settings panels read as one.
//
// Installing a plugin routes through AppPluginManager, so the WS state-changed
// frame updates the installed list automatically (no manual refetch).

import { useCallback, useEffect, useRef, useState } from 'react'
import { api, apiRequest } from '../hooks/useApi'
import { IconAlertTriangle } from './icons/ToolIcons'
import type {
  AppPluginMarketplaceInfo,
  AppPluginMarketplacePlugin,
  AppPluginMarketplaceUpdateStatus,
} from '../../shared/app-plugins/marketplace.js'
import { StatusBadge } from './StatusBadge'
import { MarketplaceUpdateButton } from './MarketplaceUpdateButton'
import { CHECK_UPDATES_TIMEOUT_MS, MARKETPLACE_PULL_TIMEOUT_MS } from '../marketplace-update'

export function AppPluginMarketplaceSection() {
  const [marketplaces, setMarketplaces] = useState<AppPluginMarketplaceInfo[]>([])
  const [addUrl, setAddUrl] = useState('')
  const [addSubdir, setAddSubdir] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  // Bumped per marketplace after a successful pull so that row's expanded
  // plugin list refetches (the freshly-pulled catalog may have changed).
  const [reloadTokens, setReloadTokens] = useState<Record<string, number>>({})
  // The marketplaces whose own Update is in flight. A SET, not a single id:
// rows sync independently, so a second row's click must not clear the first
// row's in-flight state (which would re-enable it mid-pull and drop its
// "Updating…" label when the first promise settled).
  const [updatingIds, setUpdatingIds] = useState<ReadonlySet<string>>(new Set())

  // Per-marketplace update status from POST /check-updates. `undefined` = not
  // checked yet (no badge); an entry with hasUpdate=true puts the row's Update
  // control in its warn state. Only https marketplaces are ever checked —
  // a bundled (`local`) one has no upstream and gets no control at all.
  const [updateById, setUpdateById] = useState<Record<string, AppPluginMarketplaceUpdateStatus>>({})
  const [checking, setChecking] = useState(false)
  // Set when the WHOLE check request fails (network / timeout), so the status
  // line can tell "couldn't check" apart from "checked, all current". A single
  // marketplace's failure arrives inside a successful response instead, and is
  // shown on that row.
  const [updateCheckError, setUpdateCheckError] = useState<string | null>(null)

  // A check response is a server-side snapshot taken when the request was
  // handled. If a pull lands while a check is still in flight, that entry is
  // stale (pre-pull) and must not overwrite the newer "not behind" state the
  // pull just established. `pullEpoch` is a monotonic counter bumped on every
  // successful pull; `lastPullByMp` records the epoch each marketplace was last
  // pulled at. fetchUpdates snapshots the epoch when it starts and skips any
  // response entry for a marketplace pulled after that snapshot.
  //
  // DELIBERATELY MIRRORS MarketplaceTab's localPullEpoch/lastLocalPullByMp/
  // noteLocalPull trio, which solves the identical race — including the
  // "checking outranks the error" branch order in the status line below. Keep
  // the two in step; the only intended difference is that a bundled (`local`)
  // marketplace is never checked here, so it can't hold the check error open.
  const pullEpoch = useRef(0)
  const lastPullByMp = useRef<Record<string, number>>({})

  // Bulk "Update all" — refresh every https marketplace, then reinstall every
  // installed plugin whose catalog version changed. `bulkProgress` shows the
  // current phase; `bulkResult` is the completion summary.
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkProgress, setBulkProgress] = useState<string | null>(null)
  const [bulkResult, setBulkResult] = useState<string | null>(null)

  const refreshList = useCallback(async () => {
    try {
      const res = await api.get<{ marketplaces: AppPluginMarketplaceInfo[] }>('/app-plugins/marketplaces')
      setMarketplaces(res.marketplaces ?? [])
    } catch {
      setMarketplaces([])
    }
  }, [])

  // Live mirror of `marketplaces` for async callbacks that must read the
  // current list without being re-created every time it changes.
  const marketplacesRef = useRef<AppPluginMarketplaceInfo[]>(marketplaces)
  useEffect(() => { marketplacesRef.current = marketplaces }, [marketplaces])

  // Fire one batch update check. Per-marketplace errors are isolated into the
  // response by the server; a whole-request failure is surfaced via
  // updateCheckError with a Retry affordance rather than left silent.
  const fetchUpdates = useCallback(async () => {
    setChecking(true)
    const startEpoch = pullEpoch.current
    try {
      const r = await api.post<{ ok: true; updates: AppPluginMarketplaceUpdateStatus[] }>(
        '/app-plugins/marketplaces/check-updates',
        {},
        { timeoutMs: CHECK_UPDATES_TIMEOUT_MS },
      )
      // Merge, not replace: an entry for a marketplace pulled after this check
      // began is older news than the pull, so it's skipped.
      setUpdateById((prev) => {
        const next = { ...prev }
        for (const u of r.updates) {
          if ((lastPullByMp.current[u.id] ?? 0) > startEpoch) continue
          next[u.id] = u
        }
        return next
      })
      setUpdateCheckError(null)
    } catch (e) {
      // Whole-request failure (network / timeout). Skip the banner when every
      // listed https marketplace was individually pulled AFTER this check
      // began: those pulls supersede the failed batch, so a stale pre-pull
      // failure must not flash beside marketplaces the user just verified.
      const known = marketplacesRef.current.filter((m) => m.sourceType === 'https')
      const allPulledAfterStart =
        known.length > 0 && known.every((m) => (lastPullByMp.current[m.id] ?? -1) > startEpoch)
      if (!allPulledAfterStart) setUpdateCheckError((e as Error).message)
    } finally {
      setChecking(false)
    }
  }, [])

  useEffect(() => {
    let alive = true
    // List first (so rows render), then the non-mutating update check. Both
    // only setState inside their promise callbacks — the one-time mount fetch
    // of an external list is what this effect exists for.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time mount fetch of the marketplace list
    void refreshList().then(() => { if (alive) void fetchUpdates() })
    return () => { alive = false }
  }, [refreshList, fetchUpdates])

  // Record a successful pull (row Update / Add / bulk Update all). Any
  // in-flight check snapshot for this marketplace is now stale and must not
  // resurrect the badge it just cleared; and the pull re-evaluates a stale
  // whole-check error. That error is only resolved once EVERY listed https
  // marketplace is known — pulled now, or already checked clean — so a single
  // pull can't let the status line over-claim "All marketplaces up to date"
  // for siblings that were never re-checked after the failed batch. A bundled
  // (`local`) marketplace is never checked, so it can't hold the error open.
  const notePull = useCallback((id: string) => {
    pullEpoch.current += 1
    lastPullByMp.current[id] = pullEpoch.current
    const allKnown = marketplaces.every(
      (m) => m.id === id || m.sourceType === 'local'
        || (updateById[m.id] != null && !updateById[m.id]?.error),
    )
    if (allKnown) setUpdateCheckError(null)
  }, [marketplaces, updateById])

  const add = useCallback(async () => {
    const url = addUrl.trim()
    if (!url) return
    // Only include subdir when non-blank — the server trims/drops blank
    // values itself, so an empty string on the wire is never meaningful.
    const body: { url: string; subdir?: string } = { url }
    const subdir = addSubdir.trim()
    if (subdir) body.subdir = subdir
    setBusy(true); setError(null)
    try {
      const res = await api.post<{ ok: true; marketplace: AppPluginMarketplaceInfo }>(
        '/app-plugins/marketplaces',
        body,
      )
      // The POST response carries the freshly-created marketplace — replace or
      // append it locally instead of refetching the whole list. A freshly
      // cloned marketplace is at upstream HEAD, so seed an explicit "not
      // behind" (no badge) instead of leaving it unknown.
      const mp = res.marketplace
      setMarketplaces((prev) => [...prev.filter((m) => m.id !== mp.id), mp])
      setUpdateById((prev) => ({ ...prev, [mp.id]: { id: mp.id, hasUpdate: false } }))
      notePull(mp.id)
      setAddUrl('')
      setAddSubdir('')
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }, [addUrl, addSubdir, notePull])

  // Sync one marketplace from upstream and fold the result into local state.
  // Shared by the row's Update control and the bulk "Update all" loop.
  const syncMarketplace = useCallback(async (id: string) => {
    const res = await api.post<{ ok: true; updated: boolean; marketplace: AppPluginMarketplaceInfo }>(
      `/app-plugins/marketplaces/${encodeURIComponent(id)}/refresh`,
      {},
      { timeoutMs: MARKETPLACE_PULL_TIMEOUT_MS },
    )
    setMarketplaces((prev) => prev.map((m) => (m.id === id ? res.marketplace : m)))
    // The pull moved local to upstream HEAD — clear the warn state.
    setUpdateById((prev) => ({ ...prev, [id]: { id, hasUpdate: false } }))
    notePull(id)
  }, [notePull])

  /** Re-fetch the plugin list of each (expanded) row, so its per-plugin
   *  Install / Update / "Installed vX" buttons reflect the marketplace's new
   *  catalog (a pull) or its new installed versions (a reinstall). Called by
   *  the caller AFTER that work — never by the pull itself, because during a
   *  bulk run the pull is not the last thing to touch the row. */
  const bumpReload = useCallback((ids: string[]) => {
    if (ids.length === 0) return
    setReloadTokens((t) => {
      const next = { ...t }
      for (const id of ids) next[id] = (next[id] ?? 0) + 1
      return next
    })
  }, [])

  const handleRowUpdate = useCallback(async (id: string) => {
    setUpdatingIds((prev) => new Set(prev).add(id)); setError(null)
    // syncMarketplace records the pull, which also re-evaluates a stale
    // whole-check error (see notePull).
    try {
      await syncMarketplace(id)
      // The pull may have revealed newer catalog versions.
      bumpReload([id])
    } catch (e) { setError((e as Error).message) } finally {
      setUpdatingIds((prev) => { const next = new Set(prev); next.delete(id); return next })
    }
  }, [syncMarketplace, bumpReload])

  const removeMp = useCallback(async (id: string) => {
    setBusy(true); setError(null)
    try {
      await apiRequest(`/app-plugins/marketplaces/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        body: JSON.stringify({ confirm: true }),
      })
      // Drop the removed marketplace's update state. The epoch is bumped BEFORE
      // stamping its id (a tombstone, not just a delete) so an in-flight check
      // that started before this removal can't merge a stale entry for an id
      // that no longer exists — the merge guard skips any id stamped above the
      // epoch the check snapshotted.
      pullEpoch.current += 1
      lastPullByMp.current[id] = pullEpoch.current
      setUpdateById((prev) => {
        const next = { ...prev }
        delete next[id]
        return next
      })
      await refreshList()
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }, [refreshList])

  const handleUpdateAll = async () => {
    const https = marketplaces.filter((m) => m.sourceType === 'https')
    if (https.length === 0) return
    setBulkBusy(true)
    setError(null)
    setBulkResult(null)
    const refreshErrors: string[] = []
    const installErrors: string[] = []
    const installs: { mpId: string; name: string }[] = []
    let permissionRequired = 0
    try {
      // Phase 1 — sync every https marketplace. This makes the new catalog
      // (and plugin code) available on disk, but it does NOT bump the
      // record's installedVersion.
      setBulkProgress('Refreshing marketplaces…')
      for (const m of https) {
        try {
          await syncMarketplace(m.id)
        } catch (e) {
          refreshErrors.push(`${m.displayName}: ${(e as Error).message}`)
        }
      }
      // Phase 2 — discover installed plugins with a newer catalog version.
      setBulkProgress('Checking for updates…')
      for (const m of https) {
        try {
          const res = await api.get<{ plugins: AppPluginMarketplacePlugin[] }>(
            `/app-plugins/marketplaces/${encodeURIComponent(m.id)}/plugins`,
          )
          for (const p of res.plugins ?? []) {
            if (p.installed && p.version && p.installedVersion && p.installedVersion !== p.version) {
              installs.push({ mpId: m.id, name: p.name })
            }
          }
        } catch {
          // A marketplace whose plugin list can't be read is skipped; its
          // per-plugin Update buttons remain available for manual updates.
        }
      }
      if (installs.length === 0) {
        const parts: string[] = []
        parts.push(refreshErrors.length === 0 ? 'All plugins up to date.' : 'No updates found.')
        if (refreshErrors.length > 0) {
          parts.push(
            `${refreshErrors.length} marketplace${refreshErrors.length === 1 ? '' : 's'} couldn't be refreshed: ${refreshErrors.join('; ')}`,
          )
        }
        setBulkResult(parts.join(' '))
        return
      }
      // Phase 3 — reinstall each changed plugin. This is what bumps the
      // record's installedVersion to the new version (the sync above left it
      // stale) and surfaces permission escalations.
      for (let i = 0; i < installs.length; i++) {
        const it = installs[i]
        setBulkProgress(`Updating ${it.name} (${i + 1}/${installs.length})…`)
        try {
          const res = await api.post<{ ok: true; result: { permissionRequired: boolean } }>(
            `/app-plugins/marketplaces/${encodeURIComponent(it.mpId)}/plugins/${encodeURIComponent(it.name)}/install`,
          )
          if (res.result?.permissionRequired) permissionRequired++
        } catch (e) {
          installErrors.push(`${it.name}: ${(e as Error).message}`)
        }
      }
      const parts: string[] = []
      const ok = installs.length - installErrors.length
      parts.push(
        installErrors.length === 0
          ? `Updated ${ok} plugin${ok === 1 ? '' : 's'}.`
          : `Updated ${ok}/${installs.length}. Failed: ${installErrors.join('; ')}`,
      )
      if (permissionRequired > 0) {
        parts.push(`${permissionRequired} need permission review (see Installed).`)
      }
      if (refreshErrors.length > 0) {
        parts.push(`${refreshErrors.length} marketplace${refreshErrors.length === 1 ? '' : 's'} couldn't be refreshed: ${refreshErrors.join('; ')}`)
      }
      setBulkResult(parts.join(' '))
    } finally {
      setBulkBusy(false)
      setBulkProgress(null)
      // A bulk run changes BOTH signals an expanded row renders — the catalog
      // (phase 1's pulls) and installedVersion (phase 3) — and it may have
      // ended early with no plugin to reinstall. So re-fetch the rows' plugin
      // lists here, once, on every exit path.
      bumpReload(https.map((m) => m.id))
      // Re-probe so the status line settles on the truth once the badges have
      // cleared (and picks up a failed re-probe as an honest error note).
      await fetchUpdates()
    }
  }

  const httpsCount = marketplaces.filter((m) => m.sourceType === 'https').length
  const updateableCount = marketplaces.filter((m) => updateById[m.id]?.hasUpdate === true).length
  const anyCheckError = marketplaces.some((m) => updateById[m.id]?.error)

  return (
    <section className="settings-group">
      <div className="settings-group-head">
        <h4>Marketplace</h4>
        <span className="settings-group-desc">
          App Plugins (Mods) add menus, commands, and panels to the app; Claude
          Plugins (Marketplace) add tools and servers to the agent — the two are
          separate. Add a GitHub-hosted marketplace URL, then browse and install.
        </span>
      </div>
      <div className="settings-group-body">
      <div className="app-plugins-install">
        <input
          className="input"
          type="text"
          placeholder="https://github.com/owner/app-plugins-repo"
          value={addUrl}
          onChange={(e) => setAddUrl(e.target.value)}
          aria-label="Marketplace URL"
          disabled={busy || bulkBusy}
          onKeyDown={(e) => { if (e.key === 'Enter') void add() }}
        />
        <input
          className="input app-plugins-subdir-input"
          type="text"
          placeholder="plugins"
          value={addSubdir}
          onChange={(e) => setAddSubdir(e.target.value)}
          aria-label="Marketplace content subfolder (optional)"
          aria-describedby="app-plugin-subdir-hint"
          disabled={busy || bulkBusy}
          onKeyDown={(e) => { if (e.key === 'Enter') void add() }}
        />
        <button className="btn btn-primary" disabled={busy || bulkBusy || !addUrl.trim()} onClick={add}>Add</button>
      </div>
      <p id="app-plugin-subdir-hint" className="app-plugins-subdir-hint">
        Optional: usually auto-detected. Only needed when a repo nests its catalog in a subfolder that auto-detection can’t pick, e.g. “plugins”.
      </p>

      {error && <div className="modal-error">{error}</div>}

      {httpsCount > 0 && (
        <div className="app-plugins-update-all" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {/* Same wording as the Claude Plugin marketplace's status line, but
              the button is NOT hidden when nothing is badged: unlike Claude
              (whose plugins are read live out of the clone, so "not behind
              upstream" means "nothing to do"), an App Plugin is an installed
              copy that can lag its catalog with the repo already at HEAD. The
              bulk reconcile is the only way to apply that in one click, so it
              stays available — gaining the primary styling and the count only
              when a marketplace is actually behind. */}
          <button
            className={`btn${updateableCount > 0 ? ' btn-primary' : ''}`}
            onClick={() => void handleUpdateAll()}
            // Also blocked while any ROW sync is in flight: the bulk loop pulls
            // the same clone dirs, and two concurrent `git pull --ff-only` runs
            // there collide on .git/index.lock.
            disabled={bulkBusy || updatingIds.size > 0}
            title="Sync every marketplace from upstream, then reinstall the plugins that changed"
          >
            {bulkBusy
              ? (bulkProgress ?? 'Updating…')
              : updateableCount > 0 ? `Update all (${updateableCount})` : 'Update all'}
          </button>
          {!bulkBusy && updateableCount === 0 && (
            // `checking` outranks the error, exactly as in the Claude panel:
            // mid-check the honest line is "checking", and it also removes the
            // Retry affordance while a retry is in flight (a second click would
            // start an overlapping batch that shares this one's pull epoch, so
            // the two responses could each half-apply).
            checking ? (
              <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--fg-muted)' }}>Checking for updates…</span>
            ) : updateCheckError || anyCheckError ? (
              <>
                {/* Two different failures land here: the whole request failed
                    (network / timeout), or the server responded with
                    per-marketplace errors (it was up, upstreams were not).
                    Both are recoverable with Retry. */}
                <span
                  className="marketplace-update-error"
                  title={updateCheckError
                    ? `Couldn't check for updates: ${updateCheckError}`
                    : 'Some marketplaces could not be checked against their upstream'}
                  aria-label={updateCheckError
                    ? `Couldn't check for updates: ${updateCheckError}`
                    : 'Some marketplaces could not be checked against their upstream'}
                >
                  <IconAlertTriangle size={12} />
                  {updateCheckError ? "Couldn't check for updates" : "Some marketplaces couldn't be checked"}
                </span>
                <button
                  className="btn"
                  style={{ padding: '1px 8px', fontSize: 'var(--fs-xs)' }}
                  onClick={() => void fetchUpdates()}
                  title="Retry the update check"
                >
                  Retry
                </button>
              </>
            ) : (
              <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--ok-text)' }}>All marketplaces up to date</span>
            )
          )}
          {bulkResult && (
            <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--fg-muted)' }}>{bulkResult}</span>
          )}
        </div>
      )}

      <ul className="app-plugins-list">
        {marketplaces.length === 0 && <li className="app-plugins-empty">No marketplaces added.</li>}
        {marketplaces.map((mp) => (
          <MarketplaceRow
            key={mp.id}
            mp={mp}
            expanded={expanded === mp.id}
            onToggle={() => setExpanded(expanded === mp.id ? null : mp.id)}
            updateStatus={updateById[mp.id]}
            updating={updatingIds.has(mp.id)}
            onUpdate={() => void handleRowUpdate(mp.id)}
            onRemove={() => removeMp(mp.id)}
            reloadToken={reloadTokens[mp.id] ?? 0}
            busy={busy || bulkBusy}
          />
        ))}
      </ul>
      </div>
    </section>
  )
}

function MarketplaceRow(props: {
  mp: AppPluginMarketplaceInfo
  expanded: boolean
  onToggle: () => void
  /** Update-check result for this marketplace; `undefined` = not checked. */
  updateStatus?: AppPluginMarketplaceUpdateStatus
  /** This row's own Update is in flight. */
  updating: boolean
  onUpdate: () => void
  onRemove: () => void
  /** Bumped after a pull so the expanded plugin list refetches. */
  reloadToken: number
  busy: boolean
}) {
  const { mp, expanded } = props
  const [plugins, setPlugins] = useState<AppPluginMarketplacePlugin[] | null>(null)
  const [installing, setInstalling] = useState<string | null>(null)

  const fetchPlugins = useCallback(async (): Promise<AppPluginMarketplacePlugin[] | null> => {
    try {
      const res = await api.get<{ plugins: AppPluginMarketplacePlugin[] }>(`/app-plugins/marketplaces/${encodeURIComponent(mp.id)}/plugins`)
      return res.plugins ?? []
    } catch {
      return null
    }
  }, [mp.id])

  useEffect(() => {
    if (!expanded) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clear plugin list on collapse
      setPlugins(null)
      return
    }
    let alive = true
    // setState happens inside the promise callback — outside the synchronous
    // effect body — so react-hooks/set-state-in-effect does not fire here.
    void fetchPlugins().then((res) => {
      if (!alive) return
      if (res !== null) {
        setPlugins(res)
      } else {
        setPlugins([])
      }
    })
    return () => { alive = false }
  }, [expanded, fetchPlugins, props.reloadToken])

  /** Blocked while this row's clone is being rewritten by git: an install
   *  copies the plugin dir straight out of it. */
  const pluginActionsBlocked = props.updating || props.busy

  const install = async (name: string) => {
    setInstalling(name)
    try {
      await api.post(`/app-plugins/marketplaces/${encodeURIComponent(mp.id)}/plugins/${encodeURIComponent(name)}/install`)
      // The WS state-changed frame from manager.install refreshes the
      // installed list in AppPluginsTab. This row's cached plugin list also
      // needs a refresh so the freshly-installed plugin flips from "Install"
      // to "Installed" without a collapse/expand.
      const fresh = await fetchPlugins()
      if (fresh !== null) setPlugins(fresh)
    } catch { /* surfaced via the installed list / next expand */ } finally {
      setInstalling(null)
    }
  }

  return (
    <li className="app-plugins-row">
      <div className="app-plugins-row-head">
        <button className="app-plugins-row-toggle" onClick={props.onToggle} aria-expanded={expanded}>
          <span className="app-plugins-name">{mp.displayName}</span>
          {mp.sourceType === 'local' && <StatusBadge tone="muted">Bundled</StatusBadge>}
          <StatusBadge tone="muted">{mp.pluginCount} plugins</StatusBadge>
        </button>
        <div className="app-plugins-row-actions">
          {/* A bundled (`local`) marketplace has no upstream — no Update
              control at all, rather than a button that can never do anything. */}
          {mp.sourceType === 'https' && (
            <MarketplaceUpdateButton
              hasUpdate={props.updateStatus?.hasUpdate === true}
              // Only THIS row's sync may say "Updating…"; a panel-wide Add /
              // Remove or a bulk run merely disables the control.
              busy={props.updating}
              disabled={props.updating || props.busy}
              error={props.updateStatus?.error}
              onUpdate={props.onUpdate}
            />
          )}
          {/* Blocked while this row's own pull runs: the server is inside
              `git pull` on this very clone dir, and a DELETE would remove the
              directory underneath it. */}
          <button className="btn" disabled={props.updating || props.busy} onClick={props.onRemove}>Remove</button>
        </div>
      </div>
      <div className="app-plugins-meta">
        {mp.sourceType === 'local' ? <span>Bundled with app</span> : <span>{mp.url}{mp.subdir ? ` / ${mp.subdir}` : ''}</span>}
        {mp.sourceType !== 'local' && mp.ref && <span>@ {mp.ref}</span>}
      </div>
      {expanded && (
        <ul className="app-plugins-mp-plugins">
          {plugins === null && <li>Loading…</li>}
          {plugins !== null && plugins.length === 0 && <li>No plugins in this marketplace.</li>}
          {plugins?.map((p) => {
            const installed = p.installed === true
            // A catalog version that differs from what's installed means an
            // update is available; otherwise the installed plugin is current.
            const updateAvailable =
              installed && p.version !== undefined && p.installedVersion !== undefined && p.installedVersion !== p.version
            return (
              <li key={p.name} className="app-plugins-mp-plugin">
                <div>
                  <strong>{p.name}</strong>
                  {p.version && <span className="app-plugins-meta"> v{p.version}</span>}
                  {p.description && <div className="app-plugins-meta">{p.description}</div>}
                  {installed && p.installedVersion && (
                    <div className="app-plugins-meta">Installed v{p.installedVersion}</div>
                  )}
                </div>
                {installed ? (
                  updateAvailable ? (
                    <button className="btn" disabled={installing === p.name || pluginActionsBlocked} onClick={() => install(p.name)}>Update</button>
                  ) : (
                    <button className="btn" disabled>Installed</button>
                  )
                ) : (
                  <button className="btn btn-primary" disabled={installing === p.name || pluginActionsBlocked} onClick={() => install(p.name)}>
                    {installing === p.name ? 'Installing…' : 'Install'}
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </li>
  )
}
