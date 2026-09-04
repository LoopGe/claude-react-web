// App Plugin Marketplace section — add GitHub-hosted marketplaces, browse,
// and install App Plugins from them. Rendered at the top of AppPluginsTab.
//
// Mirrors the Claude Plugin MarketplaceTab pattern but hits the App Plugin
// marketplace routes (/api/app-plugins/marketplaces/*). Installing a plugin
// routes through AppPluginManager, so the WS state-changed frame updates the
// installed list automatically (no manual refetch of the installed list).

import { useCallback, useEffect, useState } from 'react'
import { api, apiRequest } from '../hooks/useApi'
import type { AppPluginMarketplaceInfo, AppPluginMarketplacePlugin } from '../../shared/app-plugins/marketplace.js'

export function AppPluginMarketplaceSection() {
  const [marketplaces, setMarketplaces] = useState<AppPluginMarketplaceInfo[]>([])
  const [addUrl, setAddUrl] = useState('')
  const [addSubdir, setAddSubdir] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)

  // Bulk "Update all" — refresh every https marketplace to discover new
  // catalog versions, then reinstall each installed plugin whose version
  // changed. `bulkProgress` shows the current phase; `bulkResult` is the
  // completion summary.
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

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time mount fetch of the marketplace list
    void refreshList()
  }, [refreshList])

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
      // append it locally instead of refetching the whole list (mirrors
      // MarketplaceTab.handleAdd).
      const mp = res.marketplace
      setMarketplaces((prev) => [...prev.filter((m) => m.id !== mp.id), mp])
      setAddUrl('')
      setAddSubdir('')
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }, [addUrl, addSubdir])

  const refreshMp = useCallback(async (id: string) => {
    setBusy(true); setError(null)
    try { await api.post(`/app-plugins/marketplaces/${encodeURIComponent(id)}/refresh`); await refreshList() }
    catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }, [refreshList])

  const removeMp = useCallback(async (id: string) => {
    setBusy(true); setError(null)
    try {
      await apiRequest(`/app-plugins/marketplaces/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        body: JSON.stringify({ confirm: true }),
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
      // Phase 1 — git-pull every https marketplace. This makes the new
      // catalog (and plugin code) available on disk, and revalidates each
      // installed plugin from that marketplace, but it does NOT bump the
      // record's installedVersion.
      setBulkProgress('Refreshing marketplaces…')
      for (const m of https) {
        try {
          await api.post(`/app-plugins/marketplaces/${encodeURIComponent(m.id)}/refresh`)
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
        await refreshList()
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
      // record's installedVersion to the new version (the refresh above left
      // it stale) and surfaces permission escalations.
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
      await refreshList()
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
    }
  }

  return (
    <div className="app-plugins-marketplace">
      <h4>Marketplace</h4>
      <p className="app-plugins-intro">Add a GitHub-hosted App Plugin marketplace URL, then browse and install.</p>
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

      {marketplaces.length > 0 && (
        <div className="app-plugins-update-all" style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <button
            className="btn btn-primary"
            onClick={() => void handleUpdateAll()}
            disabled={bulkBusy}
            title="Refresh marketplaces and update every installed plugin that has a new version"
          >
            {bulkBusy ? (bulkProgress ?? 'Updating…') : 'Update all'}
          </button>
          {bulkResult && <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>{bulkResult}</span>}
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
            onRefresh={() => refreshMp(mp.id)}
            onRemove={() => removeMp(mp.id)}
            busy={busy || bulkBusy}
          />
        ))}
      </ul>
    </div>
  )
}

function MarketplaceRow(props: {
  mp: AppPluginMarketplaceInfo
  expanded: boolean
  onToggle: () => void
  onRefresh: () => void
  onRemove: () => void
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
  }, [expanded, fetchPlugins])

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
          {mp.sourceType === 'local' && <span className="app-plugins-state state-muted">Bundled</span>}
          <span className="app-plugins-state state-muted">{mp.pluginCount} plugins</span>
        </button>
        <div className="app-plugins-row-actions">
          <button className="btn" disabled={props.busy} onClick={props.onRefresh}>Refresh</button>
          <button className="btn" disabled={props.busy} onClick={props.onRemove}>Remove</button>
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
                    <button className="btn" disabled={installing === p.name} onClick={() => install(p.name)}>Update</button>
                  ) : (
                    <button className="btn" disabled>Installed</button>
                  )
                ) : (
                  <button className="btn btn-primary" disabled={installing === p.name} onClick={() => install(p.name)}>
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
