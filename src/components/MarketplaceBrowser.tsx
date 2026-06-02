// Marketplace browser — adds, removes, refreshes plugin marketplaces and
// installs / enables / disables / uninstalls individual plugins.
//
// All mutating operations route through `/api/marketplaces/...` which
// shells out to the `claude` CLI on the server. The UI surfaces CLI
// errors verbatim because they're more accurate than anything we'd
// reconstruct (e.g. "marketplace 'foo' not found", "invalid path").
//
// In-band confirms (Add form, Remove confirm) replace the toolbar row
// rather than stacking modal-on-modal — keeps focus management simple
// and avoids z-index ambiguity with the parent modal.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { IconTrash, IconX, IconCircleDot, IconCircle } from './icons/ToolIcons'
import { api } from '../hooks/useApi'
import { formatRelativeTime } from '../utils/format'
import type { MarketplaceInfo, MarketplacePlugin } from '../types'

interface Props {
  onClose: () => void
  /** Called whenever installed/enabled state may have changed so the
   *  parent can re-fetch slash-commands / agents. */
  onInstalled?: () => void
}

type ToolbarMode = 'idle' | 'adding' | 'confirming-remove'

export function MarketplaceBrowser({ onClose, onInstalled }: Props) {
  const [marketplaces, setMarketplaces] = useState<MarketplaceInfo[]>([])
  const [selected, setSelected] = useState<string>('')
  const [plugins, setPlugins] = useState<MarketplacePlugin[]>([])
  const [pluginsLoading, setPluginsLoading] = useState(false)
  const [filter, setFilter] = useState('')
  /** Per-plugin in-flight action (`installing`/`uninstalling`/`toggling`)
   *  so we can disable the relevant buttons and show progress text. */
  const [busyPlugin, setBusyPlugin] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  /** Banner shown when a marketplace-level action succeeds; clears on next mutation. */
  const [info, setInfo] = useState<string | null>(null)
  const [toolbarMode, setToolbarMode] = useState<ToolbarMode>('idle')
  const [addSource, setAddSource] = useState('')
  const [addBusy, setAddBusy] = useState(false)
  const [refreshingAll, setRefreshingAll] = useState(false)
  const [refreshingOne, setRefreshingOne] = useState(false)
  const [removingOne, setRemovingOne] = useState(false)

  const addInputRef = useRef<HTMLInputElement>(null)

  // Per-loader request-id refs. Each loader call increments its ref;
  // after `await`, the resolved handler bails out if a newer call has
  // since been issued. Without this, rapid marketplace-switching can
  // race: a slow loadPlugins('A') resolves AFTER a fast loadPlugins('B')
  // and overwrites B's plugin list with A's. (Replaces the `cancelled`
  // flag pattern from the previous incarnation — refs survive the
  // useCallback identity churn caused by `selected` deps.)
  const marketplacesReqRef = useRef(0)
  const pluginsReqRef = useRef(0)

  // ─── Data loaders ─────────────────────────────────────────────

  const loadMarketplaces = useCallback(
    async (preferName?: string): Promise<MarketplaceInfo[]> => {
      const reqId = ++marketplacesReqRef.current
      try {
        const res = await api.get<{ marketplaces: MarketplaceInfo[] }>('/marketplaces')
        // Stale response — a newer loadMarketplaces() has been issued.
        // Drop our setState calls but still return the list to the
        // caller (which awaited THIS call's promise specifically and
        // is using the result for its own sync logic).
        if (reqId !== marketplacesReqRef.current) return res.marketplaces ?? []
        const list = res.marketplaces ?? []
        setMarketplaces(list)
        if (preferName && list.some((m) => m.name === preferName)) {
          setSelected(preferName)
        } else if (list.length > 0 && !list.some((m) => m.name === selected)) {
          setSelected(list[0].name)
        } else if (list.length === 0) {
          setSelected('')
        }
        return list
      } catch (e) {
        if (reqId !== marketplacesReqRef.current) return []
        setErr((e as Error).message)
        return []
      }
    },
    [selected],
  )

  const loadPlugins = useCallback(async (marketplace: string) => {
    if (!marketplace) {
      // The empty-marketplace path also bumps the request id so any
      // earlier in-flight loadPlugins(prev) gets superseded — otherwise
      // a slow prior fetch could repopulate the list seconds later.
      ++pluginsReqRef.current
      setPlugins([])
      return
    }
    const reqId = ++pluginsReqRef.current
    setPluginsLoading(true)
    try {
      const res = await api.get<{ plugins: MarketplacePlugin[] }>(
        `/marketplaces/${encodeURIComponent(marketplace)}/plugins`,
      )
      if (reqId !== pluginsReqRef.current) return
      setPlugins(res.plugins ?? [])
    } catch (e) {
      if (reqId !== pluginsReqRef.current) return
      setPlugins([])
      setErr((e as Error).message)
    } finally {
      // Only the latest in-flight request owns the loading flag — an
      // earlier-superseded request flipping it back to false here
      // would cause UI flicker if the latest is still pending.
      if (reqId === pluginsReqRef.current) setPluginsLoading(false)
    }
  }, [])

  // Load marketplaces once on mount. The setState calls inside
  // loadMarketplaces happen after an `await` (microtask boundary), so
  // the lint rule's "setState during effect" complaint is a false
  // positive — but explicit silence is clearer than relying on a
  // future fix.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadMarketplaces()
    // We intentionally don't depend on loadMarketplaces — its identity
    // changes whenever `selected` does, which would re-fetch on every
    // dropdown change. The plugin-list effect below handles selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Reload plugin list whenever the selected marketplace changes.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadPlugins(selected)
  }, [selected, loadPlugins])

  // Auto-focus the source input when the user opens the Add form.
  useEffect(() => {
    if (toolbarMode === 'adding') {
      addInputRef.current?.focus()
    }
  }, [toolbarMode])

  // ─── Plugin actions ───────────────────────────────────────────

  const runPluginAction = useCallback(
    async (plugin: MarketplacePlugin, verb: 'install' | 'uninstall' | 'enable' | 'disable') => {
      setBusyPlugin(plugin.name)
      setErr(null)
      // Clear any lingering marketplace-level info banner ("Removed
      // 'X'.", "Refreshed 'Y'.") so it doesn't sit above an unrelated
      // plugin action. Other mutating paths (submitAdd/refreshOne/
      // refreshAll) already do this; runPluginAction was the outlier.
      setInfo(null)
      try {
        const path = `/marketplaces/${encodeURIComponent(plugin.marketplace)}/plugins/${encodeURIComponent(plugin.name)}`
        if (verb === 'install') {
          await api.post(`${path}/install`)
        } else if (verb === 'uninstall') {
          await api.delete(path)
        } else {
          await api.post(`${path}/${verb}`)
        }
        // Reload from server so the cached list reflects the new state
        // (including any side-effects on dependent plugins).
        await loadPlugins(plugin.marketplace)
        onInstalled?.()
      } catch (e) {
        setErr((e as Error).message)
      } finally {
        setBusyPlugin(null)
      }
    },
    [loadPlugins, onInstalled],
  )

  // ─── Marketplace actions ──────────────────────────────────────

  const submitAdd = useCallback(async () => {
    const source = addSource.trim()
    if (!source) return
    setAddBusy(true)
    setErr(null)
    setInfo(null)
    // Capture existing names so we can detect the newly-added one and
    // auto-select it after the list refetches.
    const before = new Set(marketplaces.map((m) => m.name))
    try {
      await api.post('/marketplaces', { source })
      const list = await loadMarketplaces()
      const added = list.find((m) => !before.has(m.name))
      if (added) {
        setSelected(added.name)
        setInfo(`Added "${added.name}".`)
      }
      setAddSource('')
      setToolbarMode('idle')
      onInstalled?.()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setAddBusy(false)
    }
  }, [addSource, marketplaces, loadMarketplaces, onInstalled])

  const confirmRemove = useCallback(async () => {
    if (!selected) return
    setRemovingOne(true)
    setErr(null)
    try {
      await api.delete(`/marketplaces/${encodeURIComponent(selected)}`)
      setInfo(`Removed "${selected}". Plugins remain installed.`)
      setToolbarMode('idle')
      await loadMarketplaces()
      onInstalled?.()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setRemovingOne(false)
    }
  }, [selected, loadMarketplaces, onInstalled])

  const refreshOne = useCallback(async () => {
    if (!selected) return
    setRefreshingOne(true)
    setErr(null)
    try {
      await api.post(`/marketplaces/${encodeURIComponent(selected)}/refresh`)
      await loadMarketplaces(selected)
      await loadPlugins(selected)
      setInfo(`Refreshed "${selected}".`)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setRefreshingOne(false)
    }
  }, [selected, loadMarketplaces, loadPlugins])

  const refreshAll = useCallback(async () => {
    setRefreshingAll(true)
    setErr(null)
    try {
      await api.post('/marketplaces/refresh-all')
      await loadMarketplaces(selected)
      if (selected) await loadPlugins(selected)
      setInfo('Refreshed all marketplaces.')
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setRefreshingAll(false)
    }
  }, [selected, loadMarketplaces, loadPlugins])

  // ─── Derived data ─────────────────────────────────────────────

  const selectedInfo = useMemo<MarketplaceInfo | undefined>(
    () => marketplaces.find((m) => m.name === selected),
    [marketplaces, selected],
  )

  const filteredPlugins = useMemo<MarketplacePlugin[]>(() => {
    if (!filter) return plugins
    const q = filter.toLowerCase()
    return plugins.filter(
      (p) => p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q),
    )
  }, [plugins, filter])

  const anyMutating = addBusy || removingOne || refreshingAll || refreshingOne

  // ─── Render ───────────────────────────────────────────────────

  return (
    <div className="marketplace-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="marketplace-card">
        <div className="modal-header">
          <h3>Plugin Marketplace</h3>
          <button className="btn btn-sm" onClick={onClose}>Close</button>
        </div>

        {err && (
          <div className="marketplace-error">
            <span>{err}</span>
            <button className="marketplace-dismiss" onClick={() => setErr(null)} aria-label="Dismiss"><IconX size={12} /></button>
          </div>
        )}
        {info && !err && (
          <div className="marketplace-info">
            <span>{info}</span>
            <button className="marketplace-dismiss" onClick={() => setInfo(null)} aria-label="Dismiss"><IconX size={12} /></button>
          </div>
        )}

        {/* Marketplace selector + filter row */}
        <div className="marketplace-row">
          <select
            className="select"
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            disabled={marketplaces.length === 0}
          >
            {marketplaces.length === 0 && <option value="">No marketplaces registered</option>}
            {marketplaces.map((m) => (
              <option key={m.name} value={m.name}>{m.name}</option>
            ))}
          </select>
          <input
            className="input"
            placeholder="Filter plugins…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            disabled={!selected}
          />
          <button
            className="btn btn-sm"
            onClick={() => { setToolbarMode('adding'); setErr(null); setInfo(null) }}
            disabled={anyMutating}
          >
            + Add
          </button>
        </div>

        {/* Selected-marketplace meta + per-marketplace toolbar (or active form) */}
        {toolbarMode === 'adding' ? (
          <div className="marketplace-add-form">
            <input
              ref={addInputRef}
              className="input marketplace-add-input"
              placeholder="GitHub repo (owner/repo), git URL, or local path"
              value={addSource}
              onChange={(e) => setAddSource(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && addSource.trim() && !addBusy) {
                  e.preventDefault()
                  void submitAdd()
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  setToolbarMode('idle')
                  setAddSource('')
                }
              }}
              disabled={addBusy}
            />
            <button
              className="btn btn-primary btn-sm"
              onClick={() => void submitAdd()}
              disabled={!addSource.trim() || addBusy}
            >
              {addBusy ? 'Adding…' : 'Add'}
            </button>
            <button
              className="btn btn-sm"
              onClick={() => { setToolbarMode('idle'); setAddSource('') }}
              disabled={addBusy}
            >
              Cancel
            </button>
          </div>
        ) : toolbarMode === 'confirming-remove' ? (
          <div className="marketplace-confirm-remove">
            <span>
              Remove <strong>{selected}</strong>? Plugins from this marketplace stay installed.
            </span>
            <div className="marketplace-confirm-actions">
              <button
                className="btn btn-sm"
                onClick={() => setToolbarMode('idle')}
                disabled={removingOne}
              >
                Cancel
              </button>
              <button
                className="btn btn-danger btn-sm"
                onClick={() => void confirmRemove()}
                disabled={removingOne}
              >
                {removingOne ? 'Removing…' : 'Remove'}
              </button>
            </div>
          </div>
        ) : selectedInfo ? (
          <div className="marketplace-meta-row">
            <div className="marketplace-meta-text">
              <div className="marketplace-meta-source" title={selectedInfo.source}>
                source: {selectedInfo.source || '(unknown)'}
              </div>
              {selectedInfo.lastUpdated && (
                <div className="marketplace-meta-time">
                  Updated {formatRelativeTime(selectedInfo.lastUpdated)}
                </div>
              )}
            </div>
            <div className="marketplace-meta-actions">
              <button
                className="btn btn-sm"
                onClick={() => void refreshOne()}
                disabled={anyMutating}
                title="Refresh this marketplace from its source"
              >
                {refreshingOne ? '↻ Refreshing…' : '↻ Refresh'}
              </button>
              <button
                className="btn btn-sm"
                onClick={() => void refreshAll()}
                disabled={anyMutating || marketplaces.length === 0}
                title="Refresh every registered marketplace"
              >
                {refreshingAll ? '↻ Refreshing all…' : '↻ Refresh all'}
              </button>
              <button
                className="btn btn-danger btn-sm"
                onClick={() => { setToolbarMode('confirming-remove'); setErr(null); setInfo(null) }}
                disabled={anyMutating}
                title="Unregister this marketplace (plugins stay installed)"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
              >
                <IconTrash size={14} /> Remove
              </button>
            </div>
          </div>
        ) : null}

        {/* Plugin list */}
        <div className="marketplace-plugin-list">
          {pluginsLoading && (
            <div className="marketplace-plugin-empty">Loading…</div>
          )}
          {!pluginsLoading && !selected && (
            <div className="marketplace-plugin-empty">
              Add a marketplace above to browse plugins.
            </div>
          )}
          {!pluginsLoading && selected && filteredPlugins.length === 0 && (
            <div className="marketplace-plugin-empty">
              {plugins.length === 0
                ? 'No plugins available in this marketplace.'
                : 'No plugins match the filter.'}
            </div>
          )}
          {!pluginsLoading && filteredPlugins.map((p) => {
            const busy = busyPlugin === p.name
            return (
              <div key={p.name} className="marketplace-plugin-row">
                <div className="marketplace-plugin-head">
                  <span className="marketplace-plugin-name">{p.name}</span>
                  <span className="marketplace-plugin-version">v{p.version}</span>
                  {p.installed && (
                    <span
                      className={`marketplace-plugin-status ${p.enabled ? 'enabled' : 'disabled'}`}
                      title={p.enabled ? 'Plugin is enabled' : 'Plugin is installed but disabled'}
                    >
                      {p.enabled ? <IconCircleDot size={12} /> : <IconCircle size={12} />} {p.enabled ? 'enabled' : 'disabled'}
                    </span>
                  )}
                  <div className="marketplace-plugin-actions">
                    {!p.installed && (
                      <button
                        className="btn btn-primary btn-sm"
                        onClick={() => void runPluginAction(p, 'install')}
                        disabled={busy}
                      >
                        {busy ? 'Installing…' : 'Install'}
                      </button>
                    )}
                    {p.installed && (
                      <>
                        <button
                          className="btn btn-sm"
                          onClick={() => void runPluginAction(p, p.enabled ? 'disable' : 'enable')}
                          disabled={busy}
                          title={p.enabled ? 'Disable without uninstalling' : 'Re-enable this plugin'}
                        >
                          {busy ? '…' : p.enabled ? 'Disable' : 'Enable'}
                        </button>
                        <button
                          className="btn btn-danger btn-sm"
                          onClick={() => void runPluginAction(p, 'uninstall')}
                          disabled={busy}
                          title="Remove this plugin entirely"
                        >
                          {busy ? '…' : 'Uninstall'}
                        </button>
                      </>
                    )}
                  </div>
                </div>
                {p.description && (
                  <div className="marketplace-plugin-desc">{p.description}</div>
                )}
                {p.author && (
                  <div className="marketplace-plugin-author">by {p.author}</div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
