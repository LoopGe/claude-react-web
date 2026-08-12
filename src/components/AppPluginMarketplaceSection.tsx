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
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)

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
    setBusy(true); setError(null)
    try {
      await api.post('/app-plugins/marketplaces', { url })
      setAddUrl('')
      await refreshList()
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }, [addUrl, refreshList])

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
        />
        <button className="btn btn-primary" disabled={busy || !addUrl.trim()} onClick={add}>Add</button>
      </div>

      {error && <div className="modal-error">{error}</div>}

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
            busy={busy}
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
